// T3 transcript 渲染集成测试（虚拟 TTY + renderToString）：
// - 已落定（turn 结束后）的工具卡仍可按稳定 id 展开（H2 验收）
// - partial 渲染「未完成 / 已中断」+ stopReason/error；empty 禁止空白气泡
// - 会话重投影整体替换 items
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString, useInput } from 'ink';
import { Transcript } from '../../src/tui/TranscriptView.js';
import type { TranscriptItem } from '../../src/tui/transcript.js';
import { mountTui } from './harness.js';

const EDIT_ARGS = JSON.stringify({ file_path: 'a.ts', old_text: '旧内容', new_text: '新内容' });

const TOOL_ITEM: TranscriptItem = {
  kind: 'tool',
  id: 'tool:c1',
  callId: 'c1',
  tool: 'edit',
  args: EDIT_ARGS,
  summary: 'a.ts',
  status: 'ok',
  output: '已应用编辑',
};

describe('Transcript：落定工具卡可展开（H2）', () => {
  it('expandedIds 含该 item id → 渲染 DiffCard 真实变更', () => {
    const out = renderToString(
      <Transcript items={[TOOL_ITEM]} expandedIds={new Set(['tool:c1'])} height={20} width={80} />,
    );
    expect(out).toContain('edit 变更');
    expect(out).toContain('- 旧内容');
    expect(out).toContain('+ 新内容');
  });

  it('未展开 → 不渲染 diff，仅工具名与摘要', () => {
    const out = renderToString(<Transcript items={[TOOL_ITEM]} expandedIds={new Set()} height={20} width={80} />);
    expect(out).toContain('edit');
    expect(out).toContain('a.ts');
    expect(out).not.toContain('- 旧内容');
    expect(out).not.toContain('+ 新内容');
  });

  it('展开态显示真实 tool output', () => {
    const out = renderToString(
      <Transcript items={[TOOL_ITEM]} expandedIds={new Set(['tool:c1'])} height={20} width={80} />,
    );
    expect(out).toContain('已应用编辑');
  });

  it('虚拟 TTY：turn 结束后按 Ctrl+O 仍可展开已落定卡片', async () => {
    function Shell({ items }: { items: TranscriptItem[] }): React.ReactElement {
      const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
      useInput((input, key) => {
        if (!key.ctrl || input.toLowerCase() !== 'o') return;
        setExpanded((prev) => {
          const next = new Set(prev);
          const lastTool = [...items].reverse().find((i) => i.kind === 'tool');
          if (lastTool === undefined) return next;
          if (next.has(lastTool.id)) next.delete(lastTool.id);
          else next.add(lastTool.id);
          return next;
        });
      });
      return <Transcript items={items} expandedIds={expanded} height={20} width={80} follow />;
    }
    const t = mountTui(<Shell items={[TOOL_ITEM]} />, { columns: 80, rows: 24 });
    try {
      await t.flush();
      expect(t.output()).not.toContain('+ 新内容');
      t.write('\x0f'); // Ctrl+O
      await t.flush();
      expect(t.output()).toContain('+ 新内容');
    } finally {
      t.unmount();
    }
  });
});

describe('Transcript：冻结终态语义渲染', () => {
  it('partial：必须标注「未完成 / 已中断」并给出 stopReason/error', () => {
    const partial: TranscriptItem = {
      kind: 'partial',
      id: 'attempt:t1',
      seq: 6,
      text: '半截文本',
      error: 'network error',
      stopReason: 'error',
    };
    const out = renderToString(<Transcript items={[partial]} height={20} width={80} />);
    expect(out).toContain('半截文本');
    expect(out).toContain('未完成 / 已中断');
    expect(out).toContain('network error');
    expect(out).toContain('error');
  });

  it('empty：不渲染空白气泡，只给 stopReason/error 与标签', () => {
    const empty: TranscriptItem = {
      kind: 'empty',
      id: 'attempt:t2',
      seq: 7,
      error: 'provider 在首个 token 前失败',
      stopReason: 'error',
    };
    const out = renderToString(<Transcript items={[empty]} height={20} width={80} />);
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain('provider 在首个 token 前失败');
    expect(out).toContain('error');
    // 不得是空 bubble：必须带明确提示
    expect(out).toContain('未完成 / 已中断');
  });

  it('empty 无 error 时也给出可读占位（禁止静默）', () => {
    const empty: TranscriptItem = { kind: 'empty', id: 'attempt:t3', seq: 8 };
    const out = renderToString(<Transcript items={[empty]} height={20} width={80} />);
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain('未完成 / 已中断');
  });

  it('final：按普通正文渲染并保留 reasoning 展开行为', () => {
    const assistant: TranscriptItem = {
      kind: 'assistant',
      id: 'assistant:5',
      seq: 5,
      text: '完整正文',
      outcome: 'final',
      reasoning: '推理内容',
    };
    const collapsed = renderToString(<Transcript items={[assistant]} height={20} width={80} />);
    expect(collapsed).toContain('完整正文');
    expect(collapsed).toContain('[reasoning · 按 Ctrl+R 展开]');
    const expanded = renderToString(<Transcript items={[assistant]} height={20} width={80} reasoningExpanded />);
    expect(expanded).toContain('推理内容');
  });
});

describe('Transcript：会话重投影替换 items', () => {
  it('渲染 B 会话 items 时不含 A 会话任何文本', () => {
    const a: TranscriptItem = { kind: 'user', id: 'user:2', seq: 2, text: 'A 会话的问题' };
    const b: TranscriptItem = { kind: 'user', id: 'user:2', seq: 2, text: 'B 会话的问题' };
    expect(renderToString(<Transcript items={[a]} height={20} width={80} />)).toContain('A 会话的问题');
    const out = renderToString(<Transcript items={[b]} height={20} width={80} />);
    expect(out).toContain('B 会话的问题');
    expect(out).not.toContain('A 会话的问题');
  });
});
