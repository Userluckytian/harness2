// T1 子代理执行内容可见（子会话入口）：
// - reducer 从 subagent_start/subagent_continue 的 tool/result.output（JSON）解析 childSessionId，
//   解析不到不伪造；非 subagent 工具不解析
// - Transcript 工具卡渲染「子会话 <id>」入口提示（有 childSessionId 才显示）
// - SubagentView 只读浮层：正常目录重投影子会话文本；坏目录/未定位显示如实错误
// - InkShell 集成：真实 mock provider 派发 subagent_start → 工具卡出现入口 → Ctrl+K/Ctrl+J 打开浮层 → Esc 关闭
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { Transcript } from '../../src/tui/TranscriptView.js';
import { SubagentView } from '../../src/tui/SubagentView.js';
import {
  childSessionIdFromToolResult,
  transcriptReducer,
  emptyTranscript,
  type TranscriptItem,
  type TranscriptState,
} from '../../src/tui/transcript.js';
import { createDialogController, InkShell } from '../../src/tui/runInkChat.js';
import { mountTui } from './harness.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const SUBAGENT_OUTPUT = JSON.stringify({ childSessionId: 'sub-c1', stopReason: 'end_turn', finalText: '搞定' });

/** 子会话 id 的真实格式：YYYYMMDD-HHMMSS-<rand>（非 sub- 前缀） */
const CHILD_ID_RE = /子会话 ([0-9A-Za-z_-]+)/;

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop();
    await r?.cleanup();
  }
});

