// worker.mjs — bench 子进程：跑单个阶段并以最后一行 JSON 输出结果。
// 用法：node worker.mjs <mode>
//   cold        动态 import ink/react + 首帧（进程内计时）
//   init-10k    非虚拟化直接渲染 10k 行（预期极慢，如实测）
//   init-vp     虚拟化窗口初始渲染（viewport±缓冲，模拟 TranscriptView computeViewport 思路）
//   scroll      虚拟化窗口下程序化滚动 2000 步，逐帧计时（rerender→stdout 落写）
//   echo        useInput 按键回显延迟（stdin 注入字节→stdout 落写）
// 口径：性能钩子 performance.now()；stdout 为 NullStdout（丢弃字节），
// 「落写」= ink 向 stdout 发起 write（不等于真实终端刷屏耗时）。
import React from 'react';
import { performance } from 'node:perf_hooks';
import { generateLines } from '../common/generate-transcript.mjs';
import { NullStdout, FakeStdin } from './fake-streams.mjs';

const mode = process.argv[2] ?? '';
const VIEWPORT_H = 28; // 可视行数（模拟 rows-2 的转录区）
const BUFFER = 10; // 上下缓冲行数
const SCROLL_STEPS = 2000; // 滚动步数
const SCROLL_LINES_PER_STEP = 3; // 每步滚动行数（对齐一次滚轮 notch 的常见量级）

const lines = generateLines(10000, 42);
const out = new NullStdout();

// 虚拟化窗口组件：只渲染 [scrollTop-BUFFER, scrollTop+VIEWPORT_H+BUFFER)
function VirtualTranscript({ scrollTop }) {
  const start = Math.max(0, scrollTop - BUFFER);
  const end = Math.min(lines.length, scrollTop + VIEWPORT_H + BUFFER);
  const slice = lines.slice(start, end);
  const rows = [];
  for (let i = 0; i < slice.length; i += 1) {
    rows.push(
      React.createElement(
        'ink-box',
        { key: start + i, style: { flexDirection: 'row' } },
        React.createElement('ink-text', {}, slice[i]),
      ),
    );
  }
  return React.createElement('ink-box', { style: { flexDirection: 'column', width: 100 } }, ...rows);
}

// 非虚拟化：一次性渲染全部 10k 行
function FullTranscript() {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    rows.push(
      React.createElement(
        'ink-box',
        { key: i, style: { flexDirection: 'row' } },
        React.createElement('ink-text', {}, lines[i]),
      ),
    );
  }
  return React.createElement('ink-box', { style: { flexDirection: 'column', width: 100 } }, ...rows);
}

const result = { mode };
result.rssDataMB = +(process.memoryUsage().rss / 1048576).toFixed(1);

