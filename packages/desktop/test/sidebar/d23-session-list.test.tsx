// D-23 区域席位：`sidebar.workspaces`（会话列表）渲染、当前会话高亮、空态；
// 底部固定 `sidebar.settings` 席位。轨道态（D-13）列表让位给图标但不消失。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderSidebar, sessionItem } from './harness.js';

afterEach(() => {
  cleanup();
});

describe('D-23 会话列表席位', () => {
  it('渲染每一行的标题与条数/时间摘要', () => {
    renderSidebar({ sessions: [sessionItem('a'), sessionItem('b', { title: '第二个会话', messageCount: 7 })] });
    const rows = screen.getAllByTestId('sidebar-session-list')[0]?.querySelectorAll('[data-session-id]');
    expect(rows?.length).toBe(2);
    expect(screen.getByText('第二个会话')).toBeDefined();
    expect(screen.getByText(/7 条/)).toBeDefined();
  });

  it('当前会话高亮：data-selected=true 且 aria-current 标注（唯一一行）', () => {
    renderSidebar({ sessions: [sessionItem('a'), sessionItem('b')], selectedId: 'b' });
    const selected = document.querySelectorAll('[data-selected="true"]');
    expect([...selected].map((el) => el.getAttribute('data-session-id'))).toEqual(['b']);
    expect(selected[0]?.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-session-id="a"]')?.getAttribute('aria-current')).toBeNull();
  });

  it('运行中与未读标记只在该行出现（不凭空给每行都画）', () => {
    renderSidebar({
      sessions: [sessionItem('a', { running: true, unread: 3 }), sessionItem('b')],
    });
    expect(screen.getAllByTestId('session-running').length).toBe(1);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('点击行回调会话 id', () => {
    const opened: string[] = [];
    renderSidebar({ sessions: [sessionItem('a'), sessionItem('b')], onOpenSession: (id) => opened.push(id) });
    fireEvent.click(document.querySelector('[data-session-id="b"]') as HTMLElement);
    expect(opened).toEqual(['b']);
  });

  it('空态：一条会话都没有 → 「暂无会话」', () => {
    renderSidebar({ sessions: [] });
    expect(screen.getByTestId('sidebar-empty').textContent).toBe('暂无会话');
  });

  it('空态：有查询无匹配 → 「无匹配会话」', () => {
    renderSidebar({ sessions: [], query: 'zzz', onQueryChange: () => {} });
    expect(screen.getByTestId('sidebar-empty').textContent).toBe('无匹配会话');
  });

  it('空态：主列表为空但存在归档会话 → 如实指向归档区', () => {
    renderSidebar({ sessions: [], archivedSessions: [sessionItem('a', { archived: true })] });
    expect(screen.getByTestId('sidebar-empty').textContent).toBe('会话都在归档区');
  });

  it('归档区默认折叠，展开后列出已归档行', () => {
    renderSidebar({
      sessions: [sessionItem('a')],
      archivedSessions: [sessionItem('z', { title: '老会话', archived: true })],
    });
    const toggle = screen.getByText('已归档（1）');
    expect(screen.queryByText('老会话')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('老会话')).toBeDefined();
    expect(document.querySelector('[data-session-id="z"]')?.getAttribute('data-archived')).toBe('true');
  });

  it('搜索框受控：输入把查询串交回装配层', () => {
    const queries: string[] = [];
    renderSidebar({ sessions: [sessionItem('a')], query: '', onQueryChange: (q) => queries.push(q) });
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'abc' } });
    expect(queries).toEqual(['abc']);
  });
});

describe('D-23 底部设置席位', () => {
  it('没有占用方时不渲染假入口', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-foot').textContent).toBe('');
  });

  it('占用方按宽窄态渲染（轨道态收到 wide=false）', () => {
    const wides: boolean[] = [];
    const seat = ({ wide }: { wide: boolean }): React.ReactNode => {
      wides.push(wide);
      return <button type="button">设置</button>;
    };
    renderSidebar({ collapsed: true, renderSettings: seat });
    cleanup();
    renderSidebar({ renderSettings: seat });
    expect(wides).toEqual([false, true]);
  });

  it('设置席位在会话列表滚动区之外（列表滚动不顶走设置）', () => {
    renderSidebar({ sessions: [sessionItem('a')], renderSettings: () => <button type="button">设置</button> });
    const foot = screen.getByTestId('sidebar-foot');
    expect(screen.getByTestId('sidebar-session-list').contains(foot)).toBe(false);
  });
});
