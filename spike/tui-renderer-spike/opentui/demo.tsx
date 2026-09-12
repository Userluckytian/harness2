// P0 spike 方案 C：OpenTUI 交互 demo（真机运行用）
// 10k 行转录（common/generate-transcript.mjs, seed 42）渲染进 scrollbox，底部输入框，鼠标滚轮滚动。
// 运行：bun demo.tsx   （Node 22 不可运行，见 results.md）
// 退出：ctrl-c（exitOnCtrlC）或 q
import { useState, useRef, useEffect } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { generateLines } from '../common/generate-transcript.mjs';

const LINES = generateLines(10000, 42);

function App() {
  const scrollRef = useRef(null);
  const [status, setStatus] = useState({ top: 0, fps: 0, w: 0, h: 0 });

  useEffect(() => {
    const timer = setInterval(() => {
      const sb = scrollRef.current;
      const r = globalThis.__spike_renderer;
      setStatus({
        top: sb ? Math.round(sb.scrollTop) : -1,
        fps: r ? Math.round(r.getStats().fps) : 0,
        w: r ? r.terminalWidth : 0,
        h: r ? r.terminalHeight : 0,
      });
    }, 200);
    return () => clearInterval(timer);
  }, []);

  useKeyboard((key) => {
    if (key.name === 'q') {
      process.exit(0);
    }
  });

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        scrollY
        focusable
        title={`demo-10k-lines  top=${status.top}  fps=${status.fps}  ${status.w}x${status.h}`}
        scrollbarOptions={{ visible: true, trackOptions: { backgroundColor: '#222' } }}
      >
        {LINES.map((line, i) => (
          <text key={i}>{`${String(i + 1).padStart(5)} | ${line}`}</text>
        ))}
      </scrollbox>
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <text content="> " fg="#888" />
        <input flexGrow={1} placeholder="type here; wheel scrolls transcript; q quits" focused />
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true, // 开启鼠标（含滚轮 SGR 上报）
});
globalThis.__spike_renderer = renderer;
createRoot(renderer).render(<App />);
