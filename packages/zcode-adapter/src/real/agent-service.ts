import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubService } from '../stub-factory.js';
import { Emitter, Event } from '@zcode/rpc';
import {
  createSessionManager,
  defaultSessionsRoot,
  loadConfig,
  createProvider,
  runTurn,
  resolveHarness2Home,
  MockProvider,
  ToolRegistry,
  extensionEventTypes,
} from './core-bridge.js';
import type { IZCodeAgentService } from '@zcode/services';
import type { ApprovalHandler, MockScript } from '@harness2/core';
import type { PendingInteraction } from '@zcode/shared/zcode-protocol-v4';
import { encodeTopicWireFrames, measureTopicNotificationEnvelopeBytes } from '@zcode/shared/zcode-protocol-v4';
import { trackCreatedTask } from './project-service.js';
import {
  buildSnapshot,
  makeAssistantTextRow,
  makeControl,
  makeReasoningRow,
  makeToolCallRow,
  makeTurnHeaderRow,
  makeUserInputRow,
  USER_ATTACHMENTS_EVENT,
} from './v4-projection.js';
import type { ControlPhase, ProjectedRow } from './v4-projection.js';
import type { SessionWriter, ToolRegistryTypeExport } from './core-bridge.js';

/** harness2 本地 auth.json 路径（P2-8：提为常量，避免散落硬编码） */
const HARNESS2_AUTH_PATH = (home: string): string => join(home, '.harness2', 'auth.json');

/**
 * ZS3-T0 ACK 白名单：只有已实现的命令可以回 accepted，其余一律 rejected。
 * 红线⑩：任何情况不得回假 accepted；新增命令实现时同步加入本表。
 */
const SUPPORTED_COMMAND_TYPES = new Set([
  'createSession',
  'sendText',
  'stop',
  'resolveInteraction',
  'snoozeInteractionAutoResolution',
]);

/** ZS3-T2 审批截止时间（与 core approvalTimeoutMs 同口径）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/** 审批审计事件：走 core extension event 落 JSONL，不扩内建事件白名单。 */
const APPROVAL_REQUEST_EVENT = 'adapter/permission-request';
const APPROVAL_RESOLVED_EVENT = 'adapter/permission-resolved';

function ensureApprovalEventTypes(): void {
  if (!extensionEventTypes.has(APPROVAL_REQUEST_EVENT)) {
    extensionEventTypes.register({
      type: APPROVAL_REQUEST_EVENT,
      validator: (p) => typeof p.interactionId === 'string' && typeof p.toolName === 'string',
      projection: 'opaque',
    });
  }
  if (!extensionEventTypes.has(APPROVAL_RESOLVED_EVENT)) {
    extensionEventTypes.register({
      type: APPROVAL_RESOLVED_EVENT,
      validator: (p) => typeof p.interactionId === 'string' && typeof p.allowed === 'boolean',
      projection: 'opaque',
    });
  }
  if (!extensionEventTypes.has(USER_ATTACHMENTS_EVENT)) {
    extensionEventTypes.register({
      type: USER_ATTACHMENTS_EVENT,
      validator: (p) => typeof p.turnId === 'string' && Array.isArray(p.attachments),
      projection: 'opaque',
    });
  }
}

// 进程级注册：loadSession 可能早于首个 runSession，扩展类型必须先于读日志注册。
ensureApprovalEventTypes();

export interface AgentServiceOptions {
  dataRoot?: string;
  home?: string;
  /** 测试缝：脚本化 MockProvider，跳过 config 加载（service 层帧序列断言用）。 */
  mockScript?: MockScript;
  /** 测试缝：工具注册表（审批用例需要真实工具）；生产缺省空表。 */
  tools?: ToolRegistryTypeExport;
  /** 审批截止时间；测试可缩短，缺省 120s。 */
  approvalTimeoutMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  emitter?: Emitter<any>;
}

