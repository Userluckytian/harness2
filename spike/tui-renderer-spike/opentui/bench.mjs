// P0 spike 方案 C：OpenTUI 性能基准（headless）
// 运行：bun bench.mjs   （Node 22 无 node:ffi，不可运行 —— 见 results.md）
// 方法：CliRendererConfig 传入自定义 stdin/stdout 与固定 120x40 画布，stdout 全部丢弃；
//       gatherStats=true 用 renderer.getStats() 取帧统计；
//       滚动驱动：劫持后的全局 requestAnimationFrame 每帧 scrollBy(3)，测 240 帧帧间隔（含布局+绘制）。
// 输出：JSON 摘要（stdout）。
import { PassThrough, Writable } from "node:stream";
import { createElement as h } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { generateLines } from "../common/generate-transcript.mjs";

const W = 120, H = 40;
const SCROLL_FRAMES = Number(process.env.SPIKE_SCROLL_FRAMES ?? 240);
const LINES = generateLines(10000, 42);

// ---- fake terminal ----
class NullStdout extends Writable {
  columns = W;
  rows = H;
  isTTY = false;
  _write(_chunk, _enc, cb) { cb(); }
}
const fakeStdout = new NullStdout();
const fakeStdin = new PassThrough();
fakeStdin.isTTY = false;
fakeStdin.setRawMode = () => {};
fakeStdin.ref = () => {};
fakeStdin.unref = () => {};

const t0 = performance.now();
const renderer = await createCliRenderer({
  stdin: fakeStdin,
  stdout: fakeStdout,
  width: W,
  height: H,
  targetFps: 60,
  gatherStats: true,
  exitOnCtrlC: false,
  useMouse: false,
  screenMode: "alternate-screen",
  clearOnShutdown: false,
});
const tRendererReady = performance.now();

// ---- React tree: 10k 行 scrollbox + 底部 input ----
let scrollRef = null;
let inputRef = null;
const captureScroll = (r) => { scrollRef = r; };
const captureInput = (r) => { inputRef = r; };

const children = LINES.map((line, i) =>
  h("text", { key: i }, `${String(i + 1).padStart(5)} | ${line}`)
);

const tRenderCalled = performance.now();
createRoot(renderer).render(
  h("box", { style: { flexDirection: "column", flexGrow: 1, padding: 1 } },
    h("scrollbox", {
      ref: captureScroll,
      flexGrow: 1, scrollY: true, focusable: true,
      style: { flexGrow: 1 },
    }, children),
    h("box", { style: { flexDirection: "row", flexShrink: 0 } },
      h("text", { content: "> ", fg: "#888" }),
      h("input", { ref: captureInput, flexGrow: 1, focused: true, placeholder: "bench input" }),
    ),
  ),
);

function nextFrame() {
  return new Promise((res) => {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === "function") raf(() => res(performance.now()));
    else setTimeout(() => res(performance.now()), 0);
  });
}
async function waitFrames(n) {
  for (let i = 0; i < n; i++) await nextFrame();
}

// 初始渲染：等前 3 帧稳定，取首帧时刻
await waitFrames(3);
const tFirstStable = performance.now();

if (!scrollRef) {
  console.error(JSON.stringify({ error: "scrollRef not captured" }));
  process.exit(1);
}

// ---- 滚动帧耗 ----
scrollRef.scrollTo(0);
await waitFrames(2);
const deltas = [];
let last = performance.now();
for (let i = 0; i < SCROLL_FRAMES; i++) {
  scrollRef.scrollBy(3); // 每帧滚动 3 行（模拟连续滚轮）
  const now = await nextFrame();
  deltas.push(now - last);
  last = now;
}
deltas.sort((a, b) => a - b);
const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
const p = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))];

// ---- 输入回显延迟 ----
if (!inputRef) {
  console.error(JSON.stringify({ error: "inputRef not captured" }));
  process.exit(1);
}
const echoLatencies = [];
for (const ch of "abcdefgh1234") {
  const ts = performance.now();
  fakeStdin.write(ch);
  // 逐帧轮询 input.value 变化，上限 30 帧
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) {
    await nextFrame();
    if ((inputRef.value ?? "").includes(ch)) seen = true;
  }
  if (seen) echoLatencies.push(performance.now() - ts);
  else echoLatencies.push(Number.NaN);
}

const stats = renderer.getStats();
const mem = process.memoryUsage();

const result = {
  runtime: { name: process.versions.bun ? "bun" : "node", versions: process.versions.bun ?? process.versions.node, platform: process.platform, arch: process.arch },
  canvas: `${W}x${H}`, lines: LINES.length,
  ms_rendererCreate: +(tRendererReady - t0).toFixed(1),
  ms_initialRender10k: +(tFirstStable - tRenderCalled).toFixed(1),
  scroll: {
    frames: SCROLL_FRAMES,
    avgMs: +avg.toFixed(2),
    p50Ms: +p(0.5).toFixed(2),
    p95Ms: +p(0.95).toFixed(2),
    p99Ms: +p(0.99).toFixed(2),
    maxMs: +deltas[deltas.length - 1].toFixed(2),
  },
  inputEcho: {
    measured: echoLatencies.filter((v) => !Number.isNaN(v)).length,
    total: echoLatencies.length,
    avgMs: +(echoLatencies.filter((v) => !Number.isNaN(v)).reduce((s, v) => s + v, 0) / Math.max(1, echoLatencies.filter((v) => !Number.isNaN(v)).length)).toFixed(2),
  },
  rendererStats: {
    fps: stats.fps, frameCount: stats.frameCount,
    averageFrameTime: stats.averageFrameTime, minFrameTime: stats.minFrameTime, maxFrameTime: stats.maxFrameTime,
  },
  rssMB: +(mem.rss / 1048576).toFixed(1),
  heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
};

await renderer.destroy();
console.log(JSON.stringify(result, null, 2));
process.exit(0);
