// 分屏工作台纯模型测试（Z2-06 / Z-19）：落点几何 / 分割树四种 side / 塌缩 / 上限 / 比例钳制。
// 纯函数（node 环境，无需 DOM）。
import { describe, expect, it } from 'vitest';
import {
  DROP_EDGE,
  MAX_PANES,
  SPLIT_MAX,
  SPLIT_MIN,
  clampRatio,
  countPanes,
  createInitialSnapshot,
  dropSideForRect,
  findLeaf,
  findLeafBySession,
  firstLeafId,
  leafIds,
  removeLeaf,
  replaceLeaf,
  sessionOfLeaf,
  setSplitRatio,
  splitLeafAt,
  type WorkbenchNode,
} from '@harness2/ui-shared/renderer/layout/workbench/model.js';

const leaf = (id: string): WorkbenchNode => ({ t: 'leaf', id });
const rect = (width = 100, height = 100) => ({ left: 0, top: 0, width, height });

describe('常量（Z-19）', () => {
  it('上限 4 格、比例钳制 [0.25, 0.75]、边缘带 0.32', () => {
    expect(MAX_PANES).toBe(4);
    expect(SPLIT_MIN).toBe(0.25);
    expect(SPLIT_MAX).toBe(0.75);
    expect(DROP_EDGE).toBe(0.32);
  });
});

describe('初始快照与计数', () => {
  it('初始为单叶、未绑定、焦点即该叶', () => {
    const snap = createInitialSnapshot();
    expect(snap.root).toEqual({ t: 'leaf', id: 'pane-0' });
    expect(snap.bindings).toEqual({});
    expect(snap.focusedId).toBe('pane-0');
    expect(countPanes(snap.root)).toBe(1);
    expect(leafIds(snap.root)).toEqual(['pane-0']);
    expect(firstLeafId(snap.root)).toBe('pane-0');
  });

  it('countPanes / leafIds / firstLeafId 在嵌套树上按左到右', () => {
    const s1 = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    const s2 = splitLeafAt(s1, 'b', 'down', 'c')!;
    expect(countPanes(s2)).toBe(3);
    expect(leafIds(s2)).toEqual(['a', 'b', 'c']);
    expect(firstLeafId(s2)).toBe('a');
  });
});

describe('落点判定 dropSideForRect（四边 / 中间 / 边界 0.32 / 未测量）', () => {
  it('四边：归一化最小距离命中对应 side', () => {
    expect(dropSideForRect(rect(), 5, 50)).toBe('left');
    expect(dropSideForRect(rect(), 95, 50)).toBe('right');
    expect(dropSideForRect(rect(), 50, 5)).toBe('up');
    expect(dropSideForRect(rect(), 50, 95)).toBe('down');
  });

  it('中间区域返回 null（不误触分屏）', () => {
    expect(dropSideForRect(rect(), 50, 50)).toBeNull();
    expect(dropSideForRect(rect(), 40, 60)).toBeNull();
  });

  it('边界 0.32：恰好等于 0.32 命中（含边界），略大于则 null', () => {
    expect(dropSideForRect(rect(), 32, 50)).toBe('left');
    expect(dropSideForRect(rect(), 33, 50)).toBeNull(); // 0.33 > 0.32
    expect(dropSideForRect(rect(), 68, 50)).toBe('right'); // 1-0.68 = 0.32
  });

  it('角点平局按 left/right/up/down 顺序（left 先）', () => {
    expect(dropSideForRect(rect(), 32, 32)).toBe('left');
  });

  it('宽/高为 0（未测量）一律 null', () => {
    expect(dropSideForRect({ left: 0, top: 0, width: 0, height: 100 }, 0, 50)).toBeNull();
    expect(dropSideForRect({ left: 0, top: 0, width: 100, height: 0 }, 50, 0)).toBeNull();
  });
});

