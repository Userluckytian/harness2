// H-12 压缩分层：把「单层覆盖区摘要」升级为三层，且不改事实源。
//
//   第 1 层 turn：按 turn 折叠出确定性单行摘要（用户诉求 / 助手结论 / 工具计数）。
//   第 2 层 session：由 turn 层摘要再折叠出会话级摘要——这是写入
//                   `compaction/applied.summary` 的内容（沿用既有单层事件形状，
//                   因此 loop.buildChatMessages 的「取最新一条替换覆盖区」语义零改动）。
//   第 3 层 trajectory：**独立**的轨迹压缩器，与上下文压缩解耦（对标 hermes 的
//                   `trajectory_compressor.py` 独立模块），产出可归档的紧凑轨迹，
//                   不参与模型上下文替换。
//
// append-only 红线：本模块**绝不改写 session.v1.jsonl**。
//   - 第 1/2 层的产物落两侧：① 会话级摘要经既有 `compaction/applied` 事件追加（写入口
//     仍是 SessionWriter/SessionAppender，无新事件类型、无新写入路径）；
//     ② turn 层摘要明细追加到会话目录内的辅助文件 `compaction.layers.jsonl`
//     （与 rewind_points.jsonl 同级的派生物，读取按「换行即提交」容错）。
//   - 触发器（阈值）与既有单层对齐：本模块只做「决策 + 折叠」，占用比例仍由调用方用
//     唯一算法 `agent/contextUsage.getContextUsage` 求得后传入（禁止第二套估算）。
//
// 确定性：纯函数层（turn/session/trajectory 折叠与 planLayeredCompaction）不含时间与随机，
// 同日志同参数 → 同产物（测试钉死）。LLM 精炼为注入式（`refine`），未注入即用确定性摘要，
// core 内不存在模型调用硬编。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeProjection, type LoadedSession } from './reader.js';
import type { AnySessionEvent } from './types.js';
import type { SessionAppender } from './writer.js';

/** turn 层摘要明细的辅助文件名（会话目录内；派生物，不入导出白名单） */
export const COMPACTION_LAYERS_FILE = 'compaction.layers.jsonl';

/**
 * 阈值（与 agent/compaction 的单层口径对齐，由测试钉死相等）：
 *   ratio ≥ LAYER_TURN_TRIGGER_RATIO     → 启用 turn 层（0.5）
 *   ratio ≥ LAYER_SESSION_TRIGGER_RATIO  → 叠加 session 层（0.75 = COMPACTION_TRIGGER_RATIO）
 * 尾部保护条数同 COMPACTION_TAIL_KEEP；会话级摘要上限同 COMPACTION_MAX_SUMMARY_CHARS。
 */
export const LAYER_TURN_TRIGGER_RATIO = 0.5;
export const LAYER_SESSION_TRIGGER_RATIO = 0.75;
export const LAYER_TAIL_KEEP = 6;
export const LAYER_SESSION_SUMMARY_MAX_CHARS = 2000;

/** turn 层单条摘要上限（字符） */
export const LAYER_TURN_SUMMARY_MAX_CHARS = 400;
/** 轨迹层单条工具输出保留字符数（其余折叠为省略计数） */
export const LAYER_TRAJECTORY_TOOL_OUTPUT_MAX_CHARS = 200;
/** 轨迹层总文本上限（字符；从尾部保留，最旧端截断） */
export const LAYER_TRAJECTORY_MAX_CHARS = 8000;

/** turn 层摘要（确定性、单行、有界） */
export interface TurnSummary {
  /** turn 标识：事件 turnId 原值；缺失时按 user 消息边界推导 `turn-<seq>` */
  turnId: string;
  startSeq: number;
  endSeq: number;
  userText: string;
  assistantText: string;
  toolCalls: number;
  toolOk: number;
  toolFail: number;
  /** 单行确定性摘要（≤ LAYER_TURN_SUMMARY_MAX_CHARS） */
  digest: string;
}

/** 会话层摘要（由 turn 层折叠） */
export interface SessionDigest {
  text: string;
  turnCount: number;
  coveredUpToSeq: number;
}

/** 轨迹层记录（独立于上下文压缩） */
export interface TrajectoryRecord {
  seq: number;
  kind: 'user' | 'assistant' | 'tool' | 'step' | 'rewind' | 'memory' | 'compaction' | 'other';
  text: string;
}

