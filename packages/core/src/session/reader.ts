// 会话读取器与投影：从 append-only 日志重建会话。
// 投影语义（见 types.ts RewindMarkerPayload）：
//   rewind/marker 追溯遮蔽「已出现且 seq > rewindToSeq」的非标记事件；
//   标记之后新追加的事件属于新分支、默认活动。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_LOG_FILE, type AnySessionEvent, type SessionHeaderPayload, parseEventLine } from './types.js';
import { parseExtensionEventLine, type ExtensionSessionEvent, type LoadedExtensionEvent } from './extension-events.js';

export interface LoadedEvent {
  event: AnySessionEvent;
  /** 是否在当前活动投影内（影子事件为 false，仍保留可导出） */
  active: boolean;
}

export interface LoadedSession {
  dir: string;
  header: SessionHeaderPayload | null;
  /** 日志顺序的全部内建事件（含影子事件）；扩展事件走 extensionEvents 通道，不进本列表 */
  events: LoadedEvent[];
  /**
   * 日志顺序的全部扩展事件（D02 事件类型开放化；含影子事件）。
   * opaque 通道：不进 messages、不进模型上下文、不参与任何内建事件语义；
   * 活动性由 computeProjection 就地回填（与 events 同一套 rewind 遮蔽窗口）。
   */
  extensionEvents: LoadedExtensionEvent[];
  /** 解析告警（跳过的非法行等）；合法日志应为空 */
  warnings: string[];
}

export type ProjectionRole = 'user' | 'assistant';

export interface ProjectionMessage {
  seq: number;
  ts: string;
  role: ProjectionRole;
  text: string;
  turnId?: string;
}

/**
 * 扩展事件的 opaque 投影条目（D02）：按日志序携带已注册扩展事件，供壳/渲染层做
 * 通用兜底展示。不进 messages、不参与内建投影语义；payload 即落盘原文（只读约定）。
 */
export interface ProjectionOpaqueEvent {
  seq: number;
  ts: string;
  /** 注册的扩展类型名（不在 SessionEventType 联合内） */
  type: string;
  payload: Record<string, unknown>;
}

export interface SessionProjection {
  /** 可用于重建模型上下文的消息序列（Model-visible ⟺ logged 的读侧体现） */
  messages: ProjectionMessage[];
  /** 活动事件数（含 header 与 rewind/marker；只计内建通道，扩展事件见 opaqueEvents） */
  activeCount: number;
  /** 被回退遮蔽的事件数（只计内建通道） */
  shadowedCount: number;
  /** 已应用的回退次数 */
  rewindCount: number;
  /** 日志中最后一个事件的 seq */
  lastSeq: number;
  /**
   * 扩展事件的 opaque 投影（D02 加性通道）：仅含活动（未被 rewind 遮蔽）的扩展事件，
   * 按日志序（seq 升序）。无扩展事件时为空数组——既有投影消费方零变化。
   */
  opaqueEvents: readonly ProjectionOpaqueEvent[];
}

/** 读取并解析会话日志。非法行跳过并记入 warnings（只读分析不抛错）。 */
export function loadSession(dir: string): LoadedSession {
  const logPath = join(dir, SESSION_LOG_FILE);
  if (!existsSync(logPath)) {
    throw new Error(`session log not found: ${logPath}`);
  }
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const events: LoadedEvent[] = [];
  const extensionEvents: LoadedExtensionEvent[] = [];
  const warnings: string[] = [];
  let header: SessionHeaderPayload | null = null;
  let maxSeq = 0;
  for (const [i, line] of lines.entries()) {
    if (line.length === 0) continue;
    const e = parseEventLine(line);
    if (e !== null) {
      if (e.type === 'session/header') {
        header = e.payload;
      }
      if (e.seq > maxSeq) maxSeq = e.seq;
      events.push({ event: e, active: true });
      continue;
    }
    // 内建解析拒绝 → 尝试扩展事件（已注册类型）；仍未中即维持现状：告警跳过
    const ext = parseExtensionEventLine(line);
    if (ext !== null) {
      if (ext.seq > maxSeq) maxSeq = ext.seq;
      extensionEvents.push({ event: ext, active: true });
      continue;
    }
    warnings.push(`skipped invalid line ${i + 1}: ${line.slice(0, 80)}`);
  }
  // P2-1（读侧容错旧日志）：日志中已存在的越界 rewind/marker 给 warning，不抛错
  for (const { event } of events) {
    if (event.type !== 'rewind/marker') continue;
    const n = event.payload.rewindToSeq;
    if (!Number.isInteger(n) || n < 1 || n > maxSeq) {
      warnings.push(`rewind/marker at seq ${event.seq}: rewindToSeq ${n} out of range (1..${maxSeq})`);
    }
  }
  return { dir, header, events, extensionEvents, warnings };
}

