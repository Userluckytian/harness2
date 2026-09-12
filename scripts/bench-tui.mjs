// bench-tui.mjs — P2 方案 B 渲染层性能基线（10k 行合成转录）。
//
// 运行：pnpm --filter harness2 build && node scripts/bench-tui.mjs
// 口径（与 P0 spike bench.mjs 同口径，如实写明）：
// - 所有计时为 performance.now() 进程内 wall time，不含真实终端 I/O 与 vsync；
// - 「初始满帧」= viewport fill + 首帧 diff 全量输出（冷 wrap 单独计时）；
// - 「滚动差量帧」= viewport 重填 + diff + 输出（输出流接 null），wheel 步（3 物理行）×2000；
// - 「idle 帧」= 内容无变化的重复 present（期望零输出零字节）；
// - 「输入回显」= 键入字符 → draft 更新 → 差量帧呈现的进程内耗时；
// - RSS 用 process.memoryUsage().rss。
// 数据：内嵌 spike 同款确定性生成器（mulberry32 seed=42，60% ASCII / 20% CJK /
// 10% emoji 混合 / 10% 200~400 字符长行）；wrapLine 同 spike 算法内嵌。
// 渲染核心从 packages/cli/dist 导入（先 pnpm --filter harness2 build）。
import { Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const distDir = fileURLToPath(new URL('../packages/cli/dist/tui/renderer/', import.meta.url));
if (!existsSync(distDir + 'cell-buffer.js')) {
  console.error('缺少构建产物：先运行 pnpm --filter harness2 build 再跑本基准。');
  process.exit(1);
}
const { CellBuffer, charWidth } = await import(pathToFileURL(distDir + 'cell-buffer.js').href);
const { DiffPresenter } = await import(pathToFileURL(distDir + 'diff-presenter.js').href);

const COLS = 100;
const ROWS = 32;
const VIEWPORT = ROWS - 1; // 底部 1 行输入

// ---------- 内嵌：确定性数据生成（spike common/generate-transcript.mjs 同款） ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = ((t + (t ^ (t >>> 14))) >>> 0) / 4294967296;
    return t;
  };
}

const ASCII_WORDS =
  'the renderer scrolls transcript buffer diff cell grid frame budget latency throughput virtualization viewport anchor sticky follow momentum inertia flicker tear resize alternate screen cursor report sequence grade compile bundle package install license native binding'.split(
    ' ',
  );
const CJK_SENTENCES = [
  '渲染层选型需要实测数据支撑，不能只看社区口碑。',
  '终端本质是字符网格，宽字符占两列，断行时不能切开。',
  '滚动模型要区分跟随、锚定与粘性三种状态。',
  '输入框恒定贴底，弹层锚定在输入框上方。',
  '鼠标滚轮在任意区域滚动转录，悬停下拉时改选。',
  '子代理块运行时有动画，完成后按成功失败着色。',
  '异常退出必须恢复鼠标上报与光标状态。',
  '一万行转录下滚动帧耗要低于三十三毫秒。',
];
const EMOJI = ['✅', '⏺', '🐛', '⚠️', '🚀', '🇨🇳', '👍', '🎉'];

function asciiLine(rand) {
  const n = 8 + Math.floor(rand() * 20);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(ASCII_WORDS[Math.floor(rand() * ASCII_WORDS.length)]);
  return parts.join(' ');
}
function cjkLine(rand) {
  const n = 1 + Math.floor(rand() * 3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(CJK_SENTENCES[Math.floor(rand() * CJK_SENTENCES.length)]);
  return parts.join('');
}
function emojiLine(rand) {
  const e = EMOJI[Math.floor(rand() * EMOJI.length)];
  return `${e} ${asciiLine(rand)} ${e} ${cjkLine(rand)}`;
}
function longLine(rand) {
  const target = 200 + Math.floor(rand() * 200);
  let s = '';
  while (s.length < target) s += asciiLine(rand) + ' ';
  return s.slice(0, target);
}
const KINDS = [
  { w: 0.6, make: asciiLine },
  { w: 0.2, make: cjkLine },
  { w: 0.1, make: emojiLine },
  { w: 0.1, make: longLine },
];
function generateLines(n = 10000, seed = 42) {
  const rand = mulberry32(seed);
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rand();
    let acc = 0;
    for (const k of KINDS) {
      acc += k.w;
      if (r < acc) {
        lines[i] = k.make(rand);
        break;
      }
    }
  }
  return lines;
}

