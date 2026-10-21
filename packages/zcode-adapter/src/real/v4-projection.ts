/**
 * v4-projection —— core 事件 → v4 conversation rows/frames（ZS2-T2 / ZS3-T0）
 *
 * 唯一投影源：事件流投影（projectEvents）与实时流式行构造（make*Row）共用同一组
 * 行构造器，字段名直接使用协议名（status/inputText/output/error/attachments）。
 * 协议 schema 出处：refs/ZCode/packages/shared/src/zcode-protocol-v4/rows.ts。
 *
 * 未覆盖事件按映射详表 §3.5「可丢弃」清单如实处理（memory/snapshot、nudge、step/*）。
 */
import type { AnySessionEvent } from '@harness2/core';
import type { PendingInteraction } from '@zcode/shared/zcode-protocol-v4';

export type ProjectedRowKind = 'turnHeader' | 'userInput' | 'assistantText' | 'reasoning' | 'toolCall';

export type ToolCallStatus = 'inputStreaming' | 'pendingApproval' | 'running' | 'success' | 'error' | 'cancelled';
export type AssistantTextState = 'streaming' | 'complete' | 'interrupted' | 'failed';
export type ReasoningState = 'streaming' | 'complete' | 'interrupted';
export type TurnHeaderState = 'running' | 'completedSuccess' | 'completedInterrupted' | 'failed';
export type ControlPhase = 'running' | 'completedSuccess' | 'completedInterrupted' | 'error';

/** 行身份：rowId 在会话内单调唯一；turnId/createdAt 是协议必填字段。 */
export interface RowIdentity {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
}

export interface ProjectedRow extends RowIdentity {
  kind: ProjectedRowKind;
  text?: string;
  state?: string;
  origin?: string;
  startedAt?: number;
  toolName?: string;
  toolCallId?: string;
  status?: ToolCallStatus;
  inputText?: string;
  output?: { text: string };
  error?: { code: string; message: string };
  attachments?: unknown[];
}

export interface ProjectionState {
  controlPhase: ControlPhase;
  usage: { inputTokens: number; outputTokens: number };
  title: string;
  /** 本阶段恒为空；T2 起由审批投影填充。集中在此，避免散落硬编码。 */
  pendingInteractions: PendingInteraction[];
}

export interface ProjectionResult {
  rows: ProjectedRow[];
  state: ProjectionState;
  lastSeq: number;
}

// ── 行构造器（实时流与事件回放共用） ──

export function makeUserInputRow(id: RowIdentity, text: string, attachments?: unknown[]): ProjectedRow {
  return {
    ...id,
    kind: 'userInput',
    text,
    origin: 'realUser',
    ...(attachments && attachments.length ? { attachments } : {}),
  };
}

export function makeTurnHeaderRow(id: RowIdentity, state: TurnHeaderState = 'running'): ProjectedRow {
  return { ...id, kind: 'turnHeader', origin: 'userInput', state, startedAt: id.createdAt };
}

export function makeAssistantTextRow(id: RowIdentity, text: string, state: AssistantTextState): ProjectedRow {
  return { ...id, kind: 'assistantText', text, state };
}

export function makeReasoningRow(id: RowIdentity, text: string, state: ReasoningState): ProjectedRow {
  return { ...id, kind: 'reasoning', text, state };
}

export interface ToolCallRowInput {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  inputText: string;
  output?: { text: string };
  error?: { code: string; message: string };
}

