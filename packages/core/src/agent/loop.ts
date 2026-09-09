// Agent loop：turn/step 状态机。
// 核心不变量（Model-visible ⟺ logged）：每一步模型请求的消息列表唯一来源是
// 会话日志投影——先 loadSession → buildChatMessages 重建，再发请求；工具结果也
// 先落 tool/result 事件、下一请求从日志重建。禁止任何内存旁路。
// append-only：取消/失败都以追加事件记录（assistant/attempt、ok:false 的 tool/result）。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCompactionDigest,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_TRIGGER_RATIO,
  computeCoveredUpToSeq,
  DEFAULT_CONTEXT_WINDOW,
  estimateContextTokens,
  requestCompactionSummary,
} from './compaction.js';
import { assembleMemorySnapshot, type MemoryStore } from '../memory/store.js';
import { assembleSkillsSystemBlock } from '../skills/store.js';
import { computeProjection, loadSession, type LoadedSession } from '../session/reader.js';
import { readTextOrNull, snapshotTargetFile } from '../session/snapshots.js';
import { SessionWriter, type SessionAppender } from '../session/writer.js';
import { SESSION_LOG_FILE } from '../session/types.js';
import type { CompactionAppliedPayload } from '../session/types.js';
import type {
  ChatMessage,
  ChatRequest,
  ProviderStopReason,
  ProviderUsage,
  ToolCallRequest,
  ToolSpec,
} from '../provider/types.js';
import { ToolExecutor, type ExecutedToolResult, type ToolExecutionRequest } from '../tools/executor.js';
import type { TurnOptions, TurnResult, TurnStopReason } from './types.js';
import type { SteerRequest } from '../interaction/types.js';
import {
  classifyAttemptError,
  createRetryBudget,
  effectiveDelay,
  backoffSeconds,
  waitWithAbort,
  RetryAbortError,
  type EffectiveDelay,
  type RetryBudgetState,
} from '../interaction/retry-policy.js';
import { RETRY_MAX_EXTRA_PER_TURN, RETRY_MAX_TOTAL_WAIT_SECONDS } from '../interaction/types.js';

export const DEFAULT_MAX_STEPS = 25;
/** A1-3：连续工具失败熔断阈值（默认 5）。与 maxSteps 独立：任一工具成功即重置计数。 */
const DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURES = 5;

/**
 * 从会话日志重建模型请求消息列表（provider/types.ts 中映射规则的唯一实现）：
 *   user/message → user 消息；assistant/message → assistant 消息；
 *   紧随 assistant 的 tool/call → 该消息的 toolCalls；tool/result → tool 消息。
 * 压缩（阶段 7）：取**最新**一条活动 compaction/applied（旧摘要被新摘要覆盖），
 * 把 seq <= coveredUpToSeq 的活动消息替换为一条摘要 user 消息；保留区首条消息若为
 * user 则摘要并入其中（role 交替不变量）；覆盖区边界消息的工具流量（摘要区与保留区
 * 之间的 tool/call 与 tool/result）一并跳过——它们属于被摘要的边界消息，保留会成为
 * 孤儿 tool 消息。依赖 computeProjection 的 rewind 语义：被回退遮蔽的事件不进入上下文。
 */
