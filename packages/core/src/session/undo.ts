// undo/redo 内核语义：全部是 append-only 日志上的投影操作 + 快照恢复联动，无内存旁路。
//
// undoLastTurn：定位最近一条**活动** user/message 的 seq U → 目标 = U-1（撤掉该用户
//   消息及其后所有内容，含 attempt 与 tool 事件）；执行 = 追加 rewind/marker
//   {rewindToSeq: 目标, reason:'undo'} + snapshots.restore(目标)。
// redoLastUndo：从日志回放 undo 栈定位「最后一个未被重做的 undo 标记」M（undo 入栈、
//   redo 按其 rewindToSeq+1 出栈）；redo 目标 = M.seq - 1（即 undo 前的活动 tip）；
//   执行 = 追加 rewind/marker {rewindToSeq: 目标, reason:'redo'} +
//   snapshots.restoreAfter(M.rewindToSeq)。redo 标记按投影的「redo 链中立化」语义
//   （reader.computeProjection）精确复活 M 遮蔽的事件——n 级 undo/redo 链自然成立。
//
// dryRun 只返回预览（将撤/将恢复的消息数、文件清单、冲突）不落盘（不追加 marker、
// 不写文件）。目标恒在界内（与 Ph2 的 writer 侧 rewindToSeq 1..lastSeq 校验兼容）。
import { computeProjection, loadSession, type ProjectionMessage } from './reader.js';
import type { SnapshotRestoreItem, SnapshotStore } from './snapshots.js';
import type { SessionWriter } from './writer.js';

/** undo/redo 无法执行时的明确错误（调用方按一行友好输出处理） */
export class UndoRedoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoRedoError';
  }
}

export interface UndoRedoOptions {
  /** 提供时联动文件快照恢复；缺省只做投影截断 */
  snapshots?: SnapshotStore;
  /** true = 只预览不落盘（不追加 marker、不恢复文件） */
  dryRun?: boolean;
}

export interface UndoRedoResult {
  kind: 'undo' | 'redo';
  dryRun: boolean;
  /** 追加（或拟追加）的 rewind/marker 的 seq */
  markerSeq: number;
  /** 回退目标（rewindToSeq） */
  rewindToSeq: number;
  /** undo：将被遮蔽的活动消息数；redo：将恢复活动的影子消息数 */
  messages: number;
  /** 文件恢复计划/结果（未提供 snapshots 时为空数组） */
  files: SnapshotRestoreItem[];
}

function activeMessages(session: Parameters<typeof computeProjection>[0]): ProjectionMessage[] {
  return computeProjection(session).messages;
}

/** 在「日志 + 拟追加 marker」的假想会话上计算投影（用于预览与结果摘要，无副作用） */
function projectionWithMarker(
  dir: string,
  markerSeq: number,
  rewindToSeq: number,
  reason: 'undo' | 'redo',
): ProjectionMessage[] {
  const session = loadSession(dir);
  session.events.push({
    event: {
      v: 1,
      seq: markerSeq,
      ts: new Date().toISOString(),
      type: 'rewind/marker',
      payload: { rewindToSeq, reason },
    },
    active: true,
  });
  return activeMessages(session);
}

/** diff 两份投影的消息集合（按 seq） */
function messageSeqs(messages: readonly ProjectionMessage[]): Set<number> {
  return new Set(messages.map((m) => m.seq));
}

/**
 * 撤销最近一个用户 turn：目标 = 最近活动 user/message 的 seq - 1。
 * 无活动 user/message（无可撤）或目标越界（撤到 seq 0）→ UndoRedoError。
 */
export function undoLastTurn(writer: SessionWriter, opts: UndoRedoOptions = {}): UndoRedoResult {
  const session = loadSession(writer.dir);
  const lastUser = activeMessages(session)
    .slice()
    .reverse()
    .find((m) => m.role === 'user');
  if (!lastUser) {
    throw new UndoRedoError('没有可撤回的用户消息');
  }
  const target = lastUser.seq - 1;
  if (target < 1) {
    throw new UndoRedoError(`无法撤回：目标 seq ${target} 越界（会话起始之前）`);
  }
  return applyMarker(writer, 'undo', target, opts);
}

