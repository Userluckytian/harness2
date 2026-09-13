// focus 单测：焦点环纯状态机全规则（G-08）+ Esc 负向断言 + G-20 park 入口。
import { describe, expect, it } from 'vitest';
import { focusActionFromKey, initialFocusState, reduceFocus, type FocusAction } from '../../../src/tui/input/focus.js';

describe('G-08 焦点环：Tab 双向切换', () => {
  it('prompt → scrollback → prompt 往返', () => {
    const s0 = initialFocusState();
    expect(s0.pane).toBe('prompt'); // 应用启动 = prompt
    expect(reduceFocus(s0, { type: 'toggle' }).pane).toBe('scrollback');
    expect(reduceFocus(reduceFocus(s0, { type: 'toggle' }), { type: 'toggle' }).pane).toBe('prompt');
  });

  it('纯函数：不原地改写入参', () => {
    const s0 = initialFocusState('scrollback');
    reduceFocus(s0, { type: 'toggle' });
    expect(s0.pane).toBe('scrollback');
  });
});

describe('G-08 焦点环：模式键回输入框', () => {
  it('to-prompt 从 scrollback 回 prompt；从 prompt 是恒等（调用方不应发，机器保持全函数）', () => {
    expect(reduceFocus(initialFocusState('scrollback'), { type: 'to-prompt' }).pane).toBe('prompt');
    expect(reduceFocus(initialFocusState('prompt'), { type: 'to-prompt' }).pane).toBe('prompt');
  });
});

describe('G-08 负向断言：Esc 一律不参与焦点切换', () => {
  it('escape 动作在两态下都恒等返回（连引用都不变——零副作用）', () => {
    const prompt = initialFocusState('prompt');
    const scrollback = initialFocusState('scrollback');
    expect(reduceFocus(prompt, { type: 'escape' })).toBe(prompt);
    expect(reduceFocus(scrollback, { type: 'escape' })).toBe(scrollback);
  });

  it('任意动作序列中夹入 escape 不改变结果（Esc 不进焦点环）', () => {
    const withEsc: readonly FocusAction[] = [
      { type: 'escape' },
      { type: 'toggle' },
      { type: 'escape' },
      { type: 'to-prompt' },
      { type: 'escape' },
    ];
    const withoutEsc: readonly FocusAction[] = [{ type: 'toggle' }, { type: 'to-prompt' }];
    let a = initialFocusState();
    for (const action of withEsc) a = reduceFocus(a, action);
    let b = initialFocusState();
    for (const action of withoutEsc) b = reduceFocus(b, action);
    expect(a.pane).toBe(b.pane);
    expect(a.pane).toBe('prompt');
  });

  it('focusActionFromKey 不认识 Esc（Esc 语义全归 esc-machine）', () => {
    expect(focusActionFromKey('simple', 'escape', { shift: false, alt: false, ctrl: false })).toBeNull();
    expect(focusActionFromKey('vim', 'escape', { shift: false, alt: false, ctrl: false })).toBeNull();
    // 带修饰的 Tab 也不是焦点键（Shift+Tab 是 G-33 模式循环，归接线层）
    expect(focusActionFromKey('simple', 'tab', { shift: true, alt: false, ctrl: false })).toBeNull();
  });
});

describe('G-08 焦点动作的键映射（模式差异）', () => {
  it('simple：Tab=toggle、Space=to-prompt；无 i 语义', () => {
    const none = { shift: false, alt: false, ctrl: false };
    expect(focusActionFromKey('simple', 'tab', none)).toEqual({ type: 'toggle' });
    expect(focusActionFromKey('simple', ' ', none)).toEqual({ type: 'to-prompt' });
    expect(focusActionFromKey('simple', 'i', none)).toBeNull();
  });

  it('vim：Tab=toggle、i=to-prompt；无 Space 语义（Space 属 vi 编辑）', () => {
    const none = { shift: false, alt: false, ctrl: false };
    expect(focusActionFromKey('vim', 'tab', none)).toEqual({ type: 'toggle' });
    expect(focusActionFromKey('vim', 'i', none)).toEqual({ type: 'to-prompt' });
    expect(focusActionFromKey('vim', ' ', none)).toBeNull();
  });
});

describe('G-20 park：卡片退完后焦点停到 scrollback', () => {
  it('park 动作从任意态都落到 scrollback', () => {
    expect(reduceFocus(initialFocusState('prompt'), { type: 'park' }).pane).toBe('scrollback');
    expect(reduceFocus(initialFocusState('scrollback'), { type: 'park' }).pane).toBe('scrollback');
  });
});
