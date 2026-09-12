// P1 输入分发器测试：按优先级级联（overlay > approval > composer > scrollback）、
// 消费语义（true=消费停止下传，false=未消费继续）、全部未消费 fallback、
// 层级顺序可配置、FocusEvent 焦点路由。
import { describe, expect, it, vi } from 'vitest';
import { createInputDispatcher, DEFAULT_LAYER_ORDER, type InputLayer } from '../../src/input/dispatcher.js';
import type { InputEvent, KeyEvent, MouseEvent } from '../../src/input/types.js';

function keyEvent(key = 'a'): KeyEvent {
  return {
    type: 'key',
    key,
    modifiers: { shift: false, alt: false, ctrl: false },
    text: key,
    consumed: false,
  };
}
function focusEvent(direction: 'in' | 'out' = 'in'): InputEvent {
  return { type: 'focus', direction, consumed: false };
}
function mouseEvent(): MouseEvent {
  return {
    type: 'mouse',
    kind: 'down',
    button: 0,
    col: 0,
    row: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
    consumed: false,
  };
}

/** 记录调用顺序的层；返回 true=消费 */
function tracingLayer(name: string, consume: boolean): InputLayer & { calls: InputEvent[] } {
  const calls: InputEvent[] = [];
  return {
    name,
    calls,
    handle: (e) => {
      calls.push(e);
      return consume;
    },
  };
}

describe('dispatcher：默认优先级 overlay > approval > composer > scrollback', () => {
  it('DEFAULT_LAYER_ORDER 常量即默认顺序', () => {
    expect([...DEFAULT_LAYER_ORDER]).toEqual(['overlay', 'approval', 'composer', 'scrollback']);
    expect(createInputDispatcher({}).layers()).toEqual(['overlay', 'approval', 'composer', 'scrollback']);
  });

  it('最高层消费后低层不再收到事件', () => {
    const overlay = tracingLayer('overlay', true);
    const approval = tracingLayer('approval', true);
    const composer = tracingLayer('composer', true);
    const scrollback = tracingLayer('scrollback', true);
    const d = createInputDispatcher({ layers: [overlay, approval, composer, scrollback] });
    const ev = keyEvent();
    expect(d.dispatch(ev)).toBe(true);
    expect(overlay.calls.length).toBe(1);
    expect(approval.calls.length).toBe(0);
    expect(composer.calls.length).toBe(0);
    expect(scrollback.calls.length).toBe(0);
  });

  it('高层返回 false 时逐层下传，直到首个消费者', () => {
    const overlay = tracingLayer('overlay', false);
    const approval = tracingLayer('approval', false);
    const composer = tracingLayer('composer', true);
    const scrollback = tracingLayer('scrollback', true);
    const d = createInputDispatcher({ layers: [overlay, approval, composer, scrollback] });
    const ev = keyEvent();
    expect(d.dispatch(ev)).toBe(true);
    expect(overlay.calls.length).toBe(1);
    expect(approval.calls.length).toBe(1);
    expect(composer.calls.length).toBe(1);
    expect(scrollback.calls.length).toBe(0);
  });
});

describe('dispatcher：消费语义与 fallback', () => {
  it('消费后 event.consumed 置位', () => {
    const composer = tracingLayer('composer', true);
    const d = createInputDispatcher({ layers: [composer] });
    const ev = keyEvent();
    d.dispatch(ev);
    expect(ev.consumed).toBe(true);
  });

  it('全部未消费 → fallback 调用、dispatch 返回 false、consumed 保持 false', () => {
    const composer = tracingLayer('composer', false);
    const fallback = vi.fn();
    const d = createInputDispatcher({ layers: [composer], fallback });
    const ev = keyEvent();
    expect(d.dispatch(ev)).toBe(false);
    expect(ev.consumed).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(ev);
  });

  it('有层消费时 fallback 绝不调用', () => {
    const composer = tracingLayer('composer', true);
    const fallback = vi.fn();
    const d = createInputDispatcher({ layers: [composer], fallback });
    d.dispatch(keyEvent());
    expect(fallback).not.toHaveBeenCalled();
  });

  it('鼠标事件同样按级联分发并带 consumed 语义', () => {
    const scrollback = tracingLayer('scrollback', true);
    const d = createInputDispatcher({ layers: [scrollback] });
    const ev = mouseEvent();
    expect(d.dispatch(ev)).toBe(true);
    expect(scrollback.calls[0]).toBe(ev);
  });
});

describe('dispatcher：层级顺序可配置', () => {
  it('自定义数组顺序覆盖默认（composer 在 overlay 前）', () => {
    const composer = tracingLayer('composer', true);
    const overlay = tracingLayer('overlay', true);
    const d = createInputDispatcher({ layers: [composer, overlay] });
    d.dispatch(keyEvent());
    expect(composer.calls.length).toBe(1);
    expect(overlay.calls.length).toBe(0);
    expect(d.layers()).toEqual(['composer', 'overlay']);
  });
});

describe('dispatcher：FocusEvent 焦点路由', () => {
  it('focusTarget 指定时焦点事件只投递给目标层', () => {
    const overlay = tracingLayer('overlay', true);
    const composer = tracingLayer('composer', true);
    const scrollback = tracingLayer('scrollback', true);
    const d = createInputDispatcher({
      layers: [overlay, composer, scrollback],
      focusTarget: 'composer',
    });
    const ev = focusEvent('in');
    d.dispatch(ev);
    expect(composer.calls.length).toBe(1);
    expect(overlay.calls.length).toBe(0);
    expect(scrollback.calls.length).toBe(0);
    expect(ev.consumed).toBe(true);
  });

  it('focusTarget 指定时按键事件仍按普通级联分发', () => {
    const overlay = tracingLayer('overlay', false);
    const composer = tracingLayer('composer', true);
    const d = createInputDispatcher({ layers: [overlay, composer], focusTarget: 'composer' });
    d.dispatch(keyEvent());
    expect(overlay.calls.length).toBe(1);
    expect(composer.calls.length).toBe(1);
  });

  it('未指定 focusTarget 时焦点事件按普通级联', () => {
    const composer = tracingLayer('composer', false);
    const scrollback = tracingLayer('scrollback', true);
    const d = createInputDispatcher({ layers: [composer, scrollback] });
    const ev = focusEvent('out');
    d.dispatch(ev);
    expect(composer.calls.length).toBe(1);
    expect(scrollback.calls.length).toBe(1);
    expect(ev.consumed).toBe(true);
  });
});
