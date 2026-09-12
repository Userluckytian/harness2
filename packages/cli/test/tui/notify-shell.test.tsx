// T4 接线：InkShell 回合结束 → notifier.onTurnComplete（策略 × 焦点桥联动）。
// - 回合正常结束 → 按策略发提醒（注入 capture sink 断言字节）
// - never / 聚焦（unfocused 策略）→ 不发
// - DECSET 1004 焦点丢失（桥事件）后回合结束 → unfocused 策略发提醒
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import React from 'react';
import { createNotifier } from '../../src/tui/notify.js';
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

function capture() {
  const writes: string[] = [];
  return { writes, write: (s: string) => writes.push(s) };
}

/** 跑一轮 mock turn，等待回答文本出现（turn 已收尾） */
async function runTurn(t: ReturnType<typeof mountTui>): Promise<void> {
  await t.flush();
  t.write('hi');
  await t.flush();
  t.write('\r');
  await waitFor(() => t.output().includes('这是回答正文'), t.flush, 20000);
  await t.flush(); // 等 finally（notifier 调用）执行完
}

describe('T4 回合结束提醒接线', () => {
  it('always 策略：回合正常结束 → 发出 bel', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { writes, write } = capture();
    const notifier = createNotifier({ HARNESS2_NOTIFY: 'always' }, write);
    const t = mountTui(
      <InkShell
        runtime={tr.runtime}
        bootLines={[]}
        dialog={createDialogController()}
        onExit={() => undefined}
        notifier={notifier}
      />,
      { columns: 100, rows: 30 },
    );
    try {
      await runTurn(t);
      expect(writes).toEqual(['\x07']);
    } finally {
      t.unmount();
    }
  });

  it('never 策略：回合结束不发', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { writes, write } = capture();
    const notifier = createNotifier({ HARNESS2_NOTIFY: 'never' }, write);
    const t = mountTui(
      <InkShell
        runtime={tr.runtime}
        bootLines={[]}
        dialog={createDialogController()}
        onExit={() => undefined}
        notifier={notifier}
      />,
      { columns: 100, rows: 30 },
    );
    try {
      await runTurn(t);
      expect(writes).toEqual([]);
    } finally {
      t.unmount();
    }
  });

  it('unfocused 策略：聚焦时不发；终端失焦（DECSET 1004 桥）后回合结束 → 发', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { writes, write } = capture();
    const notifier = createNotifier({ HARNESS2_NOTIFY: 'unfocused' }, write);
    const stdin = fakeStdin();
    const bridge = attachTerminalEvents(stdin, new PassThrough() as unknown as NodeJS.WriteStream, { enabled: false });
    const t = mountTui(
      <InkShell
        runtime={tr.runtime}
        bootLines={[]}
        dialog={createDialogController()}
        onExit={() => undefined}
        notifier={notifier}
        terminalEvents={bridge}
      />,
      { columns: 100, rows: 30, stdin },
    );
    try {
      // 聚焦状态 → 回合结束不发
      await runTurn(t);
      expect(writes).toEqual([]);

      // 焦点丢失（\x1b[O 挂起 40ms 后解析为 focus-out）→ 回合结束发 bel
      stdin.write('\x1b[O');
      await new Promise<void>((resolve) => setTimeout(resolve, 150)); // 等挂起超时消费
      await t.flush();
      await runTurn(t);
      expect(writes).toEqual(['\x07']);
    } finally {
      bridge.dispose();
      t.unmount();
    }
  });
});
