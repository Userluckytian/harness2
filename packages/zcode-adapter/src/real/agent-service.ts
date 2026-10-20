import { createStubService } from '../stub-factory.js';
import { Emitter, Event } from '@zcode/rpc';
import {
  createSessionManager,
  defaultSessionsRoot,
  loadConfig,
  createProvider,
  runTurn,
  resolveHarness2Home,
  ToolRegistry,
  MockProvider,
} from './core-bridge.js';
import type { IZCodeAgentService } from '@zcode/services';
import type { MockScript } from '@harness2/core';
import { encodeTopicWireFrames, measureTopicNotificationEnvelopeBytes } from '@zcode/shared/zcode-protocol-v4';

export interface AgentServiceOptions {
  dataRoot?: string;
  home?: string;
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
    activeWorks: running ? [{ kind: 'primaryTurn', startedAt: new Date().toISOString() }] : [],
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
    usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
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
  const emitter = opts.emitter ?? new Emitter<any>();

  // provider
  const defaultMock: MockScript = [{ text: 'Hello from harness2 mock provider.' }];
  let provider: unknown;
  try {
    const loaded = loadConfig({ root: process.cwd(), home });
    if (loaded.config) {
      provider = createProvider(loaded.config, 'main', {
        authPath: (loaded as { paths?: { globalAuth: string } }).paths?.globalAuth ?? '',
      });
    } else {
      provider = new MockProvider(defaultMock);
    }
  } catch {
    provider = new MockProvider(defaultMock);
  }

  const subs = new Map<string, { sessionId: string; seq: number; ordinal: number }>();
  const rowCounters = new Map<string, number>();
  const toolRowByCall = new Map<string, number>();

  function nextRowId(sessionId: string): number {
    const c = (rowCounters.get(sessionId) ?? 0) + 1;
    rowCounters.set(sessionId, c);
    return c;
  }

