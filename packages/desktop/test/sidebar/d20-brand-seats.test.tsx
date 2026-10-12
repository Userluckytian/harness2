// Z-16 #0：aside 品牌行（含品牌席位与侧栏内折叠钮）整体移除——
// 品牌与折叠入口的唯一真源在左上浮层 FrameTopOverlay（见 layout 测试），入口不丢。
// 本文件钉住「品牌行不在侧栏 DOM」这一预期差异（原 D-20 品牌席位用例随功能一并移除）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderSidebar } from './harness.js';

afterEach(() => {
  cleanup();
});

describe('Z-16 #0 aside 无品牌行', () => {
  it('展开态：没有品牌行 / 品牌席位 / 侧栏内折叠钮', () => {
    renderSidebar();
    expect(screen.queryByTestId('sidebar-brand')).toBeNull();
    expect(screen.queryByTestId('sidebar-brand-mark')).toBeNull();
    expect(screen.queryByTestId('sidebar-brand-name')).toBeNull();
    expect(document.querySelector('.h2-sidebar-brand-row')).toBeNull();
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull();
  });

  it('折叠态（Z-06）：内容仍只隐藏不卸载，也没有品牌行', () => {
    renderSidebar({ collapsed: true });
    expect(screen.getByTestId('sidebar-root').classList.contains('opacity-0')).toBe(true);
    expect(screen.getByTestId('sidebar-root').classList.contains('pointer-events-none')).toBe(true);
    expect(screen.queryByTestId('sidebar-brand')).toBeNull();
    expect(screen.queryByTestId('sidebar-region-rail')).toBeNull();
  });

  it('Z-16 槽位序列：aside 第一槽 = 新建任务 →（搜索）→（自动化）→（插件市场）→ 会话区域', () => {
    renderSidebar({ onOpenCommandPalette: () => undefined, onOpenAutomations: () => undefined, placeholders: true });
    const order = [
      screen.getByTestId('sidebar-new-session'),
      screen.getByTestId('sidebar-command-center'),
      screen.getByTestId('sidebar-automation-entry'),
      screen.getByTestId('sidebar-plugin-market-placeholder'),
      screen.getByTestId('sidebar-region-area'),
    ];
    for (let i = 0; i + 1 < order.length; i += 1) {
      expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('Z-16 #3 桌面口径：传真回调 = 真入口（enabled、无 data-placeholder 旗标）', () => {
    renderSidebar({ onOpenAutomations: () => undefined });
    const entry = screen.getByTestId('sidebar-automation-entry') as HTMLButtonElement;
    expect(entry.disabled).toBe(false);
    expect(entry.hasAttribute('data-placeholder')).toBe(false);
  });

  it('Z-16 反向钉：不给 placeholders → 自动化/插件市场/账号槽一律不画（宿主不被强加占位）', () => {
    renderSidebar();
    expect(screen.queryByTestId('sidebar-automation-entry')).toBeNull();
    expect(screen.queryByTestId('sidebar-plugin-market-placeholder')).toBeNull();
    expect(screen.queryByTestId('sidebar-account-slot')).toBeNull();
  });
});
