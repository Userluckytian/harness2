// Z-17（phase-Z8 §7）命令面板 **tabbed 布局** 单测：四 tab 渲染/切换（role=tablist + getByRole('tab')）、
// 全部=组头分区、任务=会话数据源 + 空态、文件=未注入空态、disabled 占位项（title/data-placeholder、
// 点击不触发 run、键盘跳过）、统一 placeholder 文案、←→ 切 tab、纯函数（groupCommands/visibleItems/
// stepTab）、以及 **向后兼容钉**（layout 缺省 = classic 旧行为逐字不变：open=false null / 遮罩关闭 /
// Enter 执行后 onClose / JUMP_TO_SESSION_ID 仍切会话态）。
// 旧 command-palette.test.tsx 不改、继续绿 = classic 兼容的另一半证明。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import {
  CommandPalette,
  FILES_EMPTY_TEXT,
  groupCommands,
  JUMP_TO_SESSION_ID,
  PALETTE_TABS,
  stepTab,
  TASKS_EMPTY_TEXT,
  TABBED_PLACEHOLDER,
  visibleItems,
  type PaletteCommand,
  type PaletteFile,
  type PaletteSession,
} from '../src/renderer/components/CommandPalette.js';

/* —— 夹具 —— */

const CMDS: PaletteCommand[] = [
  { id: 'new', label: '新任务', hint: 'Ctrl+N', group: '建议', run: vi.fn() },
  { id: 'settings', label: '设置', group: '建议', run: vi.fn() },
  { id: 'side', label: '切换侧边栏', hint: 'Ctrl+B', group: '面板', run: vi.fn() },
  { id: 'term', label: '切换终端', group: '面板', disabled: true, disabledHint: '终端 dock 未引入', run: vi.fn() },
  { id: 'loose', label: '无组命令', run: vi.fn() },
];
const SESSIONS: PaletteSession[] = [
  { id: 's1', label: '重构命令面板' },
  { id: 's2', label: '补单测' },
];
const FILES: PaletteFile[] = [
  { id: 'f1', label: 'CommandPalette.tsx', hint: 'src/renderer/components' },
  { id: 'f2', label: 'shell.css', hint: 'src/styles' },
];

function renderTabbed(overrides?: { open?: boolean; files?: PaletteFile[]; onSelectFile?: (id: string) => void }) {
  const onClose = vi.fn();
  const onSelectSession = vi.fn();
  render(
    <CommandPalette
      open={overrides?.open ?? true}
      onClose={onClose}
      commands={CMDS}
      sessions={SESSIONS}
      onSelectSession={onSelectSession}
      layout="tabbed"
      files={overrides?.files === undefined ? FILES : overrides.files}
      onSelectFile={overrides?.onSelectFile}
    />,
  );
  return { onClose, onSelectSession };
}

const input = (): HTMLInputElement => document.querySelector('.command-palette-input') as HTMLInputElement;
const options = (): HTMLElement[] => screen.queryAllByRole('option') as HTMLElement[];

beforeEach(() => {
  cleanup();
});

/* —— 纯函数 —— */

describe('groupCommands', () => {
  it('按 group 首现顺序分区，无 group 不入组', () => {
    const g = groupCommands(CMDS);
    expect(g.map((x) => x.group)).toEqual(['建议', '面板']);
    expect(g[0]!.items.map((c) => c.id)).toEqual(['new', 'settings']);
    expect(g[1]!.items.map((c) => c.id)).toEqual(['side', 'term']);
  });
  it('全空 → []', () => {
    expect(groupCommands([{ id: 'x', label: 'x', run: () => {} }])).toEqual([]);
  });
});