  function emitWire(subId: string, frame: any) {
    const sub = subs.get(subId);
    if (!sub) return;
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind: 'online',
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      logicalFrameId: `lf-${sub.ordinal}`,
      logicalFrameOrdinal: sub.ordinal++,
      measurePhysicalFrameBytes: (w: any) => measureTopicNotificationEnvelopeBytes(w).maxBytes,
    });
    for (const w of wires) emitter.fire(w);
  }

  function emitSnapshot(subId: string, rows: any[], phase: string) {
    const sub = subs.get(subId);
    if (!sub) return;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq: 0,
      toSeq: sub.seq,
      sentAt: new Date().toISOString(),
      payload: { kind: 'snapshot', snapshot: buildSnapshot(sub.sessionId, sub.seq, rows, phase) },
    };
    emitWire(subId, frame);
  }

  function emitDeltas(subId: string, deltas: any[]) {
    const sub = subs.get(subId);
    if (!sub) return;
    sub.seq += 1;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq: sub.seq - 1,
      toSeq: sub.seq,
      sentAt: new Date().toISOString(),
      payload: { kind: 'deltas', deltas },
    };
    emitWire(subId, frame);
  }

  async function runSession(sessionId: string, text: string) {
    const targetSubs = [...subs.entries()].filter(([, s]) => s.sessionId === sessionId).map(([id]) => id);
    let resumed: any;
    try {
      resumed = manager.resume(sessionId);
    } catch {
      const created = manager.create(process.cwd());
      resumed = manager.resume(created.id);
      // if mismatch, use created id for subs? subs already sessionId; best effort
    }
    const counter = rowCounters;
    const userRowId = nextRowId(sessionId);
    const turnHeaderRowId = nextRowId(sessionId);
    const assistantRowId = nextRowId(sessionId);
    const turnId = `turn-${Date.now()}`;
    const now = new Date().toISOString();

    const initialDeltas = [
      { op: 'row.appended', row: { rowId: userRowId, turnId, kind: 'userInput', text, origin: 'realUser', createdAt: now, createdAtSeq: 0 } },
      { op: 'row.appended', row: { rowId: turnHeaderRowId, turnId, kind: 'turnHeader', origin: 'userInput', state: 'running', startedAt: now, createdAt: now, createdAtSeq: 0 } },
      { op: 'row.appended', row: { rowId: assistantRowId, turnId, kind: 'assistantText', text: '', state: 'streaming', createdAt: now, createdAtSeq: 0 } },
    ];
    for (const sid of targetSubs) emitDeltas(sid, initialDeltas);

    let accumulated = '';
    const tools = new ToolRegistry();
    const ac = new AbortController();
    try {
      await runTurn(resumed.writer, {
        provider: provider as never,
        tools: tools as never,
        cwd: resumed.dir,
        userText: text,
        signal: ac.signal,
        onStream: (chunk: any) => {
          if (chunk.type === 'text-delta') {
            accumulated += chunk.text;
            for (const sid of targetSubs) emitDeltas(sid, [{ op: 'row.delta', rowId: assistantRowId, path: 'text', append: chunk.text }]);
          } else if (chunk.type === 'reasoning-delta') {
            // ignore for now
          } else if (chunk.type === 'tool-call') {
            const tr = nextRowId(sessionId);
            toolRowByCall.set(chunk.call.id, tr);
            for (const sid of targetSubs) emitDeltas(sid, [{ op: 'row.appended', row: { rowId: tr, turnId, kind: 'toolCall', toolCallId: chunk.call.id, toolName: chunk.call.name, status: 'running', inputText: chunk.call.arguments ?? '', createdAt: now, createdAtSeq: 0 } }]);
          } else if (chunk.type === 'tool-result') {
            const tr = toolRowByCall.get(chunk.callId);
            if (tr) {
              for (const sid of targetSubs) emitDeltas(sid, [{ op: 'row.upserted', row: { rowId: tr, turnId, kind: 'toolCall', toolCallId: chunk.callId, toolName: '', status: chunk.ok ? 'success' : 'error', inputText: '', createdAt: now, createdAtSeq: 0 } }]);
            }
          }
        },
      });
    } catch (e) {
      // ignore
    }

    for (const sid of targetSubs) {
      emitDeltas(sid, [
        { op: 'row.upserted', row: { rowId: assistantRowId, turnId, kind: 'assistantText', text: accumulated || 'done', state: 'complete', createdAt: now, createdAtSeq: 0 } },
        { op: 'state.updated', patch: { control: makeControl('completedSuccess') } },
      ]);
    }
  }

  const impl: Record<string, unknown> = {
    async helloConversationV4(): Promise<unknown> {
      return {
        connectionId: 'zs2',
        clientMode: 'desktop-continuous',
        deliveryProfile: 'continuous',
        capabilities: {},
      };
    },
    async initializeConversationV4(): Promise<unknown> {
      return { ok: true };
    },
    async subscribeConversationV4(params: { sessionId?: string; base?: { seq: number } }): Promise<unknown> {
      const sessionId = params?.sessionId ?? 'default';
      const subscriptionId = `zs2-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      subs.set(subscriptionId, { sessionId, seq: params?.base?.seq ?? 0, ordinal: 1 });
      // emit initial snapshot
      setTimeout(() => {
        emitSnapshot(subscriptionId, [], 'running');
      }, 0);
      return {
        ack: { subscriptionId, mode: params?.base ? 'resume' : 'snapshot', logEpoch: 'zs2-epoch' },
      };
    },
    async resyncConversationV4(params: { subscriptionId?: string; base?: { seq: number } | null }): Promise<unknown> {
      const sid = params?.subscriptionId ?? '';
      const sub = subs.get(sid);
      if (sub && params?.base?.seq !== undefined) sub.seq = params.base.seq;
      return { ack: { subscriptionId: sid, mode: 'snapshot', logEpoch: 'zs2-epoch' } };
    },
    async unsubscribeConversationV4(params: { subscriptionId?: string }): Promise<void> {
      if (params?.subscriptionId) subs.delete(params.subscriptionId);
    },
    async sendConversationCommandV4(params: { envelope?: any }): Promise<unknown> {
      const env = params?.envelope ?? {};
      if (env.type === 'createSession') {
        const created = manager.create(process.cwd());
        const sid = created.id;
        const firstInput = env?.payload?.firstInput;
        if (firstInput?.text) {
          setTimeout(() => { runSession(sid, firstInput.text).catch(() => {}); }, 0);
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
        if (!sid) {
          const created = manager.create(process.cwd());
          sid = created.id;
        }
        const text = env?.payload?.text ?? '';
        setTimeout(() => { runSession(sid, text).catch(() => {}); }, 0);
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
      return { sessionId: created.id };
    },
    async resumeSession(params: { sessionId: string }): Promise<unknown> {
      const r = manager.resume(params.sessionId);
      return { sessionId: r.id };
    },
    async listSessions(): Promise<unknown[]> {
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
