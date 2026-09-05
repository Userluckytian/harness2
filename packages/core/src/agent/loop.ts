// Agent loop：turn/step 状态机。
// 核心不变量（Model-visible ⟺ logged）：每一步模型请求的消息列表唯一来源是
// 会话日志投影——先 loadSession → buildChatMessages 重建，再发请求；工具结果也
// 先落 tool/result 事件、下一请求从日志重建。禁止任何内存旁路。
// append-only：取消/失败都以追加事件记录（assistant/attempt、ok:false 的 tool/result）。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeProjection, loadSession, type LoadedSession } from '../session/reader.js';
import { readTextOrNull, snapshotTargetFile, type SnapshotStore } from '../session/snapshots.js';
import { SessionWriter } from '../session/writer.js';
import { SESSION_LOG_FILE } from '../session/types.js';
import type {
  ChatMessage,
  ChatRequest,
  ProviderStopReason,
  ProviderUsage,
  ToolCallRequest,
  ToolSpec,
} from '../provider/types.js';
import { ToolExecutor, type ExecutedToolResult, type ToolExecutionRequest } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { TurnOptions, TurnResult, TurnStopReason } from './types.js';

export const DEFAULT_MAX_STEPS = 25;

/**
 * 从会话日志重建模型请求消息列表（provider/types.ts 中映射规则的唯一实现）：
 *   user/message → user 消息；assistant/message → assistant 消息；
 *   紧随 assistant 的 tool/call → 该消息的 toolCalls；tool/result → tool 消息。
 * 依赖 computeProjection 的 rewind 语义：被回退遮蔽的事件不进入上下文。
 */
export function buildChatMessages(session: LoadedSession): ChatMessage[] {
  computeProjection(session); // 标记每个事件的活动性（rewind 感知）
  const messages: ChatMessage[] = [];
  for (const { event: e, active } of session.events) {
    if (!active) continue;
    switch (e.type) {
      case 'user/message':
        messages.push({ role: 'user', content: e.payload.text });
        break;
      case 'assistant/message':
        messages.push({ role: 'assistant', content: e.payload.text });
        break;
      case 'tool/call': {
        // tool/call 归属其前最近的 assistant 消息；孤儿调用（日志异常）不进模型上下文
        const last = messages.at(-1);
        if (last?.role === 'assistant') {
          const calls = (last.toolCalls ??= []);
          calls.push({
            id: e.payload.callId,
            name: e.payload.tool,
            arguments: JSON.stringify(e.payload.args ?? {}),
          });
        }
        break;
      }
      case 'tool/result': {
        const content = e.payload.ok
          ? (e.payload.output ?? '')
          : [e.payload.error, e.payload.output].filter(Boolean).join('\n');
        messages.push({ role: 'tool', content, toolCallId: e.payload.callId, name: e.payload.tool });
        break;
      }
      default:
        break; // 结构性事件（header/step/attempt/rewind）不进模型上下文
    }
  }
  return messages;
}

/**
 * 运行一个用户 turn：循环执行 step（模型调用 + 工具执行）直到模型不再调用工具、
 * 达到 maxSteps、被取消或模型出错。session 可传目录或调用方已持有的 SessionWriter：
 *   - 目录 + 日志不存在 → 新建会话（sessionId 自动生成）并在结束后 close；
 *   - 目录 + 日志已存在 → open 续写并在结束后 close；
 *   - writer → 直接使用（由调用方负责 close）。
 */
export async function runTurn(session: string | SessionWriter, options: TurnOptions): Promise<TurnResult> {
  if (typeof session !== 'string') return runTurnWithWriter(session, options);
  const writer = existsSync(join(session, SESSION_LOG_FILE))
    ? SessionWriter.open(session)
    : SessionWriter.create(session, { sessionId: randomUUID(), cwd: options.cwd });
  try {
    return await runTurnWithWriter(writer, options);
  } finally {
    writer.close();
  }
}

interface PendingCall {
  callId: string;
  tool: string;
  args: unknown;
  parseError?: string;
}

function parseToolArgs(raw: string): { args: unknown; parseError?: string } {
  if (raw.trim() === '') return { args: {} };
  try {
    return { args: JSON.parse(raw) };
  } catch (e) {
    return { args: undefined, parseError: `invalid JSON arguments: ${(e as Error).message}` };
  }
}