describe('visibleItems', () => {
  it('all：组头行 + 组内项 + 无 group 归尾部无组区', () => {
    const rows = visibleItems('all', { commands: CMDS, sessions: [], files: [] });
    const kinds = rows.map((r) => (r.kind === 'group' ? `G:${r.label}` : r.kind));
    expect(kinds).toEqual(['G:建议', 'command', 'command', 'G:面板', 'command', 'command', 'command']);
    expect(rows[rows.length - 1]!.kind).toBe('command');
  });
  it('commands（操作）：平铺无组头', () => {
    const rows = visibleItems('commands', { commands: CMDS, sessions: [], files: [] });
    expect(rows.every((r) => r.kind === 'command')).toBe(true);
    expect(rows).toHaveLength(CMDS.length);
  });
  it('tasks：组头「最近任务」+ 会话；files：组头「最近变更」+ 文件', () => {
    const t = visibleItems('tasks', { commands: [], sessions: SESSIONS, files: [] });
    expect(t[0]).toMatchObject({ kind: 'group', label: '最近任务' });
    expect(t.filter((r) => r.kind === 'session')).toHaveLength(2);
    const f = visibleItems('files', { commands: [], sessions: [], files: FILES });
    expect(f[0]).toMatchObject({ kind: 'group', label: '最近变更' });
    expect(f.filter((r) => r.kind === 'file')).toHaveLength(2);
  });
  it('tabbed 下 JUMP_TO_SESSION_ID 视为 disabled 占位', () => {
    const jump: PaletteCommand = { id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: () => {} };
    const rows = visibleItems('commands', { commands: [jump], sessions: [], files: [] });
    expect(rows[0]).toMatchObject({ kind: 'command', disabled: true });
  });
});

describe('stepTab', () => {
  it('←→ 在四 tab 间回绕', () => {
    expect(stepTab('all', 1)).toBe('commands');
    expect(stepTab('commands', 1)).toBe('tasks');
    expect(stepTab('files', 1)).toBe('all'); // 回绕
    expect(stepTab('all', -1)).toBe('files'); // 反向回绕
    expect(stepTab('commands', -1)).toBe('all');
  });
});

/* —— 组件：tabbed 布局 —— */

