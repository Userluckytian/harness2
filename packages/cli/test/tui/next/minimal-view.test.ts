// minimal-view.test.ts — P3-D G-01 minimal 追加式渲染基座的纯函数单测。
// - composeMinimalPrompt：块行序（statusline → 浮层 → 候选 → 草稿）、光标定位、宽字符；
// - renderPromptBlock / erasePromptBlock：ANSI 协议（擦旧 = CUU + \r\x1b[2K 逐行、画新、
//   光标 CUF 定位）；MinimalView 实例的 prevRows 记账（printLines 自动擦 prompt）。
import { describe, expect, it } from 'vitest';
import {
  composeMinimalPrompt,
  erasePromptBlock,
  extractRows,
  MinimalView,
  renderPromptBlock,
} from '../../../src/tui/next/minimal-view.js';
import { CellBuffer, displayWidth } from '../../../src/tui/renderer/cell-buffer.js';
import { DEFAULT_PLACEHOLDER, DEFAULT_PROMPT } from '../../../src/tui/next/composer.js';

/** P11-T2：草稿行锚点显示宽（'❯ ' = 2；按 displayWidth 计，不用 .length 当宽度） */
const GUTTER = displayWidth(DEFAULT_PROMPT);

describe('composeMinimalPrompt', () => {
  it('空草稿 = 单行 prompt 块（readline 同构）', () => {
    const block = composeMinimalPrompt({ draft: '', cursor: 0, cols: 80 });
    // P11-T2：空态显示锚点 + 弱化占位（占位只呈现，不进提交内容）
    expect(block.rows).toEqual([`${DEFAULT_PROMPT}${DEFAULT_PLACEHOLDER}`]);
    expect(block.cursorRow).toBe(0);
    expect(block.cursorCol).toBe(GUTTER); // 光标落在草稿处（占位右侧不动）
  });

  it('草稿文本进块，光标定位在文本末（cursorCol = 锚点 + 显示宽）', () => {
    const block = composeMinimalPrompt({ draft: 'hello', cursor: 5, cols: 80 });
    expect(block.rows).toEqual([`${DEFAULT_PROMPT}hello`]);
    expect(block.cursorRow).toBe(0);
    expect(block.cursorCol).toBe(GUTTER + 5);
  });

  it('宽字符光标列按显示宽度计（CJK = 2 列/字）', () => {
    const block = composeMinimalPrompt({ draft: '你好', cursor: 2, cols: 80 });
    expect(block.rows).toEqual([`${DEFAULT_PROMPT}你好`]);
    expect(block.cursorCol).toBe(GUTTER + 4);
  });

  it('多行草稿（\n 硬换行）逐物理行，光标行随换行下移', () => {
    const block = composeMinimalPrompt({ draft: 'ab\ncd', cursor: 5, cols: 80 });
    expect(block.rows).toEqual([`${DEFAULT_PROMPT}ab`, `${DEFAULT_PROMPT}cd`]);
    expect(block.cursorRow).toBe(1);
    expect(block.cursorCol).toBe(GUTTER + 2);
  });

  it('候选行画在草稿上方（block 顶 = 候选）', () => {
    const block = composeMinimalPrompt({
      draft: 'x',
      cursor: 1,
      candidates: { items: ['/aa', '/bb', '/cc'], activeIndex: 1 },
      cols: 80,
    });
    expect(block.rows).toEqual(['/aa', '/bb', '/cc', `${DEFAULT_PROMPT}x`]);
    expect(block.cursorRow).toBe(3); // 光标在草稿行（块底）
  });

  it('statusline 占块顶行（minimalStatusLine 开启时的可选层）', () => {
    const block = composeMinimalPrompt({ draft: 'x', cursor: 1, statusline: '~/p · mock', cols: 80 });
    expect(block.rows).toEqual(['~/p · mock', `${DEFAULT_PROMPT}x`]);
    expect(block.cursorRow).toBe(1);
  });

  it('浮层（审批卡等阻塞卡）画在候选/草稿上方——minimal 下卡片不可隐形', () => {
    const block = composeMinimalPrompt({
      draft: '',
      cursor: 0,
      overlays: [{ title: 'Approval', items: ['y 允许', 'n 拒绝'], activeIndex: 0 }],
      cols: 80,
    });
    // 标题 + 分隔线 + 2 条目 + 草稿空行（空态 = 锚点 + 占位）
    expect(block.rows.length).toBe(5);
    expect(block.rows[0]).toContain('Approval');
    expect(block.rows[1]).toContain('──');
    expect(block.rows[2]).toContain('y 允许');
    expect(block.rows[4]).toBe(`${DEFAULT_PROMPT}${DEFAULT_PLACEHOLDER}`);
  });

  it('超宽草稿按 cols 折行（与 wrapLine 同语义；光标列行满钳制到 cols-1）', () => {
    // cols=10、锚点 2 列 → 草稿区 8 列：15 个 a = 8 + 7
    const block = composeMinimalPrompt({ draft: 'a'.repeat(15), cursor: 15, cols: 10 });
    expect(block.rows).toEqual([`${DEFAULT_PROMPT}${'a'.repeat(8)}`, `${DEFAULT_PROMPT}${'a'.repeat(7)}`]);
    expect(block.cursorRow).toBe(1);
    expect(block.cursorCol).toBe(9); // GUTTER + 7 = 9（= cols-1 行满钳制）
  });
});

