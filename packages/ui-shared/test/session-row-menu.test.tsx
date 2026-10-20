// @vitest-environment jsdom
// P0-2（Z-10）侧栏右键菜单：
//   - 纯函数 `rowMenuActions`：只列**可兑现**的项（无回调=不出现），顺序按 ZCode，
//     归档态项文案翻转「取消归档」，置顶态翻转「取消置顶」；**不含「标记未读」**（无通道）。
//   - 组件：会话行右键唤出菜单、动作回调透传、分屏满 4 格禁用「在分屏打开」。
//   - 重命名：菜单项打开 SessionBrowser 内置对话框；提交走 onSubmitRename（trim、拒绝空名、
//     失败不关窗并如实显示错误）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import { SessionBrowser, type WorkspacesOwnerProps } from '../src/renderer/sidebar/SessionBrowser.js';
import { rowMenuActions, type RowMenuFlags } from '../src/renderer/sidebar/session-row-menu.js';
import type { SidebarSessionItem } from '../src/renderer/sidebar/session-items.js';

afterEach(() => cleanup());

const owner: WorkspacesOwnerProps = {
  wide: true,
  expandSidebar: () => undefined,
  registerScrollRegion: () => undefined,
  scrollBars: 'drawn',
};

const NOW = 1_700_000_000_000;
const item = (id: string, overrides: Partial<SidebarSessionItem> = {}): SidebarSessionItem => ({
  id,
  title: `会话 ${id}`,
  messageCount: 2,
  mtimeMs: NOW,
  archived: false,
  running: false,
  unread: 0,
  pendingApprovals: 0,
  pinned: false,
  ...overrides,
});

function renderBrowser(props: Partial<Parameters<typeof SessionBrowser>[0]> = {}): void {
  render(
    createElement(SessionBrowser, {
      ...owner,
      sessions: [],
      labels: DEFAULT_SIDEBAR_LABELS,
      onOpenSession: () => undefined,
      ...props,
    }),
  );
}

const flags = (over: Partial<RowMenuFlags>): RowMenuFlags => ({
  pinned: false,
  archived: false,
  canPin: true,
  canRename: true,
  canArchive: true,
  canSplit: true,
  canTrajectory: true,
  ...over,
});

function fullMenuFor(id: string) {
  void id;
  return {
    onPin: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onOpenInSplit: vi.fn(),
    onInspectTrajectory: vi.fn(),
  };
}

describe('rowMenuActions（纯函数）', () => {
  it('全通道可用 = 完整子集，顺序按 ZCode（置顶→重命名→归档→分屏→轨迹）', () => {
    expect(rowMenuActions(flags({}))).toEqual(['pin', 'rename', 'archive', 'split', 'trajectory']);
  });

  it('ZCode 全集里我们无通道的项不出现（标记未读 / 复制路径 / 文件管理器 / 反馈…）', () => {
    const actions = rowMenuActions(flags({}));
    const forbidden = ['markUnread', 'revealInFolder', 'copyWorkspacePath', 'copySessionId', 'feedback'];
    expect(actions.filter((a) => forbidden.includes(a))).toEqual([]);
  });

  it('已置顶/已归档翻转单项文案态', () => {
    expect(rowMenuActions(flags({ pinned: true }))[0]).toBe('unpin');
    expect(rowMenuActions(flags({ archived: true }))).toEqual(['pin', 'rename', 'unarchive', 'split', 'trajectory']);
  });

  it('缺回调 = 对应项不渲染；全缺 = 空集（行不挂 ContextMenu）', () => {
    expect(rowMenuActions(flags({ canRename: false }))).toEqual(['pin', 'archive', 'split', 'trajectory']);
    expect(
      rowMenuActions(
        flags({ canPin: false, canRename: false, canArchive: false, canSplit: false, canTrajectory: false }),
      ),
    ).toEqual([]);
  });
});

