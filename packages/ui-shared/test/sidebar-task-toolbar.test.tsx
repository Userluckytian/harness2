// @vitest-environment jsdom
// Z8-1 侧栏任务工具栏与会话项渲染（Z-07 #5～#8 / Z-08 / Z-09）：
// 视图模式切换真实改变分组、Pinned 空/非空/超 20 折叠、排序、归档开关、
// 分组/分区折叠、leading 槽优先级、相对时间元信息行。
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import { SessionBrowser, type WorkspacesOwnerProps } from '../src/renderer/sidebar/SessionBrowser.js';
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
      nowMs: NOW,
      ...props,
    }),
  );
}

const idsIn = (testId: string): Array<string | null> =>
  [...document.querySelectorAll(`[data-testid="${testId}"] [data-session-id]`)].map((el) =>
    el.getAttribute('data-session-id'),
  );

describe('Z-08 视图模式分段：切换真实改变分组方式', () => {
  it('默认项目模式（项目区 cwd 归组 + 会话区无 cwd）；切到分组模式合并为单区', () => {
    renderBrowser({
      sessions: [item('a', { cwd: 'D:/p/alpha' }), item('b', { cwd: 'D:/p/beta' }), item('c')],
    });
    expect(screen.getByTestId('sidebar-view-project').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('sidebar-projects')).toBeTruthy();
    expect(screen.getByTestId('sidebar-conversations')).toBeTruthy();
    // 项目区按 cwd 归组（组标题 = 项目名）；无 cwd 的会话只在会话区（不重复）
    expect(idsIn('sidebar-projects')).toEqual(['a', 'b']);
    expect(idsIn('sidebar-conversations')).toEqual(['c']);

    fireEvent.click(screen.getByTestId('sidebar-view-grouped'));
    expect(screen.getByTestId('sidebar-view-grouped').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('sidebar-grouped')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-projects')).toBeNull();
    expect(screen.queryByTestId('sidebar-conversations')).toBeNull();
    // 合并后无 cwd 会话归入「无项目」组
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText(DEFAULT_SIDEBAR_LABELS.noProject)).toBeTruthy();
  });
});

describe('Z-07 #6 Pinned 区', () => {
  it('空 → 整区不渲染（红线⑩）', () => {
    renderBrowser({ sessions: [item('a')] });
    expect(screen.queryByTestId('sidebar-pinned')).toBeNull();
  });

  it('有置顶 → 显示，且「取消置顶」回调带 (id, false)（U2 批D / D4：✕ 交互态才 mount）', () => {
    const calls: Array<[string, boolean]> = [];
    renderBrowser({ sessions: [item('a', { pinned: true })], onTogglePin: (id, pinned) => calls.push([id, pinned]) });
    expect(screen.getByTestId('sidebar-pinned')).toBeTruthy();
    // 未 hover：✕ 不 mount（JS 挂载取代 CSS opacity）
    expect(screen.queryByTestId('session-unpin-a')).toBeNull();
    const row = document.querySelector('[data-session-id="a"]')?.closest('li') as HTMLElement;
    fireEvent.mouseOver(row);
    fireEvent.click(screen.getByTestId('session-unpin-a'));
    expect(calls).toEqual([['a', false]]);
  });

  it('超 20 条折叠为「显示全部」，点击后全部可见', () => {
    const pinned = Array.from({ length: 25 }, (_, i) => item(`p${i}`, { pinned: true }));
    renderBrowser({ sessions: pinned, onTogglePin: () => undefined });
    expect(idsIn('sidebar-pinned').length).toBe(20);
    fireEvent.click(screen.getByTestId('sidebar-pinned-show-all'));
    expect(idsIn('sidebar-pinned').length).toBe(25);
  });
});

