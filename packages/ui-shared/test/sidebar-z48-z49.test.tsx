// @vitest-environment jsdom
// Z-48/Z-49 侧栏操作面：
//   a) 显式项目组头 hover/focus 才 mount「在此项目新建会话」，点击带项目 cwd（真动作透传）；
//   b) 行菜单「删除」（壳给 onDeleteSession 才出现；恒最后 + 前置分隔）→ 确认框（Z-49 文案族）
//      → 确认后回调真删除；取消不删；
//   c) running 会话行的「删除」项禁用（title 说明，点击不回调）；
//   d) 「移出项目」守卫（U2 批D / D5：入口 = 组头「更多」⋯ 下拉末项「移除」，XIcon，同 Z-49 规格）：
//      组内有 running 会话 → 先弹确认（Z-49 文案「移除运行中的项目？」），确认后才调 onRemoveProject；
//      无 running → 直接移除不弹框。
//   反向钉：不给 onDeleteSession/onNewSessionInProject = 菜单无删除项 / hover 无新建钮（web 行为不变）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import {
  SessionBrowser,
  shouldMountRowActions,
  type WorkspacesOwnerProps,
} from '../src/renderer/sidebar/SessionBrowser.js';
import type { SidebarSessionItem } from '../src/renderer/sidebar/session-items.js';

afterEach(() => cleanup());

const owner: WorkspacesOwnerProps = {
  wide: true,
  expandSidebar: () => undefined,
  registerScrollRegion: () => undefined,
  scrollBars: 'drawn',
};

const NOW = 1_700_000_000_000;
const ALPHA = 'D:/p/alpha';

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

function hoverProjectHead(cwd: string = ALPHA): void {
  const headRow = document.querySelector(`[data-group-key="project:${cwd}"] > .h2-sidebar-group-head-row`);
  if (!headRow) throw new Error(`组头行未找到：project:${cwd}`);
  fireEvent.mouseOver(headRow);
}

/** U2 批D（D5）：「移除」= 组头「更多」⋯ 下拉末项。hover 组头 → ⋯ mount → Enter 开菜单（jsdom 无 PointerEvent，同 session-row-menu 模式）。 */
async function openGroupRemoveMenu(cwd: string = ALPHA): Promise<HTMLElement> {
  hoverProjectHead(cwd);
  const slug = `project-${cwd.replace(/[^A-Za-z0-9]/g, '-')}`;
  const trigger = screen.getByTestId(`sidebar-group-more-${slug}`);
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findByTestId(`sidebar-group-more-menu-${slug}`);
}

async function clickGroupRemove(cwd: string = ALPHA): Promise<void> {
  const menu = await openGroupRemoveMenu(cwd);
  fireEvent.click(menu.querySelector('[data-menu-action="remove-project"]')!);
}

describe('shouldMountRowActions（Z-48 纯判据）', () => {
  it('hover / focusWithin / menuOpen 任一为真才 mount；全假不 mount', () => {
    const base = { hovered: false, focusWithin: false, menuOpen: false };
    expect(shouldMountRowActions(base)).toBe(false);
    expect(shouldMountRowActions({ ...base, hovered: true })).toBe(true);
    expect(shouldMountRowActions({ ...base, focusWithin: true })).toBe(true);
    expect(shouldMountRowActions({ ...base, menuOpen: true })).toBe(true);
  });
});

describe('Z-48 项目组头「在此项目新建会话」', () => {
  it('hover 出现钮（aria-label=在此项目新建会话），点击回调带项目 cwd；未 hover 不 mount', () => {
    const onNewSessionInProject = vi.fn();
    renderBrowser({
      projects: [{ cwd: ALPHA, addedAt: 1 }],
      sessions: [item('a1', { cwd: ALPHA })],
      onNewSessionInProject,
    });
    expect(screen.queryByTestId('sidebar-group-new-session-project-D--p-alpha')).toBeNull();
    hoverProjectHead();
    const btn = screen.getByTestId('sidebar-group-new-session-project-D--p-alpha') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.newSessionInProject);
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onNewSessionInProject).toHaveBeenCalledTimes(1);
    expect(onNewSessionInProject).toHaveBeenCalledWith(ALPHA);
  });

  it('键盘可达：焦点进入组头行（focusWithin）同样 mount 动作钮', () => {
    const onNewSessionInProject = vi.fn();
    renderBrowser({
      projects: [{ cwd: ALPHA, addedAt: 1 }],
      sessions: [item('a1', { cwd: ALPHA })],
      onNewSessionInProject,
    });
    const head = screen.getByTestId('sidebar-group-head');
    fireEvent.focus(head); // React onFocusCapture 冒泡捕获
    expect(screen.getByTestId('sidebar-group-new-session-project-D--p-alpha')).toBeTruthy();
  });

  it('反向钉：不给回调 → hover 也不出现新建钮（不摆无效入口）', () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }], sessions: [item('a1', { cwd: ALPHA })] });
    hoverProjectHead();
    expect(screen.queryByTestId('sidebar-group-new-session-project-D--p-alpha')).toBeNull();
    // U2 批D（D5）：「移除」入口改为 ⋯ 下拉，按回调有无渲染（无回调 = 菜单项 disabled 占位）
    expect(screen.getByTestId('sidebar-group-more-project-D--p-alpha')).toBeTruthy();
  });
});

