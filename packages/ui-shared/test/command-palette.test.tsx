// 命令面板（Z7 下沉 ui-shared）组件级测试：过滤/导航纯函数（filterCommands / filterSessions /
// stepSelection）+ 组件键盘导航（↑↓ 移动、Enter 执行 run、Esc 关闭）、会话跳转二态、过滤与空态。
// 语义与桌面既有 `packages/desktop/test/command-palette.test.tsx` 一致（下沉不改行为）；桌面侧那份
// 保留 App 集成用例（Ctrl+K 唤出 / 左栏命令中心入口），并改引本包实现。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import {
  CommandPalette,
  filterCommands,
  filterSessions,
  JUMP_TO_SESSION_ID,
  stepSelection,
  type PaletteCommand,
  type PaletteSession,
} from '../src/renderer/components/CommandPalette.js';

/* —— 过滤纯函数 —— */

const CMD: PaletteCommand[] = [
  { id: 'newSession', label: '新建会话', hint: 'Ctrl+N', run: () => {} },
  { id: 'openSettings', label: '打开设置', hint: 'Ctrl+,', run: () => {} },
  { id: 'setPanes2', label: '切换为双栏（2 栏）', run: () => {} },
];

describe('filterCommands', () => {
  it('空查询 → 全量（不改变顺序）', () => {
    expect(filterCommands(CMD, '')).toEqual(CMD);
    expect(filterCommands(CMD, '   ')).toEqual(CMD);
  });

  it('按 label 大小写不敏感子串过滤', () => {
    expect(filterCommands(CMD, '新建').map((c) => c.id)).toEqual(['newSession']);
    expect(filterCommands(CMD, '设置').map((c) => c.id)).toEqual(['openSettings']);
  });

  it('仅命中 hint 的也返回，且排在 label 命中之后', () => {
    const res = filterCommands(CMD, 'ctrl');
    expect(res.map((c) => c.id)).toEqual(['newSession', 'openSettings']); // label 命中在前
    const hintOnly = filterCommands(CMD, '2 栏');
    expect(hintOnly.map((c) => c.id)).toEqual(['setPanes2']);
  });

  it('无匹配 → 空数组', () => {
    expect(filterCommands(CMD, '不存在')).toEqual([]);
  });
});

describe('filterSessions', () => {
  const S: PaletteSession[] = [
    { id: 's1', label: '第一句' },
    { id: 's2', label: '重构' },
  ];
  it('空查询 → 全量', () => {
    expect(filterSessions(S, '')).toEqual(S);
  });
  it('按标题过滤', () => {
    expect(filterSessions(S, '重构').map((s) => s.id)).toEqual(['s2']);
  });
  it('无匹配 → 空数组', () => {
    expect(filterSessions(S, 'xyz')).toEqual([]);
  });
});

describe('stepSelection', () => {
  it('上下移动回绕', () => {
    expect(stepSelection(0, 1, 3)).toBe(1);
    expect(stepSelection(2, 1, 3)).toBe(0); // 到底回开头
    expect(stepSelection(0, -1, 3)).toBe(2); // 到顶回末尾
  });
  it('空/单条边界', () => {
    expect(stepSelection(0, 1, 0)).toBe(-1);
    expect(stepSelection(0, 1, 1)).toBe(0);
  });
});

/* —— 组件：键盘导航 / Esc / Enter / 遮罩点击 / 二态 / 空态 —— */

const MOCK_CMDS: PaletteCommand[] = [
  { id: 'newSession', label: '新建会话', run: vi.fn() },
  { id: 'openSettings', label: '打开设置', run: vi.fn() },
  { id: 'setPanes2', label: '切换为双栏（2 栏）', run: vi.fn() },
];
const MOCK_SESSIONS: PaletteSession[] = [
  { id: 's1', label: '第一句' },
  { id: 's2', label: '重构' },
];

