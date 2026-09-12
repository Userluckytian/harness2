// D2 稳定滚动测试：贴底跟随、上滚阅读历史不被拽回、阈值边界。
import { describe, expect, it } from 'vitest';
import {
  STICK_TO_BOTTOM_THRESHOLD,
  isAtBottom,
  nextScrollTop,
} from '../src/renderer/features/timeline/execution-log.js';

const box = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('isAtBottom（贴底判定）', () => {
  it('正好贴底 → true', () => {
    expect(isAtBottom(box(400, 900, 500))).toBe(true);
  });

  it('阈值内（≤24px）仍算贴底', () => {
    expect(isAtBottom(box(400 - STICK_TO_BOTTOM_THRESHOLD, 900, 500))).toBe(true);
  });

  it('超过阈值 → 未贴底', () => {
    expect(isAtBottom(box(300, 900, 500))).toBe(false);
  });

  it('内容不足一屏（scrollHeight==clientHeight）→ 贴底', () => {
    expect(isAtBottom(box(0, 500, 500))).toBe(true);
  });
});

describe('nextScrollTop（稳定滚动）', () => {
  it('原本贴底 → 新内容到达时跟随到底', () => {
    expect(nextScrollTop(box(400, 900, 500), { scrollHeight: 1200 }, true)).toBe(1200);
  });

  it('用户上滚阅读历史 → 不动（不被新帧拽回底部）', () => {
    expect(nextScrollTop(box(100, 900, 500), { scrollHeight: 1200 }, false)).toBeNull();
  });

  it('wasAtBottom=true 但实际已离底（内容先变）→ 以实际位置为准', () => {
    // before 已离底超过阈值，即便标记为贴底也不跟随（防御陈旧标记）
    expect(nextScrollTop(box(100, 900, 500), { scrollHeight: 1200 }, false)).toBeNull();
  });

  it('从未滚动（初始 0/0/0，视为贴底）→ 跟随到底', () => {
    expect(nextScrollTop(box(0, 0, 0), { scrollHeight: 800 }, true)).toBe(800);
  });
});
