// @vitest-environment jsdom
// Z4-02/Z4-03 席位消费端：外部引用预填 → 活草稿 store（与建议 chip 同通道）→ 追加不覆盖 →
// 经既有订阅落 controller.setDraft（store.draftFor 可查）→ 按请求聚焦。
// 以及划词「询问」端到端：转录选区 → 浮层 → composer 引用块。
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import { ConversationSeat } from '../src/renderer/conversation/seat.js';
import { composerPrefill } from '../src/renderer/conversation/composer/prefill.js';
import type { SessionEventsPayloadShape } from '../src/shared/protocol.js';

afterEach(cleanup);

let seq = 0;
function event(type: string, payload: Record<string, unknown>): SessionEventsPayloadShape['events'][number] {
  seq += 1;
  return { v: 1, seq, ts: '2026-10-11T00:00:00Z', type, payload, active: true };
}

function boot(store: AppStore): void {
  store.applyStatus('connected');
  store.setSessions([
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: '第一句问题', messageCount: 2, lastSeq: 2 },
  ]);
  store.select('s1');
  store.applyReplay({
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1', cwd: 'D:/proj' },
    events: [
      event('user/message', { text: '第一句问题', turnId: 't1' }),
      event('assistant/message', { text: '第一句回答', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 2,
  });
}

function renderSeat(store: AppStore): void {
  const controller = createController(store, {} as never); // 渲染路径不触达桥
  render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
}

const QUOTE = '`src/a.ts:3`\n> const x = 1';

describe('席位消费预填请求（Z4-02/Z4-03 共用通道）', () => {
  it('空草稿 → 引用块写入 composer；focus 请求把焦点交给编辑器；草稿经 controller.setDraft 落 store', () => {
    const store = new AppStore();
    boot(store);
    renderSeat(store);
    const editor = screen.getByTestId('composer-editor');

    act(() => {
      composerPrefill.request({ sessionId: 's1', quote: QUOTE, focus: true });
    });
    expect(editor.textContent).toBe(QUOTE);
    expect(store.draftFor('s1')).toBe(QUOTE); // 既有订阅经 controller.setDraft 落盘
    expect(document.activeElement).toBe(editor);
  });

  it('非空草稿 → 追加不覆盖（空行分隔）', () => {
    const store = new AppStore();
    boot(store);
    store.setDraft('s1', '已有草稿'); // 挂载前播种（seat 首次进入用持久草稿播种）
    renderSeat(store);
    const editor = screen.getByTestId('composer-editor');
    expect(editor.textContent).toBe('已有草稿');

    act(() => {
      composerPrefill.request({ sessionId: 's1', quote: QUOTE, focus: false });
    });
    expect(editor.textContent).toBe('已有草稿\n\n' + QUOTE);
    expect(store.draftFor('s1')).toBe('已有草稿\n\n' + QUOTE);
  });

  it('别的会话的请求不消费（本席位只认自己绑定的会话）', () => {
    const store = new AppStore();
    boot(store);
    renderSeat(store);
    act(() => {
      composerPrefill.request({ sessionId: 'other-session', quote: QUOTE, focus: false });
    });
    expect(screen.getByTestId('composer-editor').textContent).toBe('');
    expect(store.draftFor('other-session')).toBe('');
  });

  it('同会话两席位（Z2-06 分屏同任务）：nonce 去重，只消费一次', () => {
    const store = new AppStore();
    boot(store);
    renderSeat(store);
    renderSeat(store); // 第二个席位实例（各自的草稿 store）
    const editors = screen.getAllByTestId('composer-editor');
    expect(editors.length).toBe(2);

    act(() => {
      composerPrefill.request({ sessionId: 's1', quote: QUOTE, focus: false });
    });
    expect(editors[0]?.textContent).toBe(QUOTE);
    expect(editors[1]?.textContent).toBe(''); // 第二个席位跳过（nonce 已被首个消费者领走）
  });
});

describe('划词「询问」端到端（转录选区 → 浮层 → composer）', () => {
  it('选区落在用户消息气泡内 → 「询问」→ 引用块（来源行类型 + 选中文本）预填 + 焦点', () => {
    const store = new AppStore();
    boot(store);
    renderSeat(store);

    const userText = document.querySelector('.bubble-user .text');
    expect(userText?.textContent).toBe('第一句问题');
    const range = document.createRange();
    range.selectNodeContents(userText as Node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent(document, new window.MouseEvent('mouseup', { bubbles: true }));
    const ask = screen.getByTestId('selection-ask');
    expect(ask.textContent).toBe('询问');

    fireEvent.click(ask);
    expect(screen.getByTestId('composer-editor').textContent).toBe('`对话选区（用户消息）`\n> 第一句问题');
    expect(store.draftFor('s1')).toBe('`对话选区（用户消息）`\n> 第一句问题');
    expect(document.activeElement).toBe(screen.getByTestId('composer-editor'));
  });

  it('选区落在不可引用节点（turn-header）→ 浮层不出现（红线⑩）', () => {
    const store = new AppStore();
    boot(store);
    renderSeat(store);

    const header = document.querySelector('.turn-header');
    expect(header).not.toBeNull();
    const range = document.createRange();
    range.selectNodeContents(header as Node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new window.MouseEvent('mouseup', { bubbles: true }));
    expect(screen.queryByTestId('selection-ask')).toBeNull();
  });
});