function renderPalette(overrides?: { open?: boolean; onClose?: () => void; onSelectSession?: (id: string) => void }) {
  const onClose = vi.fn();
  const onSelectSession = vi.fn();
  const utils = render(
    <CommandPalette
      open={overrides?.open ?? true}
      onClose={overrides?.onClose ?? onClose}
      commands={MOCK_CMDS}
      sessions={MOCK_SESSIONS}
      onSelectSession={overrides?.onSelectSession ?? onSelectSession}
    />,
  );
  return { onClose, onSelectSession, ...utils };
}

describe('CommandPalette 组件', () => {
  beforeEach(() => {
    cleanup();
  });

  it('open=false 时不渲染', () => {
    const { container } = renderPalette({ open: false });
    expect(container.querySelector('.command-palette')).toBeNull();
  });

  it('open=true 渲染命令列表；↑↓ 移动高亮（回绕）；Enter 执行当前命令 run 并 onClose', () => {
    const { onClose } = renderPalette();
    const input = screen.getByPlaceholderText('输入命令…');
    const items = () => screen.getAllByRole('option');

    // 默认选中第 0 项
    expect(items()[0]!.getAttribute('aria-selected')).toBe('true');

    // ↓ 移到第 1 项
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[1]!.getAttribute('aria-selected')).toBe('true');

    // ↓ 再移回绕到第 2 项
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[2]!.getAttribute('aria-selected')).toBe('true');

    // ↑ 移到第 1 项（非回绕）
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(items()[1]!.getAttribute('aria-selected')).toBe('true');

    // ↓ 回绕：第 2 项再 ↓ → 回到第 0 项
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[2]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[0]!.getAttribute('aria-selected')).toBe('true');

    // Enter 执行第 0 项 run + onClose
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(MOCK_CMDS[0]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 关闭（onClose 触发）', () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(screen.getByPlaceholderText('输入命令…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击关闭（点面板内部不关闭）', () => {
    const { onClose } = renderPalette();
    const overlay = document.querySelector('.command-palette-overlay')!;
    fireEvent.mouseDown(overlay); // e.target === currentTarget → onClose
    expect(onClose).toHaveBeenCalledTimes(1);

    const panel = document.querySelector('.command-palette')!;
    fireEvent.mouseDown(panel); // stopPropagation → 不关闭
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('输入过滤实时生效；无匹配显示空态', () => {
    renderPalette();
    const input = screen.getByPlaceholderText('输入命令…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '设置' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('打开设置');

    fireEvent.change(input, { target: { value: '根本不存在的命令' } });
    expect(screen.getByText('无匹配项')).toBeTruthy();
  });

  it('跳转会话：选中该命令 Enter → 会话态按标题过滤；再 Enter 触发 onSelectSession 并 onClose', () => {
    const cmds: PaletteCommand[] = [
      { id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: vi.fn() },
      { id: 'newSession', label: '新建会话', run: vi.fn() },
    ];
    const onClose = vi.fn();
    const onSelectSession = vi.fn();
    render(
      <CommandPalette
        open
        commands={cmds}
        sessions={MOCK_SESSIONS}
        onClose={onClose}
        onSelectSession={onSelectSession}
      />,
    );
    const input = screen.getByPlaceholderText('输入命令…') as HTMLInputElement;

    // 选中跳转命令并执行 → 进入会话态
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByPlaceholderText('搜索会话…')).toBeTruthy();

    // 会话态过滤
    fireEvent.change(input, { target: { value: '重构' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('重构');

    // Enter 选中该会话
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectSession).toHaveBeenCalledWith('s2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('会话态按 Esc 先回命令态，再按一次才关闭', () => {
    const cmds: PaletteCommand[] = [{ id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: vi.fn() }];
    const onClose = vi.fn();
    render(
      <CommandPalette open commands={cmds} sessions={MOCK_SESSIONS} onClose={onClose} onSelectSession={vi.fn()} />,
    );
    const input = screen.getByPlaceholderText('输入命令…') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' }); // 进入会话态
    expect(screen.getByPlaceholderText('搜索会话…')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' }); // 回命令态
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('输入命令…')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' }); // 关闭
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
