// P4-1 scrollback 选择与超链接单测：URL 区段检测（行首/行尾/多 URL/CJK）、选择几何
// （反向拖/跨行/宽字符首列判定）、getSelectedText（软折行逻辑重组）、drawScrollback
// 选中高亮（fg 换色方案）与滚动条/链接共存。
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p4a-evidence）。
import { describe, expect, it } from 'vitest';
import { SELECTION_FG, Scrollback, detectUrlSegments, drawScrollback } from '../../../src/tui/next/scrollback.js';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';

// —— URL 区段检测 ——
describe('detectUrlSegments', () => {
  it('行中单 URL：列区间正确（https://a.io = 12 列）', () => {
    expect(detectUrlSegments('see https://a.io end')).toEqual([{ startCol: 4, endCol: 16, url: 'https://a.io' }]);
  });

  it('行首 URL：startCol = 0', () => {
    expect(detectUrlSegments('https://a.dev x')).toEqual([{ startCol: 0, endCol: 13, url: 'https://a.dev' }]);
  });

  it('行尾 URL：endCol = 行显示宽', () => {
    expect(detectUrlSegments('go https://end.io')).toEqual([{ startCol: 3, endCol: 17, url: 'https://end.io' }]);
  });

  it('一行多 URL：两个区段且列区间不相交', () => {
    expect(detectUrlSegments('a https://x.io b https://y.io')).toEqual([
      { startCol: 2, endCol: 14, url: 'https://x.io' },
      { startCol: 17, endCol: 29, url: 'https://y.io' },
    ]);
  });

  it('CJK 前缀：startCol 计入宽字符（中文各占 2 列）', () => {
    expect(detectUrlSegments('中文 https://a.dev')).toEqual([{ startCol: 5, endCol: 18, url: 'https://a.dev' }]);
  });

  it('URL 内含 CJK：区段覆盖宽字符（每字 2 列，run 边界完整）', () => {
    expect(detectUrlSegments('https://中.io')).toEqual([{ startCol: 0, endCol: 13, url: 'https://中.io' }]);
  });

  it('无 URL：空数组', () => {
    expect(detectUrlSegments('no link here')).toEqual([]);
  });

  it('空串：空数组', () => {
    expect(detectUrlSegments('')).toEqual([]);
  });
});

