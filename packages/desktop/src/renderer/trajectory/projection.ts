// 轨迹投影（D-41/D-42/D-44/D-47）：会话事件流 → 轮次/步骤/Between turns 记录表模型。
//
// 纯函数、无 React/DOM 依赖；**不做任何核心语义重实现**：轮次/步骤/工具结果的判定完全
// 来自 core 已落盘的事件（`user/message`、`assistant/message`、`assistant/attempt`、
// `tool/call`、`tool/result`、`step/start`、`step/end`、`compaction/applied`）。
//
// 诚实性口径（D-47 + 任务书「数据不足时留空，不猜」）：
//   * 所有「未知」写 null，不写 0、不做估算；
//   * 进行中的轮次 `endedAtMs = null` → 耗时列留空，绝不把「现在 - 开始」当耗时；
//   * 助手行 TTFT/解码段**只在有真实首 token 观测**（`firstOutputAtMs`）时给出，
//     否则 ttftMs/decodeMs 留 null（UI 只画总段并标注「TTFT 未观测」）。
import { parseSubagentChildId, type ActiveEvent, type TurnEndInfo } from '@harness2/ui-shared/renderer/chat-model.js';
import {
  BETWEEN_TURNS_LABEL,
  UNASSIGNED_TURN_ID,
  type TrajectoryAttachment,
  type TrajectoryBetweenTurnEntry,
  type TrajectoryModel,
  type TrajectoryRow,
  type TrajectoryStep,
  type TrajectoryStepRole,
  type TrajectoryStepState,
  type TrajectoryTiming,
  type TrajectoryTurn,
  type TrajectoryUsage,
} from './types.js';

export interface TrajectoryProjectionInput {
  readonly events: readonly ActiveEvent[];
  /** turn-end 帧带来的轮次终态（纯重放时为 undefined —— 不发明 stopReason） */
  readonly turnEnds?: Readonly<Record<string, TurnEndInfo>>;
  /** 会话是否正在跑（store 的 `stream.running`）；true 时最后一轮标 running 且不虚构耗时 */
  readonly running?: boolean;
  /**
   * 首 token 观测（键 = `step/start` 的 stepId → epoch ms）。
   * 装配层从 WS 首 delta 观测注入；**缺失 = 未观测 → TTFT/解码段留空**（不猜）。
   */
  readonly firstOutputAtMs?: Readonly<Record<string, number>>;
  /** 会话 id（模型携带，便于呈现层断言来源） */
  readonly sessionId?: string;
}

/** 内部可变步骤（构建期可回填工具结果；出口再收敛为只读 readonly 模型） */
interface MutableStep {
  key: string;
  role: TrajectoryStepRole;
  depth: number;
  seq: number;
  turnId?: string;
  label: string;
  state: TrajectoryStepState;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  decodeMs: number | null;
  text?: string;
  reasoning?: string;
  model?: string;
  usage?: TrajectoryUsage;
  callId?: string;
  tool?: string;
  args?: unknown;
  output?: string;
  error?: string;
  childSessionId?: string;
  modelStepId?: string;
  attachments: TrajectoryAttachment[];
}

interface MutableTurn {
  id: string;
  startSeq: number;
  endSeq: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  steps: MutableStep[];
}