/**
 * 重做最近一次尚未被重做的撤销：回放 undo 栈（undo 入栈；redo 中立化其
 * rewindToSeq+1 处指向的 undo，即出栈），取栈顶 undo 标记 M，目标 = M.seq - 1。
 * 无 marker / 栈空（全部已重做）→ UndoRedoError。
 */
export function redoLastUndo(writer: SessionWriter, opts: UndoRedoOptions = {}): UndoRedoResult {
  const session = loadSession(writer.dir);
  const markers = session.events.filter((x) => x.event.type === 'rewind/marker');
  if (markers.length === 0) {
    throw new UndoRedoError('没有可重做的撤销（日志中没有 rewind/marker）');
  }
  // 回放 undo 栈：undo 入栈；redo 弹出其 rewindToSeq+1 指向的 undo 标记
  const stack: Array<{ seq: number; rewindToSeq: number }> = [];
  for (const { event } of markers) {
    if (event.type !== 'rewind/marker') continue; // 类型收窄（filter 已保证）
    if ((event.payload.reason ?? '').startsWith('undo')) {
      stack.push({ seq: event.seq, rewindToSeq: event.payload.rewindToSeq });
    } else {
      const victimSeq = event.payload.rewindToSeq + 1;
      const idx = stack.findIndex((m) => m.seq === victimSeq);
      if (idx >= 0) stack.splice(idx, 1);
    }
  }
  const top = stack.at(-1);
  if (!top) {
    throw new UndoRedoError('没有可重做的撤销（没有尚未重做的 undo 标记）');
  }
  const target = top.seq - 1;
  if (target <= top.rewindToSeq) {
    throw new UndoRedoError(`无法重做：目标 seq ${target} 未越过 undo 目标 ${top.rewindToSeq}`);
  }
  // redo 的快照恢复范围 = 被 redo 的 undo 标记的 rewindToSeq（该 undo 所撤的全部操作）
  return applyMarker(writer, 'redo', target, opts, top.rewindToSeq);
}

function applyMarker(
  writer: SessionWriter,
  kind: 'undo' | 'redo',
  target: number,
  opts: UndoRedoOptions,
  restoreFromSeq?: number,
): UndoRedoResult {
  const dryRun = opts.dryRun ?? false;
  const markerSeq = writer.lastSeq + 1;

  // 消息数变化：undo = 将被遮蔽的活动消息；redo = 将恢复活动的影子消息
  const beforeMsgs = messageSeqs(activeMessages(loadSession(writer.dir)));
  const afterMsgs = messageSeqs(projectionWithMarker(writer.dir, markerSeq, target, kind));
  const messages = kind === 'undo' ? beforeMsgs.size - countIntersection(beforeMsgs, afterMsgs) : afterMsgs.size - countIntersection(beforeMsgs, afterMsgs);

  // 文件恢复计划（dryRun 由 SnapshotStore 保证无副作用）：
  //   undo 恢复 seq > 目标 的条目；redo 恢复 seq > 被重做 undo 的 rewindToSeq 的条目
  const restoreFrom = kind === 'undo' ? target : (restoreFromSeq ?? target);
  const files = opts.snapshots
    ? (kind === 'undo'
        ? opts.snapshots.restore(restoreFrom, { dryRun })
        : opts.snapshots.restoreAfter(restoreFrom, { dryRun })
      ).items
    : [];

  if (!dryRun) {
    writer.append('rewind/marker', { rewindToSeq: target, reason: kind });
  }
  return { kind, dryRun, markerSeq, rewindToSeq: target, messages, files };
}

function countIntersection(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}
