// 会话读取器与投影：从 append-only 日志重建会话。
// 投影语义（见 types.ts RewindMarkerPayload）：
//   rewind/marker 追溯遮蔽「已出现且 seq > rewindToSeq」的非标记事件；
//   标记之后新追加的事件属于新分支、默认活动。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_LOG_FILE,
  type AnySessionEvent,
  type SessionHeaderPayload,
  parseEventLine,
} from './types.js';

export interface LoadedEvent {
  event: AnySessionEvent;
  /** 是否在当前活动投影内（影子事件为 false，仍保留可导出） */
  active: boolean;
}

export interface LoadedSession {
  dir: string;
  header: SessionHeaderPayload | null;
  /** 日志顺序的全部事件（含影子事件） */
  events: LoadedEvent[];
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

export interface SessionProjection {
  /** 可用于重建模型上下文的消息序列（Model-visible ⟺ logged 的读侧体现） */
  messages: ProjectionMessage[];
  /** 活动事件数（含 header 与 rewind/marker） */
  activeCount: number;
  /** 被回退遮蔽的事件数 */
  shadowedCount: number;
  /** 已应用的回退次数 */
  rewindCount: number;
  /** 日志中最后一个事件的 seq */
  lastSeq: number;
}

/** 读取并解析会话日志。非法行跳过并记入 warnings（只读分析不抛错）。 */
export function loadSession(dir: string): LoadedSession {
  const logPath = join(dir, SESSION_LOG_FILE);
  if (!existsSync(logPath)) {
    throw new Error(`session log not found: ${logPath}`);
  }
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const events: LoadedEvent[] = [];
  const warnings: string[] = [];
  let header: SessionHeaderPayload | null = null;
  for (const [i, line] of lines.entries()) {
    if (line.length === 0) continue;
    const e = parseEventLine(line);
    if (e === null) {
      warnings.push(`skipped invalid line ${i + 1}: ${line.slice(0, 80)}`);
      continue;
    }
    if (e.type === 'session/header') {
      header = e.payload;
    }
    events.push({ event: e, active: true });
  }
  return { dir, header, events, warnings };
}

/** 计算活动投影。两遍扫描：先由 rewind 标记求出遮蔽集，再据此构建投影。 */
export function computeProjection(session: LoadedSession): SessionProjection {
  // pass 1：每个 rewind/marker 只遮蔽「标记之前已出现且 seq > rewindToSeq」的非标记事件
  const shadowed = new Set<number>();
  let rewindCount = 0;
  const seen: LoadedEvent[] = [];
  for (const item of session.events) {
    if (item.event.type === 'rewind/marker') {
      const n = item.event.payload.rewindToSeq;
      for (const s of seen) {
        if (s.event.seq > n && s.event.type !== 'rewind/marker') {
          shadowed.add(s.event.seq);
        }
      }
      rewindCount += 1;
    }
    seen.push(item);
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

  const lastSeq = session.events.at(-1)?.event.seq ?? 0;
  return {
    messages,
    activeCount,
    shadowedCount: session.events.length - activeCount,
    rewindCount,
    lastSeq,
  };
}

/** 全量导出（含影子事件）为 JSONL 文本 —— 供归档/迁移/回放测试使用 */
export function exportAllEvents(session: LoadedSession): string {
  return session.events
    .map((x) => JSON.stringify(x.event))
    .join('\n');
}
