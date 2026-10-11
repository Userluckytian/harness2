// Z6-A17-1 bash 副作用清单（真实日志提取，不重放、不回滚）。
//
// 背景：agent/types.ts 快照契约明确排除 bash 副作用（只有 write/edit 进 SnapshotStore）——
// undo/快照恢复后文件可回滚，但 bash 造成的写/删等副作用不在账。本模块从会话日志的
// tool/call 事件提取 tool=bash 的**真实**命令清单（红线⑩：只报真实记录；args.command
// 缺失/非字符串（未执行的解析失败调用）不臆造），供 undo/redo 结果对象携带与 GUI
// 警告条展示。恢复时**不自动重放**（危险，明确不做）：呈现归 UI 批次（登记）。
//
// 区间口径（与 undo/redo 的恢复范围一致）：
//   - undo：被撤区间 = 活动投影中 seq > rewindToSeq 的事件；
//   - redo：复活区间 = seq > 被重做 undo 标记的 rewindToSeq 且 seq <= redo 目标。
// 只统计**活动**事件：已被更早 rewind 遮蔽的调用不在当前投影、不参与本次回退。
import { computeProjection, type LoadedSession } from './reader.js';

/** 一条真实记录过的 bash 调用（tool/call 事件提取） */
export interface BashCommandRecord {
  /** tool/call 事件 seq */
  seq: number;
  /** 命令文本（args.command 原值，不加工） */
  command: string;
  /** 关联 tool/result 的 ok 值（无结果事件时缺省——如结果尚未落盘的进行中调用） */
  ok?: boolean;
  /** 事件 turnId（旧日志可缺省） */
  turnId?: string;
}

export interface BashCommandQuery {
  /** 只取 seq > afterSeq 的事件（缺省 0 = 全部） */
  afterSeq?: number;
  /** 只取 seq <= upToSeq 的事件（缺省 = 不设上界） */
  upToSeq?: number;
}

/**
 * 提取 bash 命令清单（活动投影，按 seq 升序）：tool=bash 且 args.command 为非空字符串
 * 的 tool/call 事件；ok 值按 callId 关联同会话第一条活动 tool/result。
 */
export function collectBashCommands(session: LoadedSession, query: BashCommandQuery = {}): BashCommandRecord[] {
  computeProjection(session);
  const afterSeq = query.afterSeq ?? 0;
  const upToSeq = query.upToSeq ?? Number.POSITIVE_INFINITY;
  const okByCallId = new Map<string, boolean>();
  for (const { event, active } of session.events) {
    if (!active || event.type !== 'tool/result') continue;
    if (!okByCallId.has(event.payload.callId)) okByCallId.set(event.payload.callId, event.payload.ok);
  }
  const out: BashCommandRecord[] = [];
  for (const { event, active } of session.events) {
    if (!active) continue;
    if (event.seq <= afterSeq || event.seq > upToSeq) continue;
    if (event.type !== 'tool/call' || event.payload.tool !== 'bash') continue;
    const command = extractCommand(event.payload.args);
    if (command === undefined) continue; // 无可提取命令（如参数解析失败未执行）——不臆造
    const record: BashCommandRecord = { seq: event.seq, command };
    const ok = okByCallId.get(event.payload.callId);
    if (ok !== undefined) record.ok = ok;
    if (event.payload.turnId !== undefined) record.turnId = event.payload.turnId;
    out.push(record);
  }
  return out;
}

/** 从 tool/call 参数提取命令文本：非对象 / 非字符串 / 空串 → undefined */
function extractCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const raw = (args as Record<string, unknown>)['command'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
