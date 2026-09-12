// T2-1 纵向分层布局原语单测：固定层 / flex 比例分配 / min 约束 / 极端小终端。
// 覆盖 grok 分层：scrollback(flex) / 输入框(自适应) / 状态行 / 快捷键条(固定)。
import { describe, expect, it } from 'vitest';
import { columnLayout } from '../../../src/tui/renderer/layout.js';

describe('columnLayout 固定层', () => {
  it('全部固定层：top 依次累加', () => {
    const r = columnLayout({ total: 10, layers: [{ size: 3 }, { size: 2 }] });
    expect(r).toEqual([
      { top: 0, height: 3 },
      { top: 3, height: 2 },
    ]);
  });

  it('grok 分层：scrollback(flex) + 输入(3) + 状态行(1) + 快捷键条(1)，24 行终端', () => {
    const r = columnLayout({
      total: 24,
      layers: [{ flex: 1 }, { size: 3 }, { size: 1 }, { size: 1 }],
    });
    expect(r).toEqual([
      { top: 0, height: 19 },
      { top: 19, height: 3 },
      { top: 22, height: 1 },
      { top: 23, height: 1 },
    ]);
  });
});

describe('columnLayout flex 分配', () => {
  it('flex 1:1 均分', () => {
    const r = columnLayout({ total: 10, layers: [{ flex: 1 }, { flex: 1 }] });
    expect(r.map((l) => l.height)).toEqual([5, 5]);
    expect(r.map((l) => l.top)).toEqual([0, 5]);
  });

  it('flex 1:3 不能整除时余数确定性归尾层', () => {
    const r = columnLayout({ total: 10, layers: [{ flex: 1 }, { flex: 3 }] });
    expect(r.map((l) => l.height)).toEqual([2, 8]);
  });

  it('flex 与 size 混合：flex 只分剩余空间', () => {
    const r = columnLayout({ total: 10, layers: [{ size: 2 }, { flex: 1 }, { flex: 1 }] });
    expect(r.map((l) => l.height)).toEqual([2, 4, 4]);
    expect(r.map((l) => l.top)).toEqual([0, 2, 6]);
  });

  it('缺省 flex 视为 1', () => {
    const r = columnLayout({ total: 8, layers: [{}, { flex: 1 }] });
    expect(r.map((l) => l.height)).toEqual([4, 4]);
  });

  it('flex 总和加权：1:2:1 分 8 行 → 2/4/2', () => {
    const r = columnLayout({ total: 8, layers: [{ flex: 1 }, { flex: 2 }, { flex: 1 }] });
    expect(r.map((l) => l.height)).toEqual([2, 4, 2]);
  });
});

describe('columnLayout min 约束', () => {
  it('flex 层低于 min 时抬升到 min，其余层让出空间', () => {
    const r = columnLayout({ total: 10, layers: [{ flex: 1, min: 6 }, { flex: 1 }] });
    expect(r.map((l) => l.height)).toEqual([6, 4]);
  });

  it('min 抬升后剩余预算仍按 flex 加权分配', () => {
    const r = columnLayout({
      total: 12,
      layers: [{ flex: 1, min: 5 }, { flex: 1 }, { flex: 2 }],
    });
    // 无 min 时 3/3/6；第一层 ideal 3 < 5 → 固定 5，剩 7 按 1:2 → 2.33/4.67 → floor 2/4 余 1 给尾层
    expect(r.map((l) => l.height)).toEqual([5, 2, 5]);
  });

  it('min 总和超过预算时放弃 min，按 flex 比例分配（防止布局溢出）', () => {
    const r = columnLayout({
      total: 4,
      layers: [
        { flex: 1, min: 3 },
        { flex: 1, min: 3 },
      ],
    });
    expect(r.map((l) => l.height)).toEqual([2, 2]);
  });
});

describe('columnLayout 极端小终端', () => {
  it('total=0：全部 0 高度，top 均为 0', () => {
    const r = columnLayout({ total: 0, layers: [{ flex: 1 }, { size: 1 }] });
    expect(r).toEqual([
      { top: 0, height: 0 },
      { top: 0, height: 0 },
    ]);
  });

  it('固定层总高超预算：按声明顺序截断分配，flex 层归零', () => {
    const r = columnLayout({ total: 2, layers: [{ size: 3 }, { size: 2 }, { flex: 1 }] });
    expect(r).toEqual([
      { top: 0, height: 2 },
      { top: 2, height: 0 },
      { top: 2, height: 0 },
    ]);
  });

  it('2 行终端：固定层按声明顺序截断（输入框 2 行，状态行/快捷键条归零）', () => {
    const r = columnLayout({
      total: 2,
      layers: [{ flex: 1 }, { size: 3 }, { size: 1 }, { size: 1 }],
    });
    expect(r.map((l) => l.height)).toEqual([0, 2, 0, 0]);
    expect(r.map((l) => l.top)).toEqual([0, 0, 2, 2]);
  });
});

describe('columnLayout 不变量', () => {
  it('正常预算下 top 连续无重叠、总高不超 total', () => {
    const r = columnLayout({
      total: 30,
      layers: [{ flex: 2 }, { size: 4 }, { flex: 1, min: 2 }, { size: 1 }],
    });
    let expectedTop = 0;
    let sum = 0;
    for (const l of r) {
      expect(l.top).toBe(expectedTop);
      expectedTop += l.height;
      sum += l.height;
    }
    expect(sum).toBeLessThanOrEqual(30);
  });
});
