// T2-5 浮层锚定与渲染单测（headless，纯逻辑，零外部依赖）：
// - anchorOverlay：底部贴 composerTop-1 向上生长；maxHeight 钳制；空间不足钳到屏幕顶；
//   高度 0 → null（不渲染）
// - itemWindow：条目超 maxHeight 时滚动窗口，保持 activeIndex 可见
// - overlayNaturalHeight / overlayChromeRows：标题 + 分隔线 + 条目行高度计算
// - drawOverlay：标题行（两侧留空格）+ 分隔线（─）+ 条目行（active 前缀/高亮、右侧序号
//   1.~9.、超宽截断宽字符安全），只触碰自己的行（差量前提）
// - renderOverlay：经 Screen.render 差量输出；同状态重复渲染 0 字节
// - overlayStackLayout：多浮层自下而上堆叠，空间不足最上层钳到顶并截断
import { describe, expect, it } from 'vitest';
import {
  anchorOverlay,
  drawOverlay,
  itemWindow,
  overlayChromeRows,
  overlayNaturalHeight,
  overlayStackLayout,
  renderOverlay,
  type OverlaySpec,
} from '../../../src/tui/next/overlay.js';
import { displayWidth } from '../../../src/tui/renderer/cell-buffer.js';
import { Screen } from '../../../src/tui/renderer/screen.js';

class MemOut {
  private chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  clear(): void {
    this.chunks = [];
  }
}

/** 构建 buffer 并画一个浮层，返回各行文本（rowText）便捷方法 */
function drawRows(
  cols: number,
  rows: number,
  spec: OverlaySpec,
  layout: { top: number; height: number },
  opts = {},
): string[] {
  const screen = new Screen(new MemOut(), cols, rows);
  screen.start();
  screen.render((buf) => drawOverlay(buf, spec, layout, opts));
  return Array.from({ length: rows }, (_, y) => screen.buffer.rowText(y));
}

/** rowText 恒等于 cols 宽（尾部补空格）；内容断言用 rstrip 去尾部空白 */
function rstrip(s: string | undefined): string {
  return (s ?? '').replace(/ +$/, '');
}

describe('anchorOverlay 锚定定位', () => {
  it('常规：浮层底部贴 composerTop-1，向上生长', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: 5 })).toEqual({ top: 15, height: 5 });
  });

  it('底部边界：top + height === composerTop（不侵入输入框行）', () => {
    const r = anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: 5 });
    expect(r).not.toBeNull();
    expect((r as { top: number; height: number }).top + (r as { top: number; height: number }).height).toBe(20);
  });

  it('maxHeight 钳制高度（如 6 行列表上限）', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: 12, maxHeight: 6 })).toEqual({
      top: 14,
      height: 6,
    });
  });

  it('maxHeight 大于请求高度时不放大', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: 3, maxHeight: 10 })).toEqual({
      top: 17,
      height: 3,
    });
  });

  it('overlayHeight = 0 → null（不渲染）', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: 0 })).toBeNull();
  });

  it('overlayHeight 负数 → null', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: -3 })).toBeNull();
  });

  it('maxHeight = 0 → null', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 20, overlayHeight: 5, maxHeight: 0 })).toBeNull();
  });

  it('总高不足：钳到屏幕顶（top=0，height=min(overlayHeight, composerTop)）', () => {
    // composerTop=4，浮层要 10 行 → 只能给 4 行
    expect(anchorOverlay({ screenRows: 24, composerTop: 4, overlayHeight: 10 })).toEqual({ top: 0, height: 4 });
  });

  it('maxHeight 钳制后仍放不下：钳到屏幕顶（两者叠加取小）', () => {
    // composerTop=2，maxHeight 钳到 3 仍 > 2 → top=0、height=2
    expect(anchorOverlay({ screenRows: 24, composerTop: 2, overlayHeight: 10, maxHeight: 3 })).toEqual({
      top: 0,
      height: 2,
    });
  });

  it('composerTop=1：只剩 1 行可用，浮层钳为 1 行贴顶', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 1, overlayHeight: 5 })).toEqual({ top: 0, height: 1 });
  });

  it('composerTop=0：上方无空间 → null', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 0, overlayHeight: 5 })).toBeNull();
  });

  it('composerTop = screenRows-1（输入框占最后一行）：正常锚定', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 23, overlayHeight: 5 })).toEqual({ top: 18, height: 5 });
  });

  it('浮层恰好等于可用空间：top=0、height=composerTop（不判不足）', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 6, overlayHeight: 6 })).toEqual({ top: 0, height: 6 });
  });

  it('composerTop 超出 screenRows 时钳到 screenRows', () => {
    expect(anchorOverlay({ screenRows: 24, composerTop: 100, overlayHeight: 30 })).toEqual({ top: 0, height: 24 });
  });

  it('screenRows=0：无空间 → null', () => {
    expect(anchorOverlay({ screenRows: 0, composerTop: 0, overlayHeight: 3 })).toBeNull();
  });
});

