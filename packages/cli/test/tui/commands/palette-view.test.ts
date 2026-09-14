// P3-A palette-view 单测（headless）：drawPalette 写 CellBuffer 的行组成断言。
// 覆盖：标题/分隔线、组头行、命令行（active 前缀 ❯、label+摘要、badge 右对齐）、
// 滚动窗口（maxRows 跟随 active）、窄宽度 badge 让位、越界不绘制、查询联动重绘。
// 行组成：prefix(2) + body(label+两空格+摘要) + pad + badge（badgeWidth+1 列，含间隔）。
import { describe, expect, it } from 'vitest';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import { drawPalette, PALETTE_ACTIVE_FG, paletteNaturalHeight } from '../../../src/tui/commands/palette-view.js';
import {
  filterPaletteRows,
  paletteOpenState,
  paletteSetQuery,
  type PaletteEntry,
  type PaletteRow,
} from '../../../src/tui/commands/palette-model.js';

function entry(
  name: string,
  group: string,
  modeSupport: PaletteEntry['modeSupport'] = 'available',
  source: 'core' | 'shell' = 'core',
): PaletteEntry {
  return { name, summary: `${name} 的描述`, source, group, modeSupport };
}

const FIXTURE: readonly PaletteEntry[] = [
  entry('new', '会话'),
  entry('session-info', '会话'),
  entry('timeline', '历史', 'unavailable-fullscreen-only'),
  entry('mode', '模式', 'available', 'shell'),
];

/** 构建 buffer 画面板，返回各行 rowText（rstrip 尾部空白） */
function drawAt(
  rows: ReadonlyArray<PaletteRow>,
  active: number,
  cols: number,
  totalRows: number,
  rect: { top: number; height: number },
  opts?: Parameters<typeof drawPalette>[4],
): string[] {
  const buf = new CellBuffer(cols, totalRows);
  drawPalette(buf, { open: true, query: '', active }, rows, rect, opts);
  return Array.from({ length: totalRows }, (_, y) => buf.rowText(y).replace(/\s+$/, ''));
}

const rstrip = (s: string | undefined): string => (s ?? '').replace(/\s+$/, '');

describe('drawPalette 行组成', () => {
  it('标题行（两侧空格）+ 分隔线 + 组头行 + 命令行（badge 右对齐）', () => {
    const rows = filterPaletteRows('', FIXTURE); // [#会话, new, session-info, #历史, timeline, #模式, mode]
    const lines = drawAt(rows, 1, 60, 10, { top: 0, height: 10 });
    expect(lines[0]).toBe(' 命令面板');
    expect(lines[1]).toBe('─'.repeat(60));
    expect(lines[2]).toBe('── 会话');
    // active 行：❯ + body(16) + pad(51-16=35) + [core](6)
    expect(rstrip(lines[3])).toBe('❯ /new  new 的描述' + ' '.repeat(35) + '[core]');
    // 非 active 行：等宽空格前缀对齐；body(34) + pad(17)
    expect(rstrip(lines[4])).toBe('  /session-info  session-info 的描述' + ' '.repeat(17) + '[core]');
    expect(lines[5]).toBe('── 历史');
  });

  it('模式限定 badge：modeSupport=unavailable-fullscreen-only 的条目渲染 [仅 fullscreen]', () => {
    const rows = filterPaletteRows('timeline', FIXTURE); // [#历史, timeline]
    const lines = drawAt(rows, 1, 60, 6, { top: 0, height: 6 });
    expect(lines[2]).toBe('── 历史');
    // badge [仅 fullscreen] 宽 15 → badgeCols 16、bodyCols 42、body 26、pad 16
    expect(rstrip(lines[3])).toBe('❯ /timeline  timeline 的描述' + ' '.repeat(16) + '[仅 fullscreen]');
  });

  it('非 active 命令行 fg = 0、active 行与组头各有独立前景色（fg 换色高亮）', () => {
    const rows = filterPaletteRows('', FIXTURE); // [#会话(0), new(1), session-info(2), ...]
    const buf = new CellBuffer(60, 10);
    drawPalette(buf, paletteOpenState(rows), rows, { top: 0, height: 10 });
    expect(buf.fg[2 * 60]).toBe(0x8b949e); // 组头行（headerFg 暗灰）
    expect(buf.fg[3 * 60]).toBe(PALETTE_ACTIVE_FG); // /new（active）
    expect(buf.fg[4 * 60]).toBe(0); // session-info 非 active = 默认色
  });

  it('滚动窗口：maxRows 限制可见行数且窗口跟随 active（itemWindow 复用）', () => {
    const rows = filterPaletteRows('', FIXTURE);
    // 高度 5 = 标题 + 分隔线 + 3 行条目；active 指向最后一条（mode）→ 窗口贴底
    const lines = drawAt(rows, rows.length - 1, 60, 10, { top: 0, height: 5 }, { maxRows: 3 });
    expect(rstrip(lines[4])).toContain('/mode');
    expect(lines[2]).not.toContain('── 会话');
  });

  it('窄宽度：badge 让位、label 保底（不切宽字符半边）', () => {
    const rows = filterPaletteRows('new', FIXTURE); // [#会话, new]
    // 宽 12：前缀 2、contentCols 10；'[core]'+间隔 7 → 10-7 < 4 → badge 丢弃
    const lines = drawAt(rows, 1, 12, 4, { top: 0, height: 4 });
    expect(lines[2]).toBe('── 会话');
    expect(rstrip(lines[3])).toBe('❯ /new');
  });

  it('越界不绘制（top ≥ buf.rows）且不改 buffer', () => {
    const rows = filterPaletteRows('', FIXTURE);
    const buf = new CellBuffer(30, 4);
    const before = Array.from({ length: 4 }, (_, y) => buf.rowText(y));
    drawPalette(buf, paletteOpenState(rows), rows, { top: 4, height: 3 });
    expect(Array.from({ length: 4 }, (_, y) => buf.rowText(y))).toEqual(before);
  });

  it('paletteNaturalHeight：chrome(标题+分隔线) + min(rows, maxRows)', () => {
    expect(paletteNaturalHeight(7)).toBe(9);
    expect(paletteNaturalHeight(7, { maxRows: 3 })).toBe(5);
    expect(paletteNaturalHeight(7, { title: '' })).toBe(8);
  });
});

describe('drawPalette 与查询状态联动（同一面板随 query 变化重绘）', () => {
  it('setQuery 过滤后重绘只含命中组', () => {
    const rows0 = filterPaletteRows('', FIXTURE);
    const rows1 = filterPaletteRows('mode', FIXTURE); // [#模式, mode]
    const st = paletteSetQuery(paletteOpenState(rows0), 'mode', rows1);
    const lines = drawAt(rows1, st.active, 60, 6, { top: 0, height: 6 });
    expect(lines[2]).toBe('── 模式');
    expect(rstrip(lines[3])).toContain('/mode');
    expect(rstrip(lines[3])).toContain('[shell]');
  });
});
