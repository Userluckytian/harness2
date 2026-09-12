// T2-1 cell buffer 单测：East Asian 宽字符判定、续列、writeText 截断（不切半边）、
// rowText、clear、resize（内容保留左上）。
import { describe, expect, it } from 'vitest';
import { CellBuffer, charWidth, codeToFgSgr, displayWidth, fgToCode } from '../../../src/tui/renderer/cell-buffer.js';

describe('charWidth 宽字符判定', () => {
  it('ASCII 半宽 = 1', () => {
    expect(charWidth('a'.codePointAt(0)!)).toBe(1);
    expect(charWidth(' '.codePointAt(0)!)).toBe(1);
    expect(charWidth('~'.codePointAt(0)!)).toBe(1);
  });

  it('CJK 统一表意 = 2', () => {
    expect(charWidth('中'.codePointAt(0)!)).toBe(2);
    expect(charWidth('文'.codePointAt(0)!)).toBe(2);
  });

  it('谚文音节 = 2', () => {
    expect(charWidth('한'.codePointAt(0)!)).toBe(2);
  });

  it('全角 ASCII = 2', () => {
    expect(charWidth('Ａ'.codePointAt(0)!)).toBe(2);
    expect(charWidth('１'.codePointAt(0)!)).toBe(2);
  });

  it('平假名 = 2', () => {
    expect(charWidth('あ'.codePointAt(0)!)).toBe(2);
  });

  it('emoji 按 2 列近似（已知近似：未收录完整 emoji-presentation 集合）', () => {
    expect(charWidth('\u{1F600}'.codePointAt(0)!)).toBe(2); // 😀
    expect(charWidth('\u{1F680}'.codePointAt(0)!)).toBe(2); // 🚀
  });

  it('组合字符 / ZWJ / 变体选择符按 0 列（近似）', () => {
    expect(charWidth(0x0301)).toBe(0); // 组合音标
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfe0f)).toBe(0); // VS16
    expect(charWidth(0xfe0e)).toBe(0); // VS15
  });

  it('displayWidth 按码点累加', () => {
    expect(displayWidth('ab中')).toBe(4);
    expect(displayWidth('a中\u{1F600}')).toBe(5);
    expect(displayWidth('')).toBe(0);
  });
});

describe('fgToCode / codeToFgSgr 颜色编码', () => {
  it('#rrggbb → 24bit int', () => {
    expect(fgToCode('#ff0000')).toBe(0xff0000);
    expect(fgToCode('#0a0b0c')).toBe(0x0a0b0c);
  });

  it('null / 非法值 → 0（默认色）', () => {
    expect(fgToCode(null)).toBe(0);
    expect(fgToCode(undefined)).toBe(0);
    expect(fgToCode('nothex')).toBe(0);
  });

  it('24bit int → SGR truecolor 前景序列', () => {
    expect(codeToFgSgr(0xff0000)).toBe('\x1b[38;2;255;0;0m');
  });

  it('0 → 空串（默认色不发射）', () => {
    expect(codeToFgSgr(0)).toBe('');
  });
});

describe('CellBuffer 基本操作', () => {
  it('rowText 返回整行（含尾部空格填充，长度 = cols）', () => {
    const b = new CellBuffer(4, 2);
    b.writeText(0, 'ab');
    expect(b.rowText(0)).toBe('ab  ');
    expect(b.rowText(1)).toBe('    ');
  });

  it('writeText 写入 CJK：首列 width=2，续列 width=0 且 char 为空串', () => {
    const b = new CellBuffer(4, 1);
    b.writeText(0, '中');
    expect(b.chars[0]).toBe('中');
    expect(b.widths[0]).toBe(2);
    expect(b.chars[1]).toBe('');
    expect(b.widths[1]).toBe(0);
    expect(b.rowText(0)).toBe('中  ');
  });

  it('writeText 超宽整字丢弃，不切半边', () => {
    const b = new CellBuffer(5, 1);
    b.writeText(0, '中中中'); // 前两个占 0..3，第三个需 4..5 放不下 → 整字丢弃
    expect(b.rowText(0)).toBe('中中 ');
    expect(displayWidth(b.rowText(0))).toBe(5);
  });

  it('writeText 边界：宽字符恰好放下', () => {
    const b = new CellBuffer(3, 1);
    b.writeText(0, 'a中b'); // a(0) 中(1,2) b 放不下丢弃
    expect(b.rowText(0)).toBe('a中');
  });

  it('writeText 零宽字符被跳过（近似：不并入前格）', () => {
    const b = new CellBuffer(4, 1);
    b.writeText(0, 'e\u0301x'); // é 组合音标跳过
    expect(b.rowText(0)).toBe('ex  ');
  });

  it('writeText 前景色写入单元格', () => {
    const b = new CellBuffer(2, 1);
    b.writeText(0, 'a', 0xff0000);
    expect(b.fg[0]).toBe(0xff0000);
  });

  it('clear 重置为空白默认色', () => {
    const b = new CellBuffer(4, 2);
    b.writeText(0, '中', 0x00ff00);
    b.clear();
    expect(b.rowText(0)).toBe('    ');
    expect(b.rowText(1)).toBe('    ');
    expect(b.fg[0]).toBe(0);
  });

  it('resize 扩大：内容保留左上，新增区域空白', () => {
    const b = new CellBuffer(4, 2);
    b.writeText(0, 'ab');
    b.writeText(1, 'cd');
    b.resize(6, 3);
    expect(b.cols).toBe(6);
    expect(b.rows).toBe(3);
    expect(b.rowText(0)).toBe('ab    ');
    expect(b.rowText(1)).toBe('cd    ');
    expect(b.rowText(2)).toBe('      ');
  });

  it('resize 缩小：保留左上重叠区域', () => {
    const b = new CellBuffer(4, 2);
    b.writeText(0, 'abcd');
    b.writeText(1, 'efgh');
    b.resize(2, 1);
    expect(b.rowText(0)).toBe('ab');
    expect(b.rows).toBe(1);
  });

  it('resize 保留宽字符对（首列+续列一起迁移）', () => {
    const b = new CellBuffer(4, 1);
    b.writeText(0, '中');
    b.resize(6, 1);
    expect(b.widths[0]).toBe(2);
    expect(b.widths[1]).toBe(0);
    expect(b.chars[1]).toBe('');
  });
});
