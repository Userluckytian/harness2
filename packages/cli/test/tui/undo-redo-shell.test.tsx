// T5 命令对齐（ink）集成测试：/undo /redo 委托共享 handleCommand + rewind 后重投影。
// 用真实 ChatRuntime（mock provider，隔离 home/root）挂载 InkShell，经伪 TTY 注入命令，
// 从 InkShell 的转录观察缝读取最新 TranscriptState —— 直接证明：
//   跑一轮后 /undo → 被遮蔽的 user/assistant 条目从转录消失；/redo → 恢复。
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { createDialogController, InkShell } from '../../src/tui/runInkChat.js';
import { emptyTranscript, type TranscriptItem, type TranscriptState } from '../../src/tui/transcript.js';
import { mountTui } from './harness.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop();
    await r?.cleanup();
  }
});

function hasAssistant(state: TranscriptState, text: string): boolean {
  return state.items.some((i) => i.kind === 'assistant' && i.text.includes(text));
}
function hasUser(state: TranscriptState, text: string): boolean {
  return state.items.some((i) => i.kind === 'user' && i.text.includes(text));
}
function hasSystem(state: TranscriptState, text: string): boolean {
  return state.items.some((i) => i.kind === 'system' && i.text.includes(text));
}
const hasMessageItems = (state: TranscriptState): boolean =>
  state.items.some((i: TranscriptItem) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'partial');

describe('T5 ink /undo /redo：rewind 后重投影', () => {
  it('跑一轮 → /undo 使消息条目消失 → /redo 恢复；命令输出经共享 handleCommand', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    let latest: TranscriptState = emptyTranscript();
    const onTranscriptChange = (s: TranscriptState): void => {
      latest = s;
    };
    const t = mountTui(
      <InkShell
        runtime={tr.runtime}
        bootLines={['会话: test（新建）']}
        dialog={createDialogController()}
        onExit={() => undefined}
        onTranscriptChange={onTranscriptChange}
      />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      // —— 跑一轮 ——
      t.write('hi');
      await t.flush();
      t.write('\r');
      await waitFor(() => hasAssistant(latest, '这是回答正文'), t.flush);
      expect(hasUser(latest, 'hi')).toBe(true);

      // —— /undo：追加 rewind/marker → 重投影，消息条目被遮蔽 ——
      t.write('/undo');
      await t.flush();
      t.write('\r');
      await waitFor(() => hasSystem(latest, '已撤回') && !hasMessageItems(latest), t.flush);
      expect(hasMessageItems(latest)).toBe(false);
      expect(hasUser(latest, 'hi')).toBe(false);
      expect(hasAssistant(latest, '这是回答正文')).toBe(false);

      // —— /redo：重投影恢复被遮蔽的消息 ——
      t.write('/redo');
      await t.flush();
      t.write('\r');
      await waitFor(() => hasSystem(latest, '已重做') && hasAssistant(latest, '这是回答正文'), t.flush);
      expect(hasUser(latest, 'hi')).toBe(true);
      expect(hasAssistant(latest, '这是回答正文')).toBe(true);
    } finally {
      t.unmount();
    }
  });

  it('共享 /help 文本与本地浮层同源（含 /undo /redo 说明）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={[]} dialog={createDialogController()} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      t.write('/help');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(t.output()).toContain('/undo');
      expect(t.output()).toContain('/redo');
    } finally {
      t.unmount();
    }
  });
});
