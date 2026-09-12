// renderer.mjs — 双 buffer diff → 差量 ANSI 输出（方案B）：
// - present(next)：与上帧逐行、逐单元格段比较，只重写变化的单元格连续段；
//   段起点若落在宽字符续列上，自动向前扩展到首列（避免把 CJK 切半）。
// - 光标：内部跟踪逻辑光标位置，写段前用 CUP 绝对定位（简单可靠；相对移动优化为后续项）。
// - 颜色：24bit 前景 SGR，仅在段内与当前色不同、或段起点颜色未知时发射。
// - 生命周期：start() 进 alt-screen + 隐藏光标 + 开 SGR 鼠标上报；stop()/异常退出（SIGINT/
//   SIGHUP/SIGTERM/exit）统一 restore：关鼠标上报、显示光标、退 alt-screen。
// - 零外部依赖。
import { CellBuffer, codeToFgSgr } from './cell-buffer.mjs';

const ESC = '\x1b';
const CUP = (x, y) => `${ESC}[${y + 1};${x + 1}H`;
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
const SGR_RESET = `${ESC}[0m`;

export class Renderer {
  constructor(stdout) {
    this.stdout = stdout;
    this.front = null; // 上帧 buffer
    this.curX = 0;
    this.curY = 0;
    this.curFg = -1; // 当前 SGR 状态（-1=未知/已重置）
    this.started = false;
    this.restored = false;
    this.lastFrameBytes = 0;
    this._onSignal = () => this.stop();
    this._onExit = () => this.stop();
  }

  start({ mouse = true } = {}) {
    if (this.started) return;
    this.started = true;
    this.stdout.write(ALT_ENTER + HIDE_CURSOR + (mouse ? MOUSE_ON : '') + SGR_RESET);
    this.curX = -1;
    this.curY = -1;
    this.curFg = -1;
    // 异常退出恢复：注册在 start，stop 幂等
    process.on('SIGINT', this._onSignal);
    process.on('SIGHUP', this._onSignal);
    process.on('SIGTERM', this._onSignal);
    process.on('exit', this._onExit);
  }

  /** 呈现一帧：与 front diff，只写变化段。返回写入字节数。 */
  present(next) {
    if (this.front === null) {
      this.front = new CellBuffer(next.cols, next.rows);
      this.front.clear();
    } else if (next.cols !== this.front.cols || next.rows !== this.front.rows) {
      // 尺寸变化：全量重绘
      this.stdout.write(`${ESC}[2J`);
      this.front.resize(next.cols, next.rows);
      this.front.clear();
      this.curX = -1;
      this.curFg = -1;
    }
    const out = [];
    for (let y = 0; y < next.rows; y += 1) {
      this._diffRow(next, y, out);
    }
    const s = out.join('');
    if (s.length > 0) {
      this.stdout.write(s);
      this.lastFrameBytes = s.length;
    } else {
      this.lastFrameBytes = 0;
    }
    return this.lastFrameBytes;
  }

  _diffRow(next, y, out) {
    const cols = next.cols;
    const base = y * cols;
    let x = 0;
    while (x < cols) {
      // 跳过相同段（比较 char+width+fg）
      let x0 = x;
      while (x0 < cols && this._same(next, base + x0)) x0 += 1;
      if (x0 >= cols) return;
      // 收集变化段（遇到相同格子结束）；续列视为依附其首列
      let x1 = x0;
      while (x1 < cols && !this._same(next, base + x1)) {
        if (next.widths[base + x1] === 0 && x1 + 1 < cols) x1 += 1; // 续列连带
        x1 += 1;
      }
      // 段起点若在某宽字符的续列上，向前扩展到首列
      while (x0 > 0 && next.widths[base + x0] === 0 && next.chars[base + x0] === '') x0 -= 1;
      x = x1;
      // 定位光标
      if (this.curX !== x0 || this.curY !== y) {
        out.push(CUP(x0, y));
        this.curX = x0;
        this.curY = y;
      }
      // 写段并同步 front（本段单元格逐个覆盖）
      let runFg = -1;
      for (let i = x0; i < x1; i += 1) {
        const idx = base + i;
        const w = next.widths[idx];
        const ch = next.chars[idx];
        this.front.chars[idx] = ch;
        this.front.widths[idx] = w;
        this.front.fg[idx] = next.fg[idx];
        if (w === 0 && ch === '') continue; // 宽字符续列：终端自动右移，无需输出
        const fg = next.fg[idx];
        if (fg !== runFg) {
          out.push(fg === 0 ? SGR_RESET : codeToFgSgr(fg));
          runFg = fg;
          this.curFg = fg;
        }
        out.push(ch);
        this.curX += w === 0 ? 1 : w;
      }
      if (runFg !== 0) {
        out.push(SGR_RESET);
        this.curFg = 0;
      }
    }
  }

  _same(next, idx) {
    const f = this.front;
    return f.chars[idx] === next.chars[idx] && f.widths[idx] === next.widths[idx] && f.fg[idx] === next.fg[idx];
  }

  /** 把 front 同步为 next（demo 若自己维护 buffer 状态可省；diff 后调用便于链式帧） */
  swap(next) {
    if (this.front === null) {
      this.front = new CellBuffer(next.cols, next.rows);
    } else if (next.cols !== this.front.cols || next.rows !== this.front.rows) {
      this.front.resize(next.cols, next.rows);
    }
    this.front.chars = next.chars.slice();
    this.front.widths = next.widths.slice();
    this.front.fg = next.fg.slice();
  }

  /** 直接写一行文本（输入行等简单场景：定位+整行重写+清除行尾） */
  writeLine(y, text, fg = 0) {
    const out = [CUP(0, y), text, `${ESC}[K`];
    this.curX = -1; // 行尾位置不确定，强制下帧重新定位
    this.stdout.write(out.join(''));
  }

  stop() {
    if (this.restored) return;
    this.restored = true;
    this.started = false;
    this.stdout.write(MOUSE_OFF + SHOW_CURSOR + SGR_RESET + ALT_EXIT);
    try {
      process.removeListener('SIGINT', this._onSignal);
      process.removeListener('SIGHUP', this._onSignal);
      process.removeListener('SIGTERM', this._onSignal);
      process.removeListener('exit', this._onExit);
    } catch { /* exit 阶段移除失败不影响恢复 */ }
  }
}
