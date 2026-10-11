// 分屏工作台状态仓库测试（Z2-06 / Z-19）：投放/去重/上限/关闭塌缩/比例钳制/选择同步。
import { describe, expect, it } from 'vitest';
import { countPanes, leafIds, type WorkbenchNode } from '@harness2/ui-shared/renderer/layout/workbench/model.js';
import { WorkbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';

/** 建一个已绑定 a 的两格工作台（pane-0=a 主格；pane-1=b 非主格） */
function twoPane(): WorkbenchStore {
  const workbench = new WorkbenchStore();
  workbench.syncSelection('a', null);
  const outcome = workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' });
  expect(outcome.ok).toBe(true);
  return workbench;
}

describe('初始与选择同步', () => {
  it('初始单叶未绑定；syncSelection 把主格绑到 selectedId', () => {
    const workbench = new WorkbenchStore();
    expect(workbench.getSnapshot()).toMatchObject({ bindings: {}, focusedId: 'pane-0' });
    workbench.syncSelection('a', null);
    expect(workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'a' });
    expect(workbench.getSnapshot().focusedId).toBe('pane-0');
  });

  it('选择已在分屏中的会话 → 焦点移到该格（不新建、不改绑定）', () => {
    const workbench = twoPane();
    workbench.syncSelection('b', 'a');
    expect(workbench.getSnapshot().focusedId).toBe('pane-1');
    expect(countPanes(workbench.getSnapshot().root)).toBe(2);
    expect(workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'a', 'pane-1': 'b' });
  });

  it('选择未在分屏中的会话 → 上一主格改绑到新会话（主格跟随左侧选择）', () => {
    const workbench = twoPane();
    workbench.syncSelection('c', 'a');
    expect(workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'c', 'pane-1': 'b' });
    expect(workbench.getSnapshot().focusedId).toBe('pane-0');
  });

  it('selectedId 为 null：不动', () => {
    const workbench = twoPane();
    const before = workbench.getSnapshot();
    workbench.syncSelection(null, 'a');
    expect(workbench.getSnapshot()).toBe(before);
  });
});

describe('dropSession（投放 / 去重 / 上限）', () => {
  it('投放新会话 → 目标叶分裂出新格并绑定；新格成为焦点', () => {
    const workbench = new WorkbenchStore();
    workbench.syncSelection('a', null);
    const outcome = workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' });
    expect(outcome).toEqual({ ok: true, leafId: 'pane-1' });
    const snap = workbench.getSnapshot();
    expect(countPanes(snap.root)).toBe(2);
    expect(snap.bindings).toEqual({ 'pane-0': 'a', 'pane-1': 'b' });
    expect(snap.focusedId).toBe('pane-1');
    expect((snap.root as Extract<WorkbenchNode, { t: 'split' }>).dir).toBe('row');
  });

  it('同一会话重复投放 → 去重：聚焦已存在格，不新建', () => {
    const workbench = twoPane();
    const outcome = workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'left' });
    expect(outcome).toEqual({ ok: false, reason: 'duplicate', leafId: 'pane-1' });
    expect(countPanes(workbench.getSnapshot().root)).toBe(2);
    expect(workbench.getSnapshot().focusedId).toBe('pane-1');
  });

  it('上限 4 格：第 5 格被拒（reason limit），树不变', () => {
    const workbench = new WorkbenchStore();
    workbench.syncSelection('a', null);
    expect(workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' }).ok).toBe(true);
    expect(workbench.dropSession({ sessionId: 'c', targetLeafId: 'pane-0', side: 'down' }).ok).toBe(true);
    expect(workbench.dropSession({ sessionId: 'd', targetLeafId: 'pane-0', side: 'up' }).ok).toBe(true);
    expect(countPanes(workbench.getSnapshot().root)).toBe(4);
    const fifth = workbench.dropSession({ sessionId: 'e', targetLeafId: 'pane-0', side: 'left' });
    expect(fifth).toEqual({ ok: false, reason: 'limit' });
    expect(countPanes(workbench.getSnapshot().root)).toBe(4);
  });

  it('空会话 id / 目标叶不存在 → 如实拒绝', () => {
    const workbench = new WorkbenchStore();
    expect(workbench.dropSession({ sessionId: '', targetLeafId: 'pane-0', side: 'left' }).reason).toBe('empty-session');
    expect(workbench.dropSession({ sessionId: 'x', targetLeafId: 'ghost', side: 'left' }).reason).toBe('unknown-leaf');
  });
});

describe('closeLeaf（塌缩 + 焦点回主格）', () => {
  it('关闭非主格 → 树塌缩、绑定删除、焦点回主格；不触碰会话', () => {
    const workbench = twoPane();
    workbench.closeLeaf('pane-1', 'pane-0');
    const snap = workbench.getSnapshot();
    expect(countPanes(snap.root)).toBe(1);
    expect(snap.root).toEqual({ t: 'leaf', id: 'pane-0' });
    expect(snap.bindings).toEqual({ 'pane-0': 'a' });
    expect(snap.focusedId).toBe('pane-0');
  });

  it('最后一格不可关（无变化）', () => {
    const workbench = new WorkbenchStore();
    workbench.syncSelection('a', null);
    const before = workbench.getSnapshot();
    workbench.closeLeaf('pane-0', 'pane-0');
    expect(workbench.getSnapshot()).toBe(before);
  });

  it('嵌套多格：关闭中间层叶后其余叶仍在', () => {
    const workbench = new WorkbenchStore();
    workbench.syncSelection('a', null);
    workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' });
    workbench.dropSession({ sessionId: 'c', targetLeafId: 'pane-1', side: 'down' });
    expect(leafIds(workbench.getSnapshot().root)).toEqual(['pane-0', 'pane-1', 'pane-2']);
    workbench.closeLeaf('pane-1', 'pane-0');
    expect(leafIds(workbench.getSnapshot().root)).toEqual(['pane-0', 'pane-2']);
    expect(workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'a', 'pane-2': 'c' });
  });
});

describe('setRatio', () => {
  it('改比例并钳制；未命中不动', () => {
    const workbench = twoPane();
    workbench.setRatio('split:pane-1', 0.9);
    const split = workbench.getSnapshot().root as Extract<WorkbenchNode, { t: 'split' }>;
    expect(split.ratio).toBe(0.75);
    workbench.setRatio('split:pane-1', 0.05);
    expect((workbench.getSnapshot().root as Extract<WorkbenchNode, { t: 'split' }>).ratio).toBe(0.25);
    const before = workbench.getSnapshot();
    workbench.setRatio('ghost', 0.4);
    expect(workbench.getSnapshot()).toBe(before);
  });
});

describe('订阅', () => {
  it('动作产生新快照并通知；退订后不再收到', () => {
    const workbench = new WorkbenchStore();
    let calls = 0;
    const off = workbench.subscribe(() => {
      calls += 1;
    });
    workbench.syncSelection('a', null);
    expect(calls).toBe(1);
    workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' });
    expect(calls).toBe(2);
    off();
    workbench.setRatio('split:pane-1', 0.4);
    expect(calls).toBe(2);
  });
});
