// 变更审查 / 撤销守卫 纯逻辑（D5 / F5）。
//
// 契约红线（changeReview + undo/redo）：
//   - **区分拟议（planned）与真实落盘（current/lastKnown）**：外部修改必须标 dirty，不静默覆盖；
//   - **undo/redo 前比对**：有外部改动 → 必须用户显式决定（abort / overwrite），guard 不放行就不恢复；
//   - 不自动 git reset/clean/stash/commit（本模块无任何 git/进程调用）；
//   - 按任务聚合：文件 → 写它的任务 id（用 S7 execution-view 的 taskId/args 关联），关联不到如实归「未知来源」。
import type { ChangeSetShape, ToolExecutionViewShape, UndoRedoResponseShape } from '../../../shared/protocol.js';

/** 单个变更文件的展示模型 */
export interface ChangedFileView {
  file: string;
  /** 拟议 diff（快照记录的 before→after） */
  plannedBefore: string | null;
  plannedAfter: string | null;
  /** 当前磁盘内容 */
  current: string | null;
  lastKnown: string | null;
  /** 外部/用户改动过（current ≠ lastKnown） */
  dirty: boolean;
  matchesPlan: boolean;
  /** 写这个文件的任务 id（来自执行视图关联；无 → 空数组） */
  taskIds: string[];
}

export interface ChangeReviewView {
  files: ChangedFileView[];
  changedFiles: number;
  dirtyFiles: number;
  /** 是否有任何外部改动（有 → 撤销必须显式确认） */
  hasExternalChanges: boolean;
  readOnly: true;
}

/** 从执行视图里取「写文件的工具调用」的路径（write/edit 的 args.file_path） */
function writtenPathOf(view: ToolExecutionViewShape): string | undefined {
  if (view.tool !== 'write' && view.tool !== 'edit') return undefined;
  const args = view.args;
  if (typeof args !== 'object' || args === null) return undefined;
  const fp = (args as Record<string, unknown>)['file_path'];
  return typeof fp === 'string' && fp.length > 0 ? fp : undefined;
}

/** 路径归一（统一分隔符 + 去末尾斜杠 + 小写盘符），用于跨来源比对 */
export function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, '/');
  const trimmed = unified.length > 1 && unified.endsWith('/') ? unified.slice(0, -1) : unified;
  return /^[a-zA-Z]:/.test(trimmed) ? trimmed[0]!.toLowerCase() + trimmed.slice(1) : trimmed;
}

/**
 * 构建变更审查视图：把 S7 changeSet 与执行视图关联，得到「谁改了这个文件」。
 * 关联口径：执行视图 args.file_path 归一后与变更文件路径**后缀匹配**（快照可能是绝对路径，
 * 工具参数可能是相对路径）。匹配不到 → taskIds 为空（如实，不猜）。
 */
export function buildChangeReviewView(
  set: ChangeSetShape | null | undefined,
  executionViews: readonly ToolExecutionViewShape[] = [],
): ChangeReviewView | null {
  if (set === null || set === undefined) return null;
  const writers: Array<{ path: string; taskId?: string }> = [];
  for (const v of executionViews) {
    const p = writtenPathOf(v);
    if (p === undefined) continue;
    writers.push({ path: normalizePath(p), ...(v.taskId !== undefined ? { taskId: v.taskId } : {}) });
  }
  const files: ChangedFileView[] = set.files.map((f) => {
    const target = normalizePath(f.file);
    const taskIds = [
      ...new Set(
        writers
          .filter((w) => target.endsWith(w.path) || w.path.endsWith(target))
          .map((w) => w.taskId)
          .filter((t): t is string => t !== undefined),
      ),
    ];
    return {
      file: f.file,
      plannedBefore: f.planned.before,
      plannedAfter: f.planned.after,
      current: f.current,
      lastKnown: f.lastKnown,
      dirty: f.dirty,
      matchesPlan: f.matchesPlan,
      taskIds,
    };
  });
  return {
    files,
    changedFiles: set.changedFiles,
    dirtyFiles: set.dirtyFiles,
    hasExternalChanges: set.dirtyFiles > 0,
    readOnly: true,
  };
}

