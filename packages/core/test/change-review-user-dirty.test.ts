// S7b 变更审查（change-review-user-dirty）。
// 契约（计划 S7 / 验收 #7b）：
//   - 用 SnapshotStore 聚合 changeSet，区分拟议（planned）diff 与真实（applied）diff；
//   - 用户/外部改动后被标 dirty；undo/redo 前比对发现冲突上报（不静默覆盖）；
//   - 只读审查：不写快照、不改工作区文件、不触发任何恢复。
// 全部本地临时目录（快照 + 工作区），无网络。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REWIND_POINTS_FILE, SnapshotStore } from '../src/session/snapshots.js';
import { compareBeforeUndo, type ChangeSet, reviewChangeSet } from '../src/interaction/change-review.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-review-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  sessionDir: string;
  workDir: string;
  file: string;
  store: SnapshotStore;
}

/** 会话目录（快照）+ 工作目录；文件 a.txt 从 v1 计划写入为 v2（capture+commitAfter+真实落盘） */
function makeFixture(plannedAfter: string = 'v2'): Fixture {
  const sessionDir = tmpDir('h2-review-session-');
  const workDir = tmpDir('h2-review-work-');
  const file = join(workDir, 'a.txt');
  writeFileSync(file, 'v1', 'utf8');
  const store = new SnapshotStore(sessionDir);
  store.capture({ seq: 3, file, before: 'v1' });
  store.commitAfter({ seq: 3, after: plannedAfter });
  writeFileSync(file, plannedAfter, 'utf8');
  return { sessionDir, workDir, file, store };
}

describe('用 SnapshotStore 聚合 changeSet：拟议与实际 diff 区分', () => {
  it('干净用例：planned={before,v1 after,v2}、current=v2、lastKnown=v2、dirty=false、matchesPlan=true', () => {
    const fx = makeFixture();
    const set: ChangeSet = reviewChangeSet(fx.store);
    expect(set.readOnly).toBe(true);
    expect(set.changedFiles).toBe(1);
    expect(set.dirtyFiles).toBe(0);
    expect(set.files[0]!.file).toBe(fx.file);
    expect(set.files[0]!.planned).toEqual({ before: 'v1', after: 'v2' }); // 拟议 diff（快照记录）
    expect(set.files[0]!.lastKnown).toBe('v2'); // 最后已知状态
    expect(set.files[0]!.current).toBe('v2'); // 真实落盘与计划一致
    expect(set.files[0]!.dirty).toBe(false);
    expect(set.files[0]!.matchesPlan).toBe(true);
  });

  it('用户/外部改动后 → dirty=true、matchesPlan=false（真实 diff 与拟议分离）', () => {
    const fx = makeFixture();
    // 外部/用户在不经快照的情况下把文件改成 v3
    writeFileSync(fx.file, 'v3', 'utf8');
    const set = reviewChangeSet(fx.store);
    expect(set.dirtyFiles).toBe(1);
    expect(set.files[0]!.planned).toEqual({ before: 'v1', after: 'v2' }); // 拟议不变
    expect(set.files[0]!.lastKnown).toBe('v2');
    expect(set.files[0]!.current).toBe('v3'); // 真实落盘 ≠ 拟议
    expect(set.files[0]!.dirty).toBe(true);
    expect(set.files[0]!.matchesPlan).toBe(false);
  });

  it('多文件：一脏一净分别聚合计数', () => {
    const sessionDir = tmpDir('h2-review-session-');
    const workDir = tmpDir('h2-review-work-');
    const a = join(workDir, 'a.txt');
    const b = join(workDir, 'b.txt');
    writeFileSync(a, 'v1', 'utf8');
    writeFileSync(b, 'w1', 'utf8');
    const store = new SnapshotStore(sessionDir);
    store.capture({ seq: 3, file: a, before: 'v1' });
    store.commitAfter({ seq: 3, after: 'v2' });
    writeFileSync(a, 'v2', 'utf8');
    store.capture({ seq: 5, file: b, before: 'w1' });
    store.commitAfter({ seq: 5, after: 'w1' }); // 空改动（计划无变化）
    writeFileSync(a, 'v3', 'utf8'); // a 被外部改动
    const set = reviewChangeSet(store);
    expect(set.changedFiles).toBe(2);
    expect(set.dirtyFiles).toBe(1);
    const aReview = set.files.find((f) => f.file === a)!;
    const bReview = set.files.find((f) => f.file === b)!;
    expect(aReview.dirty).toBe(true);
    expect(bReview.dirty).toBe(false);
  });
});