export function buildChatMessages(session: LoadedSession): ChatMessage[] {
  computeProjection(session); // 标记每个事件的活动性（rewind 感知）
  // 最新一条活动压缩事件生效（旧 compaction/applied 被新的覆盖）
  let compaction: CompactionAppliedPayload | undefined;
  for (const { event, active } of session.events) {
    if (active && event.type === 'compaction/applied') compaction = event.payload;
  }
  // 保留区起点：覆盖区之后首条活动 user/assistant 消息的 seq（其前的工具流量一并跳过）
  let keptStart: number | null = null;
  if (compaction !== undefined) {
    for (const { event, active } of session.events) {
      if (
        active &&
        event.seq > compaction.coveredUpToSeq &&
        (event.type === 'user/message' || event.type === 'assistant/message')
      ) {
        keptStart = event.seq;
        break;
      }
    }
  }
  const messages: ChatMessage[] = [];
  for (const { event: e, active } of session.events) {
    if (!active) continue;
    if (compaction !== undefined) {
      if (e.seq <= compaction.coveredUpToSeq) continue; // 覆盖区：由摘要消息替代
      // 覆盖区与保留区之间的工具事件属于被摘要的边界消息，不进上下文
      if (keptStart !== null && e.seq < keptStart && (e.type === 'tool/call' || e.type === 'tool/result')) {
        continue;
      }
    }
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
        break; // 结构性事件（header/step/attempt/rewind/compaction/memory）不直接进消息投影
    }
  }
  if (compaction !== undefined) {
    const summaryText = `${COMPACTION_SUMMARY_PREFIX}\n${compaction.summary}`;
    const first = messages[0];
    if (first === undefined) {
      // 防御：保留区为空（如尾部被 rewind 遮蔽）——摘要消息本身成为唯一上下文
      messages.push({ role: 'user', content: summaryText });
    } else if (first.role === 'user') {
      // 保留区首条是 user：摘要与其合并为一条（role 交替不变量，禁止连续两条 user）
      messages[0] = { role: 'user', content: `${summaryText}\n\n${first.content}` };
    } else {
      messages.unshift({ role: 'user', content: summaryText });
    }
  }
  return messages;
}

/**
 * 记忆快照解析（冻结语义，阶段 6）：
 *   1. 活动投影已有 memory/snapshot 事件 → 直接复用其 content（后续轮不重读文件，
 *      也不追加新事件——prefix cache 友好）；
 *   2. 没有 → 读 store 两个文件组装快照（都为空 → undefined，不注入不落事件），
 *      先落 memory/snapshot 事件再返回 content（Model-visible ⟺ logged：system
 *      必须可从日志重建）。
 * 漂移（手工编辑破坏 § 结构）按空记忆处理——读侧内容不注入，写侧由 store 拒绝并备份。
 */
async function resolveMemorySystem(
  writer: SessionWriter | SessionAppender,
  store: MemoryStore,
): Promise<string | undefined> {
  const session = loadSession(writer.dir);
  computeProjection(session);
  for (const { event, active } of session.events) {
    if (active && event.type === 'memory/snapshot') return event.payload.content;
  }
  const views = await Promise.all([store.read('memory'), store.read('user')]);
  const snapshot = assembleMemorySnapshot(
    views[0].drift ? '' : views[0].content,
    views[1].drift ? '' : views[1].content,
  );
  if (snapshot === null) return undefined;
  writer.append('memory/snapshot', { content: snapshot });
  return snapshot;
}

/**
 * 运行一个用户 turn：循环执行 step（模型调用 + 工具执行）直到模型不再调用工具、
 * 达到 maxSteps、被取消或模型出错。session 可传目录或调用方已持有的 SessionWriter：
 *   - 目录 + 日志不存在 → 新建会话（sessionId 自动生成）并在结束后 close；
 *   - 目录 + 日志已存在 → open 续写并在结束后 close；
 *   - writer → 直接使用（由调用方负责 close）。
 */
