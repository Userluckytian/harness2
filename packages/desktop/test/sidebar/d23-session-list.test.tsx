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
  it('渲染每一行的标题与相对时间摘要（行内不显示条数）', () => {
    renderSidebar({ sessions: [sessionItem('a'), sessionItem('b', { title: '第二个会话', messageCount: 7 })] });
    const rows = screen.getAllByTestId('sidebar-session-list')[0]?.querySelectorAll('[data-session-id]');
    expect(rows?.length).toBe(2);
    expect(screen.getByText('第二个会话')).toBeDefined();
    // ZCode 1:1：行内元信息只有相对时间；反向钉「N 条」不进行内
    const rowB = document.querySelector('[data-session-id="b"]');
    expect(rowB?.querySelector('.h2-sidebar-session-meta')?.textContent ?? '').not.toBe('');
    expect(rowB?.textContent ?? '').not.toContain('条');
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
      sessions: [sessionItem('a', { running: true }), sessionItem('b', { unread: 3 })],
    });
    expect(screen.getAllByTestId('session-running').length).toBe(1);
    expect(document.querySelector('.h2-sidebar-unread')?.textContent).toBe('3');
  });

  it('Z-09 leading 槽优先级：unread > running（同一行只画未读徽标，不叠 spinner）', () => {
    renderSidebar({ sessions: [sessionItem('c', { running: true, unread: 5 })] });
    expect(screen.queryAllByTestId('session-running').length).toBe(0);
    expect(document.querySelector('.h2-sidebar-unread')?.textContent).toBe('5');
    expect(document.querySelector('[data-testid="session-leading"]')?.getAttribute('data-kind')).toBe('unread');
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

  it('归档开关默认关闭（归档行不出现），开启后列出已归档行', () => {
    renderSidebar({
      sessions: [sessionItem('a')],
      archivedSessions: [sessionItem('z', { title: '老会话', archived: true })],
    });
    expect(screen.queryByText('老会话')).toBeNull();
    fireEvent.click(screen.getByTestId('sidebar-archived-toggle'));
    expect(screen.getByText('老会话')).toBeDefined();
    expect(document.querySelector('[data-session-id="z"]')?.getAttribute('data-archived')).toBe('true');
  });

  it('搜索框受控：输入把查询串交回装配层', () => {
    const queries: string[] = [];
    renderSidebar({ sessions: [sessionItem('a')], query: '', onQueryChange: (q) => queries.push(q) });
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'abc' } });
    expect(queries).toEqual(['abc']);
  });

  it('Z-07 #1：壳传入 newSessionShortcut 才画 New Task 快捷键标注（缺省不画假提示）', () => {
    renderSidebar({ newSessionShortcut: 'Ctrl+N' });
    expect(document.querySelector('.h2-sidebar-new-hint')?.textContent).toBe('Ctrl+N');
    cleanup();
    renderSidebar({});
    expect(document.querySelector('.h2-sidebar-new-hint')).toBeNull();
  });
});

describe('D-23 底部设置席位', () => {
  it('没有占用方时不渲染假入口', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-foot').textContent).toBe('');
  });

  it('占用方按展开形态渲染（Z-06：折叠态内容只隐藏不卸载，wide 恒为 true）', () => {
    const wides: boolean[] = [];
    const seat = ({ wide }: { wide: boolean }): React.ReactNode => {
      wides.push(wide);
      return <button type="button">设置</button>;
    };
    renderSidebar({ collapsed: true, renderSettings: seat });
    cleanup();
    renderSidebar({ renderSettings: seat });
    expect(wides).toEqual([true, true]);
  });

  it('设置席位在会话列表滚动区之外（列表滚动不顶走设置）', () => {
    renderSidebar({ sessions: [sessionItem('a')], renderSettings: () => <button type="button">设置</button> });
    const foot = screen.getByTestId('sidebar-foot');
    expect(screen.getByTestId('sidebar-session-list').contains(foot)).toBe(false);
  });
});