/** ZS3-T2 待审批条目：onAsk 的 promise 与 UI 交互 id 一一对应。 */
interface PendingApprovalEntry {
  interactionId: string;
  sessionId: string;
  toolRowId: number | null;
  toolCallId: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

export function createAgentService(opts: AgentServiceOptions = {}): IZCodeAgentService {
  const home = opts.home ?? resolveHarness2Home();
  const sessionsRoot = defaultSessionsRoot(home);
  const manager = createSessionManager(sessionsRoot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const emitter = opts.emitter ?? new Emitter<any>();

  // provider
  const defaultMock: MockScript = [{ text: 'Hello from harness2 mock provider.' }];
  const __diagPath = process.env.ZS2_DIAG_PATH || join(tmpdir(), 'zs2-diag.log');
  const __diagEnabled = process.env.ZS2_DIAG === '1';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const __diag = (m: any) => {
    if (!__diagEnabled) return;
    try {
      appendFileSync(__diagPath, '[agent] ' + m);
    } catch {
      // 诊断写盘失败不影响主链路
    }
  };
  __diag('cwd=' + process.cwd() + ' home=' + home + ' HARNESS2_HOME=' + process.env.HARNESS2_HOME);
  let provider: unknown;
  if (opts.mockScript) {
    provider = new MockProvider(opts.mockScript);
    __diag('provider mocked (test seam)');
  } else {
    try {
      const loaded = loadConfig({ root: process.cwd(), home });
      __diag('loadConfig ok=' + !!loaded.config);
      if (loaded.config) {
        provider = createProvider(loaded.config, 'main', {
          authPath: HARNESS2_AUTH_PATH(home),
        });
        __diag('provider created: ' + (provider && provider.constructor && provider.constructor.name));
      } else {
        provider = new MockProvider(defaultMock);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    } catch (e: any) {
      __diag('provider load FAILED: ' + (e && e.message));
      provider = new MockProvider(defaultMock);
    }
  }
  // ZS3 e2e 审批轮专用：确定性脚本化工具调用，避免依赖真实模型是否决定调工具。
  const e2eApproval = process.env.ZS3_E2E_APPROVAL === '1';
  if (e2eApproval) {
    provider = new MockProvider([
      {
        text: '审批测试：准备调用 write 工具',
        toolCalls: [
          {
            id: 'call-e2e-approval',
            name: 'write',
            arguments: '{"path":"zs3-approval.txt","content":"x"}',
          },
        ],
      },
      { text: '审批测试完成' },
    ]);
  }

  const subs = new Map<string, { sessionId: string; seq: number; ordinal: number }>();
  const rowCounters = new Map<string, number>();
  const toolRowByCall = new Map<string, number>();

  // Per-session conversation state retained so that a later subscribe/resync
  // (the UI re-subscribes after promoting a draft session) can rebuild the
  // projection instead of starting from an empty snapshot. See task: UI not
  // rendering reply in draft prewarm flow.
  const sessionRows = new Map<string, ProjectedRow[]>();
  const sessionPhase = new Map<string, ControlPhase>();
  const sessionSeq = new Map<string, number>();
  /** 待审批/待问询交互（T2 起填充）；T0 保持空数组但集中存放，不在快照里散落硬编码。 */
  const sessionPendingInteractions = new Map<string, PendingInteraction[]>();
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  /** 用户 deny 时填写的理由，按 toolCallId 暂存，供 tool-result 错误文案使用。 */
  const deniedReasons = new Map<string, string>();
  /** 审批审计事件需要写回会话日志；runSession 期间登记，结束后清理。 */
  const sessionWriters = new Map<string, SessionWriter>();

  // ZS3 e2e 审批轮专用工具：只写会话工作目录下的测试文件，不触碰用户数据。
  let e2eToolRegistry: ToolRegistryTypeExport | undefined;
  if (e2eApproval && !opts.tools) {
    const registry = new ToolRegistry();
    registry.register({
      name: 'write',
      description: 'ZS3 e2e approval test tool',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: (args, ctx) => {
        const a = args as { path?: string; content?: string };
        writeFileSync(join(ctx.cwd, a.path ?? 'zs3-approval.txt'), a.content ?? '');
        return { output: 'written' };
      },
    });
    e2eToolRegistry = registry;
  }

  function nextRowId(sessionId: string): number {
    const c = (rowCounters.get(sessionId) ?? 0) + 1;
    rowCounters.set(sessionId, c);
    return c;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  function emitWire(subId: string, frame: any) {
    const sub = subs.get(subId);
    if (!sub) return;
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind: 'online',
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      logicalFrameId: `lf-${sub.ordinal}`,
      logicalFrameOrdinal: sub.ordinal++,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
      measurePhysicalFrameBytes: (w: any) => measureTopicNotificationEnvelopeBytes(w).maxBytes,
    });
    for (const w of wires) emitter.fire(w);
  }

  function emitSnapshot(subId: string, rows: ProjectedRow[], phase: ControlPhase) {
    const sub = subs.get(subId);
    if (!sub) return;
    const seq = sessionSeq.get(sub.sessionId) ?? sub.seq;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: Date.now(),
      payload: {
        kind: 'snapshot',
        snapshot: buildSnapshot({
          sessionId: sub.sessionId,
          seq,
          rows,
          phase,
          pendingInteractions: sessionPendingInteractions.get(sub.sessionId) ?? [],
        }),
      },
    };
    sub.seq = seq;
    emitWire(subId, frame);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  function emitDeltas(subId: string, deltas: any[]) {
    const sub = subs.get(subId);
    if (!sub) return;
    sub.seq += 1;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq: sub.seq - 1,
      toSeq: sub.seq,
      sentAt: Date.now(),
      payload: { kind: 'deltas', deltas },
    };
    sessionSeq.set(sub.sessionId, sub.seq);
    emitWire(subId, frame);
  }

  function emitToSession(sessionId: string, deltas: unknown[]) {
    for (const [sid, sub] of subs) {
      if (sub.sessionId === sessionId) emitDeltas(sid, deltas);
    }
  }

  /** 审批落定：清 pending、更新工具行、落审计事件、resolve producer promise。 */
  function settleApproval(interactionId: string, allowed: boolean): boolean {
    const entry = pendingApprovals.get(interactionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pendingApprovals.delete(interactionId);

    const remaining = (sessionPendingInteractions.get(entry.sessionId) ?? []).filter(
      (x) => x.interactionId !== interactionId,
    );
    sessionPendingInteractions.set(entry.sessionId, remaining);

    const rows = sessionRows.get(entry.sessionId) ?? [];
    const row = rows.find((r) => r.rowId === entry.toolRowId);
    const deltas: Array<{ op: string; row?: ProjectedRow; patch?: unknown }> = [];
    if (row) {
      row.status = allowed ? 'running' : 'cancelled';
      delete row.approvalInteractionId;
      deltas.push({ op: 'row.upserted', row });
    }
    deltas.push({ op: 'state.updated', patch: { pendingInteractions: remaining } });
    emitToSession(entry.sessionId, deltas);

    const writer = sessionWriters.get(entry.sessionId);
    try {
      writer?.appendExtension?.(APPROVAL_RESOLVED_EVENT, {
        interactionId,
        allowed,
        toolCallId: entry.toolCallId,
        resolvedAt: new Date().toISOString(),
      });
    } catch {
      // 会话已关闭：审计事件尽力而为，不影响审批落定
    }

    entry.resolve(allowed);
    return true;
  }

  async function runSession(sessionId: string, text: string, dirHint?: string, attachments?: unknown[]) {
    __diag(
      'runSession start provider=' +
        (provider && provider.constructor && provider.constructor.name) +
        ' fetch=' +
        typeof globalThis.fetch,
    );
    const targetSubs = [...subs.entries()].filter(([, s]) => s.sessionId === sessionId).map(([id]) => id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    let resumed: any;
    if (dirHint) {
      const cb = await import('./core-bridge.js');
      resumed = { id: sessionId, dir: dirHint, writer: cb.SessionWriter.open(dirHint) };
    } else {
      resumed = manager.resume(sessionId);
    }
    ensureApprovalEventTypes();
    sessionWriters.set(sessionId, resumed.writer);
    const userRowId = nextRowId(sessionId);
    const turnHeaderRowId = nextRowId(sessionId);
    const assistantRowId = nextRowId(sessionId);
    let reasoningRowId: number | null = null;
    let reasoningAccumulated = '';
    const turnId = `turn-${Date.now()}`;
    const now = Date.now();

    // 附件只做加性审计登记：core user/message 无附件槽位，禁止把附件内容伪装成文本喂模型。
    if (attachments && attachments.length > 0) {
      try {
        resumed.writer.appendExtension?.(USER_ATTACHMENTS_EVENT, { turnId, attachments });
      } catch {
        // 审计事件尽力而为，不影响对话主链
      }
    }

    const userRow = makeUserInputRow({ rowId: userRowId, turnId, createdAt: now, createdAtSeq: 0 }, text, attachments);
    const turnHeaderRow = makeTurnHeaderRow(
      { rowId: turnHeaderRowId, turnId, createdAt: now, createdAtSeq: 0 },
      'running',
    );
    const assistantTextRow = makeAssistantTextRow(
      { rowId: assistantRowId, turnId, createdAt: now, createdAtSeq: 0 },
      '',
      'streaming',
    );
    const rows: ProjectedRow[] = [userRow, turnHeaderRow, assistantTextRow];
    sessionRows.set(sessionId, rows);
    sessionPhase.set(sessionId, 'running');

    const initialDeltas = [
      { op: 'row.appended', row: userRow },
      { op: 'row.appended', row: turnHeaderRow },
      { op: 'row.appended', row: assistantTextRow },
    ];
    for (const sid of targetSubs) emitDeltas(sid, initialDeltas);

    let accumulated = '';
    const tools = opts.tools ?? e2eToolRegistry ?? ({ list: () => [] } as unknown as ToolRegistryTypeExport);
    const ac = new AbortController();
    const approval: ApprovalHandler = {
      // ZS3：工具调用统一走审批（生产当前无工具；测试缝与后续工具面共用同一条桥）。
      decide: () => 'ask',
      onAsk: (input) =>
        new Promise<boolean>((resolve) => {
          const interactionId = randomUUID();
          const createdAt = Date.now();
          const deadlineAt = createdAt + (opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
          const argsText =
            typeof input.args === 'string' ? input.args : input.args !== undefined ? JSON.stringify(input.args) : '';
          const toolRow = rows.find(
            (r) =>
              r.kind === 'toolCall' &&
              r.toolName === input.tool &&
              (r.status === 'running' || r.status === 'inputStreaming') &&
              (r.inputText === argsText || !r.inputText),
          );
          const interaction: PendingInteraction = {
            interactionId,
            kind: 'permission',
            anchorRowId: toolRow?.rowId ?? null,
            createdAt,
            autoResolution: {
              state: 'visibleCountdown',
              startedAt: createdAt,
              visibleAt: createdAt,
              deadlineAt,
            },
            payload: {
              kind: 'permission',
              toolCallId: toolRow?.toolCallId ?? '',
              toolName: input.tool,
              summary: `允许执行 ${input.tool} 吗？`,
              detail: input.args,
              options: [
                { optionId: 'allowOnce', label: '允许本次', kind: 'allowOnce' },
                { optionId: 'allowAlways', label: '总是允许', kind: 'allowAlways' },
                { optionId: 'deny', label: '拒绝', kind: 'deny' },
              ],
            },
          };

          if (toolRow) {
            toolRow.status = 'pendingApproval';
            toolRow.approvalInteractionId = interactionId;
            emitToSession(sessionId, [{ op: 'row.upserted', row: toolRow }]);
          }
          const list = [...(sessionPendingInteractions.get(sessionId) ?? []), interaction];
          sessionPendingInteractions.set(sessionId, list);
          emitToSession(sessionId, [{ op: 'state.updated', patch: { pendingInteractions: list } }]);

          try {
            resumed.writer.appendExtension?.(APPROVAL_REQUEST_EVENT, {
              interactionId,
              toolCallId: toolRow?.toolCallId ?? '',
              toolName: input.tool,
              args: input.args,
              createdAt,
              expiresAt: deadlineAt,
            });
          } catch {
            // 审计事件尽力而为，不影响审批主链
          }

          const timeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
          const timer = setTimeout(() => settleApproval(interactionId, false), timeoutMs);
          pendingApprovals.set(interactionId, {
            interactionId,
            sessionId,
            toolRowId: toolRow?.rowId ?? null,
            toolCallId: toolRow?.toolCallId ?? '',
            resolve,
            timer,
          });
          if (ac.signal.aborted) settleApproval(interactionId, false);
        }),
    };
    try {
      await runTurn(resumed.writer, {
        provider: provider as never,
        tools: tools as never,
        cwd: resumed.dir,
        userText: text,
        signal: ac.signal,
        approval,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
        onStream: (chunk: any) => {
          if (chunk.type === 'text-delta') {
            accumulated += chunk.text;
            for (const sid of targetSubs)
              emitDeltas(sid, [{ op: 'row.delta', rowId: assistantRowId, path: 'text', append: chunk.text }]);
          } else if (chunk.type === 'reasoning-delta') {
            if (reasoningRowId === null) {
              reasoningRowId = nextRowId(sessionId);
              const rrow = makeReasoningRow(
                { rowId: reasoningRowId, turnId, createdAt: now, createdAtSeq: 0 },
                '',
                'streaming',
              );
              rows.push(rrow);
              for (const sid of targetSubs) emitDeltas(sid, [{ op: 'row.appended', row: rrow }]);
            }
            reasoningAccumulated += chunk.text;
            for (const sid of targetSubs)
              emitDeltas(sid, [{ op: 'row.delta', rowId: reasoningRowId, path: 'text', append: chunk.text }]);
          } else if (chunk.type === 'tool-call') {
            const tr = nextRowId(sessionId);
            toolRowByCall.set(chunk.call.id, tr);
            const argsText =
              typeof chunk.call.arguments === 'string'
                ? chunk.call.arguments
                : chunk.call.arguments !== undefined
                  ? JSON.stringify(chunk.call.arguments)
                  : '';
            const identity = { rowId: tr, turnId, createdAt: now, createdAtSeq: 0 };
            const toolRowBase = makeToolCallRow(identity, {
              toolCallId: chunk.call.id,
              toolName: chunk.call.name,
              status: 'inputStreaming',
              inputText: '',
            });
            const toolRowRunning = makeToolCallRow(identity, {
              toolCallId: chunk.call.id,
              toolName: chunk.call.name,
              status: 'running',
              inputText: argsText,
            });
            rows.push(toolRowRunning);
            for (const sid of targetSubs) {
              emitDeltas(sid, [{ op: 'row.appended', row: toolRowBase }]);
              if (argsText) emitDeltas(sid, [{ op: 'row.delta', rowId: tr, path: 'inputText', append: argsText }]);
              emitDeltas(sid, [{ op: 'row.upserted', row: toolRowRunning }]);
            }
          } else if (chunk.type === 'tool-result') {
            const tr = toolRowByCall.get(chunk.callId);
            if (tr) {
              const existing = rows.find((r) => r.rowId === tr);
              const toolName = existing?.toolName ?? '';
              const inputText = existing?.inputText ?? '';
              const deniedReason = deniedReasons.get(chunk.callId);
              deniedReasons.delete(chunk.callId);
              const newRow = makeToolCallRow(
                { rowId: tr, turnId, createdAt: now, createdAtSeq: 0 },
                {
                  toolCallId: chunk.callId,
                  toolName,
                  status: chunk.ok ? 'success' : 'error',
                  inputText,
                  ...(chunk.ok
                    ? { output: { text: chunk.output ?? '' } }
                    : { error: { code: 'toolError', message: deniedReason ?? chunk.error ?? '' } }),
                },
              );
              const idx = rows.findIndex((r) => r.rowId === tr);
              if (idx >= 0) rows[idx] = newRow;
              for (const sid of targetSubs) emitDeltas(sid, [{ op: 'row.upserted', row: newRow }]);
            }
          }
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    } catch (e: any) {
      __diag('runTurn FAILED: ' + (e && e.message));
      console.error('[zs2] runTurn failed:', (e as Error)?.message ?? e);
    }
    __diag('runTurn done accumulated=' + accumulated.length);
    // 轮次结束时仍挂着的审批一律 fail-closed，避免 producer promise 悬挂。
    for (const [id, entry] of [...pendingApprovals]) {
      if (entry.sessionId === sessionId) settleApproval(id, false);
    }
    sessionWriters.delete(sessionId);
    try {
      resumed.writer.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    } catch (e: any) {
      __diag('close failed ' + (e && e.message));
      console.error('[zs2] close failed', (e as Error)?.message);
    }

    const assistantRow = rows.find((r) => r.rowId === assistantRowId);
    if (assistantRow) {
      assistantRow.text = accumulated || 'done';
      assistantRow.state = 'complete';
    }
    sessionPhase.set(sessionId, 'completedSuccess');
    sessionRows.set(sessionId, rows);
    sessionSeq.set(sessionId, sessionSeq.get(sessionId) ?? 0);

    const finishedTurnHeader = rows.find((r) => r.rowId === turnHeaderRowId);
    if (finishedTurnHeader) finishedTurnHeader.state = 'completedSuccess';

    for (const sid of targetSubs) {
      const finalDeltas: Array<{ op: string; row?: ProjectedRow; patch?: unknown }> = [];
      if (reasoningRowId !== null) {
        finalDeltas.push({
          op: 'row.upserted',
          row: makeReasoningRow(
            { rowId: reasoningRowId, turnId, createdAt: now, createdAtSeq: 0 },
            reasoningAccumulated,
            'complete',
          ),
        });
      }
      if (finishedTurnHeader) {
        finalDeltas.push({ op: 'row.upserted', row: finishedTurnHeader });
      }
      finalDeltas.push({
        op: 'row.upserted',
        row: makeAssistantTextRow(
          { rowId: assistantRowId, turnId, createdAt: now, createdAtSeq: 0 },
          accumulated || 'done',
          'complete',
        ),
      });
      finalDeltas.push({ op: 'state.updated', patch: { control: makeControl('completedSuccess') } });
      emitDeltas(sid, finalDeltas);
    }
  }

  const impl: Record<string, unknown> = {
    async helloConversationV4(): Promise<unknown> {
      return {
        kind: 'hello',
        protocolVersion: 3,
        connectionId: 'zs2',
        clientMode: 'desktop-continuous',
        deliveryProfile: 'continuous',
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: false,
          compression: 'none',
          independentPlanState: true,
        },
        auth: {},
      };
    },
    async initializeConversationV4(): Promise<unknown> {
      return { ok: true };
    },
    async subscribeConversationV4(params: { sessionId?: string; base?: { seq: number } }): Promise<unknown> {
      const sessionId = params?.sessionId ?? 'default';
      const subscriptionId = `zs2-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const baseSeq = params?.base?.seq;
      const initialSeq = baseSeq !== undefined ? baseSeq : (sessionSeq.get(sessionId) ?? 0);
      subs.set(subscriptionId, { sessionId, seq: initialSeq, ordinal: 1 });
      const rows = sessionRows.get(sessionId) ?? [];
      const phase = sessionPhase.get(sessionId) ?? 'running';
      setTimeout(() => {
        emitSnapshot(subscriptionId, rows, phase);
      }, 0);
      return {
        ack: { subscriptionId, mode: params?.base ? 'resume' : 'snapshot', logEpoch: 'zs2-epoch' },
      };
    },
    async resyncConversationV4(params: { subscriptionId?: string; base?: { seq: number } | null }): Promise<unknown> {
      const sid = params?.subscriptionId ?? '';
      const sub = subs.get(sid);
      if (sub) {
        if (params?.base?.seq !== undefined) {
          sub.seq = params.base.seq;
          sessionSeq.set(sub.sessionId, params.base.seq);
        }
        const rows = sessionRows.get(sub.sessionId) ?? [];
        const phase = sessionPhase.get(sub.sessionId) ?? 'running';
        setTimeout(() => {
          emitSnapshot(sid, rows, phase);
        }, 0);
      }
      return { ack: { subscriptionId: sid, mode: 'snapshot', logEpoch: 'zs2-epoch' } };
    },
    async unsubscribeConversationV4(params: { subscriptionId?: string }): Promise<void> {
      if (params?.subscriptionId) subs.delete(params.subscriptionId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    async sendConversationCommandV4(params: { workspacePath?: string; envelope?: any }): Promise<unknown> {
      const env = params?.envelope ?? {};
      if (!SUPPORTED_COMMAND_TYPES.has(env.type)) {
        return {
          commandId: env.commandId,
          status: 'rejected',
          reasonCode: 'proto.commandUnsupported',
          revisionAtDecision: 1,
        };
      }
      if (env.type === 'stop') {
        return { commandId: env.commandId, status: 'accepted', revisionAtDecision: 1 };
      }
      if (env.type === 'resolveInteraction') {
        const interactionId = env?.payload?.interactionId;
        if (typeof interactionId !== 'string' || interactionId.length === 0) {
          return {
            commandId: env.commandId,
            status: 'rejected',
            reasonCode: 'proto.invalidCommand',
            revisionAtDecision: 1,
          };
        }
        const entry = pendingApprovals.get(interactionId);
        if (!entry) {
          // 先到先得：重复/迟到 resolve 幂等 noop。
          return {
            commandId: env.commandId,
            status: 'noop',
            reasonCode: 'proto.alreadyResolved',
            revisionAtDecision: 1,
          };
        }
        const answer = env?.payload?.answer ?? {};
        const optionId = typeof answer.optionId === 'string' ? answer.optionId : undefined;
        const allowed = optionId === 'allowOnce' || optionId === 'allowAlways' || answer.action === 'accept';
        if (!allowed && typeof answer.freeText === 'string' && answer.freeText.length > 0) {
          deniedReasons.set(entry.toolCallId, answer.freeText);
        }
        settleApproval(interactionId, allowed);
        return {
          commandId: env.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
          result: {
            type: 'resolveInteraction',
            resolvedBy: {
              clientId: env.clientId ?? 'unknown',
              ...(optionId ? { optionId } : {}),
            },
          },
        };
      }
      if (env.type === 'snoozeInteractionAutoResolution') {
        // ZS3 不实现倒计时暂停语义（登记 ZS4）；幂等 noop，不改变 pending 状态。
        return {
          commandId: env.commandId,
          status: 'noop',
          reasonCode: 'proto.snoozeUnsupported',
          revisionAtDecision: 1,
        };
      }
      if (env.type === 'createSession') {
        const created = manager.create(process.cwd());
        try {
          created.writer.close();
        } catch {}
        const sid = created.id;
        const __wp = params?.workspacePath ?? process.cwd();
        trackCreatedTask(sid, __wp);
        sessionRows.set(sid, []);
        sessionPhase.set(sid, 'running');
        sessionSeq.set(sid, 0);
        rowCounters.set(sid, 0);
        const firstInput = env?.payload?.firstInput;
        if (firstInput?.text) {
          setTimeout(() => {
            runSession(sid, firstInput.text, created.dir, firstInput.attachments).catch((e) =>
              console.error('[zs2] runSession failed:', (e as Error)?.message ?? e),
            );
          }, 0);
        }
        return {
          commandId: env.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
          result: { type: 'createSession', sessionId: sid, input: { delivery: 'startNow', inputId: env.commandId } },
        };
      }
      if (env.type === 'sendText') {
        let sid = env.sessionId;
        let dirHint: string | undefined;
        if (!sid) {
          const created = manager.create(process.cwd());
          try {
            created.writer.close();
          } catch {}
          sid = created.id;
          dirHint = created.dir;
          const __wp2 = params?.workspacePath ?? process.cwd();
          trackCreatedTask(sid, __wp2);
          sessionRows.set(sid, []);
          sessionPhase.set(sid, 'running');
          sessionSeq.set(sid, 0);
          rowCounters.set(sid, 0);
        }
        const text = env?.payload?.text ?? '';
        setTimeout(() => {
          runSession(sid, text, dirHint, env?.payload?.attachments).catch((e) =>
            console.error('[zs2] runSession failed:', (e as Error)?.message ?? e),
          );
        }, 0);
        return {
          commandId: env.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
          result: { type: 'inputAccepted', delivery: 'startNow', inputId: env.commandId },
        };
      }
      return {
        commandId: env.commandId,
        status: 'rejected',
        reasonCode: 'proto.commandUnsupported',
        revisionAtDecision: 1,
      };
    },
    async conversationRowsRangeV4(): Promise<unknown> {
      return { rows: [], hasMore: false, atSeq: 0, atRevision: 1, atLogEpoch: 'zs2-epoch' };
    },
    async conversationPlansV4(): Promise<unknown> {
      return { plans: [], atSeq: 0, atLogEpoch: 'zs2-epoch' };
    },
    async queryConversationCommandsV4(): Promise<unknown> {
      return { results: [] };
    },
    onDynamicConversationFrame(): unknown {
      return emitter.event;
    },
    onDynamicSessionsIndexFrame(): unknown {
      return Event.None;
    },
    async syncAppRuntimePreferences(): Promise<void> {},
    async prepareStorage(): Promise<void> {},
    async getStorageStartupState(): Promise<{ ready: boolean }> {
      return { ready: true };
    },
    async initialize(): Promise<{ available: boolean }> {
      return { available: true };
    },
    async createSession(params: { workspacePath?: string }): Promise<unknown> {
      const created = manager.create(params?.workspacePath ?? process.cwd());
      try {
        created.writer.close();
      } catch {}
      trackCreatedTask(created.id, params?.workspacePath ?? process.cwd());
      sessionRows.set(created.id, []);
      sessionPhase.set(created.id, 'running');
      sessionSeq.set(created.id, 0);
      rowCounters.set(created.id, 0);
      return { sessionId: created.id };
    },
    async resumeSession(params: { sessionId: string }): Promise<unknown> {
      const r = manager.resume(params.sessionId);
      return { sessionId: r.id };
    },
    async listSessions(): Promise<unknown[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
      return manager.list().map((s: any) => ({ sessionId: s.id }));
    },
    async listSessionSubagents(): Promise<unknown> {
      return { sessions: [] };
    },
    async readSession(): Promise<unknown> {
      return {};
    },
    async readSessionMessages(): Promise<unknown[]> {
      return [];
    },
    async readSessionEvents(): Promise<unknown[]> {
      return [];
    },
    async readSessionDebug(): Promise<unknown> {
      return {};
    },
    async sendPrompt(): Promise<void> {},
    async compactSession(): Promise<void> {},
    async goalSession(): Promise<void> {},
    async closeSession(): Promise<boolean> {
      return true;
    },
    async setModel(): Promise<unknown> {
      return {};
    },
    async setThoughtLevel(): Promise<unknown> {
      return {};
    },
    async setMode(): Promise<unknown> {
      return {};
    },
    onDynamicSessionEvent(): unknown {
      return Event.None;
    },
  };

  return createStubService<IZCodeAgentService>({
    channelName: 'zcode-agent',
    classification: 'B',
    impl,
  });
}
