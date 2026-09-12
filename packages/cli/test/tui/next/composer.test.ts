// T2-4 Composer（输入框）单测（headless，Screen + 内存流）：
// - measureComposer：多行草稿（\n 硬换行 + 宽字符软折行）物理行数与光标物理位置映射
// - renderComposer：草稿画在给定 top/height 区域、光标高亮格（diff-presenter 仅支持 fg，
//   反色以可配置前景色近似——已知取舍）、候选列表（输入区上方，≤6 行 + 滚动窗口 +
//   active 高亮）、底边指示（右侧右对齐 + 超宽截断）
// - 差量性：同状态重复渲染 0 字节、光标移动帧字节量小
// - 边界：空草稿 / 光标行首行尾中间 / 超宽断行 / cols 极小 / 候选滚动 / 指示器截断
import { describe, expect, it } from 'vitest';
import { candidateRows, measureComposer, renderComposer } from '../../../src/tui/next/composer.js';
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
  get bytes(): number {
    return Buffer.byteLength(this.chunks.join(''));
  }
  clear(): void {
    this.chunks = [];
  }
}

const CURSOR_FG = 0x00ff87; // 与实现默认一致；测试同时覆盖自定义值

describe('measureComposer 测量', () => {
  it('空草稿：1 行，光标 (0,0)', () => {
    expect(measureComposer('', 80)).toEqual({ rows: 1, cursorRow: 0, cursorCol: 0 });
  });

  it('单行短文本：1 行，光标列 = 字符数', () => {
    expect(measureComposer('hello', 80)).toEqual({ rows: 1, cursorRow: 0, cursorCol: 5 });
  });

  it('多行硬换行：物理行数 = 逻辑行数，默认光标在末行行尾', () => {
    expect(measureComposer('ab\ncd\n\nx', 80)).toEqual({ rows: 4, cursorRow: 3, cursorCol: 1 });
  });

  it('超宽行软折行：100 字符 30 列 → 4 物理行，光标在末行', () => {
    expect(measureComposer('a'.repeat(100), 30)).toEqual({ rows: 4, cursorRow: 3, cursorCol: 10 });
  });

  it('宽字符软折行不切半：10 个 CJK 5 列 → 每行 2 个共 5 行', () => {
    expect(measureComposer('中'.repeat(10), 5)).toEqual({ rows: 5, cursorRow: 4, cursorCol: 4 });
  });

  it('cols=1：每字符一物理行，光标在末行行尾', () => {
    expect(measureComposer('ab', 1)).toEqual({ rows: 2, cursorRow: 1, cursorCol: 1 });
  });

  it('cols=0 兜底按 1 列', () => {
    expect(measureComposer('ab', 0).rows).toBe(2);
  });

  it('光标在第二行行首：cursorRow 1 / cursorCol 0', () => {
    expect(measureComposer('ab\ncd', 80, 3)).toEqual({ rows: 2, cursorRow: 1, cursorCol: 0 });
  });

  it('光标在 \\n 位置：映射到上一行行尾', () => {
    expect(measureComposer('ab\ncd', 80, 2)).toEqual({ rows: 2, cursorRow: 0, cursorCol: 2 });
  });

  it('行尾 \\n 之后：空逻辑行行首（col 0）', () => {
    expect(measureComposer('ab\n', 80, 3)).toEqual({ rows: 2, cursorRow: 1, cursorCol: 0 });
  });

  it('软折行段边界：光标恰在段首 → 下一段行首 col 0', () => {
    expect(measureComposer('a'.repeat(60), 30, 30)).toEqual({ rows: 2, cursorRow: 1, cursorCol: 0 });
  });

  it('emoji 代理对中间的非法偏移：钳制到码点首列', () => {
    expect(measureComposer('👍ab', 80, 1).cursorCol).toBe(0);
  });

  it('emoji 之后的光标：列宽按 2 计', () => {
    expect(measureComposer('👍ab', 80, 2).cursorCol).toBe(2);
  });

  it('行中间光标', () => {
    expect(measureComposer('hello', 80, 2)).toEqual({ rows: 1, cursorRow: 0, cursorCol: 2 });
  });

  it('光标越界钳制到草稿末尾', () => {
    expect(measureComposer('hi', 80, 999)).toEqual({ rows: 1, cursorRow: 0, cursorCol: 2 });
  });
});

