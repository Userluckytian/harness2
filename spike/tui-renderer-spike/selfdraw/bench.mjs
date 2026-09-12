// bench.mjs — 方案B（自研最小渲染层）进程内压测。输出流接 NullStdout（丢弃字节，记录字节数）。
// 运行：node bench.mjs
// 口径（如实写明）：
// - 所有计时为 performance.now() 进程内 wall time，不含真实终端 I/O 与 vsync；
// - 「初始满帧」= 10k 逻辑行全部断行（冷 wrap）+ 前缀和 + 首帧 fill + diff 全帧输出；
// - 「滚动差量帧」= 滚动模型更新 + viewport fill + diff + 输出（输出流接 null）；
//   分两组：wheel 步（3 物理行）×2000、整页翻页（viewportRows）×2000；
// - 「宽字符测量/断行」= 10k 行全部重新 wrap（含 CJK/emoji/长行混合），另给 CJK 行子集；
// - 「输入回显」= 键入字符 → draft 更新 → 帧呈现（差量）的进程内耗时，不含真实终端回显；
// - RSS 用 process.memoryUsage().rss。
import { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { CellBuffer } from './cell-buffer.mjs';
import { Renderer } from './renderer.mjs';
import { Scrollback, wrapLine } from './scrollback.mjs';
import { generateLines } from '../common/generate-transcript.mjs';

const COLS = 100;
const ROWS = 32;
const VIEWPORT = ROWS - 1; // 底部 1 行输入

class NullStdout extends Writable {
  bytes = 0;
  writes = 0;
  _write(chunk, _e, cb) { this.bytes += chunk.length; this.writes += 1; cb(); }
}

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const sum = s.reduce((p, c) => p + c, 0);
  return {
    n: s.length,
    avg: +(sum / s.length).toFixed(3),
    p50: +s[Math.floor(s.length * 0.5)].toFixed(3),
    p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
  };
}

const R = {};
R.rssBaseMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
const lines = generateLines(10000, 42);

// ---- 1) 宽字符测量/断行（10k 全量冷 wrap）----
{
  const t0 = performance.now();
  let units = 0;
  const cjkTimes = [];
  for (const line of lines) {
    const t1 = performance.now();
    const rows = wrapLine(line, COLS);
    const dt = performance.now() - t1;
    units += rows.length;
    if (/[\u4e00-\u9fff]/.test(line)) cjkTimes.push(dt);
  }
  R.wrapAll10kMs = +(performance.now() - t0).toFixed(1);
  R.wrapTotalPhysicalRows = units;
  R.wrapCjkLine = stats(cjkTimes);
}

// ---- 2) 滚动模型构建（前缀和）----
const sb = new Scrollback(lines, COLS);
sb.viewportRows = VIEWPORT;
{
  const t0 = performance.now();
  sb.view(VIEWPORT); // 触发全量前缀和构建
  R.prefixBuildMs = +(performance.now() - t0).toFixed(2);
  R.totalPhysicalRows = sb.totalRows;
}

// ---- 3) 10k 行初始满帧绘制 ----
const back = new CellBuffer(COLS, ROWS);
const stdout = new NullStdout();
const renderer = new Renderer(stdout);
renderer.start({ mouse: false });
{
  // fill（首帧：viewport 内容 + 输入行）
  const t0 = performance.now();
  back.clear();
  const view = sb.view(VIEWPORT);
  for (let i = 0; i < view.length && i < VIEWPORT; i += 1) back.writeText(i, view[i].text);
  back.writeText(ROWS - 1, 'input> _');
  const fillMs = performance.now() - t0;
  const t1 = performance.now();
  const bytes = renderer.present(back);
  R.initFullFrame = {
    fillMs: +fillMs.toFixed(2),
    presentMs: +(performance.now() - t1).toFixed(2),
    totalMs: +(performance.now() - t0).toFixed(2),
    bytes,
    note: '冷 wrap 已在步骤1单独计时（R.wrapAll10kMs）；此满帧含 diff 首帧全量输出',
  };
  // 冷启动口径（与 A 对齐）：performance.now() 以进程起点为 0，此值含模块加载 + 数据生成
  // + 10k 行断行 + 前缀和 + 首帧差量输出，即「进程起 → 首帧就绪」。
  R.coldStartToFirstFrameMs = +performance.now().toFixed(1);
}
R.rssAfterInitMB = +(process.memoryUsage().rss / 1048576).toFixed(1);

// ---- 4) 滚动差量帧（wheel 步 ×2000）----
function doWheelFrame(n) {
  sb.follow = false;
  sb.scroll(n);
  const view = sb.view(VIEWPORT);
  back.clear();
  for (let i = 0; i < view.length && i < VIEWPORT; i += 1) back.writeText(i, view[i].text);
  back.writeText(ROWS - 1, 'input> _');
  return renderer.present(back);
}
{
  sb.goToBottom();
  const times = [];
  let bytes = 0;
  // 预热 50 帧
  for (let i = 0; i < 50; i += 1) doWheelFrame(i % 2 === 0 ? -3 : 3);
  for (let i = 0; i < 2000; i += 1) {
    const t0 = performance.now();
    doWheelFrame(i % 2 === 0 ? -3 : 3); // 交替上/下滚，模拟真实滚轮
    times.push(performance.now() - t0);
  }
  R.wheelFrames = stats(times);
  R.wheelFrameBytesAvg = +(stdout.bytes / Math.max(1, stdout.writes)).toFixed(1);
}

// ---- 5) 整页翻页差量帧 ×2000 ----
{
  stdout.bytes = 0; stdout.writes = 0;
  sb.goToBottom();
  const times = [];
  const dir = () => (Math.floor(sb.scrollTopRow / VIEWPORT) % 2 === 0 ? -VIEWPORT : VIEWPORT);
  for (let i = 0; i < 50; i += 1) doWheelFrame(i % 2 === 0 ? -VIEWPORT : VIEWPORT);
  for (let i = 0; i < 2000; i += 1) {
    const t0 = performance.now();
    doWheelFrame(i % 2 === 0 ? -VIEWPORT : VIEWPORT);
    times.push(performance.now() - t0);
  }
  R.pageFrames = stats(times);
  R.pageFrameBytesAvg = +(stdout.bytes / Math.max(1, stdout.writes)).toFixed(1);
}

// ---- 6) 输入回显帧（键入字符 → draft → 差量帧）----
{
  const times = [];
  let draft = '';
  sb.goToBottom();
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    draft += 'a';
    const view = sb.view(VIEWPORT);
    for (let j = 0; j < view.length && j < VIEWPORT; j += 1) back.writeText(j, view[j].text);
    back.writeText(ROWS - 1, `input> ${draft}_`);
    renderer.present(back);
    times.push(performance.now() - t0);
  }
  R.echoFrame = stats(times);
}

R.rssEndMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
R.stdoutTotalBytes = stdout.bytes;

console.log('RESULT_JSON=' + JSON.stringify(R));
