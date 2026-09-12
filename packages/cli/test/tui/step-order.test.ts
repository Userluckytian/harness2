// T4 step 顺序保真（验收 5 的核心项）：
// 真实 useTurnStream + transcriptReducer 路径下，`解释(text) → 工具 → 解释(text)` 必须保留
// 真实交错顺序，不得把全部文本攒到 turn 末尾塌成一个块（T3 遗留问题）。
// 另覆盖「tool-call 前无文本」不得产生空 assistant 气泡。
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import type { TurnResult } from '@harness2/core';
import { useTurnStream, type UseTurnStream } from '../../src/tui/useTurnStream.js';
import {
  emptyTranscript,
  transcriptReducer,
  type TranscriptEvent,
  type TranscriptItem,
  type TranscriptState,
} from '../../src/tui/transcript.js';
import { mountTui } from './harness.js';

const apiRef: { api: UseTurnStream | null } = { api: null };
const stateRef: { state: TranscriptState } = { state: emptyTranscript() };
let dispatch: (event: TranscriptEvent) => void = () => undefined;

function Probe(): React.ReactElement {
  const [state, setState] = React.useState<TranscriptState>(emptyTranscript);
  dispatch = (event) => setState((s) => transcriptReducer(s, event));
  const api = useTurnStream(dispatch);
  apiRef.api = api;
  stateRef.state = state;
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    state.items.map((item, i) => React.createElement(Text, { key: item.id }, `${i}:${item.kind}`)),
  );
}

function textOf(item: TranscriptItem): string {
  if (item.kind === 'tool') return item.tool;
  if (item.kind === 'empty') return '';
  return item.text;
}

function finalResult(over: Partial<TurnResult>): TurnResult {
  return { stopReason: 'end_turn', steps: 2, toolCalls: 1, durationMs: 5, turnId: 't1', ...over };
}

describe('useTurnStream：解释→工具→解释 顺序保真', () => {
  it('text-delta(A) → tool-call(t1) → text-delta(B) → turn-final ⇒ assistant(A) → tool → assistant(B)', async () => {
    const t = mountTui(React.createElement(Probe), { columns: 80, rows: 24 });
    try {
      await t.flush();
      const api = apiRef.api;
      if (api === null) return;
      api.handler({ type: 'text-delta', text: 'A', turnId: 't1' });
      api.handler({
        type: 'tool-call',
        call: { id: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' },
        turnId: 't1',
      });
      api.handler({ type: 'text-delta', text: 'B', turnId: 't1' });
      const terminal = api.finalize(finalResult({ finalText: 'B', textOutcome: 'final' }));
      expect(terminal).not.toBeNull();
      if (terminal !== null) dispatch(terminal);
      await t.flush();

      const items = stateRef.state.items;
      expect(items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant']);
      expect(items.map(textOf)).toEqual(['A', 'read', 'B']);
      // A 不被重复、不被丢弃；B 只在末尾出现一次
      expect(items.filter((i) => i.kind === 'assistant' && i.text === 'A')).toHaveLength(1);
      expect(items.filter((i) => i.kind === 'assistant' && i.text === 'B')).toHaveLength(1);
      // flush 出的 step item id 以 turnId 为作用域（稳定），且与终态 item 不同 id
      const first = items[0];
      const last = items[2];
      expect(first?.id).toContain('t1');
      expect(first?.id).toContain('step');
      expect(last?.id).not.toBe(first?.id);
    } finally {
      t.unmount();
    }
  });

  it('tool-call 前无文本：不产生空 assistant 气泡', async () => {
    const t = mountTui(React.createElement(Probe), { columns: 80, rows: 24 });
    try {
      await t.flush();
      const api = apiRef.api;
      if (api === null) return;
      api.handler({ type: 'tool-call', call: { id: 'c0', name: 'bash', arguments: '{}' }, turnId: 't2' });
      api.handler({ type: 'text-delta', text: 'B', turnId: 't2' });
      const terminal = api.finalize(finalResult({ turnId: 't2', finalText: 'B', textOutcome: 'final', steps: 1 }));
      if (terminal !== null) dispatch(terminal);
      await t.flush();

      const items = stateRef.state.items;
      expect(items.map((i) => i.kind)).toEqual(['tool', 'assistant']);
      expect(items.some((i) => i.kind === 'assistant' && i.text.trim().length === 0)).toBe(false);
    } finally {
      t.unmount();
    }
  });

  it('纯 reducer：assistant/step 保留 turnId+step 作用域稳定 id', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'assistant/step', turnId: 'tt', stepIndex: 0, text: '前一段' });
    s = transcriptReducer(s, { type: 'tool/call', seq: 3, callId: 'c9', tool: 'read', summary: 'a' });
    s = transcriptReducer(s, { type: 'assistant/step', turnId: 'tt', stepIndex: 1, text: '后一段' });
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(s.items.map(textOf)).toEqual(['前一段', 'read', '后一段']);
    expect(s.items[0]?.id).toBe('assistant:tt:step:0');
    expect(s.items[2]?.id).toBe('assistant:tt:step:1');
  });

  it('卸载清理（审查 P2）：挂起中的 50ms flush timer 随 unmount 被 clearTimeout', async () => {
    // spy 透传（不 mock 行为）：只观测「调度了哪个 timer」与「unmount 是否取消它」
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const t = mountTui(React.createElement(Probe), { columns: 80, rows: 24 });
    try {
      await t.flush();
      const api = apiRef.api;
      if (api === null) return;
      api.handler({ type: 'text-delta', text: 'A', turnId: 't3' }); // 同步调度 50ms flush
      const scheduled: unknown = setSpy.mock.results.at(-1)?.value;
      expect(scheduled).toBeDefined();
      t.unmount(); // React effect cleanup 同步执行 → clearTimer()
      expect(clearSpy.mock.calls.map((c) => c[0])).toContain(scheduled);
      return; // unmount 已在 try 内完成，finally 只还原 spy
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
