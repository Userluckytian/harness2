// 会话列表（D-20～D-24 的渲染与数据投影）：共享包里的会话列表是 desktop / web 同一份实现，
// 因此把「标题回落 / 归档过滤 / 高亮 / 空态 / 轨道态」钉在这里。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import { buildSessionItems, UNTITLED_SESSION_LABEL } from '../src/renderer/sidebar/session-items.js';
import { SessionBrowser, type WorkspacesOwnerProps } from '../src/renderer/sidebar/SessionBrowser.js';

afterEach(() => cleanup());

const owner: WorkspacesOwnerProps = {
  wide: true,
  expandSidebar: () => undefined,
  registerScrollRegion: () => undefined,
  scrollBars: 'drawn',
};

const source = (id: string, firstUserText: string, mtimeMs: number) => ({
  id,
  firstUserText,
  mtimeMs,
  messageCount: 2,
});

describe('会话列表条目投影', () => {
  it('标题：覆层 title 优先 → firstUserText → 空会话占位（不编造标题）', () => {
    const { active } = buildSessionItems({
      sessions: [source('a', '原始首问', 1), source('b', '', 2)],
      metadata: { a: { title: '改过的标题' } },
    });
    expect(active.map((i) => i.title)).toEqual(['改过的标题', UNTITLED_SESSION_LABEL]);
  });

  it('归档折叠进独立区、删除两处都不出现（覆层是唯一口径）', () => {
    const { active, archived } = buildSessionItems({
      sessions: [source('a', 'A', 1), source('b', 'B', 2), source('c', 'C', 3)],
      metadata: { b: { archived: true }, c: { deleted: true } },
    });
    expect(active.map((i) => i.id)).toEqual(['a']);
    expect(archived.map((i) => i.id)).toEqual(['b']);
  });

  it('搜索串命中标题（列表过滤与展示同口径）', () => {
    const { active } = buildSessionItems({
      sessions: [source('a', '会话 A', 1), source('b', '会话 B', 2)],
      metadata: {},
      query: '会话 B',
    });
    expect(active.map((i) => i.id)).toEqual(['b']);
  });
});

describe('会话浏览器（D-23/D-13）', () => {
  const items = buildSessionItems({ sessions: [source('a', '会话 A', 1), source('b', '会话 B', 2)], metadata: {} });

  it('宽态渲染列表并高亮当前会话；点击回调带上会话 id', () => {
    const opened: string[] = [];
    render(
      createElement(SessionBrowser, {
        ...owner,
        sessions: items.active,
        selectedId: 'b',
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: (id) => opened.push(id),
      }),
    );
    expect(screen.getByText('会话 A')).toBeTruthy();
    fireEvent.click(screen.getByText('会话 A'));
    expect(opened).toEqual(['a']);
  });

  it('轨道态（56px）不渲染列表，只给「展开以浏览会话」入口（D-13 轨道不是消失）', () => {
    let expanded = 0;
    render(
      createElement(SessionBrowser, {
        ...owner,
        wide: false,
        expandSidebar: () => {
          expanded += 1;
        },
        sessions: items.active,
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: () => undefined,
      }),
    );
    expect(screen.queryByText('会话 A')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(expanded).toBe(1);
  });

  it('空列表如实显示空态（不摆假会话行）', () => {
    render(
      createElement(SessionBrowser, {
        ...owner,
        sessions: [],
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: () => undefined,
      }),
    );
    expect(screen.queryByText('会话 A')).toBeNull();
    expect(screen.getByTestId('sidebar-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noSessions);
  });
});