if (mode === 'cold') {
  // 冷启动口径：脚本已启动后的 import 时间 + 首帧 write 时间；
  // 含 node bootstrap 的总冷启动由父进程 spawnSync 计时。
  const t0 = performance.now();
  const inkMod = await import('ink');
  result.importInkMs = +(performance.now() - t0).toFixed(1);
  const tRender = performance.now();
  const inst = inkMod.render(
    React.createElement(
      'ink-box',
      { style: { flexDirection: 'column', width: 100 } },
      React.createElement('ink-text', {}, lines[0]),
      React.createElement('ink-text', {}, 'input> _'),
    ),
    { stdout: out, stdin: new FakeStdin(), exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  await new Promise((r) => setTimeout(r, 120)); // 等 30fps 节流后的首帧落写
  inst.unmount();
  result.firstFrameMs = +(out.lastWriteAt - tRender).toFixed(1);
  result.totalMs = +performance.now().toFixed(1);
}

if (mode === 'init-10k' || mode === 'init-vp') {
  const inkMod = await import('ink');
  const el =
    mode === 'init-10k'
      ? React.createElement(FullTranscript)
      : React.createElement(VirtualTranscript, { scrollTop: 10000 - VIEWPORT_H });
  let renderTimeMs = -1;
  const t0 = performance.now();
  const inst = inkMod.render(el, {
    stdout: out,
    stdin: new FakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    onRender: (info) => {
      renderTimeMs = info.renderTime;
    },
  });
  // 等节流后的帧真正落写（最多 5s）
  const tWait0 = performance.now();
  while (out.writes === 0 && performance.now() - tWait0 < 5000) await new Promise((r) => setImmediate(r));
  result.wallToFirstWriteMs = +(out.lastWriteAt - t0).toFixed(1);
  result.reactRenderTimeMs = +renderTimeMs.toFixed(1);
  result.rssAfterInitMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
  result.stdoutBytesFirstFrame = out.bytes;
  inst.unmount();
}

if (mode === 'scroll') {
  const inkMod = await import('ink');
  let scrollTop = 5000; // 从中部开始滚
  let _renderTimeMs = -1;
  const inst = inkMod.render(React.createElement(VirtualTranscript, { scrollTop }), {
    stdout: out,
    stdin: new FakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    onRender: (info) => {
      _renderTimeMs = info.renderTime;
    },
  });
  await settle();
  const lat = [];
  const cpu = [];
  for (let i = 0; i < SCROLL_STEPS; i += 1) {
    scrollTop = Math.min(10000 - VIEWPORT_H, scrollTop + SCROLL_LINES_PER_STEP);
    const t0 = performance.now();
    const writeMark = out.writes;
    const tReact0 = performance.now();
    inst.rerender(React.createElement(VirtualTranscript, { scrollTop }));
    cpu.push(performance.now() - tReact0);
    const ok = await waitForWrite(writeMark);
    lat.push(performance.now() - t0);
    if (!ok) {
      result.flushTimeoutAtStep = i;
      break;
    }
  }
  await settle();
  inst.unmount();
  result.steps = lat.length;
  result.frameLatency = stats(lat);
  result.rerenderCpu = stats(cpu);
  result.rssAfterScrollMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
  result.stdoutTotalBytes = out.bytes;
  result.note = 'rerenderCpu 只含 rerender() 同步调用；ink 30fps 节流的排队等待包含在 frameLatency 里';
}

if (mode === 'echo') {
  const inkMod = await import('ink');
  const { useInput } = inkMod;
  function EchoApp() {
    const [buf, setBuf] = React.useState('');
    useInput((data) => {
      setBuf((b) => b + data);
    });
    return React.createElement(
      'ink-box',
      { style: { flexDirection: 'column', width: 100 } },
      React.createElement('ink-text', {}, 'transcript placeholder line'),
      React.createElement('ink-text', {}, `input> ${buf}_`),
    );
  }
  const stdin = new FakeStdin();
  inkMod.render(React.createElement(EchoApp), {
    stdout: out,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  await settle();
  const lat = [];
  const chars = 'abcdefghij'.repeat(12); // 120 个样本
  for (const ch of chars) {
    const t0 = performance.now();
    const writeMark = out.writes;
    stdin.emitInput(ch);
    const ok = await waitForWrite(writeMark);
    lat.push(performance.now() - t0);
    if (!ok) {
      result.flushTimeout = true;
      break;
    }
  }
  result.samples = lat.length;
  result.echoLatency = stats(lat);
  result.rssMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
  result.note = '延迟含 ink 30fps 节流的尾沿排队；useInput→setState→重渲→落写全链路';
}

function stats(a) {
  if (a.length === 0) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const sum = s.reduce((p, c) => p + c, 0);
  return {
    n: s.length,
    avg: +(sum / s.length).toFixed(2),
    p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
    p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

async function waitForWrite(prevWrites) {
  const deadline = performance.now() + 2000;
  while (out.writes === prevWrites && performance.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
  return out.writes !== prevWrites;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 120));
}

// 输出最后一行 JSON（父进程解析）
console.log('RESULT_JSON=' + JSON.stringify(result));
process.exit(0);
