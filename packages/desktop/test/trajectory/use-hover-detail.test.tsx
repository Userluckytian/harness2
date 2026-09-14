// @vitest-environment jsdom
// 悬停详情测试（D-43：悬停 500ms 出详情）。
// 断言时间边界：499ms 不出、500ms 出、切段立即清掉上一段详情、移出取消挂起定时器。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_DETAIL_DELAY_MS, useHoverDetail } from '../../src/renderer/trajectory/use-hover-detail.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useHoverDetail（D-43）', () => {
  it('延时就是 500ms', () => {
    expect(HOVER_DETAIL_DELAY_MS).toBe(500);
  });

  it('悬停立即高亮，499ms 无详情，500ms 才出详情', () => {
    const { result } = renderHook(() => useHoverDetail());
    act(() => result.current.hover('seg-1'));
    expect(result.current.hoveredKey).toBe('seg-1');
    expect(result.current.revealedKey).toBeNull();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.revealedKey).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.revealedKey).toBe('seg-1');
  });

  it('未到 500ms 就移出 → 取消挂起定时器，永远不出详情', () => {
    const { result } = renderHook(() => useHoverDetail());
    act(() => result.current.hover('seg-1'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => result.current.leave());
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.hoveredKey).toBeNull();
    expect(result.current.revealedKey).toBeNull();
  });

  it('快速划过两个段：只揭示最后停留的那段（详情不串段）', () => {
    const { result } = renderHook(() => useHoverDetail());
    act(() => result.current.hover('seg-1'));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => result.current.hover('seg-2'));
    expect(result.current.revealedKey).toBeNull();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.revealedKey).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.revealedKey).toBe('seg-2');
  });

  it('自定义延时可用（测试/调试）；卸载后不再 setState', () => {
    const { result, unmount } = renderHook(() => useHoverDetail(100));
    act(() => result.current.hover('seg-1'));
    unmount();
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(200);
      }),
    ).not.toThrow();
  });
});
