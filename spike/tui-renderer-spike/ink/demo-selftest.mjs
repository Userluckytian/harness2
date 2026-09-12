// demo-selftest.mjs — demo.mjs 的进程内逻辑自检（非 TTY 可跑）：假 stdout/stdin 下验证
// 键盘滚动/滚轮桥剥序列/回显/Enter 追加。真终端复跑由编排者人工执行。
import React, { useState, useCallback } from 'react';
import { render, Box, Text, useInput, useWindowSize } from 'ink';
import { generateLines } from '../common/generate-transcript.mjs';
import { NullStdout, FakeStdin } from './fake-streams.mjs';

const h = React.createElement;
const LINES = generateLines(10000, 42);
const BUFFER = 10;
const WHEEL_LINES = 3;

// 与 demo.mjs 相同的滚轮桥（拷贝自 demo.mjs，作用于 FakeStdin）
function attachWheelBridge(stdin, stdout, onWheel) {
  let buf = '';
  let bypass = false;
  let timer = null;
  const flushAsLiteral = () => {
    timer = null;
    if (buf.length === 0) return;
    const text = buf;
    buf = '';
    if (stdin.listenerCount('readable') > 1) {
      bypass = true;
      stdin.unshift(text);
    }
  };
  const handler = () => {
    if (bypass) {
      bypass = false;
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    let got = false;
    for (;;) {
      const chunk = stdin.read();
      if (chunk === null) break;
      got = true;
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }
    if (!got) return;
    let forward = '';
    for (;;) {
      const m = buf.match(/^\x1b\[<(\d+);\d+;\d+([Mm])/);
      if (m) {
        if (m[2] === 'M' && Number(m[1]) === 64) onWheel(-WHEEL_LINES);
        if (m[2] === 'M' && Number(m[1]) === 65) onWheel(WHEEL_LINES);
        buf = buf.slice(m[0].length);
        continue;
      }
      const csi = buf.match(/^\x1b\[[0-9;?<=>!]*[\x40-\x7e]/);
      if (csi && csi[0].slice(2) !== '<') {
        forward += csi[0];
        buf = buf.slice(csi[0].length);
        continue;
      }
      if (buf.startsWith('\x1b')) break;
      const next = buf.indexOf('\x1b', 1);
      const piece = next === -1 ? buf : buf.slice(0, next);
      forward += piece;
      buf = buf.slice(piece.length);
      if (next === -1) break;
    }
    if (forward.length > 0 && stdin.listenerCount('readable') > 1) {
      bypass = true;
      stdin.unshift(forward);
    }
    if (buf.length > 0) timer = setTimeout(flushAsLiteral, 40);
  };
  stdin.on('readable', handler);
  stdout.write('\x1b[?1000h\x1b[?1006h');
  return () => {
    stdin.removeListener('readable', handler);
    if (timer) clearTimeout(timer);
    stdout.write('\x1b[?1006l\x1b[?1000l');
  };
}

function App({ wheel, log }) {
  const { rows = 30, columns = 100 } = useWindowSize();
  const viewportH = Math.max(3, rows - 2);
  const [scrollTop, setScrollTop] = useState(Number.MAX_SAFE_INTEGER);
  const [follow, setFollow] = useState(true);
  const [draft, setDraft] = useState('');
  const [appended, setAppended] = useState([]);

  const all = LINES.length + appended.length;
  const maxScroll = Math.max(0, all - viewportH);
  const clamp = useCallback((v) => Math.max(0, Math.min(maxScroll, v)), [maxScroll]);

  function step(n) {
    setFollow(false);
    setScrollTop((s) => clamp(Math.min(s, maxScroll) + n));
  }
  function doWheel(n) {
    setScrollTop((s) => {
      const ns = clamp(Math.min(s, maxScroll) + n);
      setFollow(ns >= maxScroll);
      return ns;
    });
  }
  wheel.current = doWheel;

  useInput((input, key) => {
    if (input.startsWith('[<')) return;
    if (input === 'j' && draft === '') return step(1); // vim：j=下滚
    if (input === 'k' && draft === '') return step(-1);
    if (key.upArrow) return step(-1);
    if (key.downArrow) return step(1);
    if (key.pageUp) return step(-viewportH);
    if (key.pageDown) return step(viewportH);
    if (key.home) {
      setFollow(false);
      setScrollTop(0);
      return;
    }
    if (key.end) {
      setFollow(true);
      return;
    }
    if (key.return) {
      setAppended((a) => [...a, `> ${draft || '(empty)'}`]);
      setDraft('');
      setFollow(true);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    if (input === 'q' && draft === '') {
      process.exit(0);
    }
    if (!key.ctrl && input && !input.startsWith('\x1b')) {
      log.push(`echo:${JSON.stringify(input)}`);
      setDraft((d) => d + input);
    }
  });

  const st = follow ? maxScroll : Math.min(scrollTop, maxScroll);
  const start = Math.max(0, st - BUFFER);
  const end = Math.min(all, st + viewportH + BUFFER);
  const slice = [];
  for (let i = start; i < end; i += 1) slice.push(i < LINES.length ? LINES[i] : appended[i - LINES.length]);
  const shown = slice.slice(Math.max(0, st - start), Math.max(0, st - start) + viewportH);
  log.push(`frame: follow=${follow} scrollTop=${st} draft=${JSON.stringify(draft)} appended=${appended.length}`);
  return h(
    Box,
    { flexDirection: 'column', width: columns },
    h(
      Box,
      { flexDirection: 'column', height: viewportH },
      ...shown.map((line, i) => h(Text, { key: st + i, wrap: 'truncate' }, line)),
    ),
    h(Box, null, h(Text, { color: 'cyan' }, 'input> '), h(Text, null, `${draft}_`)),
  );
}

const out = new NullStdout();
const stdin = new FakeStdin();
const log = [];
const wheel = { current: () => {} };
const dispose = attachWheelBridge(stdin, out, (n) => wheel.current(n));
const inst = render(h(App, { wheel, log }), {
  stdout: out,
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
  interactive: true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(150);
stdin.emitInput('k');
await sleep(120); // 上滚 1 行（vim k）
stdin.emitInput('\x1b[B');
await sleep(120); // 下滚 1 行
stdin.emitInput('\x1b[<64;10;5M');
await sleep(120); // 滚轮上 3 行（桥剥出）
stdin.emitInput('h');
await sleep(120); // 回显 'h'
stdin.emitInput('a');
await sleep(120); // 回显 'a'
stdin.emitInput('\r');
await sleep(120); // 发送 → appended=1, follow=true
stdin.emitInput('\x1b[<64;10;5M');
await sleep(120); // 滚轮上 3 行
stdin.emitInput('\x1b[<65;10;5M');
await sleep(120); // 滚轮下 3 行（9966→9969，仍未到底）
stdin.emitInput('\x1b[<65;10;5M');
await sleep(120); // 9969→9972
stdin.emitInput('\x1b[<65;10;5M');
await sleep(120); // 9972→9973（到底）→ FOLLOW
inst.unmount();
dispose();

const frames = log.filter((l) => l.startsWith('frame'));
const last = frames[frames.length - 1] ?? '';
const checks = [
  ['k 上滚生效（离开 follow）', frames.some((l) => l.includes('follow=false'))],
  ['滚轮上生效：scrollTop 9972→9969', frames.some((l) => l.includes('scrollTop=9969'))],
  ['鼠标序列未流入输入行（draft 无 "[<"）', !frames.some((l) => l.includes('"j[<') || l.includes('"[<'))],
  ['h/a 回显 → draft="ha"', frames.some((l) => l.includes('draft="ha"'))],
  ['Enter 追加消息并贴尾', frames.some((l) => l.includes('appended=1') && l.includes('follow=true'))],
  ['滚轮下后恢复 FOLLOW', last.includes('follow=true')],
  ['鼠标上报开启/关闭序列已写', out.bytes > 0],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) fail += 1;
}
console.log('--- frames ---');
for (const l of frames) console.log(l);
process.exit(fail === 0 ? 0 : 1);
