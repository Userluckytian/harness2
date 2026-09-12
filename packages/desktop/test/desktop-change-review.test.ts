// D5 变更审查测试（F5）：拟议 vs 真实落盘区分、外部改动标 dirty、按任务归属聚合。
import { describe, expect, it } from 'vitest';
import {
  buildChangeReviewView,
  decideUndo,
  normalizePath,
  sameWorkspace,
  summarizeUndoPreview,
  workspaceInfoFrom,
} from '../src/renderer/features/workspace/change-review-model.js';
import type { ChangeSetShape, ToolExecutionViewShape, UndoRedoResponseShape } from '../src/shared/protocol.js';

const changeSet: ChangeSetShape = {
  sourceDir: '/s',
  files: [
    {
      file: '/w/hello.txt',
      planned: { before: null, after: 'v2' },
      current: 'v2',
      lastKnown: 'v2',
      dirty: false,
      matchesPlan: true,
    },
    {
      file: '/w/other.ts',
      planned: { before: 'old', after: 'new' },
      current: 'human-edit',
      lastKnown: 'new',
      dirty: true,
      matchesPlan: false,
    },
  ],
  changedFiles: 2,
  dirtyFiles: 1,
  readOnly: true,
};

const execView = (over: Partial<ToolExecutionViewShape>): ToolExecutionViewShape => ({
  callId: 'c',
  tool: 'write',
  args: { file_path: '/w/hello.txt' },
  commandSource: 'none',
  cwd: '/w',
  outputRef: '',
  outputTruncated: false,
  exitCodeSource: 'none',
  status: 'success',
  readOnly: true,
  ...over,
});

describe('buildChangeReviewView', () => {
  it('空输入 → null（不臆造变更集）', () => {
    expect(buildChangeReviewView(undefined)).toBeNull();
    expect(buildChangeReviewView(null)).toBeNull();
  });

  it('区分拟议与真实落盘；dirty 文件如实标记，hasExternalChanges 置位', () => {
    const v = buildChangeReviewView(changeSet)!;
    expect(v.readOnly).toBe(true);
    expect(v.changedFiles).toBe(2);
    expect(v.dirtyFiles).toBe(1);
    expect(v.hasExternalChanges).toBe(true);
    const clean = v.files.find((f) => f.file === '/w/hello.txt')!;
    expect(clean).toMatchObject({ plannedBefore: null, plannedAfter: 'v2', current: 'v2', dirty: false });
    const dirty = v.files.find((f) => f.file === '/w/other.ts')!;
    expect(dirty).toMatchObject({ plannedAfter: 'new', current: 'human-edit', dirty: true, matchesPlan: false });
  });

  it('按任务归属聚合：写该文件的执行视图 taskId 关联到文件（相对/绝对路径归一后匹配）', () => {
    const v = buildChangeReviewView(changeSet, [
      execView({ callId: 'c1', taskId: 'task-1', args: { file_path: 'hello.txt' } }),
      execView({ callId: 'c2', taskId: 'task-2', args: { file_path: '/w/other.ts' } }),
      execView({ callId: 'c3', tool: 'bash', args: { command: 'rm x' } }), // 非写文件工具不参与
    ])!;
    expect(v.files.find((f) => f.file === '/w/hello.txt')!.taskIds).toEqual(['task-1']);
    expect(v.files.find((f) => f.file === '/w/other.ts')!.taskIds).toEqual(['task-2']);
  });

  it('无执行记录关联 → taskIds 为空（如实，不猜任务）', () => {
    const v = buildChangeReviewView(changeSet, [])!;
    expect(v.files.every((f) => f.taskIds.length === 0)).toBe(true);
  });

  it('normalizePath：分隔符统一 + Windows 盘符小写', () => {
    expect(normalizePath('C:\\Proj\\a.txt')).toBe('c:/Proj/a.txt');
    expect(normalizePath('/w/dir/')).toBe('/w/dir');
  });
});

describe('undo 冲突守卫（外部改动不静默覆盖）', () => {
  const cleanPreview: UndoRedoResponseShape = {
    results: [
      {
        kind: 'undo',
        dryRun: true,
        markerSeq: 1,
        rewindToSeq: 0,
        messages: 1,
        files: [{ file: '/w/a', target: null, externallyModified: false }],
      },
    ],
  };
  const dirtyPreview: UndoRedoResponseShape = {
    results: [
      {
        kind: 'undo',
        dryRun: true,
        markerSeq: 1,
        rewindToSeq: 0,
        messages: 1,
        files: [
          { file: '/w/a', target: 'x', externallyModified: true },
          { file: '/w/b', target: null, externallyModified: false },
        ],
      },
    ],
  };

  it('summarizeUndoPreview：统计外部改动文件（不触发恢复）', () => {
    expect(summarizeUndoPreview(cleanPreview)).toMatchObject({ externallyModified: 0, requiresUserDecision: false });
    const s = summarizeUndoPreview(dirtyPreview);
    expect(s.externallyModified).toBe(1);
    expect(s.requiresUserDecision).toBe(true);
    expect(s.files).toEqual([
      { file: '/w/a', externallyModified: true },
      { file: '/w/b', externallyModified: false },
    ]);
  });

  it('decideUndo：无冲突直接放行；有冲突必须 overwrite，abort/未决定一律拦截', () => {
    expect(decideUndo(summarizeUndoPreview(cleanPreview))).toEqual({ proceed: true, reason: 'clean' });
    const dirty = summarizeUndoPreview(dirtyPreview);
    expect(decideUndo(dirty)).toEqual({ proceed: false, reason: 'blocked' });
    expect(decideUndo(dirty, 'abort')).toEqual({ proceed: false, reason: 'blocked' });
    expect(decideUndo(dirty, 'overwrite')).toEqual({ proceed: true, reason: 'overwrite' });
  });
});

describe('工作区（A/B 项目不串）', () => {
  const rcA = { session: { root: 'C:\\projA', cwd: 'C:\\projA', perSessionCwd: true } };
  const rcB = { session: { root: 'C:\\projB', cwd: 'C:\\projB', perSessionCwd: true } };

  it('workspaceInfoFrom 从真实 run-config 取 root/cwd', () => {
    expect(workspaceInfoFrom('s1', rcA)).toEqual({
      sessionId: 's1',
      root: 'C:\\projA',
      cwd: 'C:\\projA',
      perSessionCwd: true,
    });
    expect(workspaceInfoFrom('s1', undefined)).toBeNull();
  });

  it('sameWorkspace：大小写/分隔符归一后比较（不同项目 → false）', () => {
    const a = workspaceInfoFrom('a', rcA)!;
    const b = workspaceInfoFrom('b', rcB)!;
    expect(sameWorkspace(a, b)).toBe(false);
    expect(sameWorkspace(a, { ...a, cwd: 'c:/projA' })).toBe(true);
    expect(sameWorkspace(a, null)).toBe(false);
  });
});
