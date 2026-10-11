// @vitest-environment jsdom
// 审批 attention 徽标（Z2-09b / 场景④「左栏对应任务行显示 attention 徽标」）：
// 行数据映射（pendingApprovals）+ 行渲染（无审批不渲染，>0 显示计数）。
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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

const source = (id: string, firstUserText: string, mtimeMs: number) => ({
  id,
  firstUserText,
  mtimeMs,
  messageCount: 2,
});

describe('侧栏行数据映射（pendingApprovals）', () => {
  it('flags 未给 → 0（缺省不渲染徽标）；给了 → 如实带出', () => {
    const { active } = buildSessionItems({
      sessions: [source('a', 'A', 1), source('b', 'B', 2)],
      metadata: {},
      flagsOf: (id) => (id === 'b' ? { pendingApprovals: 2 } : undefined),
    });
    expect(active.map((i) => i.pendingApprovals)).toEqual([0, 2]);
  });
});

describe('会话行 attention 徽标（场景④）', () => {
  it('无审批 → 不渲染徽标；有待审批 → 计数徽标出现（warning 族样式）', () => {
    const { active } = buildSessionItems({
      sessions: [source('a', '会话 A', 1), source('b', '会话 B', 2)],
      metadata: {},
      flagsOf: (id) => (id === 'b' ? { pendingApprovals: 3 } : undefined),
    });
    render(
      createElement(SessionBrowser, {
        ...owner,
        sessions: active,
        selectedId: null,
        labels: DEFAULT_SIDEBAR_LABELS,
        onOpenSession: () => {},
      }),
    );
    // 无审批的行没有徽标（字段没有就不显示）
    const rowA = screen.getByText('会话 A').closest('button');
    expect(rowA?.querySelector('[data-testid="session-attention"]')).toBeNull();
    // 有审批的行：计数徽标 + 警示色族（与未读徽标同族、--warn 着色）
    const rowB = screen.getByText('会话 B').closest('button');
    const badge = rowB?.querySelector('[data-testid="session-attention"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('3');
    expect(badge?.className).toContain('h2-sidebar-attention');
  });
});
