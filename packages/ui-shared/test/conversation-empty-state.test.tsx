// EmptyState（Z10-1）：会话已选中但无消息（新任务态）空态 ——
//   * 6 档时间问候（时钟注入 now 分档；**仅上午档逐字对齐 ZCode 实测**，其余同句式自拟）；
//   * Logo mark（本仓中性占位；装饰性 aria-hidden）；
//   * 4 建议 chip（文案逐字；点击回传文案，由壳预填 composer —— 非直接发送）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ConversationEmptyState,
  ConversationLogoMark,
  ConversationSuggestionChips,
  EMPTY_STATE_SUGGESTIONS,
  timeGreetingForHour,
} from '../src/renderer/conversation/EmptyState.js';

afterEach(cleanup);

describe('timeGreetingForHour（Z10-1 六档时间问候）', () => {
  it('六档各不相同；边界值（5/9/12/14/18/23）归属后一段', () => {
    const at = (h: number): string => timeGreetingForHour(h);
    expect(new Set([at(2), at(6), at(10), at(13), at(15), at(20)]).size).toBe(6);
    expect(at(4)).toBe(at(23)); // 深夜段 [23,5)
    expect(at(5)).not.toBe(at(4)); // 5 点起清晨
    expect(at(9)).not.toBe(at(8)); // 9 点起上午
    expect(at(12)).not.toBe(at(11)); // 12 点起中午
    expect(at(14)).not.toBe(at(13)); // 14 点起下午
    expect(at(18)).not.toBe(at(17)); // 18 点起傍晚
    expect(at(25)).toBe(at(1)); // 非法小时取模回卷
    expect(at(-1)).toBe(at(23));
  });

  it('六档句式统一「〈问候〉，有什么想让我帮忙的吗」', () => {
    for (const h of [2, 6, 10, 13, 15, 20]) {
      expect(timeGreetingForHour(h)).toMatch(/，有什么想让我帮忙的吗$/);
    }
  });

  it('仅「上午」档逐字对齐 ZCode 实测原文（下午 14:00 那台钟点取上午档）', () => {
    // Z10-1 §0.2 实测原文：上午好呀，有什么想让我帮忙的吗
    expect(timeGreetingForHour(10)).toBe('上午好呀，有什么想让我帮忙的吗');
    expect(timeGreetingForHour(9)).toBe('上午好呀，有什么想让我帮忙的吗');
  });
});

describe('ConversationEmptyState / Logo mark', () => {
  it('按注入的 now 分档渲染完整问候句；Logo mark 在场且装饰性（aria-hidden）', () => {
    render(<ConversationEmptyState now={new Date(2026, 9, 11, 10, 0, 0)} />);
    expect(screen.getByTestId('conversation-empty')).not.toBeNull();
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe('上午好呀，有什么想让我帮忙的吗');
    const mark = screen.getByTestId('conversation-empty-mark');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.getAttribute('aria-hidden')).toBe('true');
  });

  it('now 缺省 = 当前时间（可用当前小时取到同一档问候）', () => {
    render(<ConversationEmptyState />);
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe(
      timeGreetingForHour(new Date().getHours()),
    );
  });

  it('greeting 显式注入可覆盖分档（供壳/测试显式指定）', () => {
    render(<ConversationEmptyState greeting="自定义问候" />);
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toBe('自定义问候');
  });

  it('ConversationLogoMark 独立渲染含内联 svg（不引外部资源）', () => {
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