describe('candidateRows 候选行数', () => {
  it('0 / 少量 / 超量 / 自定义上限', () => {
    expect(candidateRows(0)).toBe(0);
    expect(candidateRows(3)).toBe(3);
    expect(candidateRows(10)).toBe(6);
    expect(candidateRows(10, 4)).toBe(4);
  });
});

describe('renderComposer 草稿与光标', () => {
  function makeScreen(cols = 80, rows = 24): { screen: Screen; out: MemOut } {
    const out = new MemOut();
    const screen = new Screen(out, cols, rows);
    screen.start();
    out.clear();
    return { screen, out };
  }

  it('首帧把草稿画在默认贴底区域（top=rows-1）', () => {
    const { screen, out } = makeScreen();
    const bytes = renderComposer(screen, { draft: 'hello', cursor: 5 });
    expect(bytes).toBeGreaterThan(0);
    expect(out.text).toContain('hello');
    expect(screen.buffer.rowText(23)).toBe('hello' + ' '.repeat(75));
  });

  it('空草稿：只有光标空格反格', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: '', cursor: 0 });
    const buf = screen.buffer;
    expect(buf.rowText(23).trim()).toBe('');
    expect(buf.fg[23 * 80]).toBe(CURSOR_FG);
  });

  it('光标高亮格：光标处字符前景色 = cursorFg', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'hello', cursor: 2 });
    const buf = screen.buffer;
    expect(buf.chars[23 * 80 + 2]).toBe('l');
    expect(buf.fg[23 * 80 + 2]).toBe(CURSOR_FG);
    expect(buf.fg[23 * 80]).toBe(0);
  });

  it('行尾光标：行尾空白格高亮', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'hi', cursor: 2 });
    const buf = screen.buffer;
    expect(buf.chars[23 * 80 + 2]).toBe(' ');
    expect(buf.fg[23 * 80 + 2]).toBe(CURSOR_FG);
  });

  it('cursorVisible:false 不画光标高亮', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'hello', cursor: 2 }, { cursorVisible: false });
    expect(screen.buffer.fg[23 * 80 + 2]).toBe(0);
  });

  it('自定义 cursorFg', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'hi', cursor: 0 }, { cursorFg: 0xff8800 });
    expect(screen.buffer.fg[23 * 80]).toBe(0xff8800);
  });

  it('自定义 top/height：多行草稿按区域定位', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'ab\ncd', cursor: 5 }, { top: 20, height: 3 });
    const buf = screen.buffer;
    expect(buf.rowText(20)).toBe('ab' + ' '.repeat(78));
    expect(buf.rowText(21)).toBe('cd' + ' '.repeat(78));
    expect(buf.rowText(22).trim()).toBe(''); // 第三行留空（可放底边指示）
  });

  it('差量性：同状态重复渲染 0 字节', () => {
    const { screen, out } = makeScreen();
    renderComposer(screen, { draft: 'hello', cursor: 2 });
    out.clear();
    const bytes = renderComposer(screen, { draft: 'hello', cursor: 2 });
    expect(bytes).toBe(0);
    expect(out.bytes).toBe(0);
  });

  it('差量性：光标移动一帧字节量小（<120）', () => {
    const { screen, out } = makeScreen();
    renderComposer(screen, { draft: 'hello world', cursor: 2 });
    out.clear();
    const bytes = renderComposer(screen, { draft: 'hello world', cursor: 3 });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(120);
  });

  it('宽字符渲染与 CellBuffer 续列一致（首列 w=2、续列 char 为空串 w=0）', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: '中文', cursor: 4 });
    const buf = screen.buffer;
    expect(buf.chars[23 * 80]).toBe('中');
    expect(buf.widths[23 * 80]).toBe(2);
    expect(buf.chars[23 * 80 + 1]).toBe('');
    expect(buf.widths[23 * 80 + 1]).toBe(0);
    expect(buf.chars[23 * 80 + 2]).toBe('文');
    // rowText 跳过续列：每个宽字符贡献 1 字符 → '中文' + 76 空格
    expect(buf.rowText(23)).toBe('中文' + ' '.repeat(76));
  });

  it('草稿超出 height：以光标行贴底滚动，光标保持可见', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'a\nb\nc\nd\ne', cursor: 9 }, { top: 20, height: 3 });
    const buf = screen.buffer;
    expect(buf.rowText(20)).toBe('c' + ' '.repeat(79)); // offset = 5-3 = 2
    expect(buf.rowText(22)).toBe('e' + ' '.repeat(79));
    expect(buf.fg[22 * 80 + 1]).toBe(CURSOR_FG); // 光标在 'e' 行尾
  });

  it('草稿超 height 且光标在顶部：从首行显示', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'a\nb\nc\nd\ne', cursor: 0 }, { top: 20, height: 3 });
    const buf = screen.buffer;
    expect(buf.rowText(20)).toBe('a' + ' '.repeat(79));
    expect(buf.rowText(22)).toBe('c' + ' '.repeat(79));
  });

  it('cols=1 下 CJK 不可见（与 wrapLine/writeRowClipped 一致的已知近似）', () => {
    const { screen } = makeScreen(4, 3);
    const bytes = renderComposer(screen, { draft: '中', cursor: 1 }, { top: 1, height: 1, width: 1 });
    expect(bytes).toBeGreaterThan(0); // 光标格仍发射
    expect(screen.buffer.rowText(1).trim()).toBe(''); // 字形整字丢弃
  });

  it('top 越界（≥ screen.rows）：返回 0 且零输出', () => {
    const { screen, out } = makeScreen();
    const bytes = renderComposer(screen, { draft: 'x', cursor: 1 }, { top: 24 });
    expect(bytes).toBe(0);
    expect(out.bytes).toBe(0);
  });

  it('草稿缩短后旧物理行被清理', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'a\nb\nc', cursor: 3 }, { top: 20, height: 4 });
    renderComposer(screen, { draft: 'a', cursor: 1 }, { top: 20, height: 4 });
    const buf = screen.buffer;
    expect(buf.rowText(20)).toBe('a' + ' '.repeat(79));
    expect(buf.rowText(21).trim()).toBe('');
    expect(buf.rowText(22).trim()).toBe('');
  });

  it('resize 后按新宽度折行渲染', () => {
    const { screen } = makeScreen();
    screen.resize(10, 24);
    renderComposer(screen, { draft: 'abcdefgh', cursor: 8 }); // 默认 top = 23
    expect(screen.buffer.rowText(23)).toBe('abcdefgh' + '  ');
  });
});