/** abort 原因归一为可读消息（reason 可能是 Error/DOMException/任意值/缺省） */
function abortReasonMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : reason !== undefined ? String(reason) : 'aborted';
}

async function runTurnWithWriter(writer: SessionWriter, options: TurnOptions): Promise<TurnResult> {
  const turnId = randomUUID();
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const executor = new ToolExecutor(options.tools, options.approval);
  const provider = options.provider;
  const signal = options.signal;
  const envSignal = signal ?? new AbortController().signal; // runWave 需要一个 signal
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);

  if (options.userText !== undefined) {
    writer.append('user/message', { text: options.userText, turnId });
  }

  let steps = 0;
  let toolCallsTotal = 0;
  let finalText: string | undefined;
  let stopReason: TurnStopReason = 'end_turn';
  let error: string | undefined;
  let warning: string | undefined;

  // eslint 结构：每个 step = step/start → 请求（日志投影）→ 模型流 → 事件落盘 → step/end
  while (true) {
    if (signal?.aborted) {
      stopReason = 'cancelled';
      error = 'turn cancelled';
      break;
    }
    if (steps >= maxSteps) {
      stopReason = 'max_steps';
      break;
    }
    steps += 1;
    const stepId = `step-${turnId.slice(0, 8)}-${steps}`;
    const stepStartedAt = performance.now();
    writer.append('step/start', { stepId, turnId });

    // —— 模型请求上下文：唯一来源 = 日志投影（无内存旁路）——
    const messages = buildChatMessages(loadSession(writer.dir));
    const toolSpecs = options.tools.list().map(
      (def): ToolSpec => ({ name: def.name, description: def.description, parameters: def.parameters }),
    );
    const request: ChatRequest = toolSpecs.length > 0 ? { messages, tools: toolSpecs } : { messages };

    let text = '';
    let reasoning: string | undefined;
    let usage: ProviderUsage | undefined;
    let providerStop: ProviderStopReason | undefined; // done 块透传的流终止原因（P2-4）
    const calls: ToolCallRequest[] = [];
    // 取消分类公共出口：半截尝试以 assistant/attempt 记录（append-only），绝不冒充 assistant/message
    const finishCancelled = (msg: string): TurnResult => {
      writer.append('assistant/attempt', {
        error: `cancelled: ${msg}`,
        model: provider.name,
        turnId,
      });
      writer.append('step/end', {
        stepId,
        turnId,
        durationMs: Math.round(performance.now() - stepStartedAt),
      });
      return {
        stopReason: 'cancelled',
        steps,
        toolCalls: toolCallsTotal,
        durationMs: elapsed(),
        error: msg,
      };
    };
    try {
      for await (const chunk of provider.streamChat(request, { signal })) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'reasoning-delta') reasoning = (reasoning ?? '') + chunk.text;
        else if (chunk.type === 'tool-call') calls.push(chunk.call);
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'done') providerStop = chunk.stopReason;
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (signal?.aborted === true) return finishCancelled(msg);
      // 失败的尝试以追加事件记录（append-only）
      writer.append('assistant/attempt', {
        error: msg,
        model: provider.name,
        turnId,
      });
      writer.append('step/end', {
        stepId,
        turnId,
        durationMs: Math.round(performance.now() - stepStartedAt),
      });
      return {
        stopReason: 'error',
        steps,
        toolCalls: toolCallsTotal,
        durationMs: elapsed(),
        error: msg,
      };
    }

    // provider 契约允许 abort 时正常结束迭代而非抛错：这里补检信号再分类（P2-1），
    // 半截文本不得落 assistant/message 被记成 end_turn。
    if (signal?.aborted) return finishCancelled(abortReasonMessage(signal));

    writer.append('assistant/message', {
      text,
      model: provider.name,
      ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
      ...(usage !== undefined ? { usage } : {}),
      turnId,
    });

    if (calls.length === 0) {
      writer.append('step/end', { stepId, turnId, durationMs: Math.round(performance.now() - stepStartedAt) });
      finalText = text;
      if (providerStop === 'paused') {
        // P2-4：Anthropic pause_turn → paused。续跑（把暂停原因写回并重发请求继续本 turn）未实现，
        // 已登记 OPEN.md；此处以 warning 通道如实告知调用方，不冒充 end_turn。
        warning = 'provider 请求暂停本 turn（pause_turn）：续跑未实现，turn 以 paused 结束，需重新发起';
      }
      // provider 白名单透传的终止原因（length/content_filter/refusal/paused）优先；
      // done 缺失（provider 契约未发）或报 tool_use 却无调用时归 end_turn
      stopReason = providerStop && providerStop !== 'tool_use' ? providerStop : 'end_turn';
      break;
    }

    // 有工具调用：逐个落 tool/call → 波次执行（safe 并行/unsafe 串行/lockKey 串行）→ 逐个落 tool/result
    const pending: PendingCall[] = [];
    const callSeqs = new Map<string, number>(); // callId → tool/call 事件 seq（快照键）
    for (const call of calls) {
      const { args, parseError } = parseToolArgs(call.arguments);
      const callEvent = writer.append('tool/call', {
        callId: call.id,
        tool: call.name,
        ...(parseError === undefined ? { args } : {}),
        turnId,
      });
      callSeqs.set(call.id, callEvent.seq);
      pending.push({ callId: call.id, tool: call.name, args, parseError });
    }

    const runnable = pending.filter((p): p is PendingCall & { parseError: undefined } => p.parseError === undefined);
    // 快照钩子（仅当提供 SnapshotStore；write/edit 才产生条目，bash/read 等不产生）
    const snapshots = options.snapshots;
    const snapshotHooks = snapshots
      ? {
          onBeforeExecute: (req: ToolExecutionRequest): void => {
            const seq = callSeqs.get(req.callId);
            const file = snapshotTargetFile(req.tool, req.args, options.cwd);
            if (seq === undefined || file === null) return;
            snapshots.capture({ seq, file, before: readTextOrNull(file) });
          },
          onAfterExecute: (req: ToolExecutionRequest, ok: boolean): void => {
            if (!ok) return; // 失败/取消不记 after（未完成的修改没有恢复点）
            const seq = callSeqs.get(req.callId);
            const file = snapshotTargetFile(req.tool, req.args, options.cwd);
            if (seq === undefined || file === null) return;
            snapshots.commitAfter({ seq, after: readTextOrNull(file) });
          },
        }
      : {};
    let results: ExecutedToolResult[];
    try {
      results =
        runnable.length > 0
          ? await executor.runWave(
              runnable.map((p): ToolExecutionRequest => ({ callId: p.callId, tool: p.tool, args: p.args })),
              { signal: envSignal, cwd: options.cwd, ...snapshotHooks },
            )
          : [];
    } catch (e) {
      // 兜底（P2-2）：执行器意外 reject 时也必须落齐 tool/result + step/end
      // （tools/types.ts 的无悬挂承诺）；回调异常正常已在 executor 内转为 ok:false。
      const msg = (e as Error)?.message ?? String(e);
      results = runnable.map((p) => ({
        callId: p.callId,
        ok: false,
        error: `executor crashed: ${msg}`,
        durationMs: 0,
      }));
    }
    const byCallId = new Map(results.map((r) => [r.callId, r]));
    for (const p of pending) {
      if (p.parseError !== undefined) {
        writer.append('tool/result', { callId: p.callId, tool: p.tool, ok: false, error: p.parseError, turnId });
        continue;
      }
      const r = byCallId.get(p.callId);
      if (!r) {
        writer.append('tool/result', { callId: p.callId, tool: p.tool, ok: false, error: 'executor lost result', turnId });
        continue;
      }
      writer.append('tool/result', {
        callId: r.callId,
        tool: p.tool,
        ok: r.ok,
        ...(r.output !== undefined ? { output: r.output } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        durationMs: r.durationMs,
        turnId,
      });
    }
    toolCallsTotal += calls.length;

    writer.append('step/end', { stepId, turnId, durationMs: Math.round(performance.now() - stepStartedAt) });
    // 继续下一 step：工具结果已落盘，下一请求由日志投影重建（含 tool role 消息）
  }

  return {
    stopReason,
    steps,
    toolCalls: toolCallsTotal,
    durationMs: elapsed(),
    ...(finalText !== undefined ? { finalText } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}
