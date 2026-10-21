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
} from './core-bridge.js';
import type { IZCodeAgentService } from '@zcode/services';
import type { MockScript } from '@harness2/core';
import { encodeTopicWireFrames, measureTopicNotificationEnvelopeBytes } from '@zcode/shared/zcode-protocol-v4';
import { trackCreatedTask } from './project-service.js';

export interface AgentServiceOptions {
  dataRoot?: string;
  home?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  emitter?: Emitter<any>;
}

function makeControl(phase: string) {
  const running = phase === 'running';
  const sessionEnded = phase === 'completedSuccess' || phase === 'completedInterrupted' || phase === 'error';
  return {
    phase,
    sessionEnded,
    canStop: running,
    stopState: running ? 'stoppable' : 'idle',
    stopTargetKind: running ? 'assistant' : 'unknown',
    activeWorks: running ? [{ kind: 'primaryTurn', startedAt: Date.now() }] : [],
    lastError: null,
    apiRetry: null,
  };
}

function makeAvailability() {
  const a = { allowed: true };
  return {
    fork: a,
    compact: a,
    switchModelConfig: a,
    setFollowupMode: a,
    queueEdit: a,
    sendQueuedNow: a,
    pauseGoal: a,
    resumeGoal: a,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
function buildSnapshot(sessionId: string, seq: number, rows: any[], phase: string) {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: 'zs2-epoch',
    seq,
    revision: 1,
    control: makeControl(phase),
    availability: makeAvailability(),
    inputRouting: { mode: 'startNow' },
    meta: { title: '', titleSource: 'default' },
    config: { provider: '', model: '', thought: '', followupMode: 'queue', thoughtLevels: [] },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows.length ? rows[0].rowId : null },
  };
}