describe('splitLeafAt（四种 side）', () => {
  it('right：row 分割，目标在前、新叶在后，ratio 0.5', () => {
    const node = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    expect(node).toEqual({
      t: 'split',
      id: 'split:b',
      dir: 'row',
      ratio: 0.5,
      a: { t: 'leaf', id: 'a' },
      b: { t: 'leaf', id: 'b' },
    });
    expect(countPanes(node)).toBe(2);
  });

  it('left：row 分割，新叶在前、目标在后', () => {
    const node = splitLeafAt(leaf('a'), 'a', 'left', 'b') as Extract<WorkbenchNode, { t: 'split' }>;
    expect(node.dir).toBe('row');
    expect(leafIds(node)).toEqual(['b', 'a']);
  });

  it('down：column 分割，目标在前、新叶在后', () => {
    const node = splitLeafAt(leaf('a'), 'a', 'down', 'b') as Extract<WorkbenchNode, { t: 'split' }>;
    expect(node.dir).toBe('column');
    expect(leafIds(node)).toEqual(['a', 'b']);
  });

  it('up：column 分割，新叶在前、目标在后', () => {
    const node = splitLeafAt(leaf('a'), 'a', 'up', 'b') as Extract<WorkbenchNode, { t: 'split' }>;
    expect(node.dir).toBe('column');
    expect(leafIds(node)).toEqual(['b', 'a']);
  });

  it('目标叶不存在 → null', () => {
    expect(splitLeafAt(leaf('a'), 'ghost', 'right', 'b')).toBeNull();
  });

  it('可在嵌套树的深层叶继续分裂（新分割 id 由新叶 id 派生，确定性且唯一）', () => {
    const s1 = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    const s2 = splitLeafAt(s1, 'b', 'down', 'c')!;
    expect(findLeaf(s2, 'c')).toEqual({ t: 'leaf', id: 'c' });
    expect(countPanes(s2)).toBe(3);
    // b 所在的分割 id 由 c 派生
    expect(JSON.stringify(s2)).toContain('split:c');
  });
});

describe('removeLeaf 塌缩', () => {
  it('移除一叶 → 父分割由另一侧子节点顶替（分割 id 消失）', () => {
    const s1 = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    const s2 = splitLeafAt(s1, 'b', 'down', 'c')!;
    const collapsed = removeLeaf(s2, 'c')!;
    expect(countPanes(collapsed)).toBe(2);
    expect(leafIds(collapsed)).toEqual(['a', 'b']);
    expect(JSON.stringify(collapsed)).not.toContain('split:c');
  });

  it('移除根叶 → null（树清空）', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
  });

  it('移除不存在的叶 → 原引用不变', () => {
    const tree = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    expect(removeLeaf(tree, 'ghost')).toBe(tree);
  });

  it('四格逐层塌缩到单格', () => {
    let tree: WorkbenchNode = leaf('a');
    tree = splitLeafAt(tree, 'a', 'right', 'b')!;
    tree = splitLeafAt(tree, 'b', 'down', 'c')!;
    tree = splitLeafAt(tree, 'c', 'right', 'd')!;
    expect(countPanes(tree)).toBe(4);
    tree = removeLeaf(tree, 'd')!;
    tree = removeLeaf(tree, 'c')!;
    tree = removeLeaf(tree, 'b')!;
    expect(tree).toEqual({ t: 'leaf', id: 'a' });
  });
});

describe('replaceLeaf / setSplitRatio / clampRatio', () => {
  it('replaceLeaf 命中替换、未命中原引用', () => {
    const tree = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    const replaced = replaceLeaf(tree, 'a', leaf('x'));
    expect(leafIds(replaced)).toEqual(['x', 'b']);
    expect(replaceLeaf(tree, 'ghost', leaf('x'))).toBe(tree);
  });

  it('setSplitRatio 钳制到 [0.25, 0.75]；同值/未命中返回原引用', () => {
    const tree = splitLeafAt(leaf('a'), 'a', 'right', 'b')!;
    const high = setSplitRatio(tree, 'split:b', 0.9) as Extract<WorkbenchNode, { t: 'split' }>;
    expect(high.ratio).toBe(0.75);
    const low = setSplitRatio(tree, 'split:b', 0.1) as Extract<WorkbenchNode, { t: 'split' }>;
    expect(low.ratio).toBe(0.25);
    expect(setSplitRatio(tree, 'split:b', 0.5)).toBe(tree);
    expect(setSplitRatio(tree, 'ghost', 0.3)).toBe(tree);
  });

  it('clampRatio：越界钳制、NaN 回落 0.5', () => {
    expect(clampRatio(0.1)).toBe(0.25);
    expect(clampRatio(0.9)).toBe(0.75);
    expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe('绑定查询', () => {
  it('findLeafBySession 去重判据；null / 未命中返回 undefined', () => {
    const bindings = { p1: 'a', p2: 'b' };
    expect(findLeafBySession(bindings, 'b')).toBe('p2');
    expect(findLeafBySession(bindings, 'ghost')).toBeUndefined();
    expect(findLeafBySession(bindings, null)).toBeUndefined();
  });

  it('sessionOfLeaf 取叶绑定', () => {
    expect(sessionOfLeaf({ p1: 'a' }, 'p1')).toBe('a');
    expect(sessionOfLeaf({ p1: 'a' }, 'p2')).toBeUndefined();
  });
});