/** undo dryRun 报告里的冲突清单（文件 + 是否外部改动） */
export interface UndoConflictSummary {
  externallyModified: number;
  files: Array<{ file: string; externallyModified: boolean }>;
  /** 是否必须用户显式决定后才能恢复 */
  requiresUserDecision: boolean;
}

/** 从 core undo(dryRun) 响应里提取冲突摘要（**不触发任何恢复**） */
export function summarizeUndoPreview(preview: UndoRedoResponseShape): UndoConflictSummary {
  const files: Array<{ file: string; externallyModified: boolean }> = [];
  for (const result of preview.results ?? []) {
    for (const f of result.files ?? []) {
      files.push({ file: f.file, externallyModified: f.externallyModified === true });
    }
  }
  const externallyModified = files.filter((f) => f.externallyModified).length;
  return { externallyModified, files, requiresUserDecision: externallyModified > 0 };
}

/** 撤销决策：无冲突直接恢复；有冲突必须 overwrite，否则拦截（与 change-review 契约同口径） */
export type UndoDecision = 'abort' | 'overwrite';

export function decideUndo(
  summary: UndoConflictSummary,
  decision?: UndoDecision,
): {
  proceed: boolean;
  reason: 'clean' | 'blocked' | 'overwrite';
} {
  if (summary.externallyModified === 0) return { proceed: true, reason: 'clean' };
  if (decision === 'overwrite') return { proceed: true, reason: 'overwrite' };
  return { proceed: false, reason: 'blocked' };
}

/**
 * PD1：redo 前冲突摘要（**不触发任何重放**）。
 * 基线口径：本端最近一次**真 undo** 响应返回的 per-file `target`（= 该次 undo 实际恢复到的内容，
 * 与 core change-review.ts 的 redo 期望基准「最早 before」同语义）。core serve `/redo` 无 dryRun
 * 参数（冻结契约），桌面侧只能用 undo 响应 + change-review 实时 `current` 自行比对。
 * 基线文件在变更集里查不到 = 无法核实 → 一并计为冲突（fail-closed，不静默放行）。
 */
export function summarizeRedoConflict(
  set: ChangeSetShape | null | undefined,
  baseline: ReadonlyArray<{ file: string; target: string | null }>,
): { externallyModified: number; files: string[] } {
  const currentByFile = new Map<string, string | null>();
  for (const f of set?.files ?? []) currentByFile.set(normalizePath(f.file), f.current);
  const files: string[] = [];
  for (const b of baseline) {
    const current = currentByFile.get(normalizePath(b.file));
    if (current === undefined || current !== b.target) files.push(b.file);
  }
  return { externallyModified: files.length, files };
}

/** 工作区（会话根/cwd）展示模型：项目切换时展示「这次请求到底在哪个目录跑」 */
export interface WorkspaceInfo {
  sessionId: string;
  /** 项目根（hub 全局 cwd） */
  root: string;
  /** 有效执行 cwd */
  cwd: string;
  /** 是否 per-session cwd（false = 回退 root） */
  perSessionCwd: boolean;
}

export function workspaceInfoFrom(
  sessionId: string,
  runConfig: { session: { root: string; cwd: string; perSessionCwd: boolean } } | undefined,
): WorkspaceInfo | null {
  // P1-1 连带防御：视图缓存可能在「指派分栏」时写入 —— 形状不完整（缺 session）按未载入处理，
  // 不渲染半份工作区信息，也不崩溃。
  if (runConfig?.session === undefined) return null;
  return {
    sessionId,
    root: runConfig.session.root,
    cwd: runConfig.session.cwd,
    perSessionCwd: runConfig.session.perSessionCwd,
  };
}

/** 两个会话是否落在同一工作区（用于「A/B 项目不串」的可测断言） */
export function sameWorkspace(a: WorkspaceInfo | null, b: WorkspaceInfo | null): boolean {
  if (a === null || b === null) return false;
  return normalizePath(a.cwd) === normalizePath(b.cwd);
}