// ---------- 内嵌：宽字符断行（spike scrollback.mjs wrapLine 同款） ----------
// 宽度判定直接复用 dist 导出的 charWidth，保证与 CellBuffer 渲染口径一致。

function wrapLine(text, cols) {
  if (text.length === 0) return [''];
  const out = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) {
      cur += ch;
      continue;
    }
    if (curW + w > cols) {
      if (w === 2 && curW < cols) {
        out.push(cur);
        cur = ch;
        curW = 2;
        continue;
      }
      out.push(cur);
      cur = ch;
      curW = w;
      continue;
    }
    cur += ch;
    curW += w;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

// ---------- 基准 ----------
class NullStdout extends Writable {
  bytes = 0;
  writes = 0;
  _write(chunk, _e, cb) {
    this.bytes += chunk.length;
    this.writes += 1;
    cb();
  }
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

// 1) 10k 行冷断行（宽字符感知 wrap）
let physicalRows;
{
  const t0 = performance.now();
  physicalRows = [];
  for (const line of lines) physicalRows.push(...wrapLine(line, COLS));
  R.wrapAll10kMs = +(performance.now() - t0).toFixed(1);
  R.totalPhysicalRows = physicalRows.length;
}

const back = new CellBuffer(COLS, ROWS);
const stdout = new NullStdout();
const presenter = new DiffPresenter(stdout);

function fillFrame(scrollTop, draft) {
  back.clear();
  for (let i = 0; i < VIEWPORT; i += 1) {
    const row = physicalRows[scrollTop + i];
    if (row !== undefined && row.length > 0) back.writeText(i, row);
  }
  back.writeText(ROWS - 1, `input> ${draft}_`);
}

// 2) 初始满帧（首帧 diff 全量输出）
{
  const scrollTop = Math.max(0, physicalRows.length - VIEWPORT);
  const t0 = performance.now();
  fillFrame(scrollTop, '');
  const fillMs = performance.now() - t0;
  const t1 = performance.now();
  const bytes = presenter.present(back);
  R.initFullFrame = {
    fillMs: +fillMs.toFixed(2),
    presentMs: +(performance.now() - t1).toFixed(2),
    totalMs: +(performance.now() - t0).toFixed(2),
    bytes,
  };
}
R.rssAfterInitMB = +(process.memoryUsage().rss / 1048576).toFixed(1);

// 3) 滚动差量帧 ×2000（wheel 步 ±3 物理行，交替上下）
{
  let scrollTop = Math.max(0, physicalRows.length - VIEWPORT);
  const doFrame = (step) => {
    scrollTop = Math.max(0, Math.min(physicalRows.length - VIEWPORT, scrollTop + step));
    fillFrame(scrollTop, '');
    return presenter.present(back);
  };
  for (let i = 0; i < 50; i += 1) doFrame(i % 2 === 0 ? -3 : 3); // 预热
  const times = [];
  stdout.bytes = 0;
  stdout.writes = 0;
  for (let i = 0; i < 2000; i += 1) {
    const t0 = performance.now();
    doFrame(i % 2 === 0 ? -3 : 3);
    times.push(performance.now() - t0);
  }
  R.scrollFrames = stats(times);
  R.scrollFrameBytesAvg = +(stdout.bytes / Math.max(1, stdout.writes)).toFixed(1);
}

// 4) idle diff 帧：内容无变化的重复 present（期望 0 字节）
{
  const times = [];
  let zeroBytes = true;
  for (let i = 0; i < 50; i += 1) presenter.present(back); // 预热
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    const bytes = presenter.present(back);
    if (bytes !== 0) zeroBytes = false;
    times.push(performance.now() - t0);
  }
  R.idleFrames = stats(times);
  R.idleFramesAllZeroBytes = zeroBytes;
}

// 5) 输入回显帧（键入字符 → draft → 差量帧）×200
{
  let scrollTop = Math.max(0, physicalRows.length - VIEWPORT);
  let draft;
  const times = [];
  for (let i = 0; i < 20; i += 1) {
    fillFrame(scrollTop, 'x'.repeat(i % 8));
    presenter.present(back);
  }
  for (let i = 0; i < 200; i += 1) {
    const t0 = performance.now();
    draft = 'a'.repeat((i % 40) + 1);
    fillFrame(scrollTop, draft);
    presenter.present(back);
    times.push(performance.now() - t0);
  }
  R.echoFrames = stats(times);
}

R.rssEndMB = +(process.memoryUsage().rss / 1048576).toFixed(1);

console.log(JSON.stringify(R));