describe('CommandPalette tabbed', () => {
  it('placeholder 统一文案；tablist 四 tab 文本精确；默认「全部」选中', () => {
    renderTabbed();
    expect(input().placeholder).toBe(TABBED_PLACEHOLDER);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(PALETTE_TABS.map((t) => t.label));
    expect(tabs.map((t) => t.textContent)).toEqual(['全部', '操作', '任务', '文件']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('全部 tab：组头出现（非 option）', () => {
    renderTabbed();
    expect(screen.getByText('建议')).toBeTruthy();
    expect(screen.getByText('面板')).toBeTruthy();
    expect(screen.queryByText('最近任务')).toBeNull();
    // 组头不可选：5 条命令是 option，组头两行不是
    expect(options()).toHaveLength(5);
  });

  it('点击切到操作 tab：平铺无组头', () => {
    renderTabbed();
    fireEvent.click(screen.getByRole('tab', { name: '操作' }));
    expect(screen.queryByText('建议')).toBeNull();
    expect(options()).toHaveLength(5);
  });

  it('←→ 切 tab（回绕）', () => {
    renderTabbed();
    fireEvent.keyDown(input(), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '操作' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowLeft' });
    fireEvent.keyDown(input(), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: '文件' }).getAttribute('aria-selected')).toBe('true');
  });

  it('任务 tab：会话列表 + 选中触发 onSelectSession；空态「暂无最近任务」', () => {
    renderTabbed();
    fireEvent.click(screen.getByRole('tab', { name: '任务' }));
    expect(screen.getByText('最近任务')).toBeTruthy();
    expect(screen.getByText('重构命令面板')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Enter' });
    // 首项被默认选中
    expect(screen.queryByText(TASKS_EMPTY_TEXT)).toBeNull();
    cleanup();

    render(
      <CommandPalette open onClose={vi.fn()} commands={CMDS} sessions={[]} onSelectSession={vi.fn()} layout="tabbed" />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '任务' }));
    expect(screen.getByText(TASKS_EMPTY_TEXT)).toBeTruthy();
    expect(TASKS_EMPTY_TEXT).toBe('暂无最近任务');
  });

  it('文件 tab：未注入 → 空态「当前任务暂无最近变更」；注入后选中触发 onSelectFile', () => {
    const onSelectFile = vi.fn();
    const { onClose } = renderTabbed({ onSelectFile });
    fireEvent.click(screen.getByRole('tab', { name: '文件' }));
    expect(screen.getByText('最近变更')).toBeTruthy();
    expect(options()).toHaveLength(2);
    fireEvent.click(screen.getByText('shell.css'));
    expect(onSelectFile).toHaveBeenCalledWith('f2');
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();

    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        commands={CMDS}
        sessions={SESSIONS}
        onSelectSession={vi.fn()}
        layout="tabbed"
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '文件' }));
    expect(screen.getByText(FILES_EMPTY_TEXT)).toBeTruthy();
    expect(FILES_EMPTY_TEXT).toBe('当前任务暂无最近变更');
  });

  it('disabled 项：渲染 + data-placeholder + title，点击不触发 run，键盘 ↓ 跳过', () => {
    const { onClose } = renderTabbed();
    fireEvent.click(screen.getByRole('tab', { name: '操作' }));
    const term = screen.getByText('切换终端').closest('li') as HTMLElement;
    expect(term.getAttribute('data-placeholder')).toBe('');
    expect(term.getAttribute('title')).toBe('终端 dock 未引入');
    expect(term.getAttribute('aria-disabled')).toBe('true');

    // 点击不触发 run、不关闭
    fireEvent.click(term);
    expect(CMDS[3]!.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 键盘：从 0 起 ↓ 应跳过 disabled（顺序 new,settings,side,[term],loose）
    fireEvent.keyDown(input(), { key: 'ArrowDown' }); // -> settings(1)
    fireEvent.keyDown(input(), { key: 'ArrowDown' }); // -> side(2)
    fireEvent.keyDown(input(), { key: 'ArrowDown' }); // -> loose(4) 跳过 term
    const opts = options();
    expect(opts[4]!.getAttribute('aria-selected')).toBe('true');
    expect(opts[3]!.getAttribute('aria-selected')).toBe('false');
  });

  it('↑↓ 在当前 tab 可选项中回绕；Enter 执行选中命令后 onClose', () => {
    const { onClose } = renderTabbed();
    fireEvent.click(screen.getByRole('tab', { name: '操作' }));
    const opts = options();
    expect(opts[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowUp' }); // 回绕到末项 loose(4)
    expect(options()[4]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(CMDS[4]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('输入框过滤当前 tab 内容', () => {
    renderTabbed();
    fireEvent.change(input(), { target: { value: '设置' } });
    const cmds = options();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.textContent).toContain('设置');
  });
});

/* —— 向后兼容钉：layout 缺省 = classic 旧行为不变 —— */

describe('CommandPalette classic 兼容（缺省 layout）', () => {
  const CLS_CMDS: PaletteCommand[] = [
    { id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: vi.fn() },
    { id: 'new', label: '新建会话', run: vi.fn() },
  ];
  function renderClassic() {
    const onClose = vi.fn();
    const onSelectSession = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={CLS_CMDS}
        sessions={SESSIONS}
        onSelectSession={onSelectSession}
      />,
    );
    return { onClose, onSelectSession };
  }

  it('open=false 返回 null（无面板、无 tablist、旧 placeholder）', () => {
    const { container } = render(
      <CommandPalette
        open={false}
        onClose={vi.fn()}
        commands={CLS_CMDS}
        sessions={SESSIONS}
        onSelectSession={vi.fn()}
      />,
    );
    expect(container.querySelector('.command-palette')).toBeNull();
  });

  it('classic 不出现 tablist；placeholder 仍「输入命令…」', () => {
    renderClassic();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(input().placeholder).toBe('输入命令…');
  });

  it('遮罩点击关闭', () => {
    const { onClose } = renderClassic();
    fireEvent.mouseDown(document.querySelector('.command-palette-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter 执行选中命令后 onClose', () => {
    const { onClose } = renderClassic();
    fireEvent.keyDown(input(), { key: 'ArrowDown' }); // -> 新建会话(1)
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(CLS_CMDS[1]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('JUMP_TO_SESSION_ID 在 classic 仍切会话态（placeholder → 搜索会话…）', () => {
    const { onSelectSession } = renderClassic();
    fireEvent.keyDown(input(), { key: 'Enter' }); // 选中跳转命令
    expect(input().placeholder).toBe('搜索会话…');
    fireEvent.keyDown(input(), { key: 'Enter' }); // 选中首个会话
    expect(onSelectSession).toHaveBeenCalledWith('s1');
  });
});
