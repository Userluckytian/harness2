// Z2-02（Z-07 分区 2 / Z-16 #2）：左栏「搜索」入口（原「命令中心」，行为仍开命令面板）。
//  - 有回调才渲染（无回调不摆假入口，硬约束）；
//  - 搜索图标 + 快捷键提示（Ctrl+K，与 App 现有唤出链路一致）；
//  - 分区顺序：New Task 之后、会话区域之前（Z-07 分区 1 → 2 → 会话区域）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '@harness2/ui-shared/renderer/sidebar/labels.js';
import { renderSidebar, sessionItem } from './harness.js';

afterEach(() => {
  cleanup();
});

describe('Z-16 #2：搜索入口（行为 = 命令面板）', () => {
  it('无 onOpenCommandPalette 时不渲染该入口（不摆假入口）', () => {
    renderSidebar();
    expect(screen.queryByTestId('sidebar-command-center')).toBeNull();
  });

  it('有回调时渲染按钮：含搜索图标与 Ctrl+K 快捷键提示', () => {
    renderSidebar({ onOpenCommandPalette: () => {} });
    const button = screen.getByTestId('sidebar-command-center');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain('搜索');
    expect(button.textContent).not.toContain('命令中心');
    expect(button.textContent).toContain('Ctrl+K');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.commandCenterLabel);
  });

  it('点击调用回调（真实可用，不是空壳）', () => {
    const open = vi.fn();
    renderSidebar({ onOpenCommandPalette: open });
    fireEvent.click(screen.getByTestId('sidebar-command-center'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('快捷键提示可覆盖（缺省 Ctrl+K）', () => {
    renderSidebar({ onOpenCommandPalette: () => {}, commandPaletteHint: '⌘K' });
    expect(screen.getByTestId('sidebar-command-center').textContent).toContain('⌘K');
  });

  it('分区顺序：New Task → 搜索 → 会话区域（DOM 先后）', () => {
    renderSidebar({ onOpenCommandPalette: () => {}, sessions: [sessionItem('a')] });
    const root = screen.getByTestId('sidebar-root');
    const order = [
      screen.getByTestId('sidebar-new-session'),
      screen.getByTestId('sidebar-command-center'),
      screen.getByTestId('sidebar-region-area'),
    ];
    // compareDocumentPosition: 后者相对前者为 FOLLOWING
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.contains(order[2]!)).toBe(true);
  });
});
