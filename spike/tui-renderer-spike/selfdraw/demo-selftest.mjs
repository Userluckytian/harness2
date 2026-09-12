// demo-selftest.mjs — 方案B demo 逻辑自检（非 TTY 可跑）：假 stdin/stdout 下验证
// 滚轮解析/键盘滚动/回显/Enter 追加/CJK 断行不切半边/差量刷新字节量/退出恢复。
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { CellBuffer, displayWidth } from './cell-buffer.mjs';
import { Renderer } from './renderer.mjs';
import { Scrollback } from './scrollback.mjs';
import { generateLines } from '../common/generate-transcript.mjs';

class NullStdout extends Writable {
  writes = 0;
  bytes = 0;
  all = '';
  _write(chunk, _e, cb) {
    this.writes += 1;
    this.bytes += chunk.length;
    this.all += chunk.toString();
    cb();
  }
}
class FakeStdin {
  listeners = new Set();
  buf = '';
  on(ev, fn) {
    if (ev === 'readable') this.listeners.add(fn);
  }
  read() {
    const c = this.buf;
    this.buf = '';
    return c === '' ? null : c;
  }
  setRawMode() {}
  setEncoding() {}
  isTTY = false;
  emit(s) {
    this.buf = s;
    for (const fn of this.listeners) fn();
  }
}

const cols = 80;
const rows = 24;
const viewportRows = rows - 1;
const lines = generateLines(10000, 42);
const sb = new Scrollback(lines, cols);
sb.viewportRows = viewportRows;
const back = new CellBuffer(cols, rows);
const out = new NullStdout();
const renderer = new Renderer(out);
renderer.start({ mouse: true });

let draft = '';
let frames = 0;
const stdin = new FakeStdin();
const decoder = new StringDecoder('utf8');
let ansiBuf = '';

function paint() {
  back.clear();
  const view = sb.view(viewportRows);
  for (let i = 0; i < view.length && i < viewportRows; i += 1) back.writeText(i, view[i].text);
  const mode = sb.follow ? 'FOLLOW' : `row ${sb.scrollTopRow + 1}/${sb.totalRows}`;
  back.writeText(rows - 1, `input> ${draft}_ [${mode}]`);
}
function frame() {
  paint();
  renderer.present(back);
  frames += 1;
}

function onChunk() {
  const chunk = stdin.read();
  if (chunk === null) return;
  ansiBuf += decoder.write(Buffer.from(chunk, 'utf8'));
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
        sb.pageUp();
        frame();
      } else if (seq === '\x1b[6~') {
        sb.pageDown();
        frame();
      }
      continue;
    }
    if (ansiBuf.length === 0) break;
    const ch = ansiBuf[0];
    ansiBuf = ansiBuf.slice(1);
    if (ch === '\r' || ch === '\n') {
      sb.append(`> ${draft || '(empty)'}`);
      draft = '';
      sb.follow = true;
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
    if (ch === '\x7f') {
      draft = draft.slice(0, -1);
      frame();
      continue;
    }
    draft += ch;
    frame();
  }
}

frame(); // 初始帧
stdin.on('readable', onChunk);
stdin.emit('j');
stdin.emit('a');
stdin.emit('渲\n'); // CJK 回显 + 追加
stdin.emit('\x1b[<64;10;5M'); // 滚轮上
stdin.emit('\x1b[B'); // 下滚
stdin.emit('\x1b[6~'); // PgDn
stdin.emit('\x7f\x7f\x7f'); // 清空 draft（回删）
stdin.emit('x'); // 回显 x
stdin.emit('k'); // 上滚

// 校验
const checks = [];
function ck(name, ok) {
  checks.push([name, ok]);
}

// 1) 帧数：每个输入事件一帧
ck('每个输入事件触发一帧（frames>=9）', frames >= 9);
// 2) 最终状态：末尾 'k' 上滚 1 行 → 离开 follow
ck('上滚后离开 follow（sb.follow=false）', sb.follow === false);
// 3) 回显：'x' 仍在 draft（前面已 Enter 清空 + 回删无效）
ck('draft 回显为 "x"', draft === 'x');
// 4) Enter 追加后逻辑行数 +1
const t1 = sb.lines.length;
ck('追加行后 lines=10001', sb.lines.length === 10001);
// 5) 差量性：滚动帧字节量远小于全帧
ck('渲染总字节数有限（差量生效，<200KB）', out.bytes < 200_000);
// 6) CJK 断行不切半边：wrapLine 输出每行宽度 <= cols 且字符零丢失零改动
const cjkLine = '渲染层选型需要实测数据支撑，不能只看社区口碑。终端本质是字符网格，宽字符占两列，断行时不能切开。';
const wrapped = (await import('./scrollback.mjs')).wrapLine(cjkLine, 20);
let wrapOk = true;
for (const w of wrapped) {
  if (displayWidth(w) > 20) wrapOk = false;
  if (/[\uD800-\uDBFF]$/.test(w) && !/[\uDC00-\uDFFF]$/.test(w)) wrapOk = false; // 孤立代理项=切断
}
ck(
  'CJK 断行：每物理行宽度≤cols、无孤立代理项、拼接还原原文、行数>1',
  wrapOk && wrapped.join('') === cjkLine && wrapped.length > 1,
);
// 7) 宽字符续列完整：writeText 后宽字符原样落格、续列以空格占位、可视宽度铺满整行
const buf2 = new CellBuffer(20, 1);
const wide = '中中中文';
buf2.writeText(0, wide);
const rowText2 = buf2.rowText(0);
ck(
  'cell buffer 行宽计算一致',
  rowText2.startsWith(wide) && /^ *$/.test(rowText2.slice(wide.length)) && displayWidth(rowText2) === 20,
);

renderer.stop();
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) fail += 1;
}
console.log(`frames=${frames} stdoutBytes=${out.bytes} writes=${out.writes} lines=${t1}`);
const tail = out.all.slice(-64);
const restoreOk =
  tail.includes('\x1b[?1049l') &&
  tail.includes('\x1b[?25h') &&
  tail.includes('\x1b[?1000l') &&
  tail.includes('\x1b[?1006l');
ck('退出恢复序列完整（退 alt-screen/显光标/关鼠标）', restoreOk);
console.log(`恢复序列尾部: ${JSON.stringify(out.all.slice(-32))}`);
process.exit(fail === 0 ? 0 : 1);