describe('renderComposer 候选列表', () => {
  function makeScreen(cols = 80, rows = 24): { screen: Screen; out: MemOut } {
    const out = new MemOut();
    const screen = new Screen(out, cols, rows);
    screen.start();
    out.clear();
    return { screen, out };
  }

  it('候选画在输入区上方、底部锚定（2 项 → top-2..top-1）', () => {
    const { screen } = makeScreen();
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        candidates: { items: ['/aa', '/bb'], activeIndex: 0 },
      },
    );
    const buf = screen.buffer;
    expect(buf.rowText(21)).toBe('/aa' + ' '.repeat(77)); // 块顶 = 首项
    expect(buf.rowText(22)).toBe('/bb' + ' '.repeat(77)); // 块底（贴输入区）= 末项
    expect(buf.rowText(20).trim()).toBe('');
  });

  it('active 候选高亮（candidateActiveFg）', () => {
    const { screen } = makeScreen();
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        candidates: { items: ['/aa', '/bb'], activeIndex: 1 },
        candidateFg: 0x666666,
        candidateActiveFg: 0x00ff87,
      },
    );
    const buf = screen.buffer;
    expect(buf.fg[21 * 80]).toBe(0x666666); // /aa 非激活
    expect(buf.fg[22 * 80]).toBe(0x00ff87); // /bb 激活
  });

  it('候选 > 6：滚动窗口贴住 active（active=末项 → 显示最后 6 项）', () => {
    const { screen, out } = makeScreen();
    const items = Array.from({ length: 8 }, (_, i) => `/cmd-${i}`);
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        candidates: { items, activeIndex: 7 },
      },
    );
    const buf = screen.buffer;
    expect(buf.rowText(23 - 6)).toBe('/cmd-2' + ' '.repeat(74)); // 窗口首行
    expect(buf.rowText(22)).toBe('/cmd-7' + ' '.repeat(74)); // active 在窗口末行
    expect(out.text).not.toContain('/cmd-1'); // 窗口外不可见
  });

  it('候选 > 6：active=0 → 显示前 6 项', () => {
    const { screen } = makeScreen();
    const items = Array.from({ length: 8 }, (_, i) => `/cmd-${i}`);
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        candidates: { items, activeIndex: 0 },
      },
    );
    const buf = screen.buffer;
    expect(buf.rowText(17)).toBe('/cmd-0' + ' '.repeat(74));
    expect(buf.rowText(22)).toBe('/cmd-5' + ' '.repeat(74));
  });

  it('top 太小：候选被裁剪只画可见部分', () => {
    const { screen } = makeScreen();
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        top: 2,
        height: 1,
        candidates: { items: ['/a', '/b', '/c', '/d'], activeIndex: 3 },
      },
    );
    const buf = screen.buffer;
    expect(buf.rowText(0)).toBe('/c' + ' '.repeat(78));
    expect(buf.rowText(1)).toBe('/d' + ' '.repeat(78));
  });

  it('maxCandidates 自定义窗口大小', () => {
    const { screen } = makeScreen();
    const items = Array.from({ length: 5 }, (_, i) => `/c${i}`);
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        maxCandidates: 3,
        candidates: { items, activeIndex: 4 },
      },
    );
    const buf = screen.buffer;
    expect(buf.rowText(20)).toBe('/c2' + ' '.repeat(77));
    expect(buf.rowText(22)).toBe('/c4' + ' '.repeat(77));
  });

  it('超长候选项按区域宽度截断', () => {
    const { screen } = makeScreen();
    renderComposer(
      screen,
      { draft: '', cursor: 0 },
      {
        candidates: { items: ['/' + 'x'.repeat(120)], activeIndex: 0 },
      },
    );
    expect(screen.buffer.rowText(22).length).toBe(80);
  });
});