export interface TrajectoryCompression {
  records: TrajectoryRecord[];
  text: string;
  /** 被省略的工具输出字符数（压缩收益的量化；测试与基准据此断言） */
  elidedChars: number;
  eventCount: number;
}

export interface LayeredCompactionOptions {
  /**
   * 当前上下文占用比例（0..1）——由调用方用唯一算法
   * `agent/contextUsage.getContextUsage` 求得后传入（本模块不自行估算）。
   */
  usageRatio?: number;
  /** 强制层（`/compact` 显式指定）；给定时跳过阈值判断，仍受「可折叠区域存在」约束 */
  layer?: 'turn' | 'session';
  /** 尾部保护条数（缺省 LAYER_TAIL_KEEP） */
  tailKeep?: number;
}

export interface LayeredCompactionPlan {
  /** 本次实际生效的最深一层 */
  layer: 'turn' | 'session';
  usageRatio: number;
  turns: TurnSummary[];
  session: SessionDigest;
  /** 写入 compaction/applied.summary 的文本（分层产物） */
  summary: string;
  /** 覆盖区上界（与单层同口径：尾部保护之前的最后一条消息 seq） */
  coveredUpToSeq: number;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 事件携带的 turnId（无该字段的事件返回 undefined） */
function turnIdOf(event: AnySessionEvent): string | undefined {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'assistant/attempt':
    case 'step/start':
    case 'step/end':
    case 'tool/call':
    case 'tool/result':
      return event.payload.turnId;
    default:
      return undefined;
  }
}

/** 归属 turn 的事件类型（结构性事件 header/memory/compaction/rewind 不进 turn 摘要） */
function isTurnScoped(type: AnySessionEvent['type']): boolean {
  switch (type) {
    case 'user/message':
    case 'assistant/message':
    case 'assistant/attempt':
    case 'step/start':
    case 'step/end':
    case 'tool/call':
    case 'tool/result':
      return true;
    default:
      return false;
  }
}

/**
 * turn 层折叠：按**活动**事件切 turn（优先事件 turnId；无 turnId 时按 user/message 边界
 * 切分——旧日志的口径），产出确定性单行摘要。结构性事件（header/memory/compaction/rewind）
 * 不归属任何 turn，跳过。不读模型、不写盘。
 */
export function buildTurnSummaries(session: LoadedSession, opts: { tailSeq?: number } = {}): TurnSummary[] {
  computeProjection(session);
  const tailSeq = opts.tailSeq ?? Number.POSITIVE_INFINITY;
  const turns: TurnSummary[] = [];
  let current: TurnSummary | null = null;
  let currentKey = '';
  const openTurn = (key: string, seq: number): TurnSummary => {
    const turn: TurnSummary = {
      turnId: key === 'implicit' ? `turn-${seq}` : key,
      startSeq: seq,
      endSeq: seq,
      userText: '',
      assistantText: '',
      toolCalls: 0,
      toolOk: 0,
      toolFail: 0,
      digest: '',
    };
    turns.push(turn);
    currentKey = key;
    return turn;
  };
  for (const { event, active } of session.events) {
    if (!active) continue;
    if (event.seq > tailSeq) break;
    if (!isTurnScoped(event.type)) continue;
    const turnId = turnIdOf(event);
    const key = turnId ?? 'implicit';
    if (event.type === 'user/message') {
      current = openTurn(key, event.seq);
      current.userText = clip(normalizeLine(event.payload.text), LAYER_TURN_SUMMARY_MAX_CHARS);
      continue;
    }
    if (current === null || (turnId !== undefined && currentKey !== turnId)) current = openTurn(key, event.seq);
    switch (event.type) {
      case 'assistant/message':
        current.assistantText = clip(normalizeLine(event.payload.text), LAYER_TURN_SUMMARY_MAX_CHARS);
        break;
      case 'tool/call':
        current.toolCalls += 1;
        break;
      case 'tool/result':
        if (event.payload.ok) current.toolOk += 1;
        else current.toolFail += 1;
        break;
      default:
        break; // step/attempt：不参与 turn 摘要正文
    }
    if (event.seq > current.endSeq) current.endSeq = event.seq;
  }
  for (const turn of turns) turn.digest = formatTurnDigest(turn);
  return turns;
}

