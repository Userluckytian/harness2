// changeReview 只读契约（S7b）：用既有 SnapshotStore 聚合变更集 + undo/redo 前冲突比对。
// 契约（计划 S7 / 验收 #7b）：
//   - 用 SnapshotStore 聚合 changeSet，区分**拟议（planned）diff 与真实（applied）diff**：
//     planned = 快照记录的 before→after（计划写入）；真实落盘 = 当前磁盘内容对照最后已知状态；
//   - **undo/redo 前比对当前版本**：执行 undo/redo 前先校验当前工作区版本与 lastKnown 快照
//     （undo=最后 after / redo=最早 before）一致；**外部修改不静默覆盖**——冲突须返回报告让用户
//     显式决定（abort / overwrite），guard 不放行即不触发实际恢复；
//   - **不自动 git reset/clean/stash/commit**：纯比对/审查视图，本模块没有任何 git/进程调用；
//   - 返回只读报告（changed files、diff 统计、冲突标记），供桌面展示。
// 红线：只读视图，不写快照、不改工作区；实际恢复仍走既有 SnapshotStore.restore/restoreAfter
//       与 session/undo.ts——本模块只在调用前给出比对结论与放行决策。
// 依赖仅 session/snapshots（复用既有聚合原语与 conflict 语义），不新造存储。
import { readTextOrNull, type SnapshotEntry, type SnapshotStore } from '../session/snapshots.js';

export interface ChangeFileReview {
  file: string;
  /** 拟议 diff（快照记录的 before→after：计划写入的起点与落点） */
  planned: { before: string | null; after: string | null };
  /** 真实落盘：当前磁盘内容 */
  current: string | null;
  /** 该文件最后被快照追踪的已知状态（最后一次 after） */
  lastKnown: string | null;
  /** 当前内容 ≠ 最后已知状态 → 被外部/用户改动过 */
  dirty: boolean;
  /** 拟议是否仍等于真实（dirty=false ⇔ lastKnown===planned.after===current） */
  matchesPlan: boolean;
}

export interface ChangeSet {
  sourceDir: string;
  files: ChangeFileReview[];
  changedFiles: number;
  dirtyFiles: number;
  /** 契约钉：只读审查视图 */
  readonly readOnly: true;
}

export type UndoRedoKind = 'undo' | 'redo';

export interface UndoRedoCompareItem {
  file: string;
  /** 该方向上应用前的期望当前内容（undo=最后 known after；redo=最早 before，即 undo 基线） */
  expected: string | null;
  current: string | null;
  /** 将恢复到的内容（undo=最早 before；redo=最新 after） */
  target: string | null;
  externallyModified: boolean;
}

export interface UndoRedoCompareReport {
  kind: UndoRedoKind;
  /** undo：toSeq（撤到该 seq 之后全部条目）；redo：fromSeq（重做该 seq 之后全部条目） */
  scopeSeq: number;
  items: UndoRedoCompareItem[];
  externalModifications: number;
  /** 任一外部修改 → 不得静默覆盖，须用户显式决定（resolveUndoDestination 见 decideUndoRestore） */
  requiresUserDecision: boolean;
  /** 契约钉：本报告只读（不应用恢复、不写盘） */
  readonly readOnly: true;
}

export type UndoConflictDecision = 'abort' | 'overwrite';
export type UndoGuardReason = 'clean' | 'blocked' | 'overwrite';

export interface UndoGuardResult {
  proceed: boolean;
  reason: UndoGuardReason;
}

interface FileGroup {
  file: string;
  entries: SnapshotEntry[];
}

/** 按文件分组并稳定排序（与 SnapshotStore.groupByFile 同序：按首次触碰 seq） */
function groupByFile(entries: readonly SnapshotEntry[]): FileGroup[] {
  const byFile = new Map<string, SnapshotEntry[]>();
  for (const e of entries) {
    const list = byFile.get(e.file);
    if (list) list.push(e);
    else byFile.set(e.file, [e]);
  }
  const groups: FileGroup[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.seq - b.seq);
    groups.push({ file, entries: list });
  }
  groups.sort((a, b) => a.entries[0]!.seq - b.entries[0]!.seq);
  return groups;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const k of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return Object.freeze(value);
}