function payloadOf(event: ActiveEvent): Record<string, unknown> {
  return event.payload;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** ISO8601 → epoch ms；非法/缺失 → null（不拿 0 冒充 1970） */
export function isoToMs(ts: string | undefined): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** 两端都已知才给耗时（且不得为负 —— 负值视为数据异常，留空而不是显示负数） */
function elapsedMs(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null;
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

function readUsage(value: unknown): TrajectoryUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = num(raw['inputTokens']);
  const outputTokens = num(raw['outputTokens']);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/**
 * 附件摘要：只认 payload 里**真实存在**的 `attachments` / `references`（形状由 core/协议决定，
 * 缺失 = 空数组 → UI 显示「无」）。字符串项按文件名计入；对象项按 mimeType 判图片。
 */
export function extractAttachments(payload: Record<string, unknown>): TrajectoryAttachment[] {
  const out: TrajectoryAttachment[] = [];
  const rawAttachments = payload['attachments'];
  if (Array.isArray(rawAttachments)) {
    for (const item of rawAttachments) {
      if (typeof item === 'string') {
        out.push({ kind: 'file', name: item });
        continue;
      }
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const mimeType = str(record['mimeType']) ?? str(record['mime_type']);
      const name = str(record['name']);
      const id = str(record['id']);
      const declared = str(record['kind']);
      const kind: TrajectoryAttachment['kind'] =
        declared === 'image' || (mimeType !== undefined && mimeType.startsWith('image/')) ? 'image' : 'file';
      out.push({
        kind,
        ...(name !== undefined ? { name } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(id !== undefined ? { id } : {}),
      });
    }
  }
  const rawReferences = payload['references'];
  if (Array.isArray(rawReferences)) {
    for (const item of rawReferences) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (str(record['kind']) !== 'file') continue; // 只把真实文件引用计入附件（url/clipboard 不是文件）
      const name = str(record['path']) ?? str(record['id']);
      out.push({ kind: 'file', ...(name !== undefined ? { name } : {}) });
    }
  }
  return out;
}

/** 嵌套子工具的父引用：只认 payload/args 里显式的 parentCallId（不发明层级） */
function parentCallIdOf(payload: Record<string, unknown>): string | undefined {
  const direct = str(payload['parentCallId']) ?? str(payload['parent_call_id']);
  if (direct !== undefined) return direct;
  const args = payload['args'];
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  return str(record['parentCallId']) ?? str(record['parent_call_id']);
}

function assistantStepState(error: string | undefined): TrajectoryStepState {
  if (error === undefined) return 'ok';
  return error.startsWith('cancelled') ? 'cancelled' : 'failed';
}

function timingOf(step: MutableStep): TrajectoryTiming {
  return {
    startedAtMs: step.startedAtMs,
    endedAtMs: step.endedAtMs,
    durationMs: step.durationMs,
    ttftMs: step.ttftMs,
    decodeMs: step.decodeMs,
  };
}

function toStep(step: MutableStep, stepMarker: number): TrajectoryStep {
  return {
    key: step.key,
    role: step.role,
    depth: step.depth,
    stepMarker,
    seq: step.seq,
    ...(step.turnId !== undefined ? { turnId: step.turnId } : {}),
    label: step.label,
    state: step.state,
    timing: timingOf(step),
    ...(step.text !== undefined ? { text: step.text } : {}),
    ...(step.reasoning !== undefined ? { reasoning: step.reasoning } : {}),
    ...(step.model !== undefined ? { model: step.model } : {}),
    ...(step.usage !== undefined ? { usage: step.usage } : {}),
    ...(step.callId !== undefined ? { callId: step.callId } : {}),
    ...(step.tool !== undefined ? { tool: step.tool } : {}),
    ...(step.args !== undefined ? { args: step.args } : {}),
    ...(step.output !== undefined ? { output: step.output } : {}),
    ...(step.error !== undefined ? { error: step.error } : {}),
    ...(step.childSessionId !== undefined ? { childSessionId: step.childSessionId } : {}),
    ...(step.modelStepId !== undefined ? { modelStepId: step.modelStepId } : {}),
    attachments: step.attachments,
  };
}

/** 会话事件流 → 轨迹模型（纯函数；可单测） */
export function projectTrajectory(input: TrajectoryProjectionInput): TrajectoryModel {
  const events = input.events;
  const turnEnds = input.turnEnds ?? {};
  const firstOutputAtMs = input.firstOutputAtMs ?? {};
  const running = input.running === true;

  const turnOrder: string[] = [];
  const turnMap = new Map<string, MutableTurn>();
  const betweenTurns: TrajectoryBetweenTurnEntry[] = [];
  /** callId → 工具步骤（tool/result 回填用） */
  const callSteps = new Map<string, MutableStep>();
  /** stepId → 结束耗时（step/end 的真实 durationMs） */
  const stepDurations = new Map<string, number>();
  /** stepId → 起始 epoch ms（step/start 的 ts） */
  const stepStarts = new Map<string, number>();

  let currentTurnId: string | undefined;
  let currentModelStepId: string | undefined;

  const ensureTurn = (turnId: string, seq: number, tsMs: number | null): MutableTurn => {
    let turn = turnMap.get(turnId);
    if (turn === undefined) {
      turn = { id: turnId, startSeq: seq, endSeq: seq, startedAtMs: tsMs, endedAtMs: tsMs, steps: [] };
      turnMap.set(turnId, turn);
      turnOrder.push(turnId);
    } else {
      if (seq < turn.startSeq) turn.startSeq = seq;
      if (seq > turn.endSeq) turn.endSeq = seq;
      if (turn.startedAtMs === null) turn.startedAtMs = tsMs;
      if (tsMs !== null && (turn.endedAtMs === null || tsMs > turn.endedAtMs)) turn.endedAtMs = tsMs;
    }
    return turn;
  };

  for (const event of events) {
    if (!event.active) continue; // 影子事件（undo 后）不进投影
    if (event.type === 'session/header' || event.type === 'memory/snapshot' || event.type === 'rewind/marker') {
      continue; // 非步骤事件：不进记录表（rewind 由 Chat 视图呈现）
    }
    const payload = payloadOf(event);
    const tsMs = isoToMs(event.ts);

    // D-47：独立压缩请求归入 Between turns 区段（compaction 事件本身不带 turnId）
    if (event.type === 'compaction/applied') {
      betweenTurns.push({
        key: `between:${event.seq}`,
        seq: event.seq,
        summary: str(payload['summary']) ?? '',
        coveredUpToSeq: num(payload['coveredUpToSeq']) ?? 0,
        timing: {
          startedAtMs: tsMs,
          endedAtMs: tsMs,
          durationMs: 0,
          ttftMs: null,
          decodeMs: null,
        },
      });
      continue;
    }

    const declaredTurnId = str(payload['turnId']);
    const turnId = declaredTurnId ?? currentTurnId ?? UNASSIGNED_TURN_ID;
    if (turnId !== currentTurnId) currentModelStepId = undefined;
    currentTurnId = turnId;
    const turn = ensureTurn(turnId, event.seq, tsMs);

    switch (event.type) {
      case 'step/start': {
        const stepId = str(payload['stepId']);
        if (stepId !== undefined) {
          currentModelStepId = stepId;
          if (tsMs !== null) stepStarts.set(stepId, tsMs);
        }
        break;
      }
      case 'step/end': {
        const stepId = str(payload['stepId']);
        const durationMs = num(payload['durationMs']);
        if (stepId !== undefined && durationMs !== undefined) stepDurations.set(stepId, durationMs);
        break;
      }
      case 'user/message': {
        turn.steps.push({
          key: `turn:${turnId}:user:${event.seq}`,
          role: 'user',
          depth: 0,
          seq: event.seq,
          turnId,
          label: 'User',
          state: 'ok',
          startedAtMs: tsMs,
          // 用户消息是时间点而非区间：结束时间/耗时不存在（null，不是 0）
          endedAtMs: null,
          durationMs: null,
          ttftMs: null,
          decodeMs: null,
          text: str(payload['text']) ?? '',
          attachments: extractAttachments(payload),
        });
        break;
      }
      case 'assistant/message': {
        const stepId = currentModelStepId;
        const modelStepId = stepId;
        const stepStart = stepId !== undefined ? (stepStarts.get(stepId) ?? null) : null;
        const endedAtMs = tsMs;
        const total = stepId !== undefined ? stepDurations.get(stepId) : undefined;
        const durationMs = stepId !== undefined && total !== undefined ? total : elapsedMs(stepStart, endedAtMs);
        const firstOutput = stepId !== undefined ? (firstOutputAtMs[stepId] ?? null) : null;
        const ttftMs = firstOutput !== null ? elapsedMs(stepStart, firstOutput) : null;
        // 解码段只在「首 token 观测 + 结束时刻」都有时给出（负值/缺失 → null，不猜）
        const decodeMs = firstOutput !== null ? elapsedMs(firstOutput, endedAtMs) : null;
        turn.steps.push({
          key: `turn:${turnId}:assistant:${event.seq}`,
          role: 'assistant',
          depth: 0,
          seq: event.seq,
          turnId,
          label: str(payload['model']) ?? 'Assistant',
          state: 'ok',
          // 已知边界（如实登记）：`step/start` 的 ts 非法时上游 `stepStarts` 拿不到起点，
          // 这里退化为 `startedAtMs = endedAtMs`（起点落在结束点）——此时耗时按 null 处理（时间列留空），
          // 不虚构区间。真要修需要 core 在日志侧保证 step/start 必有合法 ts。
          startedAtMs: stepStart ?? endedAtMs,
          endedAtMs,
          durationMs,
          ttftMs,
          decodeMs,
          text: str(payload['text']) ?? '',
          ...(str(payload['reasoning']) !== undefined ? { reasoning: str(payload['reasoning']) as string } : {}),
          ...(str(payload['model']) !== undefined ? { model: str(payload['model']) as string } : {}),
          ...(readUsage(payload['usage']) !== undefined ? { usage: readUsage(payload['usage']) } : {}),
          ...(modelStepId !== undefined ? { modelStepId } : {}),
          attachments: extractAttachments(payload),
        });
        break;
      }
      case 'assistant/attempt': {
        const stepId = currentModelStepId;
        const stepStart = stepId !== undefined ? (stepStarts.get(stepId) ?? null) : null;
        const error = str(payload['error']) ?? '';
        turn.steps.push({
          key: `turn:${turnId}:attempt:${event.seq}`,
          role: 'assistant',
          depth: 0,
          seq: event.seq,
          turnId,
          label: str(payload['model']) ?? 'Assistant (attempt)',
          state: assistantStepState(error),
          startedAtMs: stepStart ?? tsMs,
          endedAtMs: tsMs,
          durationMs: elapsedMs(stepStart ?? tsMs, tsMs),
          ttftMs: null,
          decodeMs: null,
          ...(str(payload['text']) !== undefined && (str(payload['text']) as string).length > 0
            ? { text: str(payload['text']) as string }
            : {}),
          error,
          ...(stepId !== undefined ? { modelStepId: stepId } : {}),
          attachments: [],
        });
        break;
      }
      case 'tool/call': {
        const callId = str(payload['callId']) ?? `call@${event.seq}`;
        const parentCallId = parentCallIdOf(payload);
        const parent = parentCallId !== undefined ? callSteps.get(parentCallId) : undefined;
        const depth = parent === undefined ? 0 : parent.depth + 1;
        const tool = str(payload['tool']) ?? '';
        const step: MutableStep = {
          key: `turn:${turnId}:tool:${event.seq}`,
          role: depth > 0 ? 'subtool' : 'tool',
          depth,
          seq: event.seq,
          turnId,
          label: tool,
          state: 'running', // 结果未到 = 进行中（不假报 ok）
          startedAtMs: tsMs,
          endedAtMs: null,
          durationMs: null,
          ttftMs: null,
          decodeMs: null,
          callId,
          tool,
          ...(payload['args'] !== undefined ? { args: payload['args'] } : {}),
          attachments: extractAttachments(payload),
        };
        callSteps.set(callId, step);
        turn.steps.push(step);
        break;
      }
      case 'tool/result': {
        const callId = str(payload['callId']) ?? '';
        const step = callSteps.get(callId);
        const ok = payload['ok'] === true;
        const output = str(payload['output']);
        const error = str(payload['error']);
        const durationMs = num(payload['durationMs']) ?? elapsedMs(step?.startedAtMs ?? null, tsMs);
        if (step !== undefined) {
          step.state = ok ? 'ok' : 'failed';
          step.endedAtMs = tsMs;
          step.durationMs = durationMs;
          if (output !== undefined) step.output = output;
          if (error !== undefined) step.error = error;
          const childSessionId = parseSubagentChildId(output);
          if (childSessionId !== undefined) step.childSessionId = childSessionId;
        } else {
          // 找不到宿主（异常日志）也不丢结果：单独成行（与 chat-model 同口径）
          const tool = str(payload['tool']) ?? '';
          const orphan: MutableStep = {
            key: `turn:${turnId}:tool-result:${event.seq}`,
            role: 'tool',
            depth: 0,
            seq: event.seq,
            turnId,
            label: tool,
            state: ok ? 'ok' : 'failed',
            startedAtMs: null,
            endedAtMs: tsMs,
            durationMs: durationMs,
            ttftMs: null,
            decodeMs: null,
            callId,
            ...(tool.length > 0 ? { tool } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(error !== undefined ? { error } : {}),
            attachments: extractAttachments(payload),
          };
          const childSessionId = parseSubagentChildId(output);
          if (childSessionId !== undefined) orphan.childSessionId = childSessionId;
          turn.steps.push(orphan);
        }
        break;
      }
      default:
        break; // 兜底：未知/非步骤事件不进记录表
    }
  }

  // —— 收敛为只读模型 ——
  const turns: TrajectoryTurn[] = turnOrder.map((id, turnIndex) => {
    const mutable = turnMap.get(id);
    if (mutable === undefined) throw new Error(`轨迹投影内部错误：轮次 ${id} 丢失`);
    const isLast = turnIndex === turnOrder.length - 1;
    const turnEnd = turnEnds[id];
    // D-47：会话在跑且本轮没有 turn-end 终态 → 进行中；结束时间/耗时一律 null
    const turnRunning = running && isLast && turnEnd === undefined;
    const endedAtMs = turnRunning ? null : mutable.endedAtMs;
    const steps = mutable.steps
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((step, index) => toStep(step, index + 1));
    const usage = sumUsage(steps);
    return {
      id,
      index: turnIndex + 1,
      label: id === UNASSIGNED_TURN_ID ? UNASSIGNED_TURN_ID : `Turn ${turnIndex + 1}`,
      startSeq: mutable.startSeq,
      endSeq: mutable.endSeq,
      timing: {
        startedAtMs: mutable.startedAtMs,
        endedAtMs,
        durationMs: elapsedMs(mutable.startedAtMs, endedAtMs),
        ttftMs: null,
        decodeMs: null,
      },
      running: turnRunning,
      steps,
      usage,
      ...(turnEnd !== undefined ? { turnEnd } : {}),
    };
  });

  const rows = buildRows(turns, betweenTurns);
  const hasRunningSteps = turns.some((turn) => turn.running || turn.steps.some((step) => step.state === 'running'));
  return {
    sessionId: input.sessionId ?? '',
    turns,
    betweenTurns,
    rows,
    hasRunningSteps,
  };
}

function sumUsage(steps: readonly TrajectoryStep[]): TrajectoryUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let hasInput = false;
  let hasOutput = false;
  for (const step of steps) {
    if (step.usage?.inputTokens !== undefined) {
      inputTokens += step.usage.inputTokens;
      hasInput = true;
    }
    if (step.usage?.outputTokens !== undefined) {
      outputTokens += step.usage.outputTokens;
      hasOutput = true;
    }
  }
  return {
    ...(hasInput ? { inputTokens } : {}),
    ...(hasOutput ? { outputTokens } : {}),
  };
}

/**
 * 扁平化行序列（虚拟化的输入）。轮次块 = 粗分割线 + 步骤行；
 * Between turns 区段按真实 seq 落在**轮次之间的空隙**（落在某轮内部的压缩请求放末尾，
 * 因为 payload 无 turnId、无法证明它属于该轮）。
 */
function buildRows(
  turns: readonly TrajectoryTurn[],
  betweenTurns: readonly TrajectoryBetweenTurnEntry[],
): TrajectoryRow[] {
  const rows: TrajectoryRow[] = [];
  for (const turn of turns) {
    rows.push({ kind: 'turn-boundary', key: `boundary:${turn.id}`, turnIndex: turn.index, turn });
    for (const step of turn.steps) {
      rows.push({ kind: 'step', key: step.key, turnIndex: turn.index, step });
    }
  }
  if (betweenTurns.length === 0) return rows;

  const insertAt = betweenTurnsRowIndex(turns, betweenTurns);
  const section: TrajectoryRow[] = [
    { kind: 'between-turns-boundary', key: 'boundary:between-turns' },
    ...betweenTurns.map((entry): TrajectoryRow => ({ kind: 'between-turns', key: entry.key, entry })),
  ];
  if (insertAt < 0) rows.push(...section);
  else rows.splice(insertAt, 0, ...section);
  return rows;
}

/** 区段应插入的行下标；-1 = 追加到末尾；-1 之外的负数为空 */
function betweenTurnsRowIndex(
  turns: readonly TrajectoryTurn[],
  betweenTurns: readonly TrajectoryBetweenTurnEntry[],
): number {
  let anchor = Number.POSITIVE_INFINITY;
  for (const entry of betweenTurns) anchor = Math.min(anchor, entry.seq);
  let rowIndex = 0;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn === undefined) break;
    if (anchor < turn.startSeq) {
      const prev = turns[i - 1];
      if (prev === undefined || anchor > prev.endSeq) return rowIndex;
      return -1; // 落在某轮内部 → 末尾（无法证明归属）
    }
    rowIndex += 1 + turn.steps.length;
  }
  return -1;
}

