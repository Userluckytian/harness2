// 会话流缓冲测试（Task 4）：重放→增量去重→delta 清空→running/unread/审批生命周期。
import { describe, expect, it } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import type { SessionEventsPayloadShape, WsFrame } from '../src/shared/protocol.js';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): any {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-06T00:00:00Z', type, payload, active: true };
}

const replayPayload = (id: string, events: any[]): SessionEventsPayloadShape => ({
  id,
  dir: 'd',
  header: { sessionId: id },
  events,
  warnings: [],
  lastSeq: events.at(-1)?.seq ?? 0,
});

describe('AppStore 会话流', () => {
  it('切换会话重放：applyReplay 整体应用 + 陈旧响应忽略 + 重复增量忽略', () => {
    const store = new AppStore();
    const userMsg = ev('user/message', { text: '第一句', turnId: 't1' });
    const asst = ev('assistant/message', { text: '回复', turnId: 't1' });
    store.applyReplay(replayPayload('s1', [ev('session/header', { sessionId: 's1' }), userMsg, asst]));
    expect(store.peekStream('s1')!.loaded).toBe(true);
    expect(store.chatItems('s1').filter((i) => i.kind === 'user')).toHaveLength(1);

    // 陈旧重放（lastSeq 更小）不应用
    const before = store.peekStream('s1')!.events.length;
    store.applyReplay(replayPayload('s1', [userMsg]));
    expect(store.peekStream('s1')!.events.length).toBe(before);

    // 已重放过的 seq 再经 WS 推 → 忽略
    store.applyFrame({ type: 'event', sessionId: 's1', event: asst });
    expect(store.peekStream('s1')!.events.length).toBe(before);

    // 新 seq 推 → 追加
    const fresh = ev('assistant/message', { text: '追加', turnId: 't2' });
    store.applyFrame({ type: 'event', sessionId: 's1', event: fresh });
    expect(store.peekStream('s1')!.events.length).toBe(before + 1);
  });

  it('delta 缓冲与一致性清空：text/reasoning 落 assistant/message 即清；tool delta 落 tool/call 即清', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1', [ev('session/header', { sessionId: 's1' })]));
    store.applyFrame({ type: 'delta', sessionId: 's1', kind: 'text', text: '你' });
    store.applyFrame({ type: 'delta', sessionId: 's1', kind: 'text', text: '好' });
    store.applyFrame({ type: 'delta', sessionId: 's1', kind: 'reasoning', text: '想' });
    store.applyFrame({
      type: 'delta',
      sessionId: 's1',
      kind: 'tool',
      call: { id: 'cx', name: 'bash', arguments: '{}' },
    });
    let items = store.chatItems('s1');
    expect(items.filter((i) => i.kind === 'streaming')).toHaveLength(2);

    // assistant/message 落盘：live 文本/reasoning 清空
    store.applyFrame({
      type: 'event',
      sessionId: 's1',
      event: ev('assistant/message', { text: '你好', reasoning: '想', turnId: 't1' }),
    });
    items = store.chatItems('s1');
    const streaming = items.filter((i) => i.kind === 'streaming');
    expect(streaming).toHaveLength(1); // 仅剩 pending tool；text/reasoning 已被落盘事件清空
    expect(streaming[0]!.tool).toBe('bash');
    expect(items.find((i) => i.kind === 'assistant')?.text).toBe('你好'); // 以落盘为准

    // tool/call 落盘：pending tool delta 清空
    store.applyFrame({
      type: 'event',
      sessionId: 's1',
      event: ev('tool/call', { callId: 'cx', tool: 'bash', args: {}, turnId: 't1' }),
    });
    expect(store.chatItems('s1').some((i) => i.kind === 'streaming')).toBe(false);
  });

  it('running 生命周期：markSending 乐观置位 → user/message 确认 → turn-end 清除并记 stopReason', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1', [ev('session/header', { sessionId: 's1' })]));
    store.markSending('s1');
    expect(store.peekStream('s1')!.running).toBe(true);
    store.applyFrame({ type: 'event', sessionId: 's1', event: ev('user/message', { text: 'hi', turnId: 't9' }) });
    expect(store.peekStream('s1')!.running).toBe(true);
    store.applyFrame({ type: 'turn-end', sessionId: 's1', stopReason: 'end_turn' });
    expect(store.peekStream('s1')!.running).toBe(false);
    expect(store.peekStream('s1')!.turnEnds['t9']).toEqual({ stopReason: 'end_turn' });
    // turn-end 后 live 全清
    expect(store.chatItems('s1').some((i) => i.kind === 'streaming')).toBe(false);
  });

  it('后台会话未读徽标：非选中会话的 assistant/message/turn-end 计数，选中清零', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('bg', [ev('session/header', { sessionId: 'bg' })]));
    store.select('main');
    store.applyFrame({
      type: 'event',
      sessionId: 'bg',
      event: ev('assistant/message', { text: '后台产出', turnId: 'k1' }),
    });
    store.applyFrame({ type: 'turn-end', sessionId: 'bg', stopReason: 'end_turn' });
    store.applyFrame({ type: 'delta', sessionId: 'bg', kind: 'text', text: '碎片不计' });
    expect(store.peekStream('bg')!.unread).toBe(2);
    store.select('bg');
    expect(store.peekStream('bg')!.unread).toBe(0);
  });

  it('审批请求进出待处理表；removeApproval 按 requestId 清', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1', [ev('session/header', { sessionId: 's1' })]));
    store.applyFrame({ type: 'approval-request', sessionId: 's1', tool: 'write', args: { a: 1 }, requestId: 'r1' });
    store.applyFrame({ type: 'approval-request', sessionId: 's1', tool: 'bash', args: {}, requestId: 'r2' });
    expect(store.peekStream('s1')!.approvals.map((a) => a.tool)).toEqual(['write', 'bash']);
    store.removeApproval('r1');
    expect(store.peekStream('s1')!.approvals.map((a) => a.tool)).toEqual(['bash']);
    // turn-end 清空全部残留审批（超时/取消场景）
    store.applyFrame({ type: 'turn-end', sessionId: 's1', stopReason: 'end_turn' });
    expect(store.peekStream('s1')!.approvals).toHaveLength(0);
  });

  it('error 帧记录到 statusDetail，不影响会话流', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'error', error: 'session not found: x' } as WsFrame);
    expect(store.getState().statusDetail?.error).toContain('session not found');
  });
});