describe('itemWindow 滚动窗口', () => {
  it('条目不超过 maxRows：全量可见，start=0', () => {
    expect(itemWindow(5, 6)).toEqual({ start: 0, count: 5 });
  });

  it('条目恰好等于 maxRows：全量可见', () => {
    expect(itemWindow(6, 6)).toEqual({ start: 0, count: 6 });
  });

  it('条目超限且无 active：显示前 maxRows 项', () => {
    expect(itemWindow(20, 6)).toEqual({ start: 0, count: 6 });
  });

  it('active 在窗口内（靠前）：start=0，active 可见', () => {
    expect(itemWindow(20, 6, 2)).toEqual({ start: 0, count: 6 });
  });

  it('active 超出窗口底部：窗口下移保持 active 贴底可见', () => {
    expect(itemWindow(20, 6, 7)).toEqual({ start: 2, count: 6 });
    expect(itemWindow(20, 6, 19)).toEqual({ start: 14, count: 6 });
  });

  it('active 移回上方：窗口回到顶部区间', () => {
    expect(itemWindow(20, 6, 3)).toEqual({ start: 0, count: 6 });
  });

  it('active 越界（负数/超尾）：不驱动滚动，显示前 maxRows 项', () => {
    expect(itemWindow(20, 6, -1)).toEqual({ start: 0, count: 6 });
    expect(itemWindow(20, 6, 99)).toEqual({ start: 0, count: 6 });
  });

  it('maxRows=0 或条目数为 0：count=0', () => {
    expect(itemWindow(5, 0)).toEqual({ start: 0, count: 0 });
    expect(itemWindow(0, 6, 0)).toEqual({ start: 0, count: 0 });
  });
});

describe('overlayChromeRows / overlayNaturalHeight 高度计算', () => {
  it('无标题：chrome = 分隔线 1 行', () => {
    expect(overlayChromeRows({ items: ['a'] })).toBe(1);
  });

  it('有标题：chrome = 标题 1 行 + 分隔线 1 行', () => {
    expect(overlayChromeRows({ title: 'Select', items: ['a'] })).toBe(2);
  });

  it('natural = chrome + 全部条目；空条目只有 chrome', () => {
    expect(overlayNaturalHeight({ items: ['a', 'b', 'c'] })).toBe(4);
    expect(overlayNaturalHeight({ title: 'T', items: ['a', 'b', 'c'] })).toBe(5);
    expect(overlayNaturalHeight({ title: 'T', items: [] })).toBe(2);
  });

  it('natural 受 maxItemRows 钳制', () => {
    expect(overlayNaturalHeight({ title: 'T', items: ['a', 'b', 'c', 'd'] }, 6)).toBe(6);
  });
});