describe('undo 前比对当前版本：冲突如实上报（不静默覆盖）', () => {
  it('工作区与快照一致 → 无冲突，requiresUserDecision=false', () => {
    const fx = makeFixture();
    const report = compareBeforeUndo(fx.store, 0);
    expect(report.kind).toBe('undo');
    expect(report.externalModifications).toBe(0);
    expect(report.requiresUserDecision).toBe(false);
    expect(report.items[0]!).toMatchObject({
      file: fx.file,
      expected: 'v2', // undo 前应与最后 known after 一致
      current: 'v2',
      target: 'v1',
      externallyModified: false,
    });
  });

  it('外部改动后 → 冲突上报：expected=lastKnown、current=外部内容、外改计数>0、需显式决定', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8');
    const report = compareBeforeUndo(fx.store, 0);
    expect(report.externalModifications).toBe(1);
    expect(report.requiresUserDecision).toBe(true); // 未获用户决定前不得覆盖
    expect(report.items[0]!).toMatchObject({
      expected: 'v2',
      current: 'v3',
      target: 'v1',
      externallyModified: true,
    });
  });

  it('toSeq 截断范围：只比对被撤范围内的条目（seq > toSeq）', () => {
    const fx = makeFixture(); // seq=3 条目，before=v1 after=v2
    writeFileSync(fx.file, 'v2', 'utf8');
    // toSeq=3 → 条目不参与（严格大于）→ 空报告
    const report = compareBeforeUndo(fx.store, 3);
    expect(report.items).toHaveLength(0);
    expect(report.requiresUserDecision).toBe(false);
  });

  it('拟议 diff 不可被外部改动改写（planned 固定；dirty 反映真实）', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v9', 'utf8');
    const set = reviewChangeSet(fx.store);
    expect(set.files[0]!.planned.after).toBe('v2');
    expect(set.files[0]!.current).toBe('v9');
  });
});

describe('只读审查（non-mutating）', () => {
  it('reviewChangeSet / compareBeforeUndo：不改快照文件、不改工作文件、不追加条目', () => {
    const fx = makeFixture();
    writeFileSync(fx.file, 'v3', 'utf8'); // 外部改动（审查不得触碰）
    const snapBefore = readFileSync(join(fx.sessionDir, REWIND_POINTS_FILE), 'utf8');
    const entriesBefore = fx.store.entries();

    const set = reviewChangeSet(fx.store);
    const report = compareBeforeUndo(fx.store, 0);
    expect(set.readOnly).toBe(true);
    expect(report.readOnly).toBe(true);

    expect(readFileSync(join(fx.sessionDir, REWIND_POINTS_FILE), 'utf8')).toBe(snapBefore);
    expect(fx.store.entries()).toEqual(entriesBefore);
    expect(readFileSync(fx.file, 'utf8')).toBe('v3'); // 工作区未被审查改写
  });

  it('输出深度冻结（桌面展示契约）', () => {
    const fx = makeFixture();
    const set = reviewChangeSet(fx.store);
    const report = compareBeforeUndo(fx.store, 0);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.files)).toBe(true);
    expect(Object.isFrozen(set.files[0]!.planned)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.items)).toBe(true);
    expect(Object.isFrozen(report.items[0])).toBe(true);
  });
});
