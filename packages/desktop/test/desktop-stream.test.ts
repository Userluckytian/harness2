// D0 桌面流契约测试：S0/S3 带水位 delta（连续性判定）+ attempt 终态 + P3 终态文本投影。
// 纯 store 单测（不经 IPC/WS）：驱动 applyFrame，断言渲染投影结果。
import { describe, expect, it } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { acceptDelta } from '../src/renderer/delivery.js';
import type { SessionEventsPayloadShape, WsFrame } from '../src/shared/protocol.js';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): any {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-11T00:00:00Z', type, payload, active: true };
}

const replayPayload = (id: string, events: any[]): SessionEventsPayloadShape => ({
  id,
  dir: 'd',
  header: { sessionId: id },
  events,
  warnings: [],
  lastSeq: events.at(-1)?.seq ?? 0,
});

function freshStore(id = 's1'): AppStore {
  const store = new AppStore();
  store.applyReplay(replayPayload(id, [ev('session/header', { sessionId: id })]));
  return store;
}

describe('acceptDelta：ChunkOffset 连续性判定（与 core WatermarkCursor 同语义）', () => {
  it('首块必须 offset=0；续块必须严格接续；重复/重叠/缺口/非法一律丢弃', () => {
    expect(acceptDelta(undefined, 3, 'abc')).toBeNull(); // 首块非 0
    expect(acceptDelta(undefined, 0, 'ab')).toEqual({ offset: 0, length: 2 });
    expect(acceptDelta({ offset: 0, length: 2 }, 2, 'cd')).toEqual({ offset: 2, length: 2 });
    expect(acceptDelta({ offset: 0, length: 2 }, 0, 'ab')).toBeNull(); // 重复
    expect(acceptDelta({ offset: 0, length: 2 }, 1, 'b')).toBeNull(); // 重叠
    expect(acceptDelta({ offset: 0, length: 2 }, 5, 'x')).toBeNull(); // 缺口
    expect(acceptDelta(undefined, -1, 'x')).toBeNull(); // 非法
    expect(acceptDelta(undefined, 1.5, 'x')).toBeNull(); // 非整数
  });
});

describe('cron 通知帧：无会话归属广播不得造幽灵流（审查 P2）', () => {
  it('cron 帧被如实丢弃：不 ensureStream(undefined)、不记协议错误、不影响既有会话', () => {
    const store = freshStore('s1');
    expect(store.streamIds()).toEqual(['s1']);
    // core ws.ts 广播的 cron 帧（无 sessionId 字段）。经 unknown 断言构造：
    // 无论镜像与否都能编译，专测运行期行为。
    const cronFrame = { type: 'cron', op: 'finished', id: 'job-1', ok: false, error: '超时' };
    expect(() => store.applyFrame(cronFrame as unknown as WsFrame)).not.toThrow();
    // 修复前：落到 ensureStream(frame.sessionId=undefined) → streamIds 出现 undefined 幽灵流
    expect(store.streamIds()).toEqual(['s1']);
    // 也不得被当协议错误记入 statusDetail
    expect(store.getState().statusDetail?.error).toBeUndefined();
  });
});

describe('AppStore 带水位 delta 投影（D0）', () => {
  it('text-delta 按水位拼接；重复与缺口丢弃；新 attemptId 重置在途文本', () => {
    const store = freshStore();
    store.applyFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '你',
    });
    store.applyFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 1,
      text: '好',
    });
    // 重复块（迟到 offset）丢弃
    store.applyFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 1,
      text: '好',
    });
    // 缺口块丢弃
    store.applyFrame({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 9, text: '?' });
    let streaming = store.chatItems('s1').find((i) => i.kind === 'streaming' && i.text !== undefined);
    expect(streaming?.text).toBe('你好');

    // 新 attempt（a2, offset 0）：在途文本重置，不残留 a1 内容
    store.applyFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a2',
      chunkOffset: 0,
      text: '重试',
    });
    streaming = store.chatItems('s1').find((i) => i.kind === 'streaming' && i.text !== undefined);
    expect(streaming?.text).toBe('重试');
  });

  it('text/reasoning 水位互不干扰（同一 attempt 两条独立水位线）', () => {
    const store = freshStore();
    store.applyFrame({
      type: 'reasoning-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '想',
    });
    store.applyFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '答',
    });
    store.applyFrame({
      type: 'reasoning-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 1,
      text: '了',
    });
    const streaming = store.chatItems('s1').find((i) => i.kind === 'streaming');
    expect(streaming?.text).toBe('答');
    expect(streaming?.reasoning).toBe('想了');
  });

  it('attempt-final：记录终态与半截文本；该 attempt 水位作废', () => {
    const store = freshStore();
    store.applyFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '半截',
    });
    store.applyFrame({
      type: 'attempt-final',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      state: 'failed',
      finalText: '半截',
      error: 'network',
    });
    const stream = store.peekStream('s1')!;
    expect(stream.attempts['a1']).toEqual({ turnId: 't1', state: 'failed', finalText: '半截', error: 'network' });
    // 水位作废：同一 attemptId 再来 offset=1 属缺口（首块要求 0）→ 丢弃
    store.applyFrame({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 1, text: 'x' });
    expect(stream.watermarks['a1']).toBeUndefined();
  });
});

describe('P3 跨端终态文本语义（桌面投影）', () => {
  it('textOutcome=partial：turn-summary 携带 partialText 与停因（展示须标注未完成）', () => {
    const store = freshStore();
    store.applyFrame({ type: 'event', sessionId: 's1', event: ev('user/message', { text: 'hi', turnId: 't1' }) });
    store.applyFrame({
      type: 'event',
      sessionId: 's1',
      event: ev('assistant/attempt', { turnId: 't1', error: 'cancelled: 用户取消', text: '写到一半' }),
    });
    store.applyFrame({
      type: 'turn-end',
      sessionId: 's1',
      stopReason: 'cancelled',
      textOutcome: 'partial',
      partialText: '写到一半',
    });
    const items = store.chatItems('s1');
    const attempt = items.find((i) => i.kind === 'attempt');
    expect(attempt?.text).toBe('写到一半'); // assistant/attempt 是半截文本日志权威
    expect(attempt?.error).toContain('cancelled');
    const summary = items.find((i) => i.kind === 'turn-summary');
    expect(summary?.textOutcome).toBe('partial');
    expect(summary?.partialText).toBe('写到一半');
    expect(summary?.stopReason).toBe('cancelled');
  });

  it('textOutcome=empty：无可展示正文（禁止空白气泡），只留停因/错误', () => {
    const store = freshStore();
    store.applyFrame({ type: 'event', sessionId: 's1', event: ev('user/message', { text: 'hi', turnId: 't1' }) });
    store.applyFrame({
      type: 'turn-end',
      sessionId: 's1',
      stopReason: 'error',
      textOutcome: 'empty',
      error: 'network unreachable',
    });
    const items = store.chatItems('s1');
    // 没有 assistant 正文条目（不伪造空白气泡）
    expect(items.some((i) => i.kind === 'assistant' && (i.text ?? '').length === 0 && i.streaming !== true)).toBe(
      false,
    );
    const summary = items.find((i) => i.kind === 'turn-summary');
    expect(summary?.textOutcome).toBe('empty');
    expect(summary?.error).toBe('network unreachable');
  });
});