describe('drawOverlay 渲染内容', () => {
  it('标题行两侧留空格：` Select an item `', () => {
    const rows = drawRows(30, 8, { title: 'Select an item', items: ['a'] }, { top: 2, height: 3 });
    expect(rows[2]?.startsWith(' Select an item ')).toBe(true);
  });

  it('标题行起始于 x=0（前导空格来自文本本身）', () => {
    const rows = drawRows(30, 8, { title: 'T', items: ['a'] }, { top: 0, height: 3 });
    expect(rows[0]?.startsWith(' T ')).toBe(true);
  });

  it('分隔线行：─ 铺满宽度', () => {
    const rows = drawRows(10, 8, { title: 'T', items: ['a'] }, { top: 0, height: 3 });
    expect(rows[1]).toBe('─'.repeat(10));
  });

  it('无标题：第一行即分隔线，条目跟在其后', () => {
    const rows = drawRows(10, 8, { items: ['a', 'b'] }, { top: 1, height: 3 });
    expect(rows[1]).toBe('─'.repeat(10));
    expect(rows[2]).toContain('a');
    expect(rows[3]).toContain('b');
  });

  it('activeIndex 高亮：前缀 ❯ + 空格；非活动项两个空格对齐', () => {
    const rows = drawRows(30, 8, { items: ['alpha', 'beta', 'gamma'], activeIndex: 1 }, { top: 0, height: 4 });
    expect(rstrip(rows[1])).toBe('  alpha');
    expect(rstrip(rows[2])).toBe('❯ beta');
    expect(rstrip(rows[3])).toBe('  gamma');
  });

  it('activePrefix 可降级为 "> "', () => {
    const rows = drawRows(
      30,
      8,
      { items: ['alpha', 'beta'], activeIndex: 0 },
      { top: 0, height: 3 },
      { activePrefix: '> ' },
    );
    expect(rstrip(rows[1])).toBe('> alpha');
    expect(rstrip(rows[2])).toBe('  beta');
  });

  it('active 行应用 activeFg 前景色，非活动行用默认 fg', () => {
    const screen = new Screen(new MemOut(), 30, 8);
    screen.start();
    screen.render((buf) =>
      drawOverlay(buf, { items: ['alpha', 'beta'], activeIndex: 0 }, { top: 0, height: 3 }, { activeFg: 0x00ffff }),
    );
    const buf = screen.buffer;
    // 第 1 行（active）：前缀与标签均为 activeFg
    expect(buf.fg[1 * 30 + 0]).toBe(0x00ffff);
    expect(buf.fg[1 * 30 + 2]).toBe(0x00ffff);
    // 第 2 行（非 active）：默认色 0
    expect(buf.fg[2 * 30 + 2]).toBe(0);
  });

  it('activeIndex 越界：无高亮行', () => {
    const rows = drawRows(30, 8, { items: ['alpha', 'beta'], activeIndex: 5 }, { top: 0, height: 3 });
    expect(rows.join('\n')).not.toContain('❯');
  });

  it('showNumbers：前 9 项右侧序号 1.~9. 右对齐贴内容区右缘', () => {
    const rows = drawRows(
      20,
      10,
      { items: ['aa', 'bb'], activeIndex: 1 },
      { top: 0, height: 3 },
      { showNumbers: true },
    );
    // 前缀 2 + 标签 2 + 填充 + 序号 3 = 20
    expect(rstrip(rows[1])).toBe(`  aa${' '.repeat(20 - 2 - 2 - 3)} 1.`);
    expect(rstrip(rows[2])).toBe(`❯ bb${' '.repeat(20 - 2 - 2 - 3)} 2.`);
    expect(displayWidth(rows[1] ?? '')).toBe(20);
  });

  it('showNumbers 只标前 9 项，第 10 项无序号', () => {
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    const rows = drawRows(20, 14, { items, activeIndex: 9 }, { top: 0, height: 12 }, { showNumbers: true });
    expect(rstrip(rows[10])).toBe('❯ item-9');
    expect(rstrip(rows[11])).toBe('  item-10');
  });

  it('showNumbers + 标签过长：截断标签，序号仍贴右缘不被挤掉', () => {
    const rows = drawRows(
      15,
      8,
      { items: ['averylonglabeltext'], activeIndex: 0 },
      { top: 0, height: 2 },
      { showNumbers: true },
    );
    // 前缀 2 列 + 序号区 3 列 → 标签最多 10 列
    expect(rstrip(rows[1])).toBe('❯ averylongl 1.');
    expect(displayWidth(rows[1] ?? '')).toBe(15);
  });

  it('超宽条目：整字丢弃截断，不超内容区宽度', () => {
    const rows = drawRows(8, 8, { items: ['short', 'a-very-long-label'], activeIndex: 1 }, { top: 0, height: 3 });
    expect(rstrip(rows[1])).toBe('  short');
    expect(rstrip(rows[2])).toBe('❯ a-very'); // 8 列截断
    expect(displayWidth(rows[2] ?? '')).toBeLessThanOrEqual(8);
  });

  it('CJK 宽字符条目：放不下整字丢弃，绝不切半边（行宽不留半字符空洞）', () => {
    // cols=9：前缀(2) + CJK 标签(12) → 7 列可用 → '中文中'(6)，第 4 个 CJK 放不下整字丢弃
    const rows = drawRows(9, 8, { items: ['中文中文中文'], activeIndex: 0 }, { top: 0, height: 2 });
    expect(rstrip(rows[1])).toBe('❯ 中文中');
    expect(displayWidth(rows[1] ?? '')).toBeLessThanOrEqual(9);
  });

  it('CJK 标签 + showNumbers：序号右对齐且标签截断不越界', () => {
    const rows = drawRows(
      14,
      8,
      { items: ['中文标签很长很长'], activeIndex: 0 },
      { top: 0, height: 2 },
      { showNumbers: true },
    );
    // 前缀 2 + 标签（9 列容量 → '中文标签' 8 列）+ 填充 1 + 序号 3 = 14
    expect(rstrip(rows[1])).toBe('❯ 中文标签  1.');
    expect(displayWidth(rows[1] ?? '')).toBe(14);
  });

  it('条目超 maxHeight：滚动窗口生效，activeIndex 始终可见', () => {
    const items = Array.from({ length: 10 }, (_, i) => `opt-${i}`);
    // maxHeight=6，active=7 → 窗口 [2..7]
    const rows = drawRows(20, 12, { items, activeIndex: 7 }, { top: 0, height: 8 }, { maxItemRows: 6 });
    expect(rstrip(rows[1])).toBe('  opt-2');
    expect(rstrip(rows[6])).toBe('❯ opt-7'); // 无标题：y=0 分隔线，条目 y=1~6
    expect(rows.join('\n')).not.toContain('opt-0');
    expect(rows.join('\n')).not.toContain('opt-8');
  });

  it('height 不足以容纳 chrome+条目：条目被钳到剩余行数（不越界绘制）', () => {
    // height=2、无标题 → 1 行分隔线 + 1 行条目（3 项只显示 1 项）
    const rows = drawRows(20, 6, { items: ['a', 'b', 'c'] }, { top: 0, height: 2 });
    expect(rows[0]).toBe('─'.repeat(20));
    expect(rows[1]).toContain('a');
    expect(rows[2]).toBe(' '.repeat(20)); // 未被浮层触碰
  });

  it('height=1 且有标题：只画标题行，不画分隔线', () => {
    const rows = drawRows(20, 6, { title: 'T', items: ['a'] }, { top: 0, height: 1 });
    expect(rows[0]?.startsWith(' T ')).toBe(true);
    expect(rows[1]).toBe(' '.repeat(20));
  });

  it('只触碰自己 [top, top+height) 的行：其余行保持空白', () => {
    const rows = drawRows(20, 10, { title: 'T', items: ['a'] }, { top: 4, height: 3 });
    expect(rows[3]).toBe(' '.repeat(20));
    expect(rows[4]?.startsWith(' T ')).toBe(true);
    expect(rows[7]).toBe(' '.repeat(20));
  });

  it('height=0 或负数：什么都不画', () => {
    const rows = drawRows(20, 6, { title: 'T', items: ['a'] }, { top: 0, height: 0 });
    expect(rows.every((r) => r === ' '.repeat(20))).toBe(true);
    expect(
      drawRows(20, 6, { title: 'T', items: ['a'] }, { top: 0, height: -2 }).every((r) => r === ' '.repeat(20)),
    ).toBe(true);
  });

  it('layout.top 为负：越界行被静默忽略，不抛异常', () => {
    const rows = drawRows(20, 6, { title: 'T', items: ['a'] }, { top: -1, height: 3 });
    // top=-1 的标题行被忽略；分隔线落在 y=0，条目落在 y=1
    expect(rows[0]).toBe('─'.repeat(20));
    expect(rows[1]).toContain('a');
  });

  it('OverlayItem 对象形式与字符串形式等价', () => {
    const rows = drawRows(20, 8, { items: [{ label: 'obj' }, 'str'] }, { top: 0, height: 3 });
    expect(rows[1]).toContain('obj');
    expect(rows[2]).toContain('str');
  });

  it('宽度收窄（width < buf.cols）：不越过给定宽度', () => {
    const screen = new Screen(new MemOut(), 30, 6);
    screen.start();
    screen.render((buf) => drawOverlay(buf, { title: 'T', items: ['a'] }, { top: 0, height: 3 }, { width: 10 }));
    const buf = screen.buffer;
    expect(buf.rowText(1)).toBe('─'.repeat(10) + ' '.repeat(20));
  });
});

