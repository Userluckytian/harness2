// ChatEmptyState（Z-18）：时段问候语（边界 5/9/12/14/18/23）、品牌水印、
// 建议 chip（点击 = 真实动作：写入 composer 草稿由席位注入的 onPick 承接）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  SUGGESTED_PROMPTS,
  SuggestionChips,
  ChatEmptyState,
  chatGreetingForHour,
} from '../src/renderer/components/ChatEmptyState.js';

afterEach(cleanup);

describe('chatGreetingForHour（Z-18 边界：5/9/12/14/18/23 点）', () => {
  it('按时段返回问候语，边界值归属后一段', () => {
    expect(chatGreetingForHour(0)).not.toBe('');
    expect(chatGreetingForHour(4)).toBe(chatGreetingForHour(23)); // 同为深夜段
    expect(chatGreetingForHour(5)).not.toBe(chatGreetingForHour(4)); // 5 点起早晨
    expect(chatGreetingForHour(9)).not.toBe(chatGreetingForHour(8)); // 9 点起上午
    expect(chatGreetingForHour(12)).not.toBe(chatGreetingForHour(11)); // 12 点起中午
    expect(chatGreetingForHour(14)).not.toBe(chatGreetingForHour(13)); // 14 点起下午
    expect(chatGreetingForHour(18)).not.toBe(chatGreetingForHour(17)); // 18 点起晚间
    expect(chatGreetingForHour(23)).not.toBe(chatGreetingForHour(22)); // 23 点起深夜
  });

  it('六段语义对应（深夜/早晨/上午/中午/下午/晚间），非法小时取模回卷', () => {
    const of = (h: number) => chatGreetingForHour(h);
    const deepNight = of(2);
    expect(deepNight).toBe(of(23));
    expect(of(6)).not.toBe(deepNight);
    expect(of(10)).not.toBe(of(6));
    expect(of(13)).not.toBe(of(10));
    expect(of(15)).not.toBe(of(13));
    expect(of(20)).not.toBe(of(15));
    expect(of(25)).toBe(of(1)); // 25 → 1 深夜
    expect(of(-1)).toBe(of(23));
  });
});

describe('ChatEmptyState（Timeline 空态）', () => {
  it('渲染品牌水印 + 时段问候 + 引导语；水印装饰性（aria-hidden）', () => {
    render(<ChatEmptyState now={new Date(2026, 9, 11, 10, 0, 0)} />);
    expect(screen.getByTestId('chat-empty')).not.toBeNull();
    expect(screen.getByTestId('chat-empty-greeting').textContent).toBe('上午好');
    // 水印：内联 SVG（大号低对比度）+ 文字水印
    expect(screen.getByTestId('chat-empty').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('chat-empty').textContent).toContain('harness2');
    expect(screen.getByTestId('chat-empty').textContent).toContain('发送第一条消息开始对话');
  });

  it('now 缺省 = 当前时间（可用当前小时取到问候语）', () => {
    render(<ChatEmptyState />);
    expect(screen.getByTestId('chat-empty-greeting').textContent).toBe(chatGreetingForHour(new Date().getHours()));
  });
});

describe('SuggestionChips（composer 下方建议提示）', () => {
  it('缺省渲染 4 个建议 chip，label 短 / prompt 是会被真实提交的完整提示词', () => {
    render(<SuggestionChips onPick={() => {}} />);
    const chips = screen.getAllByTestId('suggested-prompt');
    expect(chips).toHaveLength(SUGGESTED_PROMPTS.length);
    expect(SUGGESTED_PROMPTS.length).toBeGreaterThanOrEqual(3);
    for (const p of SUGGESTED_PROMPTS) {
      expect(p.label.length).toBeLessThan(p.prompt.length);
      expect(p.prompt.length).toBeGreaterThan(10);
    }
  });

  it('点击 chip 回传完整 prompt（真实动作：席位把它写入 composer 草稿）', () => {
    const onPick = vi.fn();
    render(<SuggestionChips onPick={onPick} />);
    fireEvent.click(screen.getAllByTestId('suggested-prompt')[0]!);
    expect(onPick).toHaveBeenCalledWith(SUGGESTED_PROMPTS[0]!.prompt);
  });

  it('没给 onPick（宿主没接草稿缝）→ 不渲染任何 chip（不摆点击无效的假 chip）', () => {
    const { container } = render(<SuggestionChips onPick={undefined} />);
    expect(container.querySelector('[data-testid="suggested-prompts"]')).toBeNull();
  });
});