/**
 * 计算活动投影。两遍扫描：先由 rewind 标记求出遮蔽集，再据此构建投影。
 *
 * 标记语义（单调并集 + redo 链中立化）：
 *   - 每个 rewind/marker 追溯遮蔽「标记之前已出现且 seq > rewindToSeq」的非标记事件；
 *   - reason 以 'redo' 开头的标记额外**中立化** seq = rewindToSeq + 1 处的标记
 *     （移除其遮蔽贡献）。undo/redo 约定 redo.rewindToSeq = 被重做 undo 标记的 seq - 1，
 *     因此该定位精确命中被重做的 undo 标记并恢复其遮蔽的事件——n 级 undo/redo 链
 *     按此自然成立（每次 redo 只复活一层）；
 *   - 非 redo 标记的语义与阶段 1 完全一致（只遮蔽、不复活），旧日志行为不变。
 */
export function computeProjection(session: LoadedSession): SessionProjection {
  // pass 1：逐标记求遮蔽集（redo 标记可中立化被重做的 undo 标记）
  interface MarkerRule {
    seq: number;
    /** 遮蔽窗口下界（rewindToSeq）：窗口 = (rewindToSeq, seq)，扩展事件按窗口判定活动性 */
    rewindToSeq: number;
    targets: Set<number>; // 该标记遮蔽的非标记事件 seq
    neutralized: boolean;
  }
  const rules: MarkerRule[] = [];
  const seen: LoadedEvent[] = [];
  let rewindCount = 0;
  for (const item of session.events) {
    const e = item.event;
    if (e.type === 'rewind/marker') {
      const n = e.payload.rewindToSeq;
      if ((e.payload.reason ?? '').startsWith('redo')) {
        // redo 链：中立化 seq = n+1 处的标记（undo/redo 约定的被重做 undo 标记）
        const victimSeq = n + 1;
        for (const rule of rules) {
          if (rule.seq === victimSeq) rule.neutralized = true;
        }
      }
      const targets = new Set<number>();
      for (const s of seen) {
        if (s.event.seq > n && s.event.type !== 'rewind/marker') targets.add(s.event.seq);
      }
      rules.push({ seq: e.seq, rewindToSeq: n, targets, neutralized: false });
      rewindCount += 1;
    }
    seen.push(item);
  }
  const shadowed = new Set<number>();
  for (const rule of rules) {
    if (rule.neutralized) continue;
    for (const t of rule.targets) shadowed.add(t);
  }

  // 扩展事件活动性（D02 opaque 通道）：与内建同一套遮蔽窗口——某活动标记
  // （seq = m，rewindToSeq = n）追溯遮蔽窗口 (n, m) 内的全部事件，扩展事件同口径；
  // 未注册/已注销类型根本不会到这一步（loadSession 已拒），故此处只见已注册扩展事件。
  for (const item of session.extensionEvents) {
    const s = item.event.seq;
    item.active = !rules.some((rule) => !rule.neutralized && s < rule.seq && s > rule.rewindToSeq);
  }

  // pass 2：活动性 + 可重建消息序列
  const messages: ProjectionMessage[] = [];
  let activeCount = 0;
  for (const item of session.events) {
    const e = item.event;
    // 标记事件是结构性事件，始终活动
    item.active = e.type === 'rewind/marker' || !shadowed.has(e.seq);
    if (!item.active) continue;
    activeCount += 1;
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      messages.push({
        seq: e.seq,
        ts: e.ts,
        role: e.type === 'user/message' ? 'user' : 'assistant',
        text: e.payload.text,
        turnId: e.payload.turnId,
      });
    }
  }

  // opaque 通道：仅活动扩展事件，按日志序（loadSession 已按日志序填充，seq 升序）
  const opaqueEvents: ProjectionOpaqueEvent[] = [];
  for (const item of session.extensionEvents) {
    if (!item.active) continue;
    opaqueEvents.push({
      seq: item.event.seq,
      ts: item.event.ts,
      type: item.event.type,
      payload: item.event.payload,
    });
  }

  // lastSeq：日志最后一个事件的 seq（内建与扩展两条通道取最大——扩展事件与内建共用
  // 同一 seq 空间；无扩展事件时与既往逐字段一致）
  const lastSeq = Math.max(session.events.at(-1)?.event.seq ?? 0, session.extensionEvents.at(-1)?.event.seq ?? 0);
  return {
    messages,
    activeCount,
    shadowedCount: session.events.length - activeCount,
    rewindCount,
    lastSeq,
    opaqueEvents,
  };
}

/** 全量导出（含影子事件与扩展事件）为 JSONL 文本 —— 供归档/迁移/回放测试使用 */
export function exportAllEvents(session: LoadedSession): string {
  // 内建与扩展两条通道按 seq 归并，保持日志原始顺序（无扩展事件时输出与既往逐字节一致）
  const merged: Array<AnySessionEvent | ExtensionSessionEvent> = [];
  let i = 0;
  let j = 0;
  while (i < session.events.length && j < session.extensionEvents.length) {
    const b = session.events[i]!.event;
    const x = session.extensionEvents[j]!.event;
    if (b.seq < x.seq) {
      merged.push(b);
      i += 1;
    } else {
      merged.push(x);
      j += 1;
    }
  }
  for (; i < session.events.length; i += 1) merged.push(session.events[i]!.event);
  for (; j < session.extensionEvents.length; j += 1) merged.push(session.extensionEvents[j]!.event);
  return merged.map((x) => JSON.stringify(x)).join('\n');
}