describe('renderOverlay 经 Screen 差量输出', () => {
  it('首次渲染输出 > 0 字节', () => {
    const out = new MemOut();
    const screen = new Screen(out, 30, 10);
    screen.start();
    out.clear();
    const n = renderOverlay(screen, { title: 'T', items: ['a', 'b'] }, { top: 0, height: 4 });
    expect(n).toBeGreaterThan(0);
  });

  it('同状态重复渲染：0 字节（差量性）', () => {
    const out = new MemOut();
    const screen = new Screen(out, 30, 10);
    screen.start();
    const spec: OverlaySpec = { title: 'T', items: ['a', 'b'], activeIndex: 1 };
    renderOverlay(screen, spec, { top: 2, height: 4 });
    out.clear();
    const n = renderOverlay(screen, spec, { top: 2, height: 4 });
    expect(n).toBe(0);
    expect(out.text).toBe('');
  });

  it('activeIndex 变化：差量输出，且未变化行内容保持不变', () => {
    const out = new MemOut();
    const screen = new Screen(out, 30, 10);
    screen.start();
    renderOverlay(screen, { title: 'T', items: ['a', 'b', 'c'], activeIndex: 0 }, { top: 2, height: 5 });
    const before = Array.from({ length: 10 }, (_, y) => screen.buffer.rowText(y));
    out.clear();
    renderOverlay(screen, { title: 'T', items: ['a', 'b', 'c'], activeIndex: 2 }, { top: 2, height: 5 });
    const n = out.text.length;
    expect(n).toBeGreaterThan(0);
    const after = Array.from({ length: 10 }, (_, y) => screen.buffer.rowText(y));
    // 标题(y=2)/分隔线(y=3)行不变；条目行 y=4~6，仅高亮位置移动
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
    expect(rstrip(after[4])).toBe('  a');
    expect(rstrip(after[6])).toBe('❯ c');
  });

  it('未 start 的 Screen：render 返回 0 字节', () => {
    const out = new MemOut();
    const screen = new Screen(out, 30, 10);
    const n = renderOverlay(screen, { title: 'T', items: ['a'] }, { top: 0, height: 3 });
    expect(n).toBe(0);
  });
});

