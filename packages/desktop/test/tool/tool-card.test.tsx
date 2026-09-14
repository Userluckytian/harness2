// 工具卡测试（P6-C / D-86）：单视图卡片结构、文件/轨迹入口只在可用时渲染、
// 终端类工具（bash/pwsh）用 terminal 卡片、write/edit 复用 DiffCard、子会话跳转、动作回传。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api } from '../../src/shared/protocol.js';
import {
  TERMINAL_TOOL_NAMES,
  ToolCard,
  isDiffTool,
  isTerminalTool,
  shouldRenderCommandLog,
  toolFileTarget,
  toolStatusLabel,
  toolStatusOf,
} from '../../src/renderer/tool/index.js';
import type { TimelineToolRow } from '../../src/renderer/features/timeline/execution-log.js';

afterEach(cleanup);

function stubApi(): void {
  (window as unknown as { harness2: Harness2Api }).harness2 = {
    getSnapshotForCall: vi.fn(async () => ({
      ok: true,
      entry: { file: 'a.txt', before: 'old\n', after: 'new\n' },
    })),
  } as unknown as Harness2Api;
}

function commandRow(over: Partial<TimelineToolRow> = {}): TimelineToolRow {
  return {
    callId: 'c1',
    tool: 'bash',
    status: 'running',
    commandSource: 'none',
    cwd: '',
    exitCodeSource: 'none',
    outputRef: '',
    outputTruncated: false,
    ...over,
  };
}

describe('工具卡纯模型', () => {
  it('终端类工具含 bash 与 pwsh（D-86：不只认 bash）', () => {
    expect(TERMINAL_TOOL_NAMES).toContain('bash');
    expect(TERMINAL_TOOL_NAMES).toContain('pwsh');
    expect(isTerminalTool('pwsh')).toBe(true);
    expect(isTerminalTool('BASH')).toBe(true);
    expect(isTerminalTool('read')).toBe(false);
    expect(isTerminalTool(undefined)).toBe(false);
  });

  it('文件路径取 file_path / path；写文件类工具认 write/edit', () => {
    expect(toolFileTarget({ file_path: 'a.ts' })).toBe('a.ts');
    expect(toolFileTarget({ path: 'b.ts' })).toBe('b.ts');
    expect(toolFileTarget({ file_path: '' })).toBeUndefined();
    expect(toolFileTarget(undefined)).toBeUndefined();
    expect(isDiffTool('write')).toBe(true);
    expect(isDiffTool('edit')).toBe(true);
    expect(isDiffTool('bash')).toBe(false);
  });

  it('状态文案与命令日志判据（终端类 / 有输出 / 取消 → 都要用 terminal 卡片）', () => {
    expect(toolStatusOf(undefined)).toBe('running');
    expect(toolStatusOf({ ok: true })).toBe('ok');
    expect(toolStatusOf({ ok: false })).toBe('failed');
    expect(toolStatusLabel(undefined)).toBe('运行中…');
    expect(toolStatusLabel({ ok: false, error: 'EACCES' })).toBe('FAILED: EACCES');
    expect(shouldRenderCommandLog(commandRow({ tool: 'pwsh' }))).toBe(true); // 运行中的 pwsh
    expect(shouldRenderCommandLog(commandRow({ tool: 'read', outputRef: 'x' }))).toBe(true);
    expect(shouldRenderCommandLog(commandRow({ tool: 'read', status: 'cancelled' }))).toBe(true);
    expect(shouldRenderCommandLog(commandRow({ tool: 'read' }))).toBe(false);
    expect(shouldRenderCommandLog(undefined)).toBe(false);
  });
});

