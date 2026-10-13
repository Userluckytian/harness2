// EmptyState（Z10-1 / ZCode ConversationDraftEmptyState 复刻）：
//   * 6 档时间问候（**逐字** ZCode i18n；时钟注入 now 分档）；
//   * 字号自适应（上限 30 / 下限 20，按可用宽等比缩小）；
//   * 到点自动换档（下一分档边界 setTimeout 刷新，卸载清 timer）；
//   * Logo mark（本仓中性占位；装饰性 aria-hidden）；
//   * 4 建议 chip（文案逐字；点击回传文案，由壳预填 composer —— 非直接发送）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ConversationEmptyState,
  ConversationLogoMark,
  ConversationSuggestionChips,
  EMPTY_STATE_SUGGESTIONS,
  GREETING_MAX_FONT_SIZE_PX,
  GREETING_MIN_FONT_SIZE_PX,
  GREETING_TEXTS,
  getNextGreetingDelayMs,
  greetingKeyForHour,
  resolveGreetingFontSizePx,
  timeGreetingForHour,
} from '../src/renderer/conversation/EmptyState.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('timeGreetingForHour / greetingKeyForHour（ZCode 六档逐字）', () => {
  it('六档文案逐字取自 ZCode i18n（边界 5/9/12/14/18/23 归属后一段）', () => {
    expect(timeGreetingForHour(6)).toBe('早上好呀，新的一天开始啦');
    expect(timeGreetingForHour(10)).toBe('上午好呀，有什么想让我帮忙的吗');
    expect(timeGreetingForHour(13)).toBe('中午好呀，要不要先休息一下');
    expect(timeGreetingForHour(15)).toBe('下午好呀，接下来交给我吧');
    expect(timeGreetingForHour(20)).toBe('晚上好呀，今天辛苦啦');
    expect(timeGreetingForHour(2)).toBe('夜深啦，别忘了照顾好自己哦');

    // 边界值：5/9/12/14/18/23 各归属后一段
    expect(greetingKeyForHour(4)).toBe('lateNight');
    expect(greetingKeyForHour(5)).toBe('morningEarly');
    expect(greetingKeyForHour(8)).toBe('morningEarly');
    expect(greetingKeyForHour(9)).toBe('morning');
    expect(greetingKeyForHour(11)).toBe('morning');
    expect(greetingKeyForHour(12)).toBe('noon');
    expect(greetingKeyForHour(13)).toBe('noon');
    expect(greetingKeyForHour(14)).toBe('afternoon');
    expect(greetingKeyForHour(17)).toBe('afternoon');
    expect(greetingKeyForHour(18)).toBe('evening');
    expect(greetingKeyForHour(22)).toBe('evening');
    expect(greetingKeyForHour(23)).toBe('lateNight');
    expect(greetingKeyForHour(0)).toBe('lateNight');
  });

  it('六档各不相同；非法小时取模回卷', () => {
    const set = new Set([
      timeGreetingForHour(2),
      timeGreetingForHour(6),
      timeGreetingForHour(10),
      timeGreetingForHour(13),
      timeGreetingForHour(15),
      timeGreetingForHour(20),
    ]);
    expect(set.size).toBe(6);
    expect(timeGreetingForHour(25)).toBe(timeGreetingForHour(1));
    expect(timeGreetingForHour(-1)).toBe(timeGreetingForHour(23));
  });

  it('GREETING_TEXTS 六档与 i18n 原文一致（无自拟）', () => {
    expect(GREETING_TEXTS).toEqual({
      morningEarly: '早上好呀，新的一天开始啦',
      morning: '上午好呀，有什么想让我帮忙的吗',
      noon: '中午好呀，要不要先休息一下',
      afternoon: '下午好呀，接下来交给我吧',
      evening: '晚上好呀，今天辛苦啦',
      lateNight: '夜深啦，别忘了照顾好自己哦',
    });
  });
});

describe('getNextGreetingDelayMs（下一分档边界）', () => {
  it('取当天最近的下一个边界时刻', () => {
    // 08:30 → 09:00（30 分钟）
    expect(getNextGreetingDelayMs(new Date(2026, 9, 11, 8, 30, 0))).toBe(30 * 60 * 1000);
    // 12:30 → 14:00（1.5 小时）
    expect(getNextGreetingDelayMs(new Date(2026, 9, 11, 12, 30, 0))).toBe(90 * 60 * 1000);
  });

  it('当天边界都过了 → 次日首个边界（05:00）', () => {
    // 23:30 → 次日 05:00（5.5 小时）
    expect(getNextGreetingDelayMs(new Date(2026, 9, 11, 23, 30, 0))).toBe(330 * 60 * 1000);
  });
});

describe('resolveGreetingFontSizePx（字号自适应：上限 30 / 下限 20）', () => {
  it('可用宽 ≥ 自然宽 → 上限 30', () => {
    expect(resolveGreetingFontSizePx({ availableWidthPx: 400, naturalTextWidthPx: 300 })).toBe(
      GREETING_MAX_FONT_SIZE_PX,
    );
    expect(resolveGreetingFontSizePx({ availableWidthPx: 300, naturalTextWidthPx: 300 })).toBe(30);
  });

  it('可用宽不足 → 按比例 floor 缩小（250/300 → 25）', () => {
    expect(resolveGreetingFontSizePx({ availableWidthPx: 250, naturalTextWidthPx: 300 })).toBe(25);
  });

  it('缩到下限 20 即停（150/300 → 15 被夹到 20）', () => {
    expect(resolveGreetingFontSizePx({ availableWidthPx: 150, naturalTextWidthPx: 300 })).toBe(
      GREETING_MIN_FONT_SIZE_PX,
    );
  });

  it('非法 / 非正 / 未测量 → 回退上限 30', () => {
    expect(resolveGreetingFontSizePx({ availableWidthPx: 0, naturalTextWidthPx: 300 })).toBe(30);
    expect(resolveGreetingFontSizePx({ availableWidthPx: 300, naturalTextWidthPx: 0 })).toBe(30);
    expect(resolveGreetingFontSizePx({ availableWidthPx: Number.NaN, naturalTextWidthPx: 300 })).toBe(30);
    expect(resolveGreetingFontSizePx({ availableWidthPx: 300, naturalTextWidthPx: Number.NaN })).toBe(30);
  });
});