describe('renderPromptBlock / erasePromptBlock（ANSI 协议）', () => {
  it('首帧（prevRows=0）不擦除：直接画行 + 光标定位', () => {
    const s = renderPromptBlock(0, { rows: ['hello'], cursorRow: 0, cursorCol: 5 });
    expect(s).toBe('hello\r\x1b[5C');
  });

  it('重绘先整块擦除（CUU 上移 + 逐行 \\r\\x1b[2K）再画新块', () => {
    const s = renderPromptBlock(2, { rows: ['a', 'b'], cursorRow: 1, cursorCol: 1 });
    // 擦：上移 1 行，两行各 \r\x1b[2K，行间 \n
    expect(s.startsWith('\x1b[1A\r\x1b[2K\n\r\x1b[2K')).toBe(true);
    // 画：两行 + 光标定位在 (1,1)
    expect(s.endsWith('a\nb\r\x1b[1C')).toBe(true);
  });

  it('erasePromptBlock：只擦不画；0 行返回空串', () => {
    expect(erasePromptBlock(0)).toBe('');
    expect(erasePromptBlock(1)).toBe('\r\x1b[2K');
    expect(erasePromptBlock(2)).toBe('\x1b[1A\r\x1b[2K\n\r\x1b[2K');
  });

  it('新块行数少于旧块：擦除覆盖旧行，不留残影', () => {
    const s = renderPromptBlock(3, { rows: ['x'], cursorRow: 0, cursorCol: 1 });
    expect(s.startsWith('\x1b[2A\r\x1b[2K\n\r\x1b[2K\n\r\x1b[2K')).toBe(true); // 擦 3 行
    expect(s.endsWith('x\r\x1b[1C')).toBe(true);
  });

  it('extractRows：跳过 width=0 的空白/续列格（写入空格保留）', () => {
    const buf = new CellBuffer(5, 2);
    buf.setCell(0, 0, '你', 2, 0);
    buf.setCell(2, 0, ' ', 1, 0); // 显式写入的空格
    expect(extractRows(buf)).toEqual(['你 ', '']);
  });
});

describe('MinimalView（写出口径）', () => {
  function makeOut(): { buffer: string; write(s: string): boolean } {
    return {
      buffer: '',
      write(s: string) {
        this.buffer += s;
        return true;
      },
    };
  }

  it('printLines：擦 prompt → 逐行 text\\n 写出（原生滚动追加）', () => {
    const out = makeOut();
    const view = new MinimalView(out, () => 80);
    view.renderPrompt(composeMinimalPrompt({ draft: 'draft', cursor: 5, cols: 80 }));
    out.buffer = '';
    view.printLines([{ text: 'line1' }, { text: 'line2' }]);
    expect(out.buffer).toBe('\r\x1b[2Kline1\nline2\n'); // 先擦 1 行 prompt 块，再追加转录
    // 再画 prompt：无残留擦除（printLines 已把 prevRows 归零）
    out.buffer = '';
    view.renderPrompt(composeMinimalPrompt({ draft: 'd', cursor: 1, cols: 80 }));
    expect(out.buffer.startsWith(`${DEFAULT_PROMPT}d\r`)).toBe(true);
  });

  it('行内 CR 剥离（转录文本不干扰列定位）', () => {
    const out = makeOut();
    const view = new MinimalView(out, () => 80);
    view.printLines([{ text: 'a\rb' }]);
    expect(out.buffer).toBe('ab\n');
  });

  it('erase：擦掉当前 prompt 块并归零记账；重复 erase 幂等', () => {
    const out = makeOut();
    const view = new MinimalView(out, () => 80);
    view.renderPrompt(composeMinimalPrompt({ draft: 'a\nb', cursor: 3, cols: 80 }));
    out.buffer = '';
    view.erase();
    expect(out.buffer).toBe('\x1b[1A\r\x1b[2K\n\r\x1b[2K');
    out.buffer = '';
    view.erase();
    expect(out.buffer).toBe('');
  });
});