describe('工具卡：单视图与入口可用性', () => {
  it('卡片内联在调用树里（单视图）：无详情视图状态位，工具行/状态如实展示', () => {
    const { container } = render(
      <ToolCard card={{ tool: 'write', args: { file_path: 'a.txt' }, result: { ok: true }, callId: 'c1' }} />,
    );
    const card = container.querySelector('[data-tool-card="write"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-tool-status')).toBe('ok');
    expect(container.textContent).toContain('> write');
    // 单视图：卡片内部不存在「详情」区域/第二个全高视图
    expect(container.querySelector('[data-tool-detail]')).toBeNull();
    expect(container.querySelector('.tool-detail')).toBeNull();
  });

  it('运行中：状态显示"运行中…"（半截工具行不假报 ok）', () => {
    render(<ToolCard card={{ tool: 'bash', args: { command: 'ls' }, callId: 'c1' }} />);
    expect(screen.getByText('运行中…')).toBeTruthy();
    expect(document.querySelector('[data-tool-status="running"]')).not.toBeNull();
  });

  it('文件路径入口：只在给了 onOpenFile 且有路径时渲染，点击回传 path/sessionId/callId（D-86 ①）', () => {
    const onOpenFile = vi.fn();
    const { rerender } = render(
      <ToolCard
        card={{ tool: 'read', args: { file_path: 'src/a.ts' }, result: { ok: true }, callId: 'c1' }}
        sessionId="s1"
        actions={{ onOpenFile }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(onOpenFile).toHaveBeenCalledWith({ path: 'src/a.ts', sessionId: 's1', callId: 'c1' });

    // 没给动作 → 不渲染入口（不造假按钮）
    rerender(<ToolCard card={{ tool: 'read', args: { file_path: 'src/a.ts' }, callId: 'c1' }} sessionId="s1" />);
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull();

    // 参数里没有文件 → 即便给了动作也不渲染
    rerender(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'ls' }, callId: 'c1' }}
        sessionId="s1"
        actions={{ onOpenFile }}
      />,
    );
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull();
  });

  it('轨迹入口：只在给了 onInspect（= 轨迹视图已装配）时渲染，点击回传 callId/seq（D-86 ②）', () => {
    const onInspect = vi.fn();
    const { rerender } = render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'ls' }, result: { ok: true }, callId: 'c1', seq: 7 }}
        sessionId="s1"
        actions={{ onInspect }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看轨迹' }));
    expect(onInspect).toHaveBeenCalledWith({ sessionId: 's1', callId: 'c1', seq: 7 });

    // 轨迹视图未装配（宿主不传 onInspect）→ 不渲染该入口
    rerender(<ToolCard card={{ tool: 'bash', args: { command: 'ls' }, callId: 'c1' }} sessionId="s1" actions={{}} />);
    expect(screen.queryByRole('button', { name: '查看轨迹' })).toBeNull();
  });

  it('无会话上下文时不渲染轨迹入口（inspect 缺上下文必失败，不摆死按钮）', () => {
    render(<ToolCard card={{ tool: 'bash', args: {}, callId: 'c1' }} actions={{ onInspect: () => {} }} />);
    expect(screen.queryByRole('button', { name: '查看轨迹' })).toBeNull();
  });

  it('终端类工具（含 pwsh）渲染命令日志卡；非终端无输出不渲染', () => {
    const { rerender, container } = render(
      <ToolCard
        card={{ tool: 'pwsh', args: { command: 'Get-ChildItem' }, callId: 'c1' }}
        commandRow={commandRow({ tool: 'pwsh' })}
      />,
    );
    expect(container.querySelector('.cmd-log')).not.toBeNull();

    rerender(
      <ToolCard
        card={{ tool: 'read', args: { file_path: 'a.ts' }, result: { ok: true }, callId: 'c2' }}
        commandRow={commandRow({ tool: 'read', status: 'success' })}
      />,
    );
    expect(container.querySelector('.cmd-log')).toBeNull();
  });

  it('write/edit：结果 ok 且有撤销动作时复用 DiffCard（读会话快照，红绿行）', async () => {
    stubApi();
    render(
      <ToolCard
        card={{ tool: 'edit', args: { file_path: 'a.txt' }, result: { ok: true }, callId: 'c1', seq: 3 }}
        sessionId="s1"
        actions={{ onUndo: () => {} }}
      />,
    );
    expect(await screen.findByText('a.txt')).toBeTruthy();
    expect(document.querySelector('.diff-card')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '撤销此次修改' }));
  });

  it('子会话工具：跳转按钮回传 childSessionId', () => {
    const onOpenChildSession = vi.fn();
    render(
      <ToolCard
        card={{ tool: 'subagent_start', args: {}, result: { ok: true }, callId: 'c1', childSessionId: 'child-1' }}
        actions={{ onOpenChildSession }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /子会话 child-1/ }));
    expect(onOpenChildSession).toHaveBeenCalledWith('child-1');
  });

  it('失败结果如实显示 FAILED + 原因（不吞错）', async () => {
    render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'x' }, result: { ok: false, error: 'exit 1' }, callId: 'c1' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('FAILED: exit 1')).toBeTruthy());
    expect(document.querySelector('[data-tool-status="failed"]')).not.toBeNull();
  });
});
