// P11-T1 `/help` 面板**版面级**回归断言（P0 教训：旧用例只断言「文本包含」，所以
// "文字对、版面错"逃过了测试——`next-shell.test.ts` 的 `toContain('命令：')` 对整屏错位
// 恒为真）。
//
// 症状（P0）：`/help` 首屏文字互相覆盖、出现 `essio s` 这类碎片。根因（见计划附录 A.2）：
// core HELP_TEXT 是多行文本，投影层整段当作**一条**逻辑行，`wrapLine` 又把内嵌 `\n` 当
// 1 列可打印字符写进 CellBuffer 单元格，DiffPresenter 逐格原样发射 → 终端在行中换行，
// 该行剩余格全部落到下一行同列起点，与下一物理行叠加。
//
// 本文件走真实渲染链路（transcript item → projectTranscript → Scrollback → renderChat 帧），
// 对渲染结果做**逐格/逐行**断言，而不是文本包含：
//   1) 网格内不得有任何控制字符（旧实现指纹 = 42 个 `\n` 单元格）；
//   2) 每一格的宽度必须与**独立宽度表** `string-width` 一致（宽字符 2 列 + 续列格）——
//      这条对「把宽度函数改成按字符数」的变异敏感；
//   3) 每条帮助行**独占一行且按序**，整行逐字相等（同行混入别的帮助行片段 = 交叉/覆盖）；
//   4) 每行显示宽度 ≤ 画布内容宽（不溢出、不折行）。
//
// 变异验证（红/绿证据见提交说明）：
//   ① 把 projection 的 system/status 分支改回整段下传 → 用例 1、3 变红；
//   ② 把 cell-buffer 的 charWidth 改成「一律 1 列」 → 用例 2 变红。
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { HELP_TEXT } from '@harness2/core';
import { renderChat, type ChatScreenState } from '../../../src/tui/next/chat-screen.js';
import { projectTranscript, type ProjectionLine } from '../../../src/tui/next/projection.js';
import { Scrollback, wrapLine } from '../../../src/tui/next/scrollback.js';
import type { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import { Screen } from '../../../src/tui/renderer/screen.js';
import type { TranscriptItem } from '../../../src/tui/transcript.js';

/** 固定画布：110×30 是对照台口径；高度取 50 让 43 行帮助整体入画（fits ≥ 43 + composer/shortcuts） */
const COLS = 110;
const ROWS = 50;
/** 内容区宽 = 屏宽 - 1（滚动条恒占最右列，见 chat-screen 的 sb.cols 契约） */
const CONTENT_COLS = COLS - 1;

const HELP_LINES = HELP_TEXT.split('\n');

class MemOut {
  write(): boolean {
    return true;
  }
}

/**
 * 渲染一帧 `/help`：数据形态与真实路径一致（user 回显 + core `ctx.print(HELP_TEXT)` 的
 * 单条 system 输出；`command-impls.ts` 原样 `io.print` 整段，core 冻结不改）。
 */
function makeFrame(): { buf: CellBuffer; scrollback: Scrollback; projection: ProjectionLine[] } {
  const items: TranscriptItem[] = [
    { kind: 'user', id: 'user:1', seq: 0, text: '/help' },
    { kind: 'system', id: 'sys:1', text: HELP_TEXT },
  ];
  const projection = projectTranscript(items, { cols: CONTENT_COLS });
  const scrollback = new Scrollback(
    projection.map((l) => l.text),
    CONTENT_COLS,
  );
  const state: ChatScreenState = {
    scrollback,
    draft: '',
    cursor: 0,
    candidates: null,
    overlays: [],
    shortcuts: ['/ 命令', 'Tab 焦点', 'Ctrl+C 退出'],
    statusline: '',
  };
  const screen = new Screen(new MemOut(), COLS, ROWS);
  screen.start({ mouse: false });
  renderChat(screen, state);
  return { buf: screen.buffer, scrollback, projection };
}

/** 第 y 行内容区文本（自 x=0 走格子、跳过宽字符续列；不含滚动条列） */
function rowContent(buf: CellBuffer, y: number): string {
  let out = '';
  for (let x = 0; x < CONTENT_COLS; x += 1) {
    const i = y * buf.cols + x;
    const ch = buf.chars[i] ?? ' ';
    if ((buf.widths[i] ?? 0) === 0 && ch === '') continue; // 续列：跟随首列
    out += ch;
  }
  return out;
}

describe('P11-T1 /help 面板版面（逐格/逐行断言）', () => {
  it('网格内无任何控制字符（旧实现指纹：42 个内嵌 \\n 单元格）', () => {
    const { buf } = makeFrame();
    const control = buf.chars.filter((ch) => ch !== '' && (ch.codePointAt(0) ?? 0x20) < 0x20);
    expect(control).toEqual([]);
  });

  it('逐格宽度契约：每格宽度 == 独立宽度表 string-width（宽字符 2 列 + 续列格）', () => {
    const { buf } = makeFrame();
    const bad: string[] = [];
    for (let y = 0; y < buf.rows; y += 1) {
      for (let x = 0; x < buf.cols; x += 1) {
        const i = y * buf.cols + x;
        const ch = buf.chars[i] ?? ' ';
        const w = buf.widths[i] ?? 0;
        if (ch === '' && w === 0) continue; // 续列格（宽字符右半）
        if (ch === ' ' && w === 0) continue; // 未写入的空白格（CellBuffer 空白表示）
        const want = stringWidth(ch);
        if (w !== want) bad.push(`(${x},${y}) ${JSON.stringify(ch)} width=${w} want=${want}`);
      }
    }
    expect(bad).toHaveLength(0);
  });

  it('帮助文本不被折行：逻辑行数 == 物理行数（每条帮助行恰好占一行）', () => {
    const { scrollback, projection } = makeFrame();
    expect(scrollback.totalRows).toBe(projection.length);
    // 每条帮助行显示宽 ≤ 内容区宽（因此不触发折行）
    for (const line of HELP_LINES) expect(stringWidth(line)).toBeLessThanOrEqual(CONTENT_COLS);
  });

  it('每条帮助行独占一行且按序排列（同行混入其它片段 = 交叉/覆盖 → 红）', () => {
    const { buf } = makeFrame();
    const rows = Array.from({ length: buf.rows }, (_, y) => rowContent(buf, y).trimEnd());

    // 帮助区起点：`命令：` 行；其上一行是 `/help` 回显（真实路径形态）
    const start = rows.indexOf(HELP_LINES[0] ?? '');
    expect(start).toBeGreaterThan(0);
    expect(rows[start - 1]).toBe('❯ /help');

    // 逐行整行相等（含缩进与 CJK 对齐）+ 显示宽 ≤ 画布内容宽
    rows.slice(start, start + HELP_LINES.length).forEach((row, k) => {
      expect(row).toBe(HELP_LINES[k]);
      expect(stringWidth(row)).toBeLessThanOrEqual(CONTENT_COLS);
    });

    // 每条帮助行只允许出现在唯一一行（同一片段被画两次/与别行交叉 → 红）
    for (const line of HELP_LINES) {
      expect(rows.filter((r) => r.includes(line))).toHaveLength(1);
    }

    // 帮助区之后必须是空白（不得有滚动残影/重复行）
    expect(rows[start + HELP_LINES.length]?.trim()).toBe('');
  });
});

describe('P11-T1 wrapLine 硬换行（控制字符不进网格的库级保证）', () => {
  it('\\n / \\r\\n / \\r 作硬换行，绝不当可打印字符', () => {
    expect(wrapLine('a\nb', 80)).toEqual(['a', 'b']);
    expect(wrapLine('a\r\nb', 80)).toEqual(['a', 'b']);
    expect(wrapLine('a\rb', 80)).toEqual(['a', 'b']);
    expect(wrapLine('ab\n', 80)).toEqual(['ab', '']);
    expect(wrapLine('\n', 80)).toEqual(['', '']);
    expect(wrapLine('', 80)).toEqual(['']); // 空串仍恒 1 行（既有契约）
  });

  it('硬换行段各自按显示宽度断行（宽字符不切半边）', () => {
    expect(wrapLine('abcde中\n中文', 6)).toEqual(['abcde', '中', '中文']);
    expect(wrapLine('中'.repeat(4) + '\n' + 'a'.repeat(10), 4)).toEqual(['中中', '中中', 'aaaa', 'aaaa', 'aa']);
  });
});