/** 写一个合法的子会话日志目录（session.v1.jsonl），供 SubagentView 重投影 */
function fixtureSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'h2-subagent-fixture-'));
  const lines = [
    { v: 1, seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'session/header', payload: { sessionId: 'child-1' } },
    { v: 1, seq: 2, ts: '2026-01-01T00:00:00.000Z', type: 'user/message', payload: { text: '子任务指令', turnId: 't1' } },
    {
      v: 1,
      seq: 3,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'assistant/message',
      payload: { text: '这是子任务的结果。', turnId: 't1' },
    },
  ];
  writeFileSync(join(dir, 'session.v1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return dir;
}

describe('T1 reducer：childSessionId 解析（不伪造）', () => {
  const baseResult = {
    type: 'tool/result',
    callId: 'c1',
    ok: true,
    output: SUBAGENT_OUTPUT,
  } as const;

  it('subagent_start + JSON output → 挂载 childSessionId', () => {
    const state = transcriptReducer(emptyTranscript(), { type: 'tool/result', callId: 'c1', tool: 'subagent_start', ok: true, output: SUBAGENT_OUTPUT });
    const item = state.items[0];
    expect(item).toBeDefined();
    if (item?.kind !== 'tool') throw new Error('expected tool item');
    expect(item.childSessionId).toBe('sub-c1');
  });

  it('subagent_continue + JSON output → 挂载 childSessionId', () => {
    const state = transcriptReducer(emptyTranscript(), { type: 'tool/result', callId: 'c2', tool: 'subagent_continue', ok: true, output: SUBAGENT_OUTPUT });
    const item = state.items[0];
    if (item?.kind !== 'tool') throw new Error('expected tool item');
    expect(item.childSessionId).toBe('sub-c1');
  });

  it('非 subagent 工具即使 output 含 childSessionId 也不解析（不伪造）', () => {
    const state = transcriptReducer(emptyTranscript(), { type: 'tool/result', callId: 'c3', tool: 'bash', ok: true, output: SUBAGENT_OUTPUT });
    const item = state.items[0];
    if (item?.kind !== 'tool') throw new Error('expected tool item');
    expect(item.childSessionId).toBeUndefined();
  });

  it('subagent 工具但 output 非 JSON / 无 childSessionId → 不挂载', () => {
    expect(childSessionIdFromToolResult('subagent_start', 'executor 崩溃')).toBeUndefined();
    expect(childSessionIdFromToolResult('subagent_start', JSON.stringify({ taskId: 'bg-1' }))).toBeUndefined();
    expect(childSessionIdFromToolResult('subagent_start', undefined)).toBeUndefined();
    expect(childSessionIdFromToolResult('subagent_start', '')).toBeUndefined();
  });
});

describe('T1 Transcript：入口提示', () => {
  const base: TranscriptItem = {
    kind: 'tool',
    id: 'tool:c1',
    callId: 'c1',
    tool: 'subagent_start',
    summary: '子任务',
    status: 'ok',
    output: SUBAGENT_OUTPUT,
  };

  it('有 childSessionId → 显示「子会话 <id>」入口', () => {
    const out = renderToString(<Transcript items={[{ ...base, childSessionId: 'sub-c1' }]} height={20} width={80} />);
    expect(out).toContain('子会话 sub-c1');
  });

  it('无 childSessionId → 不显示入口', () => {
    const out = renderToString(<Transcript items={[base]} height={20} width={80} />);
    expect(out).not.toContain('子会话');
  });
});

describe('T1 SubagentView：只读浮层内容', () => {
  it('正常目录 → 重投影出子会话文本（含 user 与 assistant）', () => {
    const dir = fixtureSessionDir();
    try {
      const out = renderToString(<SubagentView sessionId="child-1" dir={dir} width={60} height={20} />);
      expect(out).toContain('子任务指令');
      expect(out).toContain('这是子任务的结果。');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在（bad dir）→ 如实错误文案，不渲染空白', () => {
    const out = renderToString(<SubagentView sessionId="nope" dir={join(tmpdir(), 'h2-does-not-exist-xyz')} width={60} height={20} />);
    expect(out).toContain('无法读取子会话 nope');
    expect(out).toContain('session log not found');
  });

  it('未定位到目录（dir=undefined）→ 显示定位失败原因', () => {
    const out = renderToString(<SubagentView sessionId="nope" dir={undefined} locateError="session not found: nope" width={60} height={20} />);
    expect(out).toContain('无法读取子会话 nope');
    expect(out).toContain('session not found: nope');
  });

  it('空目录（有目录无日志）→ 如实报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-subagent-empty-'));
    try {
      const out = renderToString(<SubagentView sessionId="empty" dir={dir} width={60} height={20} />);
      expect(out).toContain('无法读取子会话 empty');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T1 InkShell 集成：真实 subagent 派发 → Ctrl+K/Ctrl+J 打开只读浮层', () => {
  it('子代理完成后入口出现，Ctrl+K 打开子会话转录，Esc 关闭且焦点回 Composer', async () => {
    const tr = await createTestRuntime([
      { toolCalls: [{ id: 'call-1', name: 'subagent_start', arguments: JSON.stringify({ prompt: '子任务' }) }] },
      { textChunks: ['父会话收尾回答'] },
    ]);
    running.push(tr);
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={[]} dialog={createDialogController()} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      t.write('hi');
      await t.flush();
      t.write('\r');
      // 子代理跑完后：工具卡出现「子会话」入口
      await waitFor(() => CHILD_ID_RE.test(t.output()), t.flush, 20000);
      expect(t.output()).toContain('subagent_start');
      expect(t.output()).toContain('父会话收尾回答');

      // Ctrl+K（0x0B，所有终端可用）：打开只读浮层显示子会话文本
      t.write('\x0b');
      await t.flush();
      expect(t.output()).toContain('子会话完成：');
      expect(t.output()).toContain('这是子任务的结果。');
      expect(t.output()).toContain('只读 · Esc 关闭');

      // Esc 关闭；焦点回 Composer（随后输入进草稿）
      t.write('\x1b');
      await t.flush();
      const before = t.output().length;
      t.write('q');
      await t.flush();
      expect(t.output().slice(before)).toContain('q');
    } finally {
      t.unmount();
    }
  });

  it('kitty CSI-u 的 Ctrl+J（\\x1b[106;5u）同样打开浮层', async () => {
    const tr = await createTestRuntime([
      { toolCalls: [{ id: 'call-2', name: 'subagent_start', arguments: JSON.stringify({ prompt: '子任务2' }) }] },
      { textChunks: ['父会话收尾回答2'] },
    ]);
    running.push(tr);
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={[]} dialog={createDialogController()} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      t.write('hi');
      await t.flush();
      t.write('\r');
      await waitFor(() => CHILD_ID_RE.test(t.output()), t.flush, 20000);
      t.write('\x1b[106;5u'); // kitty CSI-u: Ctrl+J
      await t.flush();
      expect(t.output()).toContain('子会话完成：');
    } finally {
      t.unmount();
    }
  });

  it('无子会话入口时 Ctrl+K 不打开任何浮层（不抛错）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={[]} dialog={createDialogController()} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      t.write('hi');
      await t.flush();
      t.write('\r');
      await waitFor(() => t.output().includes('这是回答正文'), t.flush);
      t.write('\x0b'); // Ctrl+K：无子会话 → no-op
      await t.flush();
      expect(t.output()).not.toContain('只读 · Esc 关闭');
      // Composer 仍可输入
      const before = t.output().length;
      t.write('z');
      await t.flush();
      expect(t.output().slice(before)).toContain('z');
    } finally {
      t.unmount();
    }
  });

  it('坏目录的子会话（磁盘被删）→ 打开浮层显示如实错误', async () => {
    const tr = await createTestRuntime([
      { toolCalls: [{ id: 'call-3', name: 'subagent_start', arguments: JSON.stringify({ prompt: '子任务3' }) }] },
      { textChunks: ['父会话收尾回答3'] },
    ]);
    running.push(tr);
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={[]} dialog={createDialogController()} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      t.write('hi');
      await t.flush();
      t.write('\r');
      await waitFor(() => CHILD_ID_RE.test(t.output()), t.flush, 20000);
      // 找出子会话 id 并删除其目录，模拟坏路径
      const m = CHILD_ID_RE.exec(t.output());
      expect(m).not.toBeNull();
      const childId = m?.[1];
      // 从磁盘定位目录（真实 runtime 的 manager）
      let dir: string | undefined;
      try {
        dir = tr.runtime.sessionManager.locate(childId ?? '', { cwd: tr.root });
      } catch {
        // locate 失败也视为坏路径场景
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      t.write('\x0b');
      await t.flush();
      expect(t.output()).toContain('无法读取子会话');
    } finally {
      t.unmount();
    }
  });
});