describe('Z-08 排序与筛选（工具栏）', () => {
  it('默认按更新时间降序；切到名称后按标题升序', () => {
    renderBrowser({
      sessions: [item('a', { title: 'zzz', mtimeMs: NOW - 1000 }), item('b', { title: 'aaa', mtimeMs: NOW - 5000 })],
    });
    expect(idsIn('sidebar-conversations')).toEqual(['a', 'b']);
    fireEvent.click(screen.getByTestId('sidebar-filter-sort'));
    fireEvent.click(screen.getByTestId('sidebar-sort-name'));
    expect(idsIn('sidebar-conversations')).toEqual(['b', 'a']);
  });

  it('筛选：只看运行中', () => {
    renderBrowser({ sessions: [item('a', { running: true }), item('b')] });
    fireEvent.click(screen.getByTestId('sidebar-filter-sort'));
    fireEvent.click(screen.getByTestId('sidebar-filter-running'));
    expect(idsIn('sidebar-conversations')).toEqual(['a']);
  });
});

describe('Z-08 归档开关（默认关闭、不持久化）', () => {
  it('默认不显示归档行；开启后列出', () => {
    renderBrowser({
      sessions: [item('a')],
      archived: [item('z', { title: '老会话', archived: true })],
    });
    expect(screen.queryByText('老会话')).toBeNull();
    fireEvent.click(screen.getByTestId('sidebar-archived-toggle'));
    expect(screen.getByText('老会话')).toBeTruthy();
  });
});

describe('Z-07 #7/#8 分区与分组折叠（默认展开）', () => {
  it('分组头可折叠（默认展开）', () => {
    renderBrowser({ sessions: [item('a', { cwd: 'D:/p/alpha' })] });
    expect(idsIn('sidebar-projects')).toEqual(['a']);
    fireEvent.click(screen.getByTestId('sidebar-group-head'));
    expect(idsIn('sidebar-projects')).toEqual([]);
    fireEvent.click(screen.getByTestId('sidebar-group-head'));
    expect(idsIn('sidebar-projects')).toEqual(['a']);
  });

  it('「全部展开/收起」切换所有分组', () => {
    renderBrowser({
      sessions: [item('a', { cwd: 'D:/p/alpha' }), item('b', { cwd: 'D:/p/beta' })],
    });
    const expandToggle = screen.getByTestId('sidebar-expand-toggle');
    expect(expandToggle.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.collapseAll);
    fireEvent.click(expandToggle);
    expect(idsIn('sidebar-projects')).toEqual([]);
    expect(expandToggle.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.expandAll);
    fireEvent.click(expandToggle);
    expect(idsIn('sidebar-projects')).toEqual(['a', 'b']);
  });

  it('分区标题可折叠会话区', () => {
    renderBrowser({ sessions: [item('a')] });
    expect(idsIn('sidebar-conversations')).toEqual(['a']);
    fireEvent.click(
      screen.getByTestId('sidebar-conversations').querySelector('[data-testid="sidebar-section-head"]') as HTMLElement,
    );
    expect(idsIn('sidebar-conversations')).toEqual([]);
  });
});

describe('Z-09 会话项 leading 槽与元信息行', () => {
  it('leading 槽优先级：unread > running > pinned', () => {
    renderBrowser({
      sessions: [item('a', { running: true }), item('b', { pinned: true }), item('c', { running: true, unread: 4 })],
    });
    const leading = (id: string): string | null =>
      document.querySelector(`[data-session-id="${id}"] [data-testid="session-leading"]`)?.getAttribute('data-kind') ??
      null;
    expect(leading('a')).toBe('running');
    expect(leading('b')).toBe('pinned');
    expect(leading('c')).toBe('unread');
  });

  it('元信息行 = 仅相对时间（ZCode 1:1 单行；行内不再出现条数）', () => {
    renderBrowser({ sessions: [item('a', { messageCount: 7, mtimeMs: NOW - 16 * 3_600_000 })] });
    const meta = document.querySelector('[data-session-id="a"] .h2-sidebar-session-meta');
    expect(meta?.textContent).toBe('16小时');
    // 反向钉：条数（「N 条」）不进行内
    expect(document.querySelector('[data-session-id="a"]')?.textContent ?? '').not.toContain('条');
  });
});