describe('会话行右键菜单（组件）', () => {
  const fullMenu = () => ({
    onPin: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onOpenInSplit: vi.fn(),
    onInspectTrajectory: vi.fn(),
  });

  it('右键唤出全部可兑现项（含轨迹项前的分隔），无「标记未读」', async () => {
    renderBrowser({ sessions: [item('s1')], rowMenu: fullMenu() });
    const row = screen.getByRole('button', { name: /会话 s1/ });
    fireEvent.contextMenu(row);
    const menu = await screen.findByTestId('session-row-menu');
    const actions = Array.from(menu.querySelectorAll('[data-menu-action]')).map((el) =>
      el.getAttribute('data-menu-action'),
    );
    expect(actions).toEqual(['pin', 'rename', 'archive', 'split', 'trajectory']);
    expect(menu.textContent).not.toContain('标记未读');
  });

  it('点击菜单项透传对应回调（置顶/归档带值）', async () => {
    const rowMenu = fullMenu();
    renderBrowser({ sessions: [item('s9')], rowMenu });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s9/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="pin"]')!);
    expect(rowMenu.onPin).toHaveBeenCalledWith('s9', true);
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s9/ }));
    const menu2 = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu2.querySelector('[data-menu-action="archive"]')!);
    expect(rowMenu.onArchive).toHaveBeenCalledWith('s9', true);
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s9/ }));
    const menu3 = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu3.querySelector('[data-menu-action="split"]')!);
    expect(rowMenu.onOpenInSplit).toHaveBeenCalledWith('s9');
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s9/ }));
    const menu4 = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu4.querySelector('[data-menu-action="trajectory"]')!);
    expect(rowMenu.onInspectTrajectory).toHaveBeenCalledWith('s9');
  });

  it('分屏满 4 格 = 「在分屏打开」禁用且点击不回调', async () => {
    const onOpenInSplit = vi.fn();
    renderBrowser({
      sessions: [item('s1')],
      rowMenu: { onOpenInSplit, splitLimitReached: true },
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s1/ }));
    const menu = await screen.findByTestId('session-row-menu');
    const splitItem = menu.querySelector('[data-menu-action="split"]')!;
    expect(splitItem.getAttribute('data-disabled')).not.toBeNull();
    expect(splitItem.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.menuSplitLimit);
    fireEvent.click(splitItem);
    expect(onOpenInSplit).not.toHaveBeenCalled();
  });

  it('一个回调都没有 = 右键不弹任何菜单（不挂 ContextMenu）', async () => {
    renderBrowser({ sessions: [item('s1')], rowMenu: {} });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s1/ }));
    await waitFor(() => expect(screen.queryByTestId('session-row-menu')).toBeNull());
  });
});

describe('重命名对话框（SessionBrowser 内置；壳只给 onSubmitRename，onRename 由组件接管）', () => {
  it('菜单「重命名」→ 打开对话框；提交 trim 名并关闭', async () => {
    const onSubmitRename = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      sessions: [item('s2')],
      rowMenu: { onPin: vi.fn() },
      onSubmitRename,
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s2/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="rename"]')!);
    const dialog = await screen.findByTestId('rename-session-dialog');
    const input = screen.getByTestId('rename-session-input') as HTMLInputElement;
    expect(input.value).toBe('会话 s2'); // 预填当前标题
    fireEvent.change(input, { target: { value: '  新名字  ' } });
    fireEvent.click(screen.getByRole('button', { name: DEFAULT_SIDEBAR_LABELS.renameConfirm }));
    await waitFor(() => expect(onSubmitRename).toHaveBeenCalledWith('s2', '新名字'));
    await waitFor(() => expect(screen.queryByTestId('rename-session-dialog')).toBeNull());
    expect(dialog.isConnected).toBe(false);
  });

  it('空名/纯空白 = 提交禁用（不写脏 title）', async () => {
    const onSubmitRename = vi.fn();
    renderBrowser({
      sessions: [item('s3')],
      rowMenu: {},
      onSubmitRename,
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s3/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="rename"]')!);
    await screen.findByTestId('rename-session-dialog');
    const input = screen.getByTestId('rename-session-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    const confirm = screen.getByRole('button', { name: DEFAULT_SIDEBAR_LABELS.renameConfirm });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(onSubmitRename).not.toHaveBeenCalled();
  });

  it('提交失败：不关窗、如实显示错误（不静默）', async () => {
    const onSubmitRename = vi.fn().mockRejectedValue(new Error('磁盘写失败'));
    renderBrowser({
      sessions: [item('s4')],
      rowMenu: {},
      onSubmitRename,
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s4/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="rename"]')!);
    await screen.findByTestId('rename-session-dialog');
    fireEvent.click(screen.getByRole('button', { name: DEFAULT_SIDEBAR_LABELS.renameConfirm }));
    const error = await screen.findByTestId('rename-session-error');
    expect(error.textContent).toContain('磁盘写失败');
    expect(screen.queryByTestId('rename-session-dialog')).not.toBeNull(); // 仍在
  });

  it('无重命名通道（既无 onRename 也无 onSubmitRename）= 菜单不出现「重命名」项', async () => {
    renderBrowser({ sessions: [item('s5')], rowMenu: { onPin: vi.fn() } });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s5/ }));
    const menu = await screen.findByTestId('session-row-menu');
    expect(menu.querySelector('[data-menu-action="rename"]')).toBeNull();
    expect(menu.querySelector('[data-menu-action="pin"]')).not.toBeNull();
  });
});