// —— 选择几何 ——
describe('Scrollback 选择几何', () => {
  const sb = () => new Scrollback(['alpha beta', 'gamma delta', 'omega'], 20);

  it('beginSelection + extendSelection（正向）：range 归一化', () => {
    const s = sb();
    s.beginSelection({ row: 0, col: 2 });
    s.extendSelection({ row: 1, col: 5 });
    expect(s.selectionRange()).toEqual({ startRow: 0, startCol: 2, endRow: 1, endCol: 5 });
    expect(s.hasSelection).toBe(true);
  });

  it('反向拖（extend 到 anchor 左上）：range 仍归一化（方向无关）', () => {
    const s = sb();
    s.beginSelection({ row: 1, col: 8 });
    s.extendSelection({ row: 0, col: 3 });
    expect(s.selectionRange()).toEqual({ startRow: 0, startCol: 3, endRow: 1, endCol: 8 });
  });

  it('begin 未 extend：零宽区间、hasSelection false（Ctrl+C 不被劫持）', () => {
    const s = sb();
    s.beginSelection({ row: 0, col: 1 });
    expect(s.hasSelection).toBe(false);
    expect(s.selectionRange()).toEqual({ startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
  });

  it('clearSelection：hasSelection false、range null', () => {
    const s = sb();
    s.beginSelection({ row: 0, col: 0 });
    s.extendSelection({ row: 2, col: 1 });
    s.clearSelection();
    expect(s.hasSelection).toBe(false);
    expect(s.selectionRange()).toBeNull();
  });

  it('physicalRowAt：绝对物理行 → text/lineIndex/segIndex；越界 null', () => {
    const s = new Scrollback(['aaa bbb'], 4); // 折成 'aaa '（尾随空格占列）+ 'bbb'
    expect(s.physicalRowAt(0)).toEqual({ text: 'aaa ', lineIndex: 0, segIndex: 0 });
    expect(s.physicalRowAt(1)).toEqual({ text: 'bbb', lineIndex: 0, segIndex: 1 });
    expect(s.physicalRowAt(2)).toBeNull();
    expect(s.physicalRowAt(-1)).toBeNull();
  });
});

// —— getSelectedText ——
describe('getSelectedText', () => {
  it('单行部分列：按显示列切片', () => {
    const s = new Scrollback(['hello world'], 20);
    s.beginSelection({ row: 0, col: 0 });
    s.extendSelection({ row: 0, col: 5 });
    expect(s.getSelectedText()).toBe('hello');
  });

  it('宽字符首列判定：列区间命中首列的字符整字入选', () => {
    const s = new Scrollback(['中文世界'], 20);
    s.beginSelection({ row: 0, col: 2 });
    s.extendSelection({ row: 0, col: 6 });
    expect(s.getSelectedText()).toBe('文世'); // 文 head 2、世 head 4；界 head 6 不入
  });

  it('跨行（不同逻辑行）：以 \\n 连接', () => {
    const s = new Scrollback(['aaa', 'bbb', 'ccc'], 20);
    s.beginSelection({ row: 0, col: 0 });
    s.extendSelection({ row: 2, col: 3 });
    expect(s.getSelectedText()).toBe('aaa\nbbb\nccc');
  });

  it('同逻辑行软折行重组：物理行间不加 \\n（去换行噪音，取舍钉死）', () => {
    const s = new Scrollback(['aaaa bbbb cccc dddd'], 10); // 折成 'aaaa bbbb ' + 'cccc dddd'
    s.beginSelection({ row: 0, col: 0 });
    s.extendSelection({ row: 1, col: 9 });
    expect(s.getSelectedText()).toBe('aaaa bbbb cccc dddd');
  });

  it('反向选择与正向同文本', () => {
    const s = new Scrollback(['hello world'], 20);
    s.beginSelection({ row: 0, col: 5 });
    s.extendSelection({ row: 0, col: 0 });
    expect(s.getSelectedText()).toBe('hello');
  });

  it('列超出行宽：钳制到行尾（不产生尾随空格）', () => {
    const s = new Scrollback(['short'], 20);
    s.beginSelection({ row: 0, col: 0 });
    s.extendSelection({ row: 0, col: 500 });
    expect(s.getSelectedText()).toBe('short');
  });

  it('空滚动区：返回空串不抛错', () => {
    const s = new Scrollback([], 20);
    s.beginSelection({ row: 0, col: 0 });
    s.extendSelection({ row: 0, col: 3 });
    expect(s.getSelectedText()).toBe('');
  });
});

// —— drawScrollback：选中高亮（fg 换色）与链接标记 ——
describe('drawScrollback 选中高亮与链接标记', () => {
  const COLS = 21; // 20 内容列 + 1 滚动条列

  it('选中格 fg = SELECTION_FG，未选格 fg 保持原值', () => {
    const sb = new Scrollback(['hello world'], COLS - 1);
    sb.beginSelection({ row: 0, col: 0 });
    sb.extendSelection({ row: 0, col: 5 });
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    for (let x = 0; x < 5; x += 1) expect(buf.fg[x]).toBe(SELECTION_FG);
    expect(buf.fg[5]).toBe(0);
    expect(buf.rowText(0).startsWith('hello world')).toBe(true);
  });

  it('宽字符选中：首列与续列同色（不切半边）', () => {
    const sb = new Scrollback(['中文测试'], COLS - 1);
    sb.beginSelection({ row: 0, col: 0 });
    sb.extendSelection({ row: 0, col: 4 }); // 中+文（各 2 列）
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    expect(buf.fg[0]).toBe(SELECTION_FG);
    expect(buf.fg[1]).toBe(SELECTION_FG); // 中 续列
    expect(buf.fg[2]).toBe(SELECTION_FG);
    expect(buf.fg[3]).toBe(SELECTION_FG); // 文 续列
    expect(buf.fg[4]).toBe(0); // 测 未选中
  });

  it('滚动条列不受选择影响', () => {
    const sb = new Scrollback(['hello world'], COLS - 1);
    sb.beginSelection({ row: 0, col: 0 });
    sb.extendSelection({ row: 0, col: 20 }); // 选满整行
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    expect(buf.fg[COLS - 1]).toBe(0); // 滚动条轨道列保持默认色
    expect(buf.chars[COLS - 1]).toBe('│');
  });

  it('清除选择后重绘：fg 还原默认', () => {
    const sb = new Scrollback(['hello world'], COLS - 1);
    sb.beginSelection({ row: 0, col: 0 });
    sb.extendSelection({ row: 0, col: 5 });
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    sb.clearSelection();
    const buf2 = new CellBuffer(COLS, 1);
    drawScrollback(buf2, sb, {});
    for (let x = 0; x < COLS - 1; x += 1) expect(buf2.fg[x]).toBe(0);
  });

  it('URL 行绘制：URL 区段 linkId 标记 + 注册表反查；非 URL 列为 0', () => {
    const sb = new Scrollback(['see https://a.io end'], COLS - 1);
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    expect(buf.linkIdAt(4, 0)).toBeGreaterThan(0);
    expect(buf.linkIdAt(15, 0)).toBeGreaterThan(0);
    expect(buf.linkUrl(buf.linkIdAt(4, 0))).toBe('https://a.io');
    expect(buf.linkIdAt(0, 0)).toBe(0); // 'see ' 前缀
    expect(buf.linkIdAt(17, 0)).toBe(0); // ' end' 后缀
  });

  it('URL 内含 CJK：首列与续列都标 linkId（run 边界完整）', () => {
    const sb = new Scrollback(['https://中.io'], COLS - 1);
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    for (let x = 0; x < 13; x += 1) expect(buf.linkIdAt(x, 0)).toBeGreaterThan(0);
    expect(buf.linkIdAt(13, 0)).toBe(0);
  });

  it('选择与链接共存：选中 URL 格 linkId 保留且 fg 高亮', () => {
    const sb = new Scrollback(['see https://a.io end'], COLS - 1);
    sb.beginSelection({ row: 0, col: 0 });
    sb.extendSelection({ row: 0, col: 10 });
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, {});
    const id = buf.linkIdAt(4, 0);
    expect(id).toBeGreaterThan(0);
    expect(buf.linkUrl(id)).toBe('https://a.io');
    expect(buf.fg[4]).toBe(SELECTION_FG);
  });

  it('跨物理行选择：中间行整行高亮、首尾行按列高亮', () => {
    const sb = new Scrollback(['row0', 'row1', 'row2'], COLS - 1);
    sb.beginSelection({ row: 0, col: 2 });
    sb.extendSelection({ row: 2, col: 2 });
    const buf = new CellBuffer(COLS, 3);
    drawScrollback(buf, sb, {});
    expect(buf.fg[0]).toBe(0); // row0 前 2 列未选
    expect(buf.fg[2]).toBe(SELECTION_FG); // row0 col2 起
    expect(buf.fg[21 + 0]).toBe(SELECTION_FG); // row1 整行
    expect(buf.fg[42 + 0]).toBe(SELECTION_FG); // row2 前 2 列
    expect(buf.fg[42 + 2]).toBe(0);
  });
});