/** turn 单行摘要格式（确定性；空段省略） */
export function formatTurnDigest(turn: TurnSummary): string {
  const parts: string[] = [`[${turn.turnId}] seq ${turn.startSeq}-${turn.endSeq}`];
  if (turn.userText.length > 0) parts.push(`USER: ${turn.userText}`);
  if (turn.assistantText.length > 0) parts.push(`ASSISTANT: ${turn.assistantText}`);
  if (turn.toolCalls > 0) parts.push(`tools: ${turn.toolCalls}（ok ${turn.toolOk} / fail ${turn.toolFail}）`);
  return clip(parts.join(' | '), LAYER_TURN_SUMMARY_MAX_CHARS);
}

/**
 * 会话层折叠：turn 摘要按时间顺序拼接，**尾部优先保留**（近端上下文最有价值），
 * 超出上限时从最旧端截断并记录省略的 turn 数。确定性、有界。
 */
export function buildSessionDigest(turns: readonly TurnSummary[], opts: { maxChars?: number } = {}): SessionDigest {
  const maxChars = opts.maxChars ?? LAYER_SESSION_SUMMARY_MAX_CHARS;
  if (turns.length === 0) {
    return { text: '', turnCount: 0, coveredUpToSeq: 0 };
  }
  const coveredUpToSeq = turns[turns.length - 1]!.endSeq;
  const header = `[分层压缩] ${turns.length} 个 turn（seq ${turns[0]!.startSeq}-${coveredUpToSeq}）`;
  const lines: string[] = [];
  let total = header.length;
  let omitted = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = turns[i]!.digest;
    if (total + line.length + 1 > maxChars) {
      omitted = i + 1;
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  lines.reverse();
  const body = [header, ...(omitted > 0 ? [`（更早 ${omitted} 个 turn 已省略）`] : []), ...lines].join('\n');
  return { text: clip(body, maxChars), turnCount: turns.length, coveredUpToSeq };
}

/**
 * 第 3 层：轨迹压缩器（独立于上下文压缩）。
 * 只处理**活动**事件；工具输出按 LAYER_TRAJECTORY_TOOL_OUTPUT_MAX_CHARS 折叠，
 * 总文本从尾部保留至 LAYER_TRAJECTORY_MAX_CHARS。确定性、无模型调用。
 */
export function compressTrajectory(
  session: LoadedSession,
  opts: { maxChars?: number; toolOutputMaxChars?: number } = {},
): TrajectoryCompression {
  computeProjection(session);
  const maxChars = opts.maxChars ?? LAYER_TRAJECTORY_MAX_CHARS;
  const toolMax = opts.toolOutputMaxChars ?? LAYER_TRAJECTORY_TOOL_OUTPUT_MAX_CHARS;
  const records: TrajectoryRecord[] = [];
  let elidedChars = 0;
  let eventCount = 0;
  for (const { event, active } of session.events) {
    if (!active) continue;
    eventCount += 1;
    switch (event.type) {
      case 'user/message':
        records.push({ seq: event.seq, kind: 'user', text: normalizeLine(event.payload.text) });
        break;
      case 'assistant/message':
        records.push({ seq: event.seq, kind: 'assistant', text: normalizeLine(event.payload.text) });
        break;
      case 'tool/call':
        records.push({
          seq: event.seq,
          kind: 'tool',
          text: `CALL ${event.payload.tool} ${safeJson(event.payload.args)}`,
        });
        break;
      case 'tool/result': {
        const raw = normalizeLine(event.payload.error ?? event.payload.output ?? '');
        const clipped = clip(raw, toolMax);
        if (raw.length > clipped.length) elidedChars += raw.length - clipped.length;
        records.push({
          seq: event.seq,
          kind: 'tool',
          text: `RESULT ${event.payload.tool ?? ''} ${event.payload.ok ? 'ok' : 'fail'} ${clipped}`.trim(),
        });
        break;
      }
      case 'step/start':
        records.push({ seq: event.seq, kind: 'step', text: `STEP ${event.payload.stepId}` });
        break;
      case 'step/end':
        records.push({
          seq: event.seq,
          kind: 'step',
          text: `END ${event.payload.stepId}${event.payload.durationMs !== undefined ? ` ${event.payload.durationMs}ms` : ''}`,
        });
        break;
      case 'rewind/marker':
        records.push({
          seq: event.seq,
          kind: 'rewind',
          text: `REWIND -> ${event.payload.rewindToSeq} ${event.payload.reason ?? ''}`.trim(),
        });
        break;
      case 'memory/snapshot':
        records.push({ seq: event.seq, kind: 'memory', text: `MEMORY ${event.payload.content.length} chars` });
        break;
      case 'compaction/applied':
        records.push({ seq: event.seq, kind: 'compaction', text: `COMPACT <= ${event.payload.coveredUpToSeq}` });
        break;
      default:
        records.push({ seq: event.seq, kind: 'other', text: event.type });
        break;
    }
  }
  // 尾部优先：从最新记录向前收集到上限（最旧端截断），再恢复时间顺序
  const kept: TrajectoryRecord[] = [];
  let total = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]!;
    const line = formatTrajectoryRecord(rec);
    const cost = kept.length === 0 ? line.length : line.length + 1; // +1 = 换行
    if (total + cost > maxChars) {
      if (kept.length === 0) {
        // 单条记录自身超上限：按尾部截断该条，保证 text 长度上界（近端信息优先）
        const prefix = `${rec.seq} ${rec.kind} `;
        const room = Math.max(0, maxChars - prefix.length - 1);
        kept.push({ ...rec, text: `…${line.slice(Math.max(0, line.length - room))}` });
      }
      break;
    }
    kept.push(rec);
    total += cost;
  }
  kept.reverse();
  return {
    records: kept,
    text: kept.map(formatTrajectoryRecord).join('\n'),
    elidedChars,
    eventCount,
  };
}

