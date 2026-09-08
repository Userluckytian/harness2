// S7b undo/redo 外部冲突守卫（undo-external-conflict）。
// 契约（计划 S7 / 验收 #7b）：
//   - undo/redo 前比对当前版本（与 lastKnown 快照一致才干净）；
//   - 外部修改不静默覆盖：返回冲突报告，须用户显式决定（abort / overwrite）；
//     abort 时 guard 拦截，绝不触发实际 restore；
//   - 不触发 git reset/clean/stash/commit（断言无 git 副作用调用）；
//   - 全部本地临时目录，无网络。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/session/snapshots.js';
import {
  compareBeforeRedo,
  compareBeforeUndo,
  decideUndoRestore,
  reviewChangeSet,
  type UndoConflictDecision,
} from '../src/interaction/change-review.js';

// 断言无 git 副作用：把 `node:child_process` 整体替换为 spy（vi.mock 在 vitest 中提升到
// 本文件所有 import 之前）。变更审查链路（change-review → snapshots）不依赖 child_process；
// 若未来某天该链路暗中引入 spawn/exec 等（git reset/clean/stash/commit 的宿主入口），
// 会被下方真实 mock 的函数调用记录捕获，.not.toHaveBeenCalled() 即失效变红——真实证据。
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
  spawnSync: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-conflict-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

interface Fixture {
  sessionDir: string;
  workDir: string;
  file: string;
  store: SnapshotStore;
}

/** 单个快照条目：seq=3 范围，before=v1 → after=v2（a.txt 真实落盘 v2） */
function makeFixture(): Fixture {
  const sessionDir = tmpDir('h2-conflict-session-');
  const workDir = tmpDir('h2-conflict-work-');
  const file = join(workDir, 'a.txt');
  writeFileSync(file, 'v1', 'utf8');
  const store = new SnapshotStore(sessionDir);
  store.capture({ seq: 3, file, before: 'v1' });
  store.commitAfter({ seq: 3, after: 'v2' });
  writeFileSync(file, 'v2', 'utf8');
  return { sessionDir, workDir, file, store };
}

describe('undo 前比对当前版本', () => {
  it('工作区与 lastKnown 一致 → 干净，不需用户决定', () => {
    const fx = makeFixture();
    const report = compareBeforeUndo(fx.store, 0);
    expect(report.requiresUserDecision).toBe(false);
    expect(report.externalModifications).toBe(0);
  });

  it('工作区与 lastKnown 不一致（外部改动）→ 冲突，需用户显式决定', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8'); // 外部/用户改动
    const report = compareBeforeUndo(fx.store, 0);
    expect(report.requiresUserDecision).toBe(true);
    expect(report.externalModifications).toBe(1);
    expect(report.items[0]!.externallyModified).toBe(true);
  });
});

describe('redo 前比对当前版本', () => {
  it('redo 冲突基准 = 最早 before（undo 恢复到的状态）；一致 → 干净', () => {
    const fx = makeFixture();
    // undo 后文件应回到 v1（最早 before）
    writeFileSync(fx.file, 'v1', 'utf8');
    const report = compareBeforeRedo(fx.store, 0);
    expect(report.kind).toBe('redo');
    expect(report.requiresUserDecision).toBe(false);
    expect(report.items[0]).toMatchObject({
      expected: 'v1', // redo 前应对齐 undo 基线（最早 before）
      current: 'v1',
      target: 'v2', // redo 恢复到最新 after
      externallyModified: false,
    });
  });

  it('外部改动（current≠最早 before）→ 冲突上报', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'vX', 'utf8'); // 既不等于 v1（redo 期望）也不等于 v2
    const report = compareBeforeRedo(fx.store, 0);
    expect(report.requiresUserDecision).toBe(true);
    expect(report.items[0]!.externallyModified).toBe(true);
  });
});

describe('外部修改不静默覆盖：须用户显式决定', () => {
  it('abort：guard 拦截（proceed=false），不触发任何 restore 副作用', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8');
    const restoreSpy = vi.spyOn(SnapshotStore.prototype, 'restore');
    const redoSpy = vi.spyOn(SnapshotStore.prototype, 'restoreAfter');
    const report = compareBeforeUndo(fx.store, 0);
    const guard = decideUndoRestore(report, 'abort');
    expect(guard.proceed).toBe(false);
    expect(guard.reason).toBe('blocked');
    // 无用户授权不实际覆盖：restore/restoreAfter 从未被调用，文件仍是外部内容
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(redoSpy).not.toHaveBeenCalled();
    expect(readFileSync(fx.file, 'utf8')).toBe('v3');
    restoreSpy.mockRestore();
    redoSpy.mockRestore();
  });

  it('overwrite：用户显式决定后才放行（guard 只给结论，恢复由既有快照路径执行）', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8');
    const report = compareBeforeUndo(fx.store, 0);
    const guard = decideUndoRestore(report, 'overwrite');
    expect(guard.proceed).toBe(true);
    expect(guard.reason).toBe('overwrite');
  });

  it('干净用例：abort/overwrite 都放行（无外部冲突无需纠结）', () => {
    const fx = makeFixture();
    const report = compareBeforeUndo(fx.store, 0);
    for (const decision of ['abort', 'overwrite'] as readonly UndoConflictDecision[]) {
      const guard = decideUndoRestore(report, decision);
      expect(guard.proceed).toBe(true);
      expect(guard.reason).toBe('clean');
    }
  });

  it('报告 readOnly：compare 本身不应用恢复、不写盘', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8');
    const snapBefore = readFileSync(join(fx.sessionDir, 'rewind_points.jsonl'), 'utf8');
    const report = compareBeforeUndo(fx.store, 0);
    expect(report.readOnly).toBe(true);
    expect(snapBefore).toContain('"after":"v2"');
    expect(readFileSync(fx.file, 'utf8')).toBe('v3');
  });
});

describe('无 git 副作用（reset/clean/stash/commit 断言，mock 已真实接线）', () => {
  it('review/compare/guard 全程零 child_process 调用；接线有效（命中即败）', () => {
    // 先证明断言不是空转：6 个入口确为本文件 vi.mock 的 mock 函数
    // （mock 经 import 从 node:child_process 解析，若实现调用即被记录 → 下方断言失败）
    expect(vi.isMockFunction(spawn)).toBe(true);
    expect(vi.isMockFunction(exec)).toBe(true);
    expect(vi.isMockFunction(execFile)).toBe(true);
    expect(vi.isMockFunction(spawnSync)).toBe(true);
    expect(vi.isMockFunction(execSync)).toBe(true);
    expect(vi.isMockFunction(execFileSync)).toBe(true);

    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8');
    const set = reviewChangeSet(fx.store);
    expect(set.dirtyFiles).toBe(1);
    const report = compareBeforeUndo(fx.store, 0);
    decideUndoRestore(report, 'abort');
    decideUndoRestore(report, 'overwrite');
    compareBeforeRedo(fx.store, 0);
    // git reset/clean/stash/commit 一律经 child_process 入口；链路若暗中调用必经 mock 函数
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});