// D-22 收起动画（含 D-16 降动效降级）：
//   淘出（冻结展开宽度淡出）→ 淘入（向左位移进 56px 轨道）；
//   prefers-reduced-motion 时两段过渡禁用、即时落定；
//   冷启动即收起态静态渲染轨道（不播动画）。
// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSE_SETTLE_MS,
  collapsePhase,
  playsRailIn,
  settleDelayMs,
  sidebarStateClasses,
} from '../../src/renderer/sidebar/collapse.js';
import {
  RAIL_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '../../src/renderer/sidebar/geometry.js';
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

describe('D-22 相位纯函数', () => {
  it('collapsePhase：展开 / 淡出中 / 轨道', () => {
    expect(collapsePhase({ collapsed: false, settled: false })).toBe('expanded');
    expect(collapsePhase({ collapsed: true, settled: false })).toBe('collapsing');
    expect(collapsePhase({ collapsed: true, settled: true })).toBe('rail');
  });

  it('settleDelayMs：常规 150ms；降动效 0ms（不排队等看不见的过渡）', () => {
    expect(settleDelayMs(false)).toBe(COLLAPSE_SETTLE_MS);
    expect(settleDelayMs(true)).toBe(0);
  });

  it('playsRailIn：只有实时收起（曾展开过）才播淘入', () => {
    expect(playsRailIn('rail', true)).toBe(true);
    expect(playsRailIn('rail', false)).toBe(false);
    expect(playsRailIn('expanded', true)).toBe(false);
  });

  it('sidebarStateClasses：相位/淘入/静默/降动效组合成类名', () => {
    expect(sidebarStateClasses({ phase: 'expanded', railIn: false, quietBars: false, reducedMotion: false })).toEqual(
      [],
    );
    expect(sidebarStateClasses({ phase: 'collapsing', railIn: false, quietBars: false, reducedMotion: false })).toEqual(
      ['h2-sidebar-fading'],
    );
    expect(sidebarStateClasses({ phase: 'rail', railIn: true, quietBars: true, reducedMotion: true })).toEqual([
      'h2-sidebar-rail',
      'h2-sidebar-rail-in',
      'h2-sidebar-quiet',
      'h2-sidebar-reduced-motion',
    ]);
  });

  it('clampSidebarWidth：D-11 264～420，非数回落 280', () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 100)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(280);
    expect(clampSidebarWidth(undefined)).toBe(280);
  });
});

describe('D-22 实时收起 / 展开', () => {
  it('收起过程冻结展开宽度淡出，落定后切 56px 轨道并淘入', () => {
    const view = renderCollapsibleSidebar({ width: 300 });
    expect(view.root().dataset.phase).toBe('expanded');
    expect(view.root().style.width).toBe('300px');
    expect(screen.getByTestId('sidebar-session-list')).toBeDefined();

    view.toggle();
    // 淡出期：相位 collapsing，宽度仍是冻结的展开宽度（滑动途中不重排），内容尚未卸载
    expect(view.root().dataset.phase).toBe('collapsing');
    expect(view.root().className).toContain('h2-sidebar-fading');
    expect(view.root().className).not.toContain('h2-sidebar-rail-in');
    expect(view.root().style.width).toBe('300px');
    expect(screen.queryByTestId('sidebar-session-list')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(COLLAPSE_SETTLE_MS - 1);
    });
    expect(view.root().dataset.phase).toBe('collapsing');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // 落定：轨道布局 + 淘入 + 56px；展开内容卸载
    expect(view.root().dataset.phase).toBe('rail');
    expect(view.root().className).toContain('h2-sidebar-rail');
    expect(view.root().className).toContain('h2-sidebar-rail-in');
    expect(view.root().style.width).toBe(`${RAIL_WIDTH}px`);
    expect(screen.queryByTestId('sidebar-session-list')).toBeNull();

    view.toggle();
    expect(view.root().dataset.phase).toBe('expanded');
    expect(view.root().className).not.toContain('h2-sidebar-rail');
    expect(view.root().style.width).toBe('300px');
  });

  it('宽度越界按 D-11 钳制（420 上限 / 264 下限）', () => {
    const wide = renderSidebar({ width: 900 });
    expect(wide.getByTestId('sidebar-root').style.width).toBe(`${SIDEBAR_MAX_WIDTH}px`);
    cleanup();
    const narrow = renderSidebar({ width: 100 });
    expect(narrow.getByTestId('sidebar-root').style.width).toBe(`${SIDEBAR_MIN_WIDTH}px`);
  });

  it('冷启动即收起态：静态渲染轨道，不播淘入动画', () => {
    renderSidebar({ collapsed: true });
    expect(root().dataset.phase).toBe('rail');
    expect(root().className).toContain('h2-sidebar-rail');
    expect(root().className).not.toContain('h2-sidebar-rail-in');
  });

  it('收起落定后宽度回到 56px，再展开恢复最后一次展开宽度', () => {
    const view = renderCollapsibleSidebar({ width: 360 });
    view.toggle();
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_SETTLE_MS);
    });
    expect(view.root().style.width).toBe(`${RAIL_WIDTH}px`);
    view.toggle();
    expect(view.root().style.width).toBe('360px');
  });
});

describe('D-22 / D-16 降动效降级', () => {
  it('prefers-reduced-motion 命中时收起即时落定：不出现淡出相位，直接 56px 轨道', () => {
    media = stubMatchMedia(true);
    const view = renderCollapsibleSidebar();
    expect(view.root().className).toContain('h2-sidebar-reduced-motion');

    view.toggle();
    // 没有任何计时等待：同一批渲染里相位已落到轨道
    expect(view.root().dataset.phase).toBe('rail');
    expect(view.root().className).not.toContain('h2-sidebar-fading');
    expect(view.root().style.width).toBe(`${RAIL_WIDTH}px`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('未命中降动效时不会加降动效类名，收起仍走 150ms 两段过渡', () => {
    media = stubMatchMedia(false);
    const view = renderCollapsibleSidebar();
    expect(view.root().className).not.toContain('h2-sidebar-reduced-motion');
    view.toggle();
    expect(view.root().dataset.phase).toBe('collapsing');
  });

  it('降动效下轨道控件仍可展开（禁用过渡不等于禁用功能）', () => {
    media = stubMatchMedia(true);
    const view = renderCollapsibleSidebar();
    view.toggle();
    expect(view.root().dataset.phase).toBe('rail');
    view.toggle();
    expect(view.root().dataset.phase).toBe('expanded');
    expect(screen.queryByTestId('sidebar-session-list')).not.toBeNull();
  });
});

describe('D-22 轨道切换按钮语义', () => {
  it('展开态 aria-label 是「收起侧边栏」，轨道态是「打开侧边栏」', () => {
    const view = renderCollapsibleSidebar();
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('收起侧边栏');
    view.toggle();
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_SETTLE_MS);
    });
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('打开侧边栏');
  });

  it('轨道态区域图标也可展开（不依赖悬停或快捷键）', () => {
    const view = renderCollapsibleSidebar({ collapsed: true });
    expect(view.root().dataset.phase).toBe('rail');
    view.clickRailRegion();
    expect(view.root().dataset.phase).toBe('expanded');
    expect(screen.queryByTestId('sidebar-session-list')).not.toBeNull();
  });
});