export function createAgentService(opts: AgentServiceOptions = {}): IZCodeAgentService {
  const home = opts.home ?? resolveHarness2Home();
  const sessionsRoot = defaultSessionsRoot(home);
  const manager = createSessionManager(sessionsRoot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const emitter = opts.emitter ?? new Emitter<any>();

  // provider
  const defaultMock: MockScript = [{ text: 'Hello from harness2 mock provider.' }];
  const __diagPath =
    process.env.ZS2_DIAG_PATH || require('node:path').join(require('node:os').tmpdir(), 'zs2-diag.log');
  const __diagEnabled = process.env.ZS2_DIAG === '1';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const __diag = (m: any) => {
    if (!__diagEnabled) return;
    try {
      require('node:fs').appendFileSync(__diagPath, '[agent] ' + m);
    } catch (e) {}
  };
  __diag('cwd=' + process.cwd() + ' home=' + home + ' HARNESS2_HOME=' + process.env.HARNESS2_HOME);
  let provider: unknown;
  try {
    const loaded = loadConfig({ root: process.cwd(), home });
    __diag('loadConfig ok=' + !!loaded.config);
    if (loaded.config) {
      provider = createProvider(loaded.config, 'main', {
        authPath: require('node:path').join(home, '.harness2', 'auth.json'),
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

  const subs = new Map<string, { sessionId: string; seq: number; ordinal: number }>();
  const rowCounters = new Map<string, number>();
  const toolRowByCall = new Map<string, number>();

  // Per-session conversation state retained so that a later subscribe/resync
  // (the UI re-subscribes after promoting a draft session) can rebuild the
  // projection instead of starting from an empty snapshot. See task: UI not
  // rendering reply in draft prewarm flow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const sessionRows = new Map<string, any[]>();
  const sessionPhase = new Map<string, string>();
  const sessionSeq = new Map<string, number>();

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  function emitSnapshot(subId: string, rows: any[], phase: string) {
    const sub = subs.get(subId);
    if (!sub) return;
    const seq = sessionSeq.get(sub.sessionId) ?? sub.seq;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: Date.now(),
      payload: { kind: 'snapshot', snapshot: buildSnapshot(sub.sessionId, seq, rows, phase) },
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

  async function runSession(sessionId: string, text: string, dirHint?: string) {
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
    const userRowId = nextRowId(sessionId);
    const turnHeaderRowId = nextRowId(sessionId);
    const assistantRowId = nextRowId(sessionId);
    const turnId = `turn-${Date.now()}`;
    const now = Date.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    const rows: any[] = [
      { rowId: userRowId, turnId, kind: 'userInput', text, origin: 'realUser', createdAt: now, createdAtSeq: 0 },
      {
        rowId: turnHeaderRowId,
        turnId,
        kind: 'turnHeader',
        origin: 'userInput',
        state: 'running',
        startedAt: now,
        createdAt: now,
        createdAtSeq: 0,
      },
      {
        rowId: assistantRowId,
        turnId,
        kind: 'assistantText',
        text: '',
        state: 'streaming',
        createdAt: now,
        createdAtSeq: 0,
      },
    ];
    sessionRows.set(sessionId, rows);
    sessionPhase.set(sessionId, 'running');

    const initialDeltas = [
      { op: 'row.appended', row: rows[0] },
      { op: 'row.appended', row: rows[1] },
      { op: 'row.appended', row: rows[2] },
    ];
    for (const sid of targetSubs) emitDeltas(sid, initialDeltas);

    let accumulated = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    const tools = { list: () => [] } as any;
    const ac = new AbortController();
    try {
      await runTurn(resumed.writer, {
        provider: provider as never,
        tools: tools as never,
        cwd: resumed.dir,
        userText: text,
        signal: ac.signal,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
        onStream: (chunk: any) => {
          if (chunk.type === 'text-delta') {
            accumulated += chunk.text;
            for (const sid of targetSubs)
              emitDeltas(sid, [{ op: 'row.delta', rowId: assistantRowId, path: 'text', append: chunk.text }]);
          } else if (chunk.type === 'reasoning-delta') {
            // ignore for now
          } else if (chunk.type === 'tool-call') {
            const tr = nextRowId(sessionId);
            toolRowByCall.set(chunk.call.id, tr);
            const toolRow = {
              rowId: tr,
              turnId,
              kind: 'toolCall',
              toolCallId: chunk.call.id,
              toolName: chunk.call.name,
              status: 'running',
              inputText: chunk.call.arguments ?? '',
              createdAt: now,
              createdAtSeq: 0,
            };
            rows.push(toolRow);
            for (const sid of targetSubs) emitDeltas(sid, [{ op: 'row.appended', row: toolRow }]);
          } else if (chunk.type === 'tool-result') {
            const tr = toolRowByCall.get(chunk.callId);
            if (tr) {
              const idx = rows.findIndex((r) => r.rowId === tr);
              if (idx >= 0) rows[idx] = { ...rows[idx], status: chunk.ok ? 'success' : 'error' };
              for (const sid of targetSubs)
                emitDeltas(sid, [
                  {
                    op: 'row.upserted',
                    row: {
                      rowId: tr,
                      turnId,
                      kind: 'toolCall',
                      toolCallId: chunk.callId,
                      toolName: '',
                      status: chunk.ok ? 'success' : 'error',
                      inputText: '',
                      createdAt: now,
                      createdAtSeq: 0,
                    },
                  },
                ]);
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

    for (const sid of targetSubs) {
      emitDeltas(sid, [
        {
          op: 'row.upserted',
          row: {
            rowId: assistantRowId,
            turnId,
            kind: 'assistantText',
            text: accumulated || 'done',
            state: 'complete',
            createdAt: now,
            createdAtSeq: 0,
          },
        },
        { op: 'state.updated', patch: { control: makeControl('completedSuccess') } },
      ]);
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
            runSession(sid, firstInput.text, created.dir).catch((e) =>
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
          runSession(sid, text, dirHint).catch((e) =>
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
        status: 'accepted',
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