describe('ConversationEmptyState / Logo mark', () => {
  it('按注入的 now 分档渲染逐字问候（6 档）', () => {
    const cases: Array<[number, string]> = [
      [6, '早上好呀，新的一天开始啦'],
      [10, '上午好呀，有什么想让我帮忙的吗'],
      [13, '中午好呀，要不要先休息一下'],
      [15, '下午好呀，接下来交给我吧'],
      [20, '晚上好呀，今天辛苦啦'],
      [2, '夜深啦，别忘了照顾好自己哦'],
    ];
    for (const [hour, expected] of cases) {
      const { unmount } = render(<ConversationEmptyState now={new Date(2026, 9, 11, hour, 0, 0)} />);
      expect(screen.getByTestId('conversation-empty')).not.toBeNull();
      expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe(expected);
      unmount();
    }
  });

  it('默认字号上限 30px（写入 CSS 变量）；无测量时回退上限', () => {
    const { container } = render(<ConversationEmptyState now={new Date(2026, 9, 11, 10, 0, 0)} />);
    const greeting = container.querySelector('.h2-empty-greeting') as HTMLElement;
    expect(greeting.style.getPropertyValue('--h2-empty-greeting-font-size')).toBe('30px');
    // 自然宽测量 span 在场且固定 30px
    const measure = container.querySelector('.h2-empty-greeting-measure') as HTMLElement;
    expect(measure).not.toBeNull();
    expect(measure.getAttribute('aria-hidden')).toBe('true');
  });

  it('宽度不足 → 缩小字号并写回 CSS 变量（无 ResizeObserver 时监听 window resize）', () => {
    const originalRO = globalThis.ResizeObserver;
    // 强制走「无 ResizeObserver → resize 监听」分支，jsdom 无真实布局故桩测量值。
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    try {
      const { container } = render(<ConversationEmptyState now={new Date(2026, 9, 11, 10, 0, 0)} />);
      const greeting = container.querySelector('.h2-empty-greeting') as HTMLElement;
      const measure = container.querySelector('.h2-empty-greeting-measure') as HTMLElement;
      greeting.style.paddingLeft = '0px';
      greeting.style.paddingRight = '0px';
      const rect = (width: number): DOMRect =>
        ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      greeting.getBoundingClientRect = () => rect(250);
      measure.getBoundingClientRect = () => rect(300);
      act(() => {
        fireEvent(window, new Event('resize'));
      });
      expect(greeting.style.getPropertyValue('--h2-empty-greeting-font-size')).toBe('25px');
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
    }
  });

  it('到点自动换档：setTimeout 到下一分档边界刷新问候', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 11, 8, 59, 0));
    render(<ConversationEmptyState now={new Date(2026, 9, 11, 8, 59, 0)} />);
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe('早上好呀，新的一天开始啦');
    act(() => {
      vi.setSystemTime(new Date(2026, 9, 11, 9, 0, 0));
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe('上午好呀，有什么想让我帮忙的吗');
  });

  it('greeting 显式注入可覆盖分档（供壳/测试显式指定）', () => {
    render(<ConversationEmptyState greeting="自定义问候" />);
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe('自定义问候');
  });

  it('now 缺省 = 当前时间（可用当前小时取到同一档问候）', () => {
    render(<ConversationEmptyState />);
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe(
      timeGreetingForHour(new Date().getHours()),
    );
  });

  it('Logo mark 装饰性（aria-hidden）且含内联 svg（不引外部资源）', () => {
    const { container } = render(<ConversationEmptyState now={new Date(2026, 9, 11, 10, 0, 0)} />);
    const mark = screen.getByTestId('conversation-empty-mark');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.h2-empty-mark svg')).not.toBeNull();
  });

  it('ConversationLogoMark 独立渲染含内联 svg', () => {
    const { container } = render(<ConversationLogoMark />);
    expect(container.querySelector('.h2-empty-mark svg')).not.toBeNull();
  });
});

describe('ConversationSuggestionChips（4 建议 chip）', () => {
  it('缺省渲染实测 4 个 chip，文案逐字（周报总结/报错修复/PPT 制作/闲时任务）', () => {
    render(<ConversationSuggestionChips onPickSuggestion={() => {}} />);
    const chips = screen.getAllByTestId('conversation-empty-suggestion');
    expect(chips.map((c) => c.textContent)).toEqual(['周报总结', '报错修复', 'PPT 制作', '闲时任务']);
    expect(EMPTY_STATE_SUGGESTIONS).toEqual(['周报总结', '报错修复', 'PPT 制作', '闲时任务']);
  });

  it('点击 chip 回传该文案（壳据此预填 composer，非直接发送）', () => {
    const onPick = vi.fn();
    render(<ConversationSuggestionChips onPickSuggestion={onPick} />);
    fireEvent.click(screen.getAllByTestId('conversation-empty-suggestion')[2]!);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('PPT 制作');
  });

  it('未注入回调 → 不渲染任何 chip（不摆点了没反应的假 chip）', () => {
    const { container } = render(<ConversationSuggestionChips />);
    expect(container.querySelector('[data-testid="conversation-empty-suggestions"]')).toBeNull();
  });
});
