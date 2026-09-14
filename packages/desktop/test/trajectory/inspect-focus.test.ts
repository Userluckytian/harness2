// P2-5（D-86 ② 完整度）：inspect 的 `callId`/`seq` → 轨迹**行键**定位（纯逻辑，node 环境）。
// 口径：只认真实存在的步骤行；callId 优先于 seq；会话不匹配/找不到 → null（不猜、不乱选）。
import { describe, expect, it, vi } from 'vitest';
import { createTrajectoryFocusStore, findFocusRowKey } from '../../src/renderer/trajectory/inspect-focus.js';
import { projectTrajectory } from '../../src/renderer/trajectory/projection.js';
import { conversationFixture } from './fixtures.js';

const model = projectTrajectory({ events: conversationFixture(), sessionId: 's1' });
const TOOL_KEY = 'turn:t1:tool:6'; // conversationFixture 的 tool/call（callId=c1, seq=6）

describe('P2-5：inspect 请求 → 目标行键', () => {
  it('callId 精确命中工具行，且优先于 seq（seq 落在别处也不会选错）', () => {
    expect(findFocusRowKey(model, { sessionId: 's1', callId: 'c1' }, 's1')).toBe(TOOL_KEY);
    // seq=2 是用户行；有 callId 时必须以 callId 为准
    expect(findFocusRowKey(model, { sessionId: 's1', callId: 'c1', seq: 2 }, 's1')).toBe(TOOL_KEY);
  });

  it('无 callId 时退回 seq；两者都找不到 → null（不猜、不乱选一行）', () => {
    expect(findFocusRowKey(model, { sessionId: 's1', seq: 6 }, 's1')).toBe(TOOL_KEY);
    expect(findFocusRowKey(model, { sessionId: 's1', callId: 'nope' }, 's1')).toBeNull();
    expect(findFocusRowKey(model, { sessionId: 's1', seq: 999 }, 's1')).toBeNull();
    expect(findFocusRowKey(model, { sessionId: 's1' }, 's1')).toBeNull();
  });

  it('会话不匹配 / 无请求 → null（绝不跨会话定位）', () => {
    expect(findFocusRowKey(model, { sessionId: 'other', callId: 'c1' }, 's1')).toBeNull();
    expect(findFocusRowKey(model, { sessionId: 's1', callId: 'c1' }, 'other')).toBeNull();
    expect(findFocusRowKey(model, null, 's1')).toBeNull();
  });
});

describe('P2-5：TrajectoryFocusStore', () => {
  it('request 覆盖上一条并通知；快照不可变；clear 清空后不再通知空转', () => {
    const store = createTrajectoryFocusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSnapshot()).toBeNull();

    store.request({ sessionId: 's1', callId: 'c1', seq: 6 });
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = store.getSnapshot();
    expect(snap).toEqual({ sessionId: 's1', callId: 'c1', seq: 6 });
    expect(Object.isFrozen(snap)).toBe(true);

    store.request({ sessionId: 's1', seq: 7 });
    expect(store.getSnapshot()).toEqual({ sessionId: 's1', seq: 7 }); // 覆盖（不是追加）
    expect(listener).toHaveBeenCalledTimes(2);

    store.clear();
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    store.clear(); // 已空：不重复通知
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('退订后不再收到通知', () => {
    const store = createTrajectoryFocusStore();
    const listener = vi.fn();
    const dispose = store.subscribe(listener);
    dispose();
    store.request({ sessionId: 's1', callId: 'c1' });
    expect(listener).not.toHaveBeenCalled();
  });
});