/**
 * 从 SnapshotStore 聚合 changeSet：每文件拟议 diff（最早 before → 最新 after）与
 * 真实落盘对照（current vs lastKnown=最新 after）。只读，不写快照、不改工作区。
 */
export function reviewChangeSet(store: SnapshotStore): ChangeSet {
  const groups = groupByFile(store.entries());
  const files: ChangeFileReview[] = groups.map((g) => {
    const first = g.entries[0]!;
    const last = g.entries[g.entries.length - 1]!;
    const lastKnown = last.after;
    const current = readTextOrNull(g.file);
    const dirty = current !== lastKnown;
    return {
      file: g.file,
      planned: { before: first.before, after: last.after },
      current,
      lastKnown,
      dirty,
      matchesPlan: current === lastKnown,
    };
  });
  const set: ChangeSet = {
    sourceDir: store.dir,
    files,
    changedFiles: files.length,
    dirtyFiles: files.filter((f) => f.dirty).length,
    readOnly: true,
  };
  return deepFreeze(set);
}

function buildCompareReport(
  kind: UndoRedoKind,
  scopeSeq: number,
  entries: readonly SnapshotEntry[],
): UndoRedoCompareReport {
  const items: UndoRedoCompareItem[] = groupByFile(entries).map((g) => {
    const first = g.entries[0]!;
    const last = g.entries[g.entries.length - 1]!;
    // 冲突基准与 SnapshotStore.restore(undo) / restoreAfter(redo) 一致：
    //   undo → 期望 = 最后 after（恢复目标 = 最早 before）；
    //   redo → 期望 = 最早 before（恢复目标 = 最新 after）。
    const undoMode = kind === 'undo';
    const expected = undoMode ? last.after : first.before;
    const target = undoMode ? first.before : last.after;
    const current = readTextOrNull(g.file);
    return { file: g.file, expected, current, target, externallyModified: current !== expected };
  });
  const externalModifications = items.filter((i) => i.externallyModified).length;
  const report: UndoRedoCompareReport = {
    kind,
    scopeSeq,
    items,
    externalModifications,
    requiresUserDecision: externalModifications > 0,
    readOnly: true,
  };
  return deepFreeze(report);
}

/**
 * undo 前比对当前版本：对 seq > toSeq 的全部快照条目按文件比较当前磁盘与 lastKnown。
 * 外部修改不静默覆盖——本报告供调用方决定放行；本函数不执行任何恢复。
 */
export function compareBeforeUndo(store: SnapshotStore, toSeq: number): UndoRedoCompareReport {
  return buildCompareReport(
    'undo',
    toSeq,
    store.entries().filter((e) => e.seq > toSeq),
  );
}

/**
 * redo 前比对当前版本：对 seq > fromSeq 的全部快照条目比较当前磁盘与 undo 基线（最早 before）。
 * 同样只出报告不动盘。
 */
export function compareBeforeRedo(store: SnapshotStore, fromSeq: number): UndoRedoCompareReport {
  return buildCompareReport(
    'redo',
    fromSeq,
    store.entries().filter((e) => e.seq > fromSeq),
  );
}

/**
 * 用户显式决定后的放行结论：
 *   - 无外部冲突 → 恒放行（reason=clean，abort/overwrite 同效）；
 *   - 有冲突 → abort 拦截（proceed=false，reason=blocked）；overwrite 放行（reason=overwrite）。
 * 本函数不触发实际恢复；调用方在 proceed=true 且获得显式授权后才应调用既有
 * SnapshotStore.restore/restoreAfter 与 session/undo.ts。
 */
export function decideUndoRestore(report: UndoRedoCompareReport, decision: UndoConflictDecision): UndoGuardResult {
  if (report.externalModifications === 0) return { proceed: true, reason: 'clean' };
  if (decision === 'overwrite') {
    return { proceed: true, reason: 'overwrite' };
  }
  return { proceed: false, reason: 'blocked' };
}
