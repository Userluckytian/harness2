// 事件流投影测试（共享 store）：流式增量 → 终态 → 取消三态。
// 这些语义是 desktop 与 web 共同依赖的「唯一一份」实现，故在共享包内直接钉住。
import { describe, expect, it } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { projectChatItems } from '../src/renderer/chat-model.js';

function event(seq: number, type: string, payload: Record<string, unknown>) {
  return { v: 1 as const, seq, ts: '2026-09-14T00:00:00.000Z', type, payload };
}

describe('store：带水位流式增量（S3c2 帧）', () => {
  it('text-delta 逐块拼接；重复/重叠块被水位拒绝（不重复渲染）', () => {
    const store = new AppStore();
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 0,
      text: '你',
    });
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 1,
      text: '好',
    });
    // 重复投递首块（offset 0）：水位已越过 → 丢弃
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 0,
      text: '你',
    });
    const stream = store.peekStream('a');
    expect(stream?.live.text).toBe('你好');
    expect(stream?.running).toBe(true);
  });

  it('新 attemptId 重置在途文本（不把上一 attempt 的残段拼进来）', () => {
    const store = new AppStore();
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 0,
      text: '半截',
    });
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at2',
      chunkOffset: 0,
      text: '完整',
    });
    expect(store.peekStream('a')?.live.text).toBe('完整');
  });

  it('attempt-final 记录终态并作废该 attempt 水位', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'text-delta', sessionId: 'a', turnId: 't1', attemptId: 'at1', chunkOffset: 0, text: 'x' });
    store.applyFrame({
      type: 'attempt-final',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      state: 'failed',
      error: '连接中断',
    });
    expect(store.peekStream('a')?.attempts['at1']).toEqual({ turnId: 't1', state: 'failed', error: '连接中断' });
    // 水位作废后，同 attemptId 的新块（offset 0）可再次接受
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 0,
      text: '重来',
    });
    expect(store.peekStream('a')?.live.text).toBe('重来');
  });
});

describe('store：turn 终态（API-STABILITY「跨端展示语义」）', () => {
  it('turn-end(final)：记 finalText、running 归位、在途增量清空', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'event', sessionId: 'a', event: event(1, 'user/message', { turnId: 't1', text: 'q' }) });
    store.applyFrame({
      type: 'text-delta',
      sessionId: 'a',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 0,
      text: '答',
    });
    store.applyFrame({
      type: 'turn-end',
      sessionId: 'a',
      stopReason: 'end_turn',
      textOutcome: 'final',
      finalText: '答案',
    });
    const stream = store.peekStream('a');
    expect(stream?.running).toBe(false);
    expect(stream?.live.text).toBe('');
    expect(stream?.turnEnds['t1']).toEqual({ stopReason: 'end_turn', textOutcome: 'final', finalText: '答案' });
  });

  it('turn-end(partial)：半截文本进 partialText 且带上停止原因（展示须标注未完成）', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'event', sessionId: 'a', event: event(1, 'user/message', { turnId: 't1', text: 'q' }) });
    store.applyFrame({
      type: 'turn-end',
      sessionId: 'a',
      stopReason: 'cancelled',
      textOutcome: 'partial',
      partialText: '写到一半',
    });
    expect(store.peekStream('a')?.turnEnds['t1']).toEqual({
      stopReason: 'cancelled',
      textOutcome: 'partial',
      partialText: '写到一半',
    });
  });

  it('turn-end(empty)：无正文可展示时如实落定 empty（不补空串、不伪造 finalText）', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'event', sessionId: 'a', event: event(1, 'user/message', { turnId: 't1', text: 'q' }) });
    store.applyFrame({ type: 'turn-end', sessionId: 'a', stopReason: 'end_turn', textOutcome: 'empty' });
    expect(store.peekStream('a')?.turnEnds['t1']).toEqual({ stopReason: 'end_turn', textOutcome: 'empty' });
  });

  it('turn-end 缺 textOutcome（旧版 serve 兼容）：只记 stopReason，不臆造三态', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'event', sessionId: 'a', event: event(1, 'user/message', { turnId: 't1', text: 'q' }) });
    store.applyFrame({ type: 'turn-end', sessionId: 'a', stopReason: 'end_turn' });
    expect(store.peekStream('a')?.turnEnds['t1']).toEqual({ stopReason: 'end_turn' });
    expect(store.peekStream('a')?.running).toBe(false);
  });

  it('终态投影成转录条目：partial 文本 + 停止原因，不留空白气泡', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'event', sessionId: 'a', event: event(1, 'user/message', { turnId: 't1', text: 'q' }) });
    store.applyFrame({
      type: 'turn-end',
      sessionId: 'a',
      stopReason: 'aborted',
      textOutcome: 'partial',
      partialText: '半截',
    });
    const items = projectChatItems(
      store.peekStream('a')!.events,
      store.peekStream('a')!.live,
      store.peekStream('a')!.turnEnds,
    );
    const kinds = items.map((i) => i.kind);
    // turn 摘要条目承载终态语义（半截文本 + 停止原因都在里面，不留空白气泡）
    expect(kinds).toContain('turn-summary');
    const summary = items.find((i) => i.kind === 'turn-summary');
    expect(JSON.stringify(summary)).toContain('半截');
    expect(JSON.stringify(summary)).toContain('aborted');
    expect(JSON.stringify(summary)).toContain('partial');
  });
});

describe('store：取消三态与提交幂等（unknown ≠ rejected）', () => {
  it('cancel-ack 三态记录在全局表（stopping → cancelled 不回退为「已停」以外的东西）', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'cancel-ack', requestId: 'r1', state: 'stopping' });
    expect(store.getState().cancelAcks['r1']).toBe('stopping');
    store.applyFrame({ type: 'cancel-ack', requestId: 'r1', state: 'cancelled' });
    expect(store.getState().cancelAcks['r1']).toBe('cancelled');
    store.applyFrame({ type: 'cancel-ack', requestId: 'r2', state: 'unknown' });
    expect(store.getState().cancelAcks['r2']).toBe('unknown');
  });

  it('提交 ack 丢失：超时标 unknown 且**不自动重发**（队列项保留、待定不禁用）', () => {
    const store = new AppStore();
    store.noteSubmit('a', { clientMessageId: 'cm1', rawText: 'x', intent: 'queue' });
    const expired = store.expirePendingSubmits(5000, Date.now() + 6000);
    expect(expired.map((e) => e.clientMessageId)).toEqual(['cm1']);
    expect(store.peekStream('a')?.submitAcks['cm1']?.state).toBe('unknown');
    expect(store.peekStream('a')?.queue.map((q) => q.id)).toEqual(['cm1']);
  });

  it('未知会话帧不造幽灵流：cron 广播帧被如实丢弃', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'cron', op: 'finished', id: 'job1', ok: true });
    expect(store.streamIds()).toEqual([]);
  });
});
