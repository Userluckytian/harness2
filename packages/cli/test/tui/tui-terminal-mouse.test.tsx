// T2 InkShell 集成：鼠标滚轮 → 转录滚动（锚定/跟随语义），且鼠标字节不流入草稿（键盘回归）。
// 桥接必须早于 ink 的 'readable' 监听注册（runInkChat 在 render 前 attach 的同款顺序），
// 故先构造伪 stdin + bridge，再挂载 InkShell。
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import React from 'react';
import { attachTerminalEvents } from '../../src/tui/terminal-events.js';
import { createDialogController, InkShell } from '../../src/tui/runInkChat.js';
import { fakeStdin, mountTui } from './harness.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop();
    await r?.cleanup();
  }
});

const boot = Array.from({ length: 40 }, (_, i) => `历史行 ${i}`);

/** 预构造 stdin + 桥接（先于 mount 注册，保证拦截优先于 ink） */
async function mountShell(runtime: Awaited<ReturnType<typeof createTestRuntime>>): Promise<{
  t: ReturnType<typeof mountTui>;
  bridge: ReturnType<typeof attachTerminalEvents>;
  stdin: NodeJS.ReadStream;
}> {
  const stdin = fakeStdin();
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const bridge = attachTerminalEvents(stdin, stdout, { enabled: false });
  const t = mountTui(
    <InkShell
      runtime={runtime.runtime}
      bootLines={boot}
      dialog={createDialogController()}
      onExit={() => undefined}
      terminalEvents={bridge}
    />,
    { columns: 100, rows: 30, stdin },
  );
  return { t, bridge, stdin };
}

describe('T2 鼠标滚轮滚动（InkShell + stdin 桥）', () => {
  it('滚轮上 → 暂停跟随并滚动（出现锚定横幅）；滚轮下回到底恢复跟随', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { t, bridge, stdin } = await mountShell(tr);
    try {
      await t.flush();
      expect(t.output()).toContain('历史行 39'); // 初始跟随贴尾

      stdin.write('\x1b[<64;1;1M'); // 滚轮上
      await waitFor(() => t.output().includes('[已暂停跟随'), t.flush);
      // 一屏（rows/2=15）回滚后视口顶到 ~行2（锚定起始位置）
      expect(t.output()).toContain('历史行 2');

      // 滚轮下：回到末尾后恢复跟随（横幅消失）
      const before = t.output().length;
      stdin.write('\x1b[<65;1;1M'); // 滚轮下
      await waitFor(() => !t.output().slice(before).includes('[已暂停跟随'), t.flush, 2000);
    } finally {
      bridge.dispose();
      t.unmount();
    }
  });

  it('鼠标事件后键入普通字符不污染草稿（序列被拦截，键盘不回归）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { t, bridge, stdin } = await mountShell(tr);
    try {
      await t.flush();
      stdin.write('\x1b[<64;1;1M'); // 滚轮
      stdin.write('\x1b[<0;20;10M'); // 点击（消费）
      await waitFor(() => t.output().includes('[已暂停跟随'), t.flush);
      t.write('z'); // 普通键经 ink 通道
      await t.flush();
      const tail = t.output().slice(-600);
      expect(tail).toContain('z');
      expect(tail).not.toContain('64;1;1'); // 原始序列不得进入草稿
      expect(tail).not.toContain('0;20;10');
    } finally {
      bridge.dispose();
      t.unmount();
    }
  });

  it('Ctrl+G 在鼠标滚动后仍恢复跟随（键位不回归）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { t, bridge, stdin } = await mountShell(tr);
    try {
      await t.flush();
      stdin.write('\x1b[<64;1;1M');
      await waitFor(() => t.output().includes('[已暂停跟随'), t.flush);
      stdin.write('\x07'); // Ctrl+G
      await t.flush(); // 等 Ctrl+G 被消费（避免与下一按键同 chunk 合并）
      const before = t.output().length;
      stdin.write('q'); // 触发重绘
      await waitFor(() => t.output().length > before, t.flush);
      expect(t.output().slice(before)).not.toContain('[已暂停跟随');
    } finally {
      bridge.dispose();
      t.unmount();
    }
  });
});