describe('行 ⋯ 按钮（P0-2/Z-10 第二入口；与右键同源 rowMenuEntries）', () => {
  /** U2 批D（D4 / Z-48）：⋯ 改为按交互态 mount —— 悬浮行（li）触发 hover */
  const hoverRow = (id: string): HTMLElement => {
    const row = document.querySelector(`[data-session-id="${id}"]`)?.closest('li') as HTMLElement;
    fireEvent.mouseOver(row);
    return row;
  };

  it('有动作时 hover 区出现 ⋯（aria-label=更多操作）；点击弹下拉含同一动作集', async () => {
    renderBrowser({ sessions: [item('m1')], rowMenu: fullMenuFor('m1') });
    // 未交互不 mount（Z-48：JS mount 取代 CSS opacity）
    expect(screen.queryByTestId('session-row-more-m1')).toBeNull();
    hoverRow('m1');
    const more = screen.getByTestId('session-row-more-m1');
    expect(more.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.rowMore);
    // jsdom 无 PointerEvent：Radix DropdownMenu 用 Enter 键打开（side-pane 启动器同款模式）
    fireEvent.keyDown(more, { key: 'Enter' });
    const menu = await screen.findByTestId('session-row-more-menu');
    expect(
      Array.from(menu.querySelectorAll('[data-menu-action]')).map((el) => el.getAttribute('data-menu-action')),
    ).toEqual(['pin', 'rename', 'archive', 'split', 'trajectory']);
  });

  it('无任何动作回调 = 不画 ⋯（与右键同口径，不摆空按钮）', () => {
    renderBrowser({ sessions: [item('m2')], rowMenu: {} });
    hoverRow('m2');
    expect(screen.queryByTestId('session-row-more-m2')).toBeNull();
  });

  it('分屏满格：⋯ 菜单里 split 项同右键一样禁用（同源逻辑）', async () => {
    renderBrowser({
      sessions: [item('m3')],
      rowMenu: { onPin: vi.fn(), onOpenInSplit: vi.fn(), splitLimitReached: true },
    });
    hoverRow('m3');
    fireEvent.keyDown(screen.getByTestId('session-row-more-m3'), { key: 'Enter' });
    const menu = await screen.findByTestId('session-row-more-menu');
    const split = menu.querySelector('[data-menu-action="split"]')!;
    expect(split.getAttribute('data-disabled')).not.toBeNull();
    expect(split.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.menuSplitLimit);
  });

  it('菜单打开时指针移开不卸载（Z-48 menuOpen 旗标：portal 下拉不被 mouseleave 拔掉）', async () => {
    renderBrowser({ sessions: [item('m4')], rowMenu: fullMenuFor('m4') });
    hoverRow('m4');
    fireEvent.keyDown(screen.getByTestId('session-row-more-m4'), { key: 'Enter' });
    await screen.findByTestId('session-row-more-menu');
    // 指针移出行（模拟移进 portal 菜单）：菜单仍在（mouseleave 只收 hovered，不收 menuOpen）
    const row = document.querySelector('[data-session-id="m4"]')?.closest('li') as HTMLElement;
    fireEvent.mouseLeave(row);
    expect(screen.getByTestId('session-row-more-menu')).toBeTruthy();
  });
});
