// diff-presenter.ts — 双 buffer diff → 差量 ANSI 输出（P2 T2-2）。
//
// - present(next)：与上帧（front）逐行、逐单元格比较（char + width + fg 三元组），
//   只重写变化的连续段；段间用 CUP 绝对定位（相对移动优化留作后续项）。
// - 段起点若落在宽字符续列上（本帧或上一帧），自动向前回退到首列——
//   避免把 CJK/emoji 宽字形切半（在字形右半列写入会导致终端破坏整字形）。
// - 颜色：24bit 前景 SGR，段内颜色变化时发射，段尾非默认色则复位。
// - 尺寸变化：先清屏再全量重绘。
// - present() 返回本次实际写入的字节数；无差异时零输出返回 0。
// 零外部依赖。
import { CLEAR_SCREEN, SGR_RESET, cup } from './ansi.js';
import { CellBuffer, codeToFgSgr } from './cell-buffer.js';

/** 可写入目标（stdout 或测试用内存流） */
export interface WriteTarget {
  write(s: string): unknown;
}

export class DiffPresenter {
  private front: CellBuffer | null = null;
  private curX = -1; // 逻辑光标跟踪，-1 = 未知（下帧强制 CUP）
  private curY = -1;

  constructor(private readonly out: WriteTarget) {}

  /** 呈现一帧：与 front diff，只写变化段。返回写入字节数（空 diff 为 0）。 */
  present(next: CellBuffer): number {
    if (this.front === null) {
      this.front = new CellBuffer(next.cols, next.rows);
    } else if (next.cols !== this.front.cols || next.rows !== this.front.rows) {
      // 尺寸变化：清屏 + 重建空 front → 全量重绘
      this.out.write(CLEAR_SCREEN);
      this.front = new CellBuffer(next.cols, next.rows);
      this.curX = -1;
      this.curY = -1;
    }
    const out: string[] = [];
    for (let y = 0; y < next.rows; y += 1) {
      this.diffRow(next, y, out);
    }
    if (out.length === 0) return 0;
    const s = out.join('');
    this.out.write(s);
    return Buffer.byteLength(s);
  }

  /** 单行 diff：跳过相同段，收集变化段并输出 */
  private diffRow(next: CellBuffer, y: number, out: string[]): void {
    const front = this.front as CellBuffer;
    const cols = next.cols;
    const base = y * cols;
    let x = 0;
    while (x < cols) {
      // 跳过相同段（比较 char + width + fg）
      let x0 = x;
      while (x0 < cols && this.same(next, front, base + x0)) x0 += 1;
      if (x0 >= cols) return;
      // 收集变化段 [x0, x1)：遇相同格子结束
      let x1 = x0;
      while (x1 < cols && !this.same(next, front, base + x1)) x1 += 1;
      // 段起点若落在宽字符续列上（本帧续列，或上一帧该列是宽字形右半），回退到首列
      while (
        x0 > 0 &&
        ((next.widths[base + x0] === 0 && next.chars[base + x0] === '') ||
          front.widths[base + x0 - 1] === 2 ||
          next.widths[base + x0 - 1] === 2)
      ) {
        x0 -= 1;
      }
      x = x1;
      // 定位光标（内部跟踪避免冗余 CUP）
      if (this.curX !== x0 || this.curY !== y) {
        out.push(cup(x0, y));
        this.curX = x0;
        this.curY = y;
      }
      // 写段并同步 front；续列不输出（终端遇宽字符自动右移两列）
      let runFg = -1;
      for (let i = x0; i < x1; i += 1) {
        const idx = base + i;
        const w = next.widths[idx] ?? 0;
        const ch = next.chars[idx] ?? ' ';
        front.chars[idx] = ch;
        front.widths[idx] = w;
        front.fg[idx] = next.fg[idx] ?? 0;
        if (w === 0 && ch === '') continue; // 续列：跟随首列，无需输出
        const fg = next.fg[idx] ?? 0;
        if (fg !== runFg) {
          out.push(fg === 0 ? SGR_RESET : codeToFgSgr(fg));
          runFg = fg;
        }
        out.push(ch);
        this.curX += w; // 宽字符终端光标右移 2，续列不移动
      }
      if (runFg !== 0) {
        out.push(SGR_RESET);
      }
    }
  }

  /** 单元格比较：char + width + fg 三元组全等 */
  private same(next: CellBuffer, front: CellBuffer, idx: number): boolean {
    return (
      front.chars[idx] === next.chars[idx] && front.widths[idx] === next.widths[idx] && front.fg[idx] === next.fg[idx]
    );
  }
}