export async function runTurn(
  session: string | SessionWriter | SessionAppender,
  options: TurnOptions,
): Promise<TurnResult> {
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

/**
 * 压缩触发检查（turn 开始，user/message 落盘后、首个 step 前）：
 *   估算（buildChatMessages 输出，已应用既有压缩替换）> contextWindow × 0.75 →
 *   覆盖区折叠 → 摘要 provider 生成摘要 → append compaction/applied。
 * 任何失败（估算/摘要/落盘）都不中断 turn：返回 warning 或 undefined，绝不抛出。
 */
async function runCompactionIfNeeded(
  writer: SessionAppender,
  options: TurnOptions,
  signal: AbortSignal,
): Promise<string | undefined> {
  const compaction = options.compaction;
  if (compaction === undefined) return undefined;
  try {
    const session = loadSession(writer.dir);
    const tokens = estimateContextTokens(buildChatMessages(session));
    const contextWindow = compaction.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    if (tokens <= contextWindow * COMPACTION_TRIGGER_RATIO) return undefined;
    const coveredUpToSeq = computeCoveredUpToSeq(session);
    if (coveredUpToSeq === null) return undefined; // 尾部保护：无安全可折叠区域，跳过
    const digest = buildCompactionDigest(session, coveredUpToSeq);
    if (digest.length === 0) return undefined;
    const summary = await requestCompactionSummary(compaction.summarizer ?? options.provider, digest, {
      ...(compaction.maxSummaryChars !== undefined ? { maxChars: compaction.maxSummaryChars } : {}),
      ...(options.signal !== undefined ? { signal } : {}),
    });
    writer.append('compaction/applied', { summary, coveredUpToSeq });
    return undefined;
  } catch (e) {
    return `上下文压缩失败已跳过（下轮重试）: ${(e as Error)?.message ?? String(e)}`;
  }
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

async function runTurnWithWriter(writer: SessionWriter | SessionAppender, options: TurnOptions): Promise<TurnResult> {
  const turnId = randomUUID();
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const maxConsecutiveToolFailures = options.maxConsecutiveToolFailures ?? DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURES;
  const executor = new ToolExecutor(options.tools, options.approval);
  const provider = options.provider;
  const signal = options.signal;
  const envSignal = signal ?? new AbortController().signal; // runWave 需要一个 signal
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);

  // —— S6 控制输入（steer）——只在安全 step 边界消费；不进日志投影 ——
  // 会话级 sink（hub 持有，跨 turn 持续）做接收/去重/排队：同 id 全局只生效一次。
  // 本 turn 的 seenSteerIds 是本地兜底（任意 sink 实现都成立：重复 id 单次、不双注入）；
  // 边界未消费的 steer 留在 sink 队列里（must-complete 排队 / turn 结束 drain 兜底回帧）。
  const steers = options.steer;
  // must-complete = 无法保证取消（cancelGuaranteed!==true）的工具名单：上一步执行了它时不强制另开 step
  const mustCompleteTools = new Set<string>();
  for (const td of options.tools.list()) {
    if (td.cancelGuaranteed !== true) mustCompleteTools.add(td.name);
  }
  const seenSteerIds = new Set<string>();
  // 已在上一步边界消费、待叠加到下一步请求的控制文本（不落盘，单步有效）
  let pendingControls: string[] = [];
  /** 判定一条 steer：stale（turn 不符）→ 保 draft；重复 id → 拒；否则接受（返回待叠加文本） */
  const resolveOne = (s: SteerRequest): string | undefined => {
    if (s.expectedTurnId !== turnId) {
      steers?.resolve({ id: s.id, expectedTurnId: s.expectedTurnId, state: 'stale', draftKept: true });
      return undefined;
    }
    if (seenSteerIds.has(s.id)) {
      steers?.resolve({ id: s.id, expectedTurnId: s.expectedTurnId, state: 'rejected' });
      return undefined;
    }
    seenSteerIds.add(s.id);
    steers?.resolve({ id: s.id, expectedTurnId: s.expectedTurnId, state: 'accepted' });
    return s.text;
  };
  /** 边界消费：把本边界可应用的 steer 全部取走并判定（id 去重），接受的叠加进待应用控制文本 */
  const drainBoundary = (): void => {
    if (steers === undefined) return;
    let s: SteerRequest | undefined;
    while ((s = steers.take()) !== undefined) {
      const text = resolveOne(s);
      if (text !== undefined) pendingControls.push(text);
    }
  };

  // —— 记忆注入（阶段 6）：先于 user/message（快照冻结在「首个 user turn 前」）——
  const memorySystem =
    options.memory !== undefined && options.userText !== undefined
      ? await resolveMemorySystem(writer, options.memory)
      : undefined;

  // —— Skills 注入（阶段 10）：turn 开始扫描两级目录（列表每 turn 重读磁盘，本轮内冻结）；
  // 仅名称+描述进 system，全文走 skill 工具按需加载；坏文件/覆盖/超限告警如实上报 ——
  let skillsSystem: string | undefined;
  let skillsWarning: string | undefined;
  if (options.skills !== undefined) {
    const scan = options.skills.scan();
    skillsSystem = assembleSkillsSystemBlock(scan.skills) ?? undefined;
    if (scan.warnings.length > 0) skillsWarning = scan.warnings.join('；');
  }

  if (options.userText !== undefined) {
    writer.append('user/message', { text: options.userText, turnId });
  }

  // —— 上下文压缩（阶段 7）：turn 开始检查触发（估算含本条用户消息）——
  // 摘要失败 → 不落事件 + 本轮跳过（下轮重试），turn 不中断；warning 如实告知。
  let compactionWarning: string | undefined;
  if (options.compaction !== undefined) {
    compactionWarning = await runCompactionIfNeeded(writer, options, envSignal);
  }

  let steps = 0;
  let toolCallsTotal = 0;
  let finalText: string | undefined;
  let stopReason: TurnStopReason = 'end_turn';
  let error: string | undefined;
  // A1-3：连续工具失败计数（成功即归零）；触发阈值时以 tool_failures 收尾并给非空 finalText
  let consecutiveToolFailures = 0;
  let lastToolFailure: { tool: string; error: string } | undefined;
  const recordToolResult = (tool: string, ok: boolean, failure?: string): void => {
    if (ok) {
      consecutiveToolFailures = 0;
      lastToolFailure = undefined;
      return;
    }
    consecutiveToolFailures += 1;
    lastToolFailure = { tool, error: failure ?? 'unknown error' };
  };
  // S4b：重试预算为整 turn 共享（per-turn 额外 ≤6 + 累计等待 ≤120s），跨 step 累计
  const retryBudget = createRetryBudget();
  /** FixC D1：turn 结束时随结果暴露预算快照（桌面读 used/remaining/stopReason） */
  const retryBudgetView = (): RetryBudgetState | undefined => {
    // 预算一次都没用 → 不输出（不臆造「已停」）；否则给出终态快照
    return retryBudget.usedAttempts === 0 && retryBudget.stopReason() === 'none'
      ? undefined
      : retryBudget.budgetState();
  };
  const earlyWarnings = [compactionWarning, skillsWarning].filter((w): w is string => w !== undefined);
  let warning: string | undefined = earlyWarnings.length > 0 ? earlyWarnings.join('；') : undefined;
  // S6：上一步是否执行过 must-complete（无法保证取消）工具——是则本边界不强制另开 step（steer 排队）
  let lastStepMustComplete = false;

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
    // system：memory 快照（阶段 6，冻结事件）在前，Skills 列表（阶段 10，仅追加内容段）在后
    const systemText =
      memorySystem !== undefined && skillsSystem !== undefined
        ? `${memorySystem}\n\n${skillsSystem}`
        : (memorySystem ?? skillsSystem);
    const messages = buildChatMessages(loadSession(writer.dir));
    // S6：上一步边界消费的 steer 作为**控制输入**叠加（追加一条 user 控制消息），
    // 不写入 session.log（不进投影、不伪造 user/message 正文）；单步有效，next 重置。
    for (const ctrl of pendingControls) messages.push({ role: 'user', content: ctrl });
    pendingControls = [];
    const toolSpecs = options.tools
      .list()
      .map((def): ToolSpec => ({ name: def.name, description: def.description, parameters: def.parameters }));
    const request: ChatRequest = {
      ...(systemText !== undefined ? { system: systemText } : {}),
      messages,
      ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
    };

    let text = '';
    let reasoning: string | undefined;
    let usage: ProviderUsage | undefined;
    let providerStop: ProviderStopReason | undefined; // done 块透传的流终止原因（P2-4）
    const calls: ToolCallRequest[] = [];
    // 取消分类公共出口：半截尝试以 assistant/attempt 记录（append-only），绝不冒充 assistant/message
    // text 为半截产出（可展开渲染），但从不作为完整 assistant/message 落盘
    const finishCancelled = (msg: string, partialText?: string): TurnResult => {
      writer.append('assistant/attempt', {
        error: `cancelled: ${msg}`,
        ...(partialText !== undefined && partialText.length > 0 ? { text: partialText } : {}),
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
        turnId,
      };
    };
    // —— S4b 有界 attempt 重试（仅约束在本模型 step 内、完整工具计划未提交前）——
    // 不变量：重试新 attempt 复用本 step 开头的日志投影 request（同一已落盘投影），
    // 不内存旁路重建；新 attempt 从零文本开始，绝不续拼旧半句。
    // 已完成工具结果在日志权威，网络失败只重试「未完成的模型 attempt」，不重跑工具。
    let stepError: string | undefined; // 非取消终止：写入 error 通道并结束本 step/turn
    let chainAttempt = 0; // 当前失败链退避档位序号（2/10/30；第 4 次起 30 封顶）
    let modelOk = false;
    while (!modelOk) {
      try {
        for await (const chunk of provider.streamChat(request, { signal })) {
          if (chunk.type === 'text-delta') {
            text += chunk.text;
            options.onStream?.({ type: 'text-delta', text: chunk.text, turnId });
          } else if (chunk.type === 'reasoning-delta') {
            reasoning = (reasoning ?? '') + chunk.text; // reasoning 汇总进 assistant/message.reasoning（日志展示），不回传模型
            options.onStream?.({ type: 'reasoning-delta', text: chunk.text, turnId }); // 观察缝（阶段 5 服务层增量推送用；REPL 不渲染）
          } else if (chunk.type === 'tool-call') {
            calls.push(chunk.call);
            options.onStream?.({ type: 'tool-call', call: chunk.call, turnId });
          } else if (chunk.type === 'usage') usage = chunk.usage;
          else if (chunk.type === 'done') providerStop = chunk.stopReason;
        }
        modelOk = true;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (signal?.aborted === true) return finishCancelled(msg, text);
        // 失败的尝试以追加事件记录（append-only），text 保留为「不完整」可展开
        writer.append('assistant/attempt', {
          error: msg,
          ...(text.length > 0 ? { text } : {}),
          model: provider.name,
          turnId,
        });
        const classification = classifyAttemptError(e);
        // 不可恢复（401/403/参数/quota/取消/拒绝/内容过滤）或预算耗尽 → 不重试，直接停止并告知
        if (!classification.retryable) {
          stepError = msg;
          break;
        }
        if (!retryBudget.canRetry()) {
          stepError = `${msg}（重试预算已耗尽：per-turn 额外 ${RETRY_MAX_EXTRA_PER_TURN} 次 / 累计 ${RETRY_MAX_TOTAL_WAIT_SECONDS}s，停止自动重试）`;
          break;
        }
        // 退避：Retry-After 优先（尊重剩余预算），否则按链档位 + 抖动
        const eff: EffectiveDelay =
          classification.retryAfterSeconds !== undefined
            ? effectiveDelay(classification.retryAfterSeconds, retryBudget)
            : effectiveDelay(backoffSeconds(chainAttempt, Math.random), retryBudget);
        if (eff.stop) {
          // FixC D1：Retry-After 超剩余预算 → 显式标记停因（桌面可读），不静默
          retryBudget.markStop('retry-after');
          stepError = eff.reason;
          break;
        }
        retryBudget.record(eff.delayMs);
        chainAttempt += 1;
        try {
          await waitWithAbort(eff.delayMs, signal);
        } catch (abortE) {
          if (abortE instanceof RetryAbortError) return finishCancelled(abortE.message);
          throw abortE;
        }
        // 新 attempt 从零文本开始（不续拼旧半句）
        text = '';
        reasoning = undefined;
        usage = undefined;
        providerStop = undefined;
        calls.length = 0;
      }
    }
    if (stepError !== undefined) {
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
        error: stepError,
        turnId,
        ...(retryBudgetView() !== undefined ? { retryBudget: retryBudgetView() } : {}),
      };
    }

    // provider 契约允许 abort 时正常结束迭代而非抛错：这里补检信号再分类（P2-1），
    // 半截文本不得落 assistant/message 被记成 end_turn。
    if (signal?.aborted) return finishCancelled(abortReasonMessage(signal), text);

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
              {
                signal: envSignal,
                cwd: options.cwd,
                ...snapshotHooks,
                // S1：执行生命周期观察透传（真正开始才 onExecuteStart，终态一次 onExecuteEnd）
                ...(options.executionObserver !== undefined ? { observer: options.executionObserver } : {}),
              },
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
        options.onStream?.({ type: 'tool-result', callId: p.callId, ok: false, error: p.parseError, turnId });
        recordToolResult(p.tool, false, p.parseError);
        continue;
      }
      const r = byCallId.get(p.callId);
      if (!r) {
        writer.append('tool/result', {
          callId: p.callId,
          tool: p.tool,
          ok: false,
          error: 'executor lost result',
          turnId,
        });
        options.onStream?.({ type: 'tool-result', callId: p.callId, ok: false, error: 'executor lost result', turnId });
        recordToolResult(p.tool, false, 'executor lost result');
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
      options.onStream?.({
        type: 'tool-result',
        callId: r.callId,
        ok: r.ok,
        turnId,
        ...(r.error !== undefined ? { error: r.error } : {}),
      });
      recordToolResult(p.tool, r.ok, r.error);
    }
    toolCallsTotal += calls.length;

    // A1-3 熔断：连续失败达阈值 → 停止并给面向用户的非空回复（禁止空回复）。
    // 文本同时落 assistant/message 与 onStream，保证 desktop（事件投影）与 CLI（流式）
    // 两个客户端都看得到；stopReason 如实为 tool_failures。
    if (
      maxConsecutiveToolFailures > 0 &&
      consecutiveToolFailures >= maxConsecutiveToolFailures &&
      signal?.aborted !== true // 取消优先：用户中断不应被熔断文案冒充
    ) {
      const failure = lastToolFailure ?? { tool: 'unknown', error: 'unknown error' };
      const circuitText =
        `连续 ${consecutiveToolFailures} 次工具调用失败，已自动停止以避免继续空转（阈值 ${maxConsecutiveToolFailures}）。` +
        `最近一次失败：${failure.tool} — ${failure.error}。` +
        `请检查工具参数或运行环境（shell/网络/依赖）后重试；也可以直接告诉我换一种做法。`;
      writer.append('assistant/message', { text: circuitText, model: provider.name, turnId });
      options.onStream?.({ type: 'text-delta', text: circuitText, turnId });
      finalText = circuitText;
      stopReason = 'tool_failures';
      writer.append('step/end', { stepId, turnId, durationMs: Math.round(performance.now() - stepStartedAt) });
      break;
    }

    writer.append('step/end', { stepId, turnId, durationMs: Math.round(performance.now() - stepStartedAt) });
    // S6 安全 step 边界：本 step 完整往返完成（模型流 + 工具波浪均已落地）后才消费 steer。
    // 上一步执行过 must-complete（无法保证取消）工具 → 不强制另开 step：steer **留在会话级
    // sink 队列中排队**（真实可达的排队语义；会话级 sink 跨 turn 持续，本 turn 干净边界再取），
    // 不丢弃；否则 drain 本边界可应用的 steer（id 去重）叠加到下一 step 请求（控制输入，不进投影）。
    lastStepMustComplete = calls.some((c) => mustCompleteTools.has(c.name));
    if (!lastStepMustComplete) {
      drainBoundary();
    }
    // 继续下一 step：工具结果已落盘，下一请求由日志投影重建（含 tool role 消息）
  }

  // S6 turn 结束（end_turn/error/cancelled/max_steps 等）：把尚未在边界应用的剩余 steer
  // 逐一明确回帧（不静默丢）：stale → 保 draft；其余（干净边界未及到达）→ rejected（窗口已关闭）。
  if (steers !== undefined) {
    let s: SteerRequest | undefined;
    while ((s = steers.take()) !== undefined) {
      if (s.expectedTurnId !== turnId) {
        steers.resolve({ id: s.id, expectedTurnId: s.expectedTurnId, state: 'stale', draftKept: true });
      } else if (seenSteerIds.has(s.id)) {
        steers.resolve({ id: s.id, expectedTurnId: s.expectedTurnId, state: 'rejected' });
      } else {
        seenSteerIds.add(s.id);
        steers.resolve({ id: s.id, expectedTurnId: s.expectedTurnId, state: 'rejected' });
      }
    }
  }

  return {
    stopReason,
    steps,
    toolCalls: toolCallsTotal,
    durationMs: elapsed(),
    turnId,
    ...(finalText !== undefined ? { finalText } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(warning !== undefined ? { warning } : {}),
    ...(retryBudgetView() !== undefined ? { retryBudget: retryBudgetView() } : {}),
  };
}