/** 轨迹记录的单行格式（records 与 text 同源，保证一致） */
function formatTrajectoryRecord(rec: TrajectoryRecord): string {
  return `${rec.seq} ${rec.kind} ${rec.text}`;
}

/** JSON 参数的单行化（失败时退化为类型名，绝不抛错） */
function safeJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return normalizeLine(JSON.stringify(value));
  } catch {
    return '[unserializable]';
  }
}

/**
 * 分层压缩决策（纯函数）：由占用比例（调用方唯一算法求得）与可折叠区域共同决定层。
 * 返回 null 的情形：未给 usageRatio 且未强制层 / 低于 turn 阈值 / 没有可折叠区域。
 */
export function planLayeredCompaction(
  session: LoadedSession,
  opts: LayeredCompactionOptions = {},
): LayeredCompactionPlan | null {
  computeProjection(session);
  const tailKeep = opts.tailKeep ?? LAYER_TAIL_KEEP;
  const messages = session.events.filter(
    ({ event, active }) => active && (event.type === 'user/message' || event.type === 'assistant/message'),
  );
  if (messages.length <= tailKeep) return null; // 无可安全折叠区域（尾部保护优先）
  const boundary = messages[messages.length - tailKeep - 1];
  const coveredUpToSeq = boundary?.event.seq ?? 0;
  if (coveredUpToSeq < 1) return null;
  const ratio = opts.usageRatio ?? 0;
  let layer: 'turn' | 'session';
  if (opts.layer !== undefined) {
    layer = opts.layer;
  } else if (ratio >= LAYER_SESSION_TRIGGER_RATIO) {
    layer = 'session';
  } else if (ratio >= LAYER_TURN_TRIGGER_RATIO) {
    layer = 'turn';
  } else {
    return null;
  }
  const turns = buildTurnSummaries(session, { tailSeq: coveredUpToSeq });
  const digest = buildSessionDigest(turns);
  const turnText = turns.map((t) => t.digest).join('\n');
  return {
    layer,
    usageRatio: ratio,
    turns,
    session: digest,
    summary: layer === 'session' ? digest.text : clip(turnText, LAYER_SESSION_SUMMARY_MAX_CHARS),
    coveredUpToSeq,
  };
}

// —— turn 层明细的辅助存储（append-only 辅助文件，绝不触碰 session.v1.jsonl） ——

export interface CompactionLayerRecord {
  v: 1;
  layer: 'turn' | 'session';
  ts: string;
  /** 该记录覆盖的消息 seq 上界 */
  coveredUpToSeq: number;
  /** 新增（尚未落过盘）的 turn 摘要数量；session 层为 0 */
  addedTurns: number;
  summary: string;
}

