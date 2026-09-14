// D-24 滚动条可供性：溢出才画；指针不在栏内即静默，离开后滑块再留 2 秒；
// 滞留窗不因指针在栏外继续移动而重启；显隐不改变布局（预留宽度见 sidebar-styles.test.ts）。
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCROLLBAR_LINGER_MS,
  armsLingerTimer,
  initialAffordanceState,
  isOverflowing,
  reduceScrollAffordance,
  scrollAffordance,
  type ScrollAffordanceEvent,
  type ScrollAffordanceState,
} from '../../src/renderer/sidebar/scroll-affordance.js';
import { renderSidebar, sessionItem, stubColumnRect, stubOverflow } from './harness.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 依序施加事件 */
function drive(
  events: ScrollAffordanceEvent[],
  from: ScrollAffordanceState = initialAffordanceState(),
): ScrollAffordanceState {
  return events.reduce(reduceScrollAffordance, from);
}

const inside: ScrollAffordanceState = { pointerInside: true, lingering: false };
const lingering: ScrollAffordanceState = { pointerInside: false, lingering: true };

describe('D-24 纯函数', () => {
  it('溢出且指针在内（或滞留窗内）才画；未溢出一律静默', () => {
    expect(scrollAffordance({ overflowing: true, pointerInside: true, lingering: false })).toBe('drawn');
    expect(scrollAffordance({ overflowing: true, pointerInside: false, lingering: true })).toBe('drawn');
    expect(scrollAffordance({ overflowing: true, pointerInside: false, lingering: false })).toBe('quiet');
    expect(scrollAffordance({ overflowing: false, pointerInside: true, lingering: true })).toBe('quiet');
  });

  it('进入栏内 → 立刻取消滞留（擦边往返不闪断）', () => {
    expect(drive(['leave'], inside)).toEqual(lingering);
    expect(drive(['enter'], lingering)).toEqual(inside);
    expect(drive(['move-inside'], lingering)).toEqual(inside);
  });

  it('离开 / 移到栏矩形外 → 进入滞留窗', () => {
    expect(drive(['leave'], inside)).toEqual(lingering);
    expect(drive(['move-outside'], inside)).toEqual(lingering);
  });

  it('滞留窗内继续在栏外移动不重启窗口；重复离开是同一状态', () => {
    const first = drive(['leave'], inside);
    expect(drive(['move-outside', 'leave'], first)).toBe(first);
  });

  it('滞留结束 → 静默；不在滞留窗时是空操作', () => {
    expect(drive(['linger-elapsed'], lingering)).toEqual({ pointerInside: false, lingering: false });
    const idle = initialAffordanceState();
    expect(drive(['linger-elapsed'], idle)).toBe(idle);
  });

  it('只有「进入滞留窗」这一次迁移需要启动计时器', () => {
    expect(armsLingerTimer(inside, lingering)).toBe(true);
    expect(armsLingerTimer(inside, inside)).toBe(false);
    expect(armsLingerTimer(lingering, lingering)).toBe(false);
    expect(armsLingerTimer(lingering, { pointerInside: false, lingering: false })).toBe(false);
  });

  it('isOverflowing：严格大于才算溢出；null 视作不溢出', () => {
    expect(isOverflowing({ scrollHeight: 201, clientHeight: 200 })).toBe(true);
    expect(isOverflowing({ scrollHeight: 200, clientHeight: 200 })).toBe(false);
    expect(isOverflowing(null)).toBe(false);
  });
});

describe('D-24 列级可供性', () => {
  const root = (): HTMLElement => screen.getByTestId('sidebar-root');

  it('未溢出：即使指针在栏内也不画滚动条', () => {
    const view = renderSidebar({ sessions: [sessionItem('a')] });
    fireEvent.pointerOver(view.getByTestId('sidebar-root'));
    expect(root().dataset.scrollBars).toBe('quiet');
    expect(root().className).toContain('h2-sidebar-quiet');
  });

  it('溢出 + 指针进入 → 画出；离开后留 2 秒再静默', () => {
    const view = renderSidebar({ sessions: [sessionItem('a')] });
    const list = view.getByTestId('sidebar-session-list');
    stubOverflow(list, true);
    stubColumnRect(view.getByTestId('sidebar-root'));
    fireEvent.pointerOver(root());
    expect(root().dataset.scrollBars).toBe('drawn');
    expect(root().className).not.toContain('h2-sidebar-quiet');

    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(SCROLLBAR_LINGER_MS - 1);
    });
    expect(root().dataset.scrollBars).toBe('drawn');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root().dataset.scrollBars).toBe('quiet');
  });

  it('滞留窗内指针回来 → 取消隐藏（不重启窗口也不算新的一次绘制）', () => {
    const view = renderSidebar({ sessions: [sessionItem('a')] });
    stubOverflow(view.getByTestId('sidebar-session-list'), true);
    stubColumnRect(view.getByTestId('sidebar-root'));
    fireEvent.pointerOver(root());
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    fireEvent.pointerOver(root());
    act(() => {
      vi.advanceTimersByTime(SCROLLBAR_LINGER_MS * 2);
    });
    expect(root().dataset.scrollBars).toBe('drawn');
  });

  it('指针移到栏矩形之外（仍在 DOM 子树内）→ 滞留后静默', () => {
    const view = renderSidebar({ sessions: [sessionItem('a')] });
    stubOverflow(view.getByTestId('sidebar-session-list'), true);
    stubColumnRect(view.getByTestId('sidebar-root'), 280, 600);
    fireEvent.pointerOver(root());
    expect(root().dataset.scrollBars).toBe('drawn');
    fireEvent.pointerMove(document, { clientX: 700, clientY: 300 });
    act(() => {
      vi.advanceTimersByTime(SCROLLBAR_LINGER_MS);
    });
    expect(root().dataset.scrollBars).toBe('quiet');
  });

  it('卸载时清掉滞留计时器（不留悬空定时器）', () => {
    const view = renderSidebar({ sessions: [sessionItem('a')] });
    stubOverflow(view.getByTestId('sidebar-session-list'), true);
    fireEvent.pointerOver(root());
    fireEvent.pointerOut(root(), { relatedTarget: document.body });
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('区域席位收到外壳的结论（drawn/quiet）与滚动容器登记口', () => {
    const seen: Array<{ scrollBars: string; wide: boolean; registered: string | null }> = [];
    renderSidebar({
      renderWorkspaces: (owner) => {
        seen.push({
          scrollBars: owner.scrollBars,
          wide: owner.wide,
          registered: owner.registerScrollRegion === undefined ? null : 'fn',
        });
        return <div data-testid="custom-region" />;
      },
    });
    expect(seen).toEqual([{ scrollBars: 'quiet', wide: true, registered: 'fn' }]);
    expect(screen.getByTestId('custom-region')).toBeDefined();
  });
});