describe('overlayStackLayout 多浮层堆叠', () => {
  it('空栈：返回空数组', () => {
    expect(overlayStackLayout({ screenRows: 24, composerTop: 20, overlays: [] })).toEqual([]);
  });

  it('单浮层：与 anchorOverlay 等价（底部贴 composerTop-1）', () => {
    const r = overlayStackLayout({ screenRows: 24, composerTop: 20, overlays: [{ height: 5 }] });
    expect(r).toEqual([{ top: 15, height: 5 }]);
  });

  it('两个浮层：第一个贴 composer，第二个贴第一个上方，互不重叠', () => {
    const r = overlayStackLayout({ screenRows: 24, composerTop: 20, overlays: [{ height: 4 }, { height: 3 }] });
    expect(r).toEqual([
      { top: 16, height: 4 },
      { top: 13, height: 3 },
    ]);
    // 不重叠：第二层底 === 第一层顶
    const first = r[0] as { top: number };
    const second = r[1] as { top: number; height: number };
    expect(second.top + second.height).toBe(first.top);
  });

  it('三个浮层自下而上依次堆叠', () => {
    const r = overlayStackLayout({
      screenRows: 24,
      composerTop: 22,
      overlays: [{ height: 3 }, { height: 3 }, { height: 3 }],
    });
    expect(r).toEqual([
      { top: 19, height: 3 },
      { top: 16, height: 3 },
      { top: 13, height: 3 },
    ]);
  });

  it('空间不足：最上面的浮层钳到屏幕顶并截断高度', () => {
    // composerTop=6，需 4+4=8 行 > 6 → 第二层 top=0、height=2
    const r = overlayStackLayout({ screenRows: 24, composerTop: 6, overlays: [{ height: 4 }, { height: 4 }] });
    expect(r).toEqual([
      { top: 2, height: 4 },
      { top: 0, height: 2 },
    ]);
  });

  it('空间完全耗尽：后续浮层 height=0 → null', () => {
    const r = overlayStackLayout({ screenRows: 24, composerTop: 4, overlays: [{ height: 4 }, { height: 3 }] });
    expect(r).toEqual([{ top: 0, height: 4 }, null]);
  });

  it('composerTop=0：全部浮层为 null', () => {
    expect(overlayStackLayout({ screenRows: 24, composerTop: 0, overlays: [{ height: 3 }, { height: 3 }] })).toEqual([
      null,
      null,
    ]);
  });

  it('堆叠各行区间互不重叠且都落在 [0, composerTop) 内', () => {
    const r = overlayStackLayout({
      screenRows: 24,
      composerTop: 8,
      overlays: [{ height: 3 }, { height: 3 }, { height: 5 }],
    });
    let prevTop = 8;
    for (const rect of r) {
      if (rect === null) continue;
      expect(rect.top + rect.height).toBeLessThanOrEqual(prevTop);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      prevTop = rect.top;
    }
  });
});
