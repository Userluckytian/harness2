// 工具卡测试（P6-C / D-86 / Z3-06 Z-93 对齐）：
//   单视图卡片结构、文件/轨迹入口只在可用时渲染、终端类工具（bash/pwsh）用 terminal 卡片、
//   write/edit 复用 DiffCard、子会话跳转、动作回传；
//   Z-93 增补：头部展开箭头（悬停显现/展开 rotate-90）、整行 role=button + Enter/Space、
//   结果区 300ms 折叠动画 + 延迟卸载、失败态虚线下划线 + tooltip 复制（复制错误/已复制）、
//   同工具展开态记忆（内存，不持久化）、三态语义色。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api } from '../../src/shared/protocol.js';
import {
  TERMINAL_TOOL_NAMES,
  ToolCard,
  isDiffTool,
  isSubagentTool,
  isTerminalTool,
  resetToolOpenMemoryForTests,
  shouldRenderCommandLog,
  toolFileTarget,
  toolStatusLabel,
  toolStatusOf,
} from '@harness2/ui-shared/renderer/tool/index.js';
import type { TimelineToolRow } from '@harness2/ui-shared/renderer/features/timeline/execution-log.js';

afterEach(cleanup);

beforeEach(() => {
  // 展开态记忆是模块级内存（Z-93），跨用例共享 —— 每个用例前清空，保证确定性初态
  resetToolOpenMemoryForTests();
});

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

  it('运行中：状态显示"运行中…"（半截工具行不假报 ok），状态色用语义 token', () => {
    const { container } = render(<ToolCard card={{ tool: 'bash', args: { command: 'ls' }, callId: 'c1' }} />);
    expect(screen.getByText('运行中…')).toBeTruthy();
    expect(document.querySelector('[data-tool-status="running"]')).not.toBeNull();
    // Z-93 三态语义色：running → text-interaction-ask-foreground
    expect(container.querySelector('.text-interaction-ask-foreground')).not.toBeNull();
  });

  it('完成态：状态节点用 text-success（Z-93 三态语义色）', () => {
    const { container } = render(
      <ToolCard card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: true }, callId: 'c1' }} />,
    );
    expect(container.querySelector('.text-success')).not.toBeNull();
  });

  it('Z-93 头部：可展开时整行 role=button + aria-expanded，展开箭头默认隐藏、悬停显现、展开 rotate-90', () => {
    const { container } = render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'ls' }, result: { ok: true }, callId: 'c1' }}
        commandRow={commandRow({ status: 'success' })}
      />,
    );
    const row = container.querySelector<HTMLDivElement>('[data-testid="tool-summary-row"]')!;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    const chevron = container.querySelector('[data-testid="tool-chevron"]');
    expect(chevron).not.toBeNull();
    const chevronClass = () => chevron!.getAttribute('class') ?? '';
    // 默认收起：箭头隐藏（opacity-0），不旋转
    expect(chevronClass()).toContain('opacity-0');
    expect(chevronClass()).not.toContain('rotate-90');
    // 悬停显现（group-hover 类存在）
    expect(chevronClass()).toContain('group-hover/tool:opacity-100');
    // 展开后 rotate-90
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(chevronClass()).toContain('rotate-90');
    expect(chevronClass()).toContain('opacity-100');
  });

  it('不可展开（无 diff / 无命令日志）时不摆假箭头、整行不是按钮', () => {
    const { container } = render(
      <ToolCard card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: true }, callId: 'c1' }} />,
    );
    expect(container.querySelector('[data-testid="tool-chevron"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-summary-row"]')?.getAttribute('role')).toBeNull();
  });

  it('整行点击 / Enter / Space 展开收起；结果区 300ms 折叠动画 + 延迟卸载', async () => {
    const { container } = render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'ls' }, result: { ok: true }, callId: 'c1' }}
        commandRow={commandRow({ status: 'success' })}
      />,
    );
    const row = container.querySelector<HTMLDivElement>('[data-testid="tool-summary-row"]')!;
    // 默认折叠：结果区不在 DOM（收起后延迟卸载）
    expect(container.querySelector('[data-testid="tool-result"]')).toBeNull();

    // Enter 展开
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="tool-result"]')).not.toBeNull();
    expect(container.querySelector('.cmd-log')).not.toBeNull();

    // Space 收起 → 动画期间仍在 DOM（aria-hidden），延迟卸载后消失
    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    const during = container.querySelector('[data-testid="tool-result"]');
    expect(during?.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(container.querySelector('[data-testid="tool-result"]')).toBeNull(), {
      timeout: 1000,
    });
  });

  it('行内按钮不触发整行开合（打开文件 / 查看轨迹 / 复制错误上 stopPropagation + inline 标记）', () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <ToolCard
        card={{ tool: 'read', args: { file_path: 'src/a.ts' }, result: { ok: true }, callId: 'c1' }}
        sessionId="s1"
        commandRow={commandRow({ tool: 'read', status: 'success', outputRef: 'x' })}
        actions={{ onOpenFile }}
      />,
    );
    const before = container.querySelector('[data-testid="tool-summary-row"]')?.getAttribute('aria-expanded');
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(onOpenFile).toHaveBeenCalledWith({ path: 'src/a.ts', sessionId: 's1', callId: 'c1' });
    expect(container.querySelector('[data-testid="tool-summary-row"]')?.getAttribute('aria-expanded')).toBe(before);
  });

  it('展开态记忆（Z-93）：同工具再次出现保持上次开合；内存实现、不持久化', () => {
    const props = {
      card: { tool: 'bash', args: { command: 'ls' }, result: { ok: true }, callId: 'c1' },
      commandRow: commandRow({ status: 'success' }),
    };
    const first = render(<ToolCard {...props} />);
    const firstRow = first.container.querySelector('[data-testid="tool-summary-row"]')!;
    expect(firstRow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(firstRow);
    expect(firstRow.getAttribute('aria-expanded')).toBe('true');
    first.unmount();

    // 同工具的新卡片实例：沿用上次开合
    const second = render(<ToolCard {...props} />);
    expect(second.container.querySelector('[data-testid="tool-summary-row"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    // 不同工具不受影响（read 有输出 → 可展开，初态仍为收起）
    const other = render(
      <ToolCard
        card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: true } }}
        commandRow={commandRow({ tool: 'read', status: 'success', outputRef: 'x' })}
      />,
    );
    expect(other.container.querySelector('[data-testid="tool-summary-row"]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('失败态（Z-93）：FAILED 带虚线下划线，tooltip 常驻 DOM（hover 显隐）内含复制按钮', async () => {
    render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'x' }, result: { ok: false, error: 'exit 1' }, callId: 'c1' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('FAILED: exit 1')).toBeTruthy());
    expect(document.querySelector('[data-tool-status="failed"]')).not.toBeNull();
    // 虚线下划线（Z-93）：失败文字带 dashed 下边框
    const failed = screen.getByText('FAILED: exit 1');
    expect(failed.className).toContain('border-dashed');
    expect(failed.className).toContain('text-destructive');
    // tooltip 在 DOM 中（CSS hover 显隐），含错误全文与复制按钮
    const tooltip = document.querySelector('[data-testid="tool-error-tooltip"]');
    expect(tooltip?.textContent).toContain('exit 1');
    expect(tooltip?.querySelector('[data-testid="tool-copy-error"]')?.textContent).toContain('复制错误');
  });

  it('复制错误：写入剪贴板成功 → 按钮短暂变「已复制」', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'x' }, result: { ok: false, error: 'exit 1' }, callId: 'c1' }}
      />,
    );
    fireEvent.click(screen.getByTestId('tool-copy-error'));
    expect(writeText).toHaveBeenCalledWith('exit 1');
    await waitFor(() => expect(screen.getByTestId('tool-copy-error').textContent).toContain('已复制'));
    // 短暂反馈后回到「复制错误」
    await waitFor(() => expect(screen.getByTestId('tool-copy-error').textContent).toContain('复制错误'), {
      timeout: 3000,
    });
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

  it('终端类工具（含 pwsh）渲染命令日志卡；非终端无输出不渲染（Z-93：先展开再断言）', async () => {
    const { rerender, container } = render(
      <ToolCard
        card={{ tool: 'pwsh', args: { command: 'Get-ChildItem' }, callId: 'c1' }}
        commandRow={commandRow({ tool: 'pwsh' })}
      />,
    );
    fireEvent.click(container.querySelector('[data-testid="tool-summary-row"]')!);
    expect(container.querySelector('.cmd-log')).not.toBeNull();

    rerender(
      <ToolCard
        card={{ tool: 'read', args: { file_path: 'a.ts' }, result: { ok: true }, callId: 'c2' }}
        commandRow={commandRow({ tool: 'read', status: 'success' })}
      />,
    );
    // read 无输出无终端归类 → 结果区不存在（不摆假箭头，也不渲染日志）
    expect(container.querySelector('.cmd-log')).toBeNull();
    expect(container.querySelector('[data-testid="tool-result"]')).toBeNull();
  });

  it('write/edit：结果 ok 且有撤销动作时复用 DiffCard（读会话快照，红绿行）', async () => {
    stubApi();
    const { container } = render(
      <ToolCard
        card={{ tool: 'edit', args: { file_path: 'a.txt' }, result: { ok: true }, callId: 'c1', seq: 3 }}
        sessionId="s1"
        actions={{ onUndo: () => {} }}
      />,
    );
    fireEvent.click(container.querySelector('[data-testid="tool-summary-row"]')!);
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

  it('Z3-07 子代理特化：subagent_start/continue 头部带「子代理」徽章 + Bot 图标，状态沿用三态', () => {
    const { container, rerender } = render(<ToolCard card={{ tool: 'subagent_start', args: {}, callId: 'c1' }} />);
    // 徽章 + Bot 形图标（lucide lucide-bot）
    expect(screen.getByTestId('tool-subagent-badge').textContent).toBe('子代理');
    expect(container.querySelector('svg.lucide-bot')).not.toBeNull();
    // 状态沿用工具卡三态：无结果 → 运行中（不假报完成）
    expect(container.querySelector('[data-tool-status="running"]')).not.toBeNull();

    rerender(<ToolCard card={{ tool: 'subagent_continue', args: {}, result: { ok: true }, callId: 'c2' }} />);
    expect(screen.getByTestId('tool-subagent-badge').textContent).toBe('子代理');
    expect(container.querySelector('.text-success')).not.toBeNull();

    rerender(<ToolCard card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: true }, callId: 'c3' }} />);
    expect(screen.queryByTestId('tool-subagent-badge')).toBeNull(); // 普通工具无徽章
  });

  it('Z3-07 isSubagentTool 分类：只认 subagent_start / subagent_continue', () => {
    expect(isSubagentTool('subagent_start')).toBe(true);
    expect(isSubagentTool('subagent_continue')).toBe(true);
    expect(isSubagentTool('SUBAGENT_START')).toBe(true);
    expect(isSubagentTool('bash')).toBe(false);
    expect(isSubagentTool(undefined)).toBe(false);
  });
});