describe('renderComposer 底边指示', () => {
  function makeScreen(cols = 80, rows = 24): { screen: Screen; out: MemOut } {
    const out = new MemOut();
    const screen = new Screen(out, cols, rows);
    screen.start();
    out.clear();
    return { screen, out };
  }

  it('指示器画在底边右侧（多段以 " · " 连接右对齐）', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: '', cursor: 0 }, { indicators: ['plan', 'gpt-5', '42%'] });
    const s = 'plan · gpt-5 · 42%';
    expect(screen.buffer.rowText(23)).toBe(' '.repeat(80 - s.length) + s);
  });

  it('CJK 指示器按显示宽度右对齐', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: '', cursor: 0 }, { indicators: ['计划'] });
    expect(screen.buffer.rowText(23)).toBe(' '.repeat(76) + '计划');
  });

  it('指示器超宽：从左截断 + … 前缀，总宽不超过区域宽', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: '', cursor: 0 }, { indicators: ['x'.repeat(100)] });
    const row = screen.buffer.rowText(23);
    expect(row.length).toBe(80);
    expect(row.startsWith('…')).toBe(true);
    expect(row.endsWith('x')).toBe(true);
  });

  it('指示器与草稿重叠时指示器获胜（写在最右）', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'a'.repeat(80), cursor: 80 }, { indicators: ['plan'] });
    const buf = screen.buffer;
    expect(buf.rowText(23).slice(76)).toBe('plan');
  });

  it('indicatorFg 应用到指示器字符', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: '', cursor: 0 }, { indicators: ['plan'], indicatorFg: 0x00aaff });
    expect(screen.buffer.fg[23 * 80 + 79]).toBe(0x00aaff);
  });

  it('空数组不渲染指示器', () => {
    const { screen } = makeScreen();
    renderComposer(screen, { draft: 'hi', cursor: 2 }, { indicators: [] });
    expect(screen.buffer.rowText(23)).toBe('hi' + ' '.repeat(78));
  });

  it('草稿 + 候选 + 指示器同帧共存', () => {
    const { screen } = makeScreen();
    renderComposer(
      screen,
      { draft: 'hello', cursor: 5 },
      {
        candidates: { items: ['/aa'], activeIndex: 0 },
        indicators: ['plan'],
      },
    );
    const buf = screen.buffer;
    expect(buf.rowText(22)).toBe('/aa' + ' '.repeat(77));
    expect(buf.rowText(23)).toBe('hello' + ' '.repeat(71) + 'plan');
  });
});