export function makeToolCallRow(id: RowIdentity, input: ToolCallRowInput): ProjectedRow {
  return {
    ...id,
    kind: 'toolCall',
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    inputText: input.inputText,
    ...(input.output ? { output: input.output } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

// ── 快照状态（协议 A 区） ──

export function makeControl(phase: ControlPhase) {
  const running = phase === 'running';
  return {
    phase,
    sessionEnded: !running,
    canStop: running,
    stopState: running ? ('stoppable' as const) : ('idle' as const),
    stopTargetKind: running ? ('assistant' as const) : ('unknown' as const),
    activeWorks: running ? [{ kind: 'primaryTurn' as const, startedAt: Date.now() }] : [],
    lastError: null,
    apiRetry: null,
  };
}

export function makeAvailability() {
  const a = { allowed: true as const };
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

export interface SnapshotInput {
  sessionId: string;
  seq: number;
  rows: ProjectedRow[];
  phase: ControlPhase;
  pendingInteractions?: PendingInteraction[];
  logEpoch?: string;
}

export function buildSnapshot(input: SnapshotInput) {
  const { sessionId, seq, rows, phase } = input;
  return {
    protocolVersion: 1 as const,
    sessionId,
    logEpoch: input.logEpoch ?? 'zs2-epoch',
    seq,
    revision: 1,
    control: makeControl(phase),
    availability: makeAvailability(),
    inputRouting: { mode: 'startNow' as const },
    meta: { title: '', titleSource: 'default' as const },
    config: {
      provider: '',
      model: '',
      thought: '',
      thoughtLevels: [] as string[],
      followupMode: 'queue' as const,
      mode: 'build',
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [] as never[], autoDrain: true },
    pendingInteractions: input.pendingInteractions ?? [],
    pendingCommands: [] as never[],
    backgroundWorks: [] as never[],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows.length ? rows[0].rowId : null,
    },
  };
}

// ── 事件流投影 ──

function parseTs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === undefined) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function stopReasonToPhase(sr: string | undefined): ControlPhase {
  if (!sr) return 'running';
  if (sr === 'end_turn') return 'completedSuccess';
  if (sr === 'cancelled') return 'completedInterrupted';
  if (sr === 'error') return 'error';
  return 'completedSuccess';
}

/**
 * 将 core 事件流投影为行 + 状态。rowId = 事件 seq（单调）。
 */
export function projectEvents(events: AnySessionEvent[]): ProjectionResult {
  const rows: ProjectedRow[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const title = '';

  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // rowId 分配：每行唯一整数，事件 seq 为基，同事件多行用稳定偏移；全局单调。
  let rowCounter = 0;
  const allocRowId = (seq: number): number => {
    if (seq > rowCounter) rowCounter = seq - 1;
    rowCounter += 1;
    if (rowCounter < seq) rowCounter = seq;
    return rowCounter;
  };

  // 旧日志可能缺 turnId；用最近一条 user/message 的 turn 兜底，保证同一轮行可分组。
  let fallbackTurnId = '';

  for (const e of sorted) {
    const createdAt = parseTs(e.ts);
    switch (e.type) {
      case 'user/message': {
        const p = e.payload as { text: string; turnId?: string; attachments?: unknown[] };
        const turnId = p.turnId ?? `turn-${e.seq}`;
        fallbackTurnId = turnId;
        rows.push(
          makeUserInputRow({ rowId: allocRowId(e.seq), turnId, createdAt, createdAtSeq: e.seq }, p.text, p.attachments),
        );
        // turnHeader 合成：由 user/message 触发。
        rows.push(makeTurnHeaderRow({ rowId: allocRowId(e.seq), turnId, createdAt, createdAtSeq: e.seq }));
        break;
      }
      case 'assistant/message': {
        const p = e.payload as {
          text: string;
          model?: string;
          usage?: { inputTokens?: number; outputTokens?: number };
          reasoning?: string;
          turnId?: string;
        };
        const turnId = p.turnId ?? (fallbackTurnId || `turn-${e.seq}`);
        if (p.reasoning) {
          rows.push(
            makeReasoningRow(
              { rowId: allocRowId(e.seq), turnId, createdAt, createdAtSeq: e.seq },
              p.reasoning,
              'complete',
            ),
          );
        }
        rows.push(
          makeAssistantTextRow(
            { rowId: allocRowId(e.seq), turnId, createdAt, createdAtSeq: e.seq },
            p.text,
            'complete',
          ),
        );
        if (p.usage) {
          inputTokens += p.usage.inputTokens ?? 0;
          outputTokens += p.usage.outputTokens ?? 0;
        }
        break;
      }
      case 'assistant/attempt': {
        const p = e.payload as { error: string; text?: string; model?: string; turnId?: string };
        const turnId = p.turnId ?? (fallbackTurnId || `turn-${e.seq}`);
        rows.push(
          makeAssistantTextRow(
            { rowId: allocRowId(e.seq), turnId, createdAt, createdAtSeq: e.seq },
            p.text ?? '',
            'failed',
          ),
        );
        break;
      }
      case 'tool/call': {
        const p = e.payload as { callId: string; tool: string; args?: unknown; turnId?: string };
        const turnId = p.turnId ?? (fallbackTurnId || `turn-${e.seq}`);
        rows.push(
          makeToolCallRow(
            { rowId: allocRowId(e.seq), turnId, createdAt, createdAtSeq: e.seq },
            {
              toolCallId: p.callId,
              toolName: p.tool,
              status: 'running',
              inputText: stringifyArgs(p.args),
            },
          ),
        );
        break;
      }
      case 'tool/result': {
        const p = e.payload as { callId: string; ok: boolean; output?: string; error?: string; turnId?: string };
        // 整行替换语义：保留入参（inputText），只更新终态字段。
        const target = rows.find((r) => r.kind === 'toolCall' && r.toolCallId === p.callId);
        if (target) {
          target.status = p.ok ? 'success' : 'error';
          if (p.ok) target.output = { text: p.output ?? '' };
          else target.error = { code: 'toolError', message: p.error ?? '' };
        }
        break;
      }
      case 'session/header': {
        // no row; meta.title handled separately (titles not in event). Mark.
        break;
      }
      // 可丢弃：memory/snapshot, compaction/applied, rewind/marker, step/*, nudge
      default: {
        // 无对应 row——按 §3.5 可丢弃，不伪造
        break;
      }
    }
  }

  // control phase: need turn end stopReason. If no explicit, infer from last assistant.
  const lastPhase: ControlPhase = rows.some((r) => r.kind === 'assistantText' && r.state === 'failed')
    ? 'error'
    : rows.length > 0
      ? 'completedSuccess'
      : 'running';

  const lastSeq = sorted.length ? sorted[sorted.length - 1].seq : 0;

  return {
    rows,
    state: {
      controlPhase: lastPhase,
      usage: { inputTokens, outputTokens },
      title,
      pendingInteractions: [],
    },
    lastSeq,
  };
}

/**
 * 投影控制相位（由 onTurnEnd.stopReason 映射）。
 */
export function stopReasonToControlPhase(sr: string): ControlPhase {
  return stopReasonToPhase(sr);
}