/** Between turns 区段标题（呈现层用同一常量，避免文案漂移） */
export const BETWEEN_TURNS_SECTION_TITLE = BETWEEN_TURNS_LABEL;

/** 行总数（虚拟化 ARIA 索引用；与 rows.length 同源） */
export function rowCount(model: TrajectoryModel): number {
  return model.rows.length;
}

/** 按区间过滤（D-43 拖选）：只保留与区间相交的**有时间**的步骤；无时间戳的行如实排除 */
export function filterModelBySelection(
  model: TrajectoryModel,
  selection: { readonly startMs: number; readonly endMs: number } | null,
): TrajectoryModel {
  if (selection === null) return model;
  const lo = Math.min(selection.startMs, selection.endMs);
  const hi = Math.max(selection.startMs, selection.endMs);
  const intersects = (timing: TrajectoryTiming): boolean => {
    const start = timing.startedAtMs;
    if (start === null) return false;
    const end = timing.endedAtMs ?? start;
    return end >= lo && start <= hi;
  };
  const turns: TrajectoryTurn[] = [];
  for (const turn of model.turns) {
    const steps = turn.steps.filter((step) => intersects(step.timing));
    if (steps.length === 0) continue;
    turns.push({ ...turn, steps });
  }
  const betweenTurns = model.betweenTurns.filter((entry) => intersects(entry.timing));
  const rows = buildRows(turns, betweenTurns);
  return {
    ...model,
    turns,
    betweenTurns,
    rows,
    hasRunningSteps: turns.some((turn) => turn.running || turn.steps.some((step) => step.state === 'running')),
  };
}
