// cards/focus 单测：G-25 卡内焦点环（Tab/Shift+Tab 环走）+ 不泄漏全局环的接缝契约。
import { describe, expect, it } from 'vitest';
import {
  cardFocusActionFromKey,
  globalFocusSuspended,
  initialCardFocus,
  reduceCardFocus,
  type CardFocusState,
} from '../../../src/tui/cards/focus.js';
import { activeCard, initialCardQueue, pushCard } from '../../../src/tui/cards/queue.js';
import { renderCard } from '../../../src/tui/cards/render.js';
import { initialFocusState, reduceFocus } from '../../../src/tui/input/focus.js';
import { makePermissionCard, makeQuestionCard } from './helpers.js';

const NONE = { shift: false, alt: false, ctrl: false };

function withCount(count: number): CardFocusState {
  return reduceCardFocus(initialCardFocus(), { type: 'reset', count });
}

describe('G-25 卡内焦点环：Tab/Shift+Tab 双向循环', () => {
  it('next 到尾回环到首；prev 到首回环到尾', () => {
    let s = withCount(4);
    const forward: number[] = [];
    for (let i = 0; i < 5; i++) {
      forward.push(s.index);
      s = reduceCardFocus(s, { type: 'next' });
    }
    expect(forward).toEqual([0, 1, 2, 3, 0]); // 第 5 步回环
    let t = reduceCardFocus(withCount(4), { type: 'prev' });
    expect(t.index).toBe(3); // 首项 prev → 尾项
    t = reduceCardFocus(t, { type: 'prev' });
    expect(t.index).toBe(2);
  });

  it('count=0（无可交互元素）：next/prev 恒等（原引用）', () => {
    const empty = withCount(0);
    expect(reduceCardFocus(empty, { type: 'next' })).toBe(empty);
    expect(reduceCardFocus(empty, { type: 'prev' })).toBe(empty);
  });

  it('reset：卡片打开/切换按新卡元素数落位第 0 项；非法 count 钳为无元素态', () => {
    expect(withCount(3)).toEqual({ index: 0, count: 3 });
    expect(reduceCardFocus(initialCardFocus(), { type: 'reset', count: -1 })).toEqual({ index: 0, count: 0 });
    expect(reduceCardFocus(initialCardFocus(), { type: 'reset', count: 1.5 })).toEqual({ index: 0, count: 0 });
  });

  it('环自愈：越界脏 index 经 next/prev 回到合法区间', () => {
    const dirty: CardFocusState = { index: 5, count: 3 };
    expect(reduceCardFocus(dirty, { type: 'next' }).index).toBe(0); // (5+1)%3
    expect(reduceCardFocus(dirty, { type: 'prev' }).index).toBe(1); // (5-1+3)%3
  });

  it('G-25 负向规则：escape 恒等返回（Esc 语义归 esc-machine，不参与卡内焦点）', () => {
    const s = withCount(3);
    expect(reduceCardFocus(s, { type: 'escape' })).toBe(s);
  });
});

describe('键映射桥接：只认 Tab/Shift+Tab', () => {
  it('tab → next；tab+shift → prev；带 ctrl/alt 的 tab 与其余键一概 null', () => {
    expect(cardFocusActionFromKey('tab', NONE)).toEqual({ type: 'next' });
    expect(cardFocusActionFromKey('tab', { ...NONE, shift: true })).toEqual({ type: 'prev' });
    expect(cardFocusActionFromKey('tab', { ...NONE, ctrl: true })).toBeNull();
    expect(cardFocusActionFromKey('tab', { ...NONE, alt: true })).toBeNull();
    expect(cardFocusActionFromKey('escape', NONE)).toBeNull();
    expect(cardFocusActionFromKey('down', NONE)).toBeNull(); // ↑/↓ 是接线层卡片键位，不进环语义
    expect(cardFocusActionFromKey('return', NONE)).toBeNull();
  });
});

describe('G-25 接缝：卡片打开期全局环挂起、不泄漏', () => {
  it('globalFocusSuspended：有 active 卡 = true；空队列 = false', () => {
    const empty = initialCardQueue();
    expect(globalFocusSuspended(activeCard(empty))).toBe(false);
    const open = pushCard(empty, makePermissionCard());
    expect(globalFocusSuspended(activeCard(open))).toBe(true);
  });

  it('不泄漏（结构保证）：卡打开时 Tab 走卡内环，全局焦点状态原引用不动；卡退完后 Tab 才回全局环', () => {
    // 按文件头接缝契约模拟接线层分发：先问 globalFocusSuspended，再决定喂谁
    const untouched = initialFocusState(); // 全局环初始态（引用基准）
    let globalPane = untouched;
    let cardFocus = reduceCardFocus(initialCardFocus(), { type: 'reset', count: 3 });
    let cardOpen = true;

    const dispatchTab = (): void => {
      if (cardOpen) {
        // 卡片打开期：全局环挂起——绝不调用 reduceFocus
        const action = cardFocusActionFromKey('tab', NONE);
        if (action !== null) cardFocus = reduceCardFocus(cardFocus, action);
        return;
      }
      globalPane = reduceFocus(globalPane, { type: 'toggle' });
    };

    dispatchTab();
    dispatchTab();
    expect(cardFocus.index).toBe(2); // 卡内环连走两步
    expect(globalPane).toBe(untouched); // 全局环零泄漏（引用未变）

    cardOpen = false;
    dispatchTab();
    expect(globalPane.pane).toBe('scrollback'); // 卡片退完（G-20 park 入口之后）全局环恢复
  });

  it('环长来自 render 的 items（四类通用）：焦点沿 CardView.items 环走', () => {
    const question = makeQuestionCard();
    const questionView = renderCard(question);
    expect(questionView.items.length).toBe(3); // 2 选项 + 自由文本
    let s = reduceCardFocus(initialCardFocus(), { type: 'reset', count: questionView.items.length });
    s = reduceCardFocus(s, { type: 'prev' });
    expect(questionView.items[s.index]?.id).toBe('question:free-text'); // 尾项 = 自由文本

    const permissionCount = renderCard(makePermissionCard()).items.length; // y/a/n
    expect(permissionCount).toBe(3);
    expect(withCount(permissionCount).count).toBe(3);
  });
});
