// demo.mjs — 方案B 真机 demo：自研 cell buffer 渲染层 + 10k 行转录滚动 + 底部输入行。
// 运行：node demo.mjs（需真终端）
//   鼠标滚轮       上/下 3 行（SGR：\x1b[<64;x;yM / \x1b[<65;x;yM）
//   j(下)/k(上) 或 ↑/↓  滚 1 行；PageUp/PageDown 翻页；g/G 到顶/贴尾
//   任意键入       底部输入行回显（UTF-8 多字节安全：StringDecoder 缓冲半个码点）
//   Enter          追加一条 user 消息进转录并贴尾
//   q 或 Ctrl+C    退出（恢复鼠标上报/光标/主屏缓冲）
// Windows 注意：Node 的 raw mode 在 ConPTY 下可用；Ctrl+C 在 raw mode 下到达为字节 0x03，
// 由本 demo 显式处理并 restore（不依赖 SIGINT 时序）。
import { StringDecoder } from 'node:string_decoder';
import { CellBuffer, charWidth, displayWidth } from './cell-buffer.mjs';
import { Renderer } from './renderer.mjs';
import { Scrollback } from './scrollback.mjs';
import { generateLines } from '../common/generate-transcript.mjs';

const lines = generateLines(10000, 42);
let cols = process.stdout.columns || 100;
let rows = process.stdout.rows || 30;
let viewportRows = Math.max(3, rows - 1); // 底部 1 行输入

const sb = new Scrollback(lines, cols);
sb.viewportRows = viewportRows;
const back = new CellBuffer(cols, rows);
const renderer = new Renderer(process.stdout);
renderer.start({ mouse: true });

let draft = '';

function truncateTail(s, max) {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** 把当前帧内容画进 back buffer（转录区 + 底部输入行） */
function paintFrame() {
  const view = sb.view(viewportRows);
  for (let i = 0; i < view.length && i < viewportRows; i += 1) {
    back.writeText(i, view[i].text);
  }
  const mode = sb.follow ? 'FOLLOW' : `row ${sb.scrollTopRow + 1}/${sb.totalRows}`;
  const prefix = `input> ${draft}_`;
  const status = ` [wheel j/k PgUp/PgDn g/G | Enter send | q quit] ${mode}`;
  back.writeText(rows - 1, prefix + truncateTail(status, cols - displayWidth(prefix)));
}

/** 每帧入口：paint + 差量呈现 */
function frame() {
  paintFrame();
  renderer.present(back);
}

/** 全量重绘（初始化/resize），其余走差量 */
function redrawFull() {
  back.clear();
  renderer.front = null;
  frame();
}

process.stdout.on('resize', () => {
  cols = process.stdout.columns || cols;
  rows = process.stdout.rows || rows;
  viewportRows = Math.max(3, rows - 1);
  sb.setCols(cols);
  sb.viewportRows = viewportRows;
  back.resize(cols, rows);
  redrawFull();
});

// ---- stdin 解析（raw mode；UTF-8 与 ANSI 序列增量缓冲）----
const decoder = new StringDecoder('utf8');
let ansiBuf = '';

function exit(code) {
  try {
    renderer.stop();
  } catch {
    /* 已恢复 */
  }
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* 非 TTY */
  }
  process.exit(code);
}

function onStdinChunk() {
  const chunk = process.stdin.read();
  if (chunk === null) return;
  ansiBuf += decoder.write(chunk);
  for (;;) {
    const mouse = ansiBuf.match(/^\x1b\[<(\d+);\d+;\d+([Mm])/);
    if (mouse) {
      ansiBuf = ansiBuf.slice(mouse[0].length);
      if (mouse[2] === 'M' && mouse[1] === '64') {
        sb.follow = false;
        sb.scroll(-3);
        frame();
      } else if (mouse[2] === 'M' && mouse[1] === '65') {
        sb.scroll(3);
        frame();
      }
      continue;
    }
    const csi = ansiBuf.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    if (csi) {
      const seq = csi[0];
      ansiBuf = ansiBuf.slice(seq.length);
      if (seq === '\x1b[A') {
        sb.follow = false;
        sb.scroll(-1);
        frame();
      } else if (seq === '\x1b[B') {
        sb.follow = false;
        sb.scroll(1);
        frame();
      } else if (seq === '\x1b[5~') {
        sb.follow = false;
        sb.pageUp();
        frame();
      } else if (seq === '\x1b[6~') {
        sb.pageDown();
        frame();
      } else if (seq === '\x1b[H' || seq === '\x1b[1~') {
        sb.goToTop();
        frame();
      } else if (seq === '\x1b[F' || seq === '\x1b[4~') {
        sb.goToBottom();
        frame();
      }
      continue;
    }
    if (ansiBuf.length === 0) break;
    const ch = ansiBuf[0];
    ansiBuf = ansiBuf.slice(1);
    if (ch === '\x03') {
      exit(0);
      return;
    } // Ctrl+C（raw mode 字节，显式恢复）
    if (ch === 'q' && draft === '') {
      exit(0);
      return;
    }
    if (ch === '\r' || ch === '\n') {
      sb.append(`> ${draft || '(empty)'}`);
      draft = '';
      sb.follow = true;
      frame();
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      draft = draft.slice(0, -1);
      frame();
      continue;
    }
    if (ch === 'j') {
      sb.scroll(1);
      frame();
      continue;
    } // vim：j=下滚
    if (ch === 'k') {
      sb.follow = false;
      sb.scroll(-1);
      frame();
      continue;
    } // k=上滚
    if (ch === 'g') {
      sb.goToTop();
      frame();
      continue;
    }
    if (ch === 'G') {
      sb.goToBottom();
      frame();
      continue;
    }
    if (ch === '\x1b') {
      ansiBuf = '';
      continue;
    } // 孤立 ESC：丢弃
    draft += ch; // 普通字符回显（含 CJK）
    frame();
  }
}

process.stdin.on('readable', onStdinChunk);
process.on('SIGINT', () => exit(130));
process.on('SIGHUP', () => exit(129));
if (process.stdin.isTTY) process.stdin.setRawMode(true);

redrawFull();
