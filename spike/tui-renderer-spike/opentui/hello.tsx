// P0 spike 方案 C：OpenTUI 最小 hello-world
// 全屏 app：一个 scrollbox + 底部 input。
// 运行：bun hello.tsx   （Node 下已证实不可运行，见 results.md）
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

const PLACEHOLDER_LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: hello OpenTUI`);

function App() {
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <scrollbox
        flexGrow={1}
        scrollY
        focusable
        title="hello-opentui"
        scrollbarOptions={{ visible: true, trackOptions: { backgroundColor: '#222' } }}
      >
        {PLACEHOLDER_LINES.map((t) => (
          <text key={t}>{t}</text>
        ))}
      </scrollbox>
      <input placeholder="type here (ctrl-c to quit)" height={3} border />
    </box>
  );
}

const autoExit = Number(process.env.SPIKE_AUTO_EXIT_MS ?? 0);

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);

if (autoExit > 0) {
  setTimeout(async () => {
    // 注意：不能 console.error —— OpenTUI 的 TerminalConsole 会接管 console，输出会被吞。
    process.stderr.write(`SMOKE_OK frames=${renderer.frameId}\n`);
    await renderer.destroy();
    process.exit(0);
  }, autoExit);
}