export class CompactionLayerStore {
  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, COMPACTION_LAYERS_FILE);
  }

  /** 已落盘记录（坏行/残行按「换行即提交」跳过——辅助文件尽力而为） */
  records(): CompactionLayerRecord[] {
    if (!existsSync(this.path)) return [];
    const out: CompactionLayerRecord[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Partial<CompactionLayerRecord>;
        if (
          parsed.v === 1 &&
          (parsed.layer === 'turn' || parsed.layer === 'session') &&
          typeof parsed.ts === 'string' &&
          typeof parsed.coveredUpToSeq === 'number' &&
          typeof parsed.addedTurns === 'number' &&
          typeof parsed.summary === 'string'
        ) {
          out.push(parsed as CompactionLayerRecord);
        }
      } catch {
        continue;
      }
    }
    return out;
  }

  /** 已记录的最大覆盖 seq（增量落盘用） */
  maxCoveredUpToSeq(layer?: CompactionLayerRecord['layer']): number {
    let max = 0;
    for (const rec of this.records()) {
      if (layer !== undefined && rec.layer !== layer) continue;
      if (rec.coveredUpToSeq > max) max = rec.coveredUpToSeq;
    }
    return max;
  }

  /** 追加一条层记录（唯一写入面；只写辅助文件） */
  append(record: Omit<CompactionLayerRecord, 'v' | 'ts'>): CompactionLayerRecord {
    const full: CompactionLayerRecord = { v: 1, ts: new Date().toISOString(), ...record };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(full)}\n`, { flag: 'a', encoding: 'utf8' });
    return full;
  }
}

// —— 落地：追加事件 + 落 turn 明细（注入式 LLM 精炼可选） ——

/** 注入式精炼函数（典型实现：包装 roles.small provider 的一次流式调用）；未注入即用确定性摘要 */
export type CompactionRefiner = (input: { summary: string; plan: LayeredCompactionPlan }) => Promise<string>;

export interface LayeredCompactionResult {
  layer: 'turn' | 'session';
  /** 追加到 session.v1.jsonl 的 compaction/applied.summary（最终生效文本） */
  summary: string;
  coveredUpToSeq: number;
  /** 本次落盘的 turn 明细条数 */
  turnRecords: number;
  /** 是否使用了注入的精炼结果 */
  refined: boolean;
  /** 精炼回退原因（注入方抛错/返回空时如实登记） */
  refineFallbackReason?: string;
}

/**
 * 执行分层压缩：plan →（可选精炼）→ append `compaction/applied` → 落 turn 明细。
 * 事件形状与既有单层完全一致（`{summary, coveredUpToSeq}`），故 loop.buildChatMessages
 * 无需改动即可消费分层的会话级摘要；事件写入仍走 SessionAppender（唯一写入口）。
 * 返回 null = 未达阈值/无可折叠区域（调用方如实输出「未执行压缩」）。
 */
export async function applyLayeredCompaction(
  appender: SessionAppender,
  session: LoadedSession,
  opts: LayeredCompactionOptions & { refine?: CompactionRefiner } = {},
): Promise<LayeredCompactionResult | null> {
  const plan = planLayeredCompaction(session, opts);
  if (plan === null) return null;
  let summary = plan.summary;
  let refined = false;
  let refineFallbackReason: string | undefined;
  if (opts.refine !== undefined) {
    try {
      const candidate = (await opts.refine({ summary: plan.summary, plan })).trim();
      if (candidate.length === 0) refineFallbackReason = '精炼返回空摘要';
      else {
        summary = clip(candidate, LAYER_SESSION_SUMMARY_MAX_CHARS);
        refined = true;
      }
    } catch (e) {
      refineFallbackReason = (e as Error | undefined)?.message ?? String(e);
    }
  }
  appender.append('compaction/applied', { summary, coveredUpToSeq: plan.coveredUpToSeq });
  const store = new CompactionLayerStore(appender.dir);
  const alreadyRecorded = store.maxCoveredUpToSeq('turn');
  const newTurns = plan.turns.filter((t) => t.endSeq > alreadyRecorded);
  for (const turn of newTurns) {
    store.append({ layer: 'turn', coveredUpToSeq: turn.endSeq, addedTurns: 1, summary: turn.digest });
  }
  store.append({
    layer: 'session',
    coveredUpToSeq: plan.coveredUpToSeq,
    addedTurns: newTurns.length,
    summary,
  });
  return {
    layer: plan.layer,
    summary,
    coveredUpToSeq: plan.coveredUpToSeq,
    turnRecords: newTurns.length,
    refined,
    ...(refineFallbackReason !== undefined ? { refineFallbackReason } : {}),
  };
}
