// @vitest-environment jsdom
// 会话行拖拽（Z2-06 / Z-19）向后兼容 + 拖拽钩子：不传 rowDrag 时行为与旧实现完全一致
// （行不可拖）；传 rowDrag 时行可拖并回调会话 id；disabledIds 命中的行禁用拖拽。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import { buildSessionItems } from '../src/renderer/sidebar/session-items.js';
import { SessionBrowser, type WorkspacesOwnerProps } from '../src/renderer/sidebar/SessionBrowser.js';

afterEach(() => cleanup());

const owner: WorkspacesOwnerProps = {
  wide: true,
  expandSidebar: () => undefined,
  registerScrollRegion: () => undefined,
  scrollBars: 'drawn',
};

const items = buildSessionItems({
  sessions: [
    { id: 'a', firstUserText: '会话 A', mtimeMs: 2, messageCount: 1 },
    { id: 'b', firstUserText: '会话 B', mtimeMs: 1, messageCount: 1 },
  ],
  metadata: {},
});

const row = (label: string): HTMLButtonElement => screen.getByText(label).closest('button') as HTMLButtonElement;

describe('会话行拖拽（Z-19）', () => {
  it('缺省不传 rowDrag：行不可拖（web 壳与既有调用点向后兼容）', () => {
    render(
      createElement(SessionBrowser, {
        ...owner,
        sessions: items.active,
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: () => undefined,
      }),
    );
    expect(row('会话 A').hasAttribute('draggable')).toBe(false);
  });

  it('传 rowDrag：行 draggable，拖拽开始回调带上会话 id', () => {
    const started: string[] = [];
    const ended = vi.fn();
    render(
      createElement(SessionBrowser, {
        ...owner,
        sessions: items.active,
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: () => undefined,
        rowDrag: { onDragStart: (id) => started.push(id), onDragEnd: ended },
      }),
    );
    expect(row('会话 A').getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(row('会话 A'));
    expect(started).toEqual(['a']);
    fireEvent.dragEnd(row('会话 A'));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('disabledIds 命中的行禁用拖拽（已在分屏内的会话）', () => {
    render(
      createElement(SessionBrowser, {
        ...owner,
        sessions: items.active,
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: () => undefined,
        rowDrag: { onDragStart: () => undefined, disabledIds: new Set(['b']) },
      }),
    );
    expect(row('会话 A').getAttribute('draggable')).toBe('true');
    expect(row('会话 B').hasAttribute('draggable')).toBe(false);
    expect(row('会话 B').getAttribute('data-drag-disabled')).toBe('true');
  });
});
