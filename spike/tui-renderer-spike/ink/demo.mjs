// demo.mjs — 方案A 真机可跑 demo：虚拟化转录 + 滚轮/键盘滚动 + 底部输入行。
// 运行：node demo.mjs（需真终端；Windows Terminal / Git Bash 均可）
//   j/k 或 ↑/↓     滚 1 行；PageUp/PageDown 翻页；Home/End 到顶/贴尾
//   鼠标滚轮       滚 3 行（render 前挂 stdin 拦截桥，与 packages/cli/terminal-events.ts 同思路）
//   任意键入       底部输入行回显；Enter 追加一条 user 消息并贴尾
//   q 或 Ctrl+C    退出（Ctrl+C 由 exitOnCtrlC 处理）
// 说明：这是 Ink 的「现有思路」实现——react 状态驱动、ink 默认 30fps 节流刷帧、
// 鼠标协议必须自建拦截桥（实验证据见 demo-selftest.mjs：ink 的 useInput 会吞 ESC 并把
// `[<64;x;yM` 当字面文本流入输入行，故不能靠 useInput 匹配鼠标序列）。
// 用 React.createElement 而非 JSX：spike 不引入构建链。
import React, { useState, useCallback } from 'react';
import { render, Box, Text, useInput, useWindowSize } from 'ink';
import { generateLines } from '../common/generate-transcript.mjs';

const h = React.createElement;
const LINES = generateLines(10000, 42);
const BUFFER = 10;
const WHEEL_LINES = 3;

/** render 前挂接的 SGR 滚轮拦截桥（packages/cli terminal-events.ts 的极简版）：
 *  先于 ink 注册 'readable'，剥出 `\x1b[<64/65;x;yM` 滚轮序列，其余字节 unshift 回流给 ink。
 *  返回 dispose（关鼠标上报）。残缺序列 40ms 超时按字面回流（对齐 ink pending escape 语义）。 */
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
    if (bypass) { bypass = false; return; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    let got = false;
    for (;;) {
      const chunk = stdin.read();
      if (chunk === null) break;
      got = true;
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }
    if (!got) return;
    // 剥出滚轮序列；其余字节拼成 forward，最后一次性 unshift（避免重入回环）
    let forward = '';
    for (;;) {
      const m = buf.match(/^\x1b\[<(\d+);\d+;\d+([Mm])/);
      if (m) {
        if (m[2] === 'M' && Number(m[1]) === 64) onWheel(-WHEEL_LINES);
        if (m[2] === 'M' && Number(m[1]) === 65) onWheel(WHEEL_LINES);
        buf = buf.slice(m[0].length);
        continue;
      }
      const csi = buf.match(/^\x1b\[[0-9;?<=>!]*[\x40-\x7e]/); // 完整非鼠标 CSI（如 \x1b[B）：整段回流
      if (csi && csi[0].slice(2) !== '<') {
        forward += csi[0];
        buf = buf.slice(csi[0].length);
        continue;
      }
      if (buf.startsWith('\x1b')) break; // 残缺序列：等后续字节（40ms 超时按字面回流）
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
  stdout.write('\x1b[?1000h\x1b[?1006h'); // 开启按钮事件 + SGR 扩展坐标
  return () => {
    stdin.removeListener('readable', handler);
    if (timer !== null) clearTimeout(timer);
    stdout.write('\x1b[?1006l\x1b[?1000l');
  };
}

function App({ wheel }) {
  const { rows = 30, columns = 100 } = useWindowSize();
  const viewportH = Math.max(3, rows - 2);
  const [scrollTop, setScrollTop] = useState(Number.MAX_SAFE_INTEGER);
  const [follow, setFollow] = useState(true);
  const [draft, setDraft] = useState('');
  const [appended, setAppended] = useState([]);

  const all = LINES.length + appended.length;
  const maxScroll = Math.max(0, all - viewportH);
  const clamp = useCallback((v) => Math.max(0, Math.min(maxScroll, v)), [maxScroll]);

  function step(n) { setFollow(false); setScrollTop((s) => clamp(Math.min(s, maxScroll) + n)); }
  function doWheel(n) { setScrollTop((s) => { const ns = clamp(Math.min(s, maxScroll) + n); setFollow(ns >= maxScroll); return ns; }); }
  wheel.current = doWheel;

  useInput((input, key) => {
    if (input.startsWith('[<')) return; // 鼠标残片（理论上已被桥剥出）：防御性丢弃
    if (input === 'j' && draft === '') return step(1); // vim：j=下滚
    if (input === 'k' && draft === '') return step(-1); // k=上滚（draft 非空时按普通字符回显）
    if (key.upArrow) return step(-1);
    if (key.downArrow) return step(1);
    if (key.pageUp) return step(-viewportH);
    if (key.pageDown) return step(viewportH);
    if (key.home) { setFollow(false); setScrollTop(0); return; }
    if (key.end) { setFollow(true); return; }
    if (key.return) {
      setAppended((a) => [...a, `> ${draft || '(empty)'}`]);
      setDraft('');
      setFollow(true);
      return;
    }
    if (key.backspace || key.delete) { setDraft((d) => d.slice(0, -1)); return; }
    if (input === 'q' && draft === '') { process.exit(0); }
    if (!key.ctrl && input && !input.startsWith('\x1b')) setDraft((d) => d + input);
  });

  const st = follow ? maxScroll : Math.min(scrollTop, maxScroll);
  const start = Math.max(0, st - BUFFER);
  const end = Math.min(all, st + viewportH + BUFFER);
  const slice = [];
  for (let i = start; i < end; i += 1) slice.push(i < LINES.length ? LINES[i] : appended[i - LINES.length]);
  const shown = slice.slice(Math.max(0, st - start), Math.max(0, st - start) + viewportH);

  return h(Box, { flexDirection: 'column', width: columns },
    h(Box, { flexDirection: 'column', height: viewportH },
      ...shown.map((line, i) => h(Text, { key: st + i, wrap: 'truncate' }, line))),
    h(Box, null,
      h(Text, { color: 'cyan' }, 'input> '),
      h(Text, null, `${draft}_`),
      h(Text, { color: 'gray' },
        `  [j/k arrows PgUp/PgDn scroll | wheel | Enter send | q quit] `,
        follow ? 'FOLLOW' : `line ${st + 1}/${all}`)));
}

const wheel = { current: () => {} };
const disposeBridge = attachWheelBridge(process.stdin, process.stdout, (n) => wheel.current(n));
const inst = render(h(App, { wheel }), { exitOnCtrlC: true });
inst.waitUntilExit().finally(disposeBridge);
