// Z-06 折叠形态（含 D-16 降动效降级）：
//   折叠后只剩 4px，内容 opacity-0 + pointer-events-none（只隐藏不卸载、**无图标轨道**）；
//   展开内容始终按展开宽度排版（折叠时被 4px 容器裁切），避免收起途中重排；
//   prefers-reduced-motion 时由 CSS 兜底关闭过渡。
// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLAPSE_TRANSITION_MS, sidebarStateClasses } from '@harness2/ui-shared/renderer/sidebar/collapse.js';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '@harness2/ui-shared/renderer/sidebar/geometry.js';
import { renderCollapsibleSidebar, renderSidebar, stubMatchMedia, type MediaQueryStub } from './harness.js';

let media: MediaQueryStub | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  media?.restore();
  media = undefined;
});

/** 当前根节点 */
const root = (): HTMLElement => screen.getByTestId('sidebar-root');

describe('Z-06 折叠纯函数', () => {
  it('COLLAPSE_TRANSITION_MS：Z-08 侧栏 width/opacity 200ms', () => {
    expect(COLLAPSE_TRANSITION_MS).toBe(200);
  });

  it('sidebarStateClasses：静默 / 降动效组合成类名（无轨道相位）', () => {
    expect(sidebarStateClasses({ quietBars: false, reducedMotion: false })).toEqual([]);
    expect(sidebarStateClasses({ quietBars: true, reducedMotion: false })).toEqual(['h2-sidebar-quiet']);
    expect(sidebarStateClasses({ quietBars: false, reducedMotion: true })).toEqual(['h2-sidebar-reduced-motion']);
    expect(sidebarStateClasses({ quietBars: true, reducedMotion: true })).toEqual([
      'h2-sidebar-quiet',
      'h2-sidebar-reduced-motion',
    ]);
  });

  it('clampSidebarWidth：Z-05 264～容器 50%，非数回落 264', () => {
    expect(clampSidebarWidth(300, 1400)).toBe(300);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 100, 1400)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, 1400)).toBe(700); // 1400 × 0.5
    expect(clampSidebarWidth(Number.NaN, 1400)).toBe(264);
    expect(clampSidebarWidth(undefined, 1400)).toBe(264);
    // 容器未知：只受下界约束
    expect(clampSidebarWidth(900)).toBe(900);
  });
});

describe('Z-06 折叠 / 展开', () => {
  it('折叠后内容只隐藏不卸载、无轨道；展开内容始终按展开宽度排版（不重排）', () => {
    const view = renderCollapsibleSidebar({ width: 300, sessions: [] });
    expect(view.root().dataset.collapsed).toBe('false');
    expect(view.root().style.width).toBe('300px');
    expect(screen.getByTestId('sidebar-session-list')).toBeDefined();

    view.toggle();
    // 折叠：内容仍在 DOM（只隐藏不卸载），带 opacity-0 + pointer-events-none
    expect(view.root().dataset.collapsed).toBe('true');
    expect(view.root().classList.contains('opacity-0')).toBe(true);
    expect(view.root().classList.contains('pointer-events-none')).toBe(true);
    expect(screen.getByTestId('sidebar-session-list')).toBeDefined();
    // 内容宽度仍是展开宽度（4px 裁切由帧容器负责，内容不重排）
    expect(view.root().style.width).toBe('300px');
    // 没有任何图标轨道
    expect(screen.queryByTestId('sidebar-region-rail')).toBeNull();
    expect(view.root().classList.contains('h2-sidebar-rail')).toBe(false);

    view.toggle();
    expect(view.root().dataset.collapsed).toBe('false');
    expect(view.root().classList.contains('opacity-0')).toBe(false);
    expect(view.root().style.width).toBe('300px');
  });

  it('缺省宽度为 264（Z-05 默认）', () => {
    renderSidebar();
    expect(root().style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
  });

  it('冷启动即折叠态：内容在 DOM 但不可见不可点（无轨道）', () => {
    renderSidebar({ collapsed: true });
    expect(root().dataset.collapsed).toBe('true');
    expect(root().classList.contains('opacity-0')).toBe(true);
    expect(root().classList.contains('pointer-events-none')).toBe(true);
    expect(screen.getByTestId('sidebar-session-list')).toBeDefined();
    expect(screen.queryByTestId('sidebar-region-rail')).toBeNull();
  });
});

describe('Z-06 / D-16 降动效降级', () => {
  it('prefers-reduced-motion 命中时加降动效类名（过渡由 CSS 兜底关闭）', () => {
    media = stubMatchMedia(true);
    renderSidebar();
    expect(root().classList.contains('h2-sidebar-reduced-motion')).toBe(true);
  });

  it('未命中降动效时不加降动效类名', () => {
    media = stubMatchMedia(false);
    renderSidebar();
    expect(root().classList.contains('h2-sidebar-reduced-motion')).toBe(false);
  });

  it('降动效下折叠/展开仍可用（禁用过渡不等于禁用功能）', () => {
    media = stubMatchMedia(true);
    const view = renderCollapsibleSidebar();
    view.toggle();
    expect(view.root().dataset.collapsed).toBe('true');
    view.toggle();
    expect(view.root().dataset.collapsed).toBe('false');
    expect(screen.getByTestId('sidebar-session-list')).toBeDefined();
  });
});

describe('Z-16 #0 折叠入口外置（aside 无折叠钮）', () => {
  it('aside 内没有 sidebar-toggle——折叠/展开唯一入口是左上浮层（宿主 onToggleCollapse 驱动状态）', () => {
    const view = renderCollapsibleSidebar();
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull();
    view.toggle();
    expect(view.root().dataset.collapsed).toBe('true');
    view.toggle();
    expect(view.root().dataset.collapsed).toBe('false');
  });
});