describe('Z-49 行菜单「删除」+ 确认框', () => {
  it('壳给 onDeleteSession → 菜单最后出现「删除」（前置分隔）；点击弹确认框（Z-49 文案族）', async () => {
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      sessions: [item('s1')],
      rowMenu: { onPin: vi.fn(), onArchive: vi.fn(), onOpenInSplit: vi.fn(), onInspectTrajectory: vi.fn() },
      onDeleteSession,
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s1/ }));
    const menu = await screen.findByTestId('session-row-menu');
    const actions = Array.from(menu.querySelectorAll('[data-menu-action]')).map((el) =>
      el.getAttribute('data-menu-action'),
    );
    expect(actions[actions.length - 1]).toBe('delete');
    fireEvent.click(menu.querySelector('[data-menu-action="delete"]')!);
    // 确认框：标题「删除这个会话？」描述「会话将从列表移除。」destructive 按钮「删除」
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(screen.getByTestId('confirm-dialog-title').textContent).toBe('删除这个会话？');
    expect(screen.getByTestId('confirm-dialog-description').textContent).toBe('会话将从列表移除。');
    const confirm = screen.getByTestId('confirm-dialog-confirm');
    expect(confirm.textContent).toBe('删除');
    expect(dialog.textContent).toContain('删除这个会话？');
    // 未确认前不删
    expect(onDeleteSession).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith('s1'));
    await vi.waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
  });

  it('取消 = 不删除、对话框关闭', async () => {
    const onDeleteSession = vi.fn();
    renderBrowser({ sessions: [item('s2')], rowMenu: {}, onDeleteSession });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s2/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="delete"]')!);
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await vi.waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  // U1 复审 P2：对话框开着时会话转为运行 —— 确认时按 isSessionRunning 复查 live 状态，
  // 命中则只关框不删（行菜单禁用不是最后防线）。
  it('确认时 live running 复查：isSessionRunning=true → 只关框，不触发 onDeleteSession', async () => {
    const onDeleteSession = vi.fn();
    const isSessionRunning = vi.fn((id: string) => id === 'r1');
    renderBrowser({ sessions: [item('r1')], rowMenu: {}, onDeleteSession, isSessionRunning });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 r1/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="delete"]')!);
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await vi.waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(isSessionRunning).toHaveBeenCalledWith('r1');
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  it('反向钉：不给 isSessionRunning → 确认正常删除（web 行为不变）', async () => {
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ sessions: [item('n1')], rowMenu: {}, onDeleteSession });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 n1/ }));
    const menu = await screen.findByTestId('session-row-menu');
    fireEvent.click(menu.querySelector('[data-menu-action="delete"]')!);
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await vi.waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith('n1'));
  });

  it('running 会话：「删除」项禁用（title 说明，点击不触发）', async () => {
    const onDeleteSession = vi.fn();
    renderBrowser({ sessions: [item('run', { running: true })], rowMenu: {}, onDeleteSession });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 run/ }));
    const menu = await screen.findByTestId('session-row-menu');
    const del = menu.querySelector('[data-menu-action="delete"]')!;
    expect(del.getAttribute('data-disabled')).not.toBeNull();
    expect(del.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.menuDeleteRunning);
    fireEvent.click(del);
    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('反向钉：不给 onDeleteSession → 菜单不出现「删除」（web 行为不变）', async () => {
    renderBrowser({ sessions: [item('s3')], rowMenu: { onPin: vi.fn() } });
    fireEvent.contextMenu(screen.getByRole('button', { name: /会话 s3/ }));
    const menu = await screen.findByTestId('session-row-menu');
    expect(menu.querySelector('[data-menu-action="delete"]')).toBeNull();
  });
});

describe('Z-49 「移出项目」运行守卫（U2 批D / D5：入口 = 组头 ⋯ 下拉末项「移除」）', () => {
  it('组内有 running 会话 → 先弹确认（Z-49 文案），确认后才移除', async () => {
    const onRemoveProject = vi.fn();
    renderBrowser({
      projects: [{ cwd: ALPHA, addedAt: 1 }],
      sessions: [item('busy', { cwd: ALPHA, running: true })],
      onRemoveProject,
    });
    await clickGroupRemove();
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(screen.getByTestId('confirm-dialog-title').textContent).toBe('移除运行中的项目？');
    expect(screen.getByTestId('confirm-dialog-description').textContent).toBe('历史任务不会被删除。');
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe('移除并停止运行');
    expect(onRemoveProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onRemoveProject).toHaveBeenCalledWith(ALPHA);
    await vi.waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    void dialog;
  });

  it('组内无 running → 直接移除、不弹确认', async () => {
    const onRemoveProject = vi.fn();
    renderBrowser({
      projects: [{ cwd: ALPHA, addedAt: 1 }],
      sessions: [item('idle', { cwd: ALPHA })],
      onRemoveProject,
    });
    await clickGroupRemove();
    expect(onRemoveProject).toHaveBeenCalledWith(ALPHA);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('空项目组（无会话）→ 直接移除（无 running 可言）', async () => {
    const onRemoveProject = vi.fn();
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }], onRemoveProject });
    await clickGroupRemove();
    expect(onRemoveProject).toHaveBeenCalledWith(ALPHA);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('无 onRemoveProject 通道 → ⋯ 菜单里「移除」项 disabled + 说明（红线⑩，不摆可点即坏）', async () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    const menu = await openGroupRemoveMenu();
    const remove = menu.querySelector('[data-menu-action="remove-project"]')!;
    expect(remove.getAttribute('data-disabled')).not.toBeNull();
    expect(remove.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.removeProjectTodo);
  });
});
