// @vitest-environment jsdom
// 划词「询问」浮层（Z4-03）：出现条件（可引用气泡内的非空选区 + 松开鼠标）、
// 消失条件（点击别处 / 滚动 / 选区塌缩）、点击 → 预填请求（引用块 + focus）。
// jsdom Selection 可真实模拟（Range + addRange）；矩形几何缺失 → 全 0（定位仅真机有意义）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { composerPrefill, type ComposerPrefillRequest } from '../src/renderer/conversation/composer/prefill.js';
import { QUOTE_ORIGIN_ATTR, selectionAskTarget, SelectionAskLayer } from '../src/renderer/components/selection-ask.js';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

/** 在容器内指定元素的文本上建立选区（模拟拖选） */
function selectTextOf(el: Element | null): void {
  if (el === null) throw new Error('选区目标不存在');
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function bubble(kind: 'user' | 'assistant', text: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = `<div ${QUOTE_ORIGIN_ATTR}="${kind}"><span class="role">·</span><div class="text">${text}</div></div>`;
  document.body.appendChild(host);
  return host;
}

function mouseUpOn(node: Node): void {
  fireEvent(node, new window.MouseEvent('mouseup', { bubbles: true }));
}

describe('selectionAskTarget（选区 → 划词目标）', () => {
  it('气泡内选区 → 来源行类型 + 选中文本', () => {
    bubble('user', '你好世界');
    selectTextOf(document.querySelector('.text'));
    const target = selectionAskTarget(window.getSelection());
    expect(target?.origin).toBe('user');
    expect(target?.text).toBe('你好世界');
    expect(target?.rect).toEqual({ top: 0, left: 0, bottom: 0, right: 0 }); // jsdom 无 Range 几何
  });

  it('assistant 气泡同样可引用；不可引用节点（无来源标记）→ null', () => {
    const plain = document.createElement('div');
    plain.innerHTML = '<div class="text">普通文本</div>';
    document.body.appendChild(plain);
    bubble('assistant', '回答正文');

    const assistantText = document.querySelectorAll('.text')[1];
    if (assistantText === undefined) throw new Error('助手气泡文本不存在');
    selectTextOf(assistantText);
    expect(selectionAskTarget(window.getSelection())?.origin).toBe('assistant');

    selectTextOf(plain.querySelector('.text'));
    expect(selectionAskTarget(window.getSelection())).toBeNull();
  });

  it('塌缩选区 → null；空白选区 → null（无可引用内容，红线⑩）', () => {
    bubble('user', '正文');
    selectTextOf(document.querySelector('.text') as Element);
    window.getSelection()?.collapseToEnd();
    expect(selectionAskTarget(window.getSelection())).toBeNull();

    const blank = bubble('user', '   ');
    selectTextOf(blank.querySelector('.text'));
    expect(selectionAskTarget(window.getSelection())).toBeNull();
  });
});

describe('SelectionAskLayer（浮层显隐 + 点击预填请求）', () => {
  it('mouseup 且选区可引用 → 「询问」按钮出现；点击 → 预填请求（focus=true）+ 按钮消失', () => {
    bubble('user', '选中我问');
    const received: ComposerPrefillRequest[] = [];
    const unsubscribe = composerPrefill.subscribe((req) => received.push(req));
    render(<SelectionAskLayer sessionId="s1" />);

    mouseUpOn(document);
    expect(screen.queryByTestId('selection-ask')).toBeNull(); // 无选区 → 无按钮

    selectTextOf(document.querySelector('.text'));
    mouseUpOn(document);
    expect(screen.getByTestId('selection-ask').textContent).toBe('询问');

    fireEvent.click(screen.getByTestId('selection-ask'));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sessionId: 's1', quote: '`对话选区（用户消息）`\n> 选中我问', focus: true });
    expect(screen.queryByTestId('selection-ask')).toBeNull(); // 用后即收
    unsubscribe();
  });

  it('点击别处 / 滚动 / 选区塌缩 → 按钮消失；点按钮自身不消失（click 能送达）', () => {
    bubble('assistant', '回答文本');
    render(<SelectionAskLayer sessionId="s1" />);
    selectTextOf(document.querySelector('.text'));
    mouseUpOn(document);
    expect(screen.getByTestId('selection-ask')).toBeTruthy();

    // 按钮上 mousedown 不收（否则 click 还没来按钮先没了）
    fireEvent(screen.getByTestId('selection-ask'), new window.MouseEvent('mousedown', { bubbles: true }));
    expect(screen.getByTestId('selection-ask')).toBeTruthy();

    // 点击别处（按钮外 mousedown）→ 消失
    fireEvent(document, new window.MouseEvent('mousedown', { bubbles: true }));
    expect(screen.queryByTestId('selection-ask')).toBeNull();

    // 重新划选 → 滚动 → 消失（滚动事件按真机语义派发到滚动元素：捕获阶段路过 document）
    selectTextOf(document.querySelector('.text'));
    mouseUpOn(document);
    expect(screen.getByTestId('selection-ask')).toBeTruthy();
    fireEvent.scroll(document.body);
    expect(screen.queryByTestId('selection-ask')).toBeNull();

    // 重新划选 → 选区塌缩 → 消失
    selectTextOf(document.querySelector('.text'));
    mouseUpOn(document);
    expect(screen.getByTestId('selection-ask')).toBeTruthy();
    window.getSelection()?.collapseToEnd();
    fireEvent(document, new window.Event('selectionchange'));
    expect(screen.queryByTestId('selection-ask')).toBeNull();
  });

  it('作用域（Z2-06 分屏）：containerRef 给定时只认容器内的选区，容器外选区不响应', () => {
    const outside = bubble('user', '别的格子的选区'); // 挂在 document.body，不在容器内
    const container = document.createElement('div');
    const inside = document.createElement('div');
    inside.innerHTML = `<div ${QUOTE_ORIGIN_ATTR}="user"><div class="text">本格选区</div></div>`;
    container.appendChild(inside);
    document.body.appendChild(container);
    const containerRef = { current: container as Element };

    render(<SelectionAskLayer sessionId="s1" containerRef={containerRef} />);

    selectTextOf(outside.querySelector('.text'));
    mouseUpOn(document);
    expect(screen.queryByTestId('selection-ask')).toBeNull(); // 容器外 → 不出现（不误报别的会话）

    selectTextOf(inside.querySelector('.text'));
    mouseUpOn(document);
    expect(screen.getByTestId('selection-ask')).toBeTruthy(); // 容器内 → 出现
  });

  it('跨会话投放：点击按挂载时的 sessionId 发请求（vi.fn 监听核对载荷字段）', () => {
    bubble('user', '问题文本');
    const listener = vi.fn();
    const unsubscribe = composerPrefill.subscribe(listener);
    render(<SelectionAskLayer sessionId="session-a" />);
    selectTextOf(document.querySelector('.text'));
    mouseUpOn(document);
    fireEvent.click(screen.getByTestId('selection-ask'));
    expect(listener).toHaveBeenCalledTimes(1);
    const req = listener.mock.calls[0]?.[0] as ComposerPrefillRequest;
    expect(req.sessionId).toBe('session-a');
    expect(req.focus).toBe(true);
    expect(req.nonce).toBeGreaterThan(0);
    unsubscribe();
  });
});
