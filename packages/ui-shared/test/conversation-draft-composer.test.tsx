// @vitest-environment jsdom
// 草稿态 composer 的判据与 CSS 钩子（DOM 级证据）：
//   * 判据 isDraft = 会话已加载、非运行中、且本会话无任何条目（seat.tsx，与建议 chip 同一表达式）；
//   * data-draft         → 卡片化视觉（shell.css 的 [data-draft='true'] 规则）；
//   * data-draft-inflow  → 在流内布局（草稿且队列/审批 dock 均为空时才切，否则回落贴底浮层）。
// 样式像素由 CSS 文本测试（conversation-area-css.test.ts）钉住；此处只锁属性契约。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import { ConversationSeat } from '../src/renderer/conversation/seat.js';
import type { SessionEventsPayloadShape } from '../src/shared/protocol.js';

afterEach(cleanup);

/** 空会话（已加载、零条目）= 草稿态 */
function emptySession(): AppStore {
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions([
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: '', messageCount: 0, lastSeq: 0 },
  ]);
  store.select('s1');
  store.applyReplay({
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1', cwd: 'D:/proj' },
    events: [],
    warnings: [],
    lastSeq: 0,
  });
  return store;
}

/** 有消息的会话（会话态） */
function sessionWithMessage(): AppStore {
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions([
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: '问题', messageCount: 2, lastSeq: 2 },
  ]);
  store.select('s1');
  const payload: SessionEventsPayloadShape = {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1', cwd: 'D:/proj' },
    events: [
      {
        v: 1,
        seq: 1,
        ts: '2026-10-11T00:00:00Z',
        type: 'user/message',
        payload: { text: '问题', turnId: 't1' },
        active: true,
      },
      {
        v: 1,
        seq: 2,
        ts: '2026-10-11T00:00:00Z',
        type: 'assistant/message',
        payload: { text: '回答', turnId: 't1' },
        active: true,
      },
    ],
    warnings: [],
    lastSeq: 2,
  };
  store.applyReplay(payload);
  return store;
}

function renderSeat(store: AppStore): void {
  const controller = createController(store, {} as never); // 渲染路径不触达桥
  render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
}

describe('草稿态 composer 的 data 属性契约（ZCode 卡片化 / 在流内布局）', () => {
  it('空会话：seat 与 composer-overlay 都带 data-draft + data-draft-inflow；建议 chip 出现', () => {
    renderSeat(emptySession());
    const seat = screen.getByTestId('conversation-seat');
    const overlay = screen.getByTestId('composer-overlay');
    expect(seat.getAttribute('data-draft')).toBe('true');
    expect(overlay.getAttribute('data-draft')).toBe('true');
    expect(seat.getAttribute('data-draft-inflow')).toBe('true');
    expect(overlay.getAttribute('data-draft-inflow')).toBe('true');
    // 草稿判据与建议 chip 是同一表达式 → chip 同现
    expect(screen.getByTestId('conversation-empty-suggestions')).not.toBeNull();
  });

  it('有消息（会话态）：不写 data-draft / data-draft-inflow（会话态视觉不动）', () => {
    renderSeat(sessionWithMessage());
    const seat = screen.getByTestId('conversation-seat');
    const overlay = screen.getByTestId('composer-overlay');
    expect(seat.getAttribute('data-draft')).toBeNull();
    expect(overlay.getAttribute('data-draft')).toBeNull();
    expect(seat.getAttribute('data-draft-inflow')).toBeNull();
    expect(overlay.getAttribute('data-draft-inflow')).toBeNull();
    expect(screen.queryByTestId('conversation-empty-suggestions')).toBeNull();
  });
});
