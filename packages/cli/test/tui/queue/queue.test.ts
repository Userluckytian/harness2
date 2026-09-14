// G-26 队列纯 reducer 单测：FIFO 保序、边界拒绝（空白/容量满）、两态行为切换、
// steer 请求构造对齐 cli steer.ts（buildSteerRequest 复用语义）。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  FOLLOW_UP_BEHAVIORS,
  FOLLOW_UP_CONFIG_PATH,
  buildFollowUpSteer,
  createQueueState,
  dequeueHead,
  enqueueFollowUp,
  followUpId,
  isQueueEmpty,
  removeFollowUpById,
  resolveFollowUpBehavior,
  setFollowUpBehavior,
} from '../../../src/tui/queue/queue.js';
import { QUEUE_MAX_DEFAULT } from '@harness2/core';

describe('G-26 队列状态与 FIFO 保序', () => {
  it('初始状态：缺省行为 queue、容量 = core QUEUE_MAX_DEFAULT、空队列', () => {
    const state = createQueueState();
    expect(state.behavior).toBe(DEFAULT_FOLLOW_UP_BEHAVIOR);
    expect(state.behavior).toBe('queue'); // G-26：queue 缺省（入队不打断）
    expect(state.max).toBe(QUEUE_MAX_DEFAULT);
    expect(state.entries).toEqual([]);
    expect(isQueueEmpty(state)).toBe(true);
    expect(FOLLOW_UP_BEHAVIORS).toEqual(['queue', 'steer']);
  });

  it('enqueue 保序：seq 与条目顺序一致（FIFO），id 稳定且互异', () => {
    let state = createQueueState();
    for (const text of ['第一条', '第二条', '第三条']) {
      const r = enqueueFollowUp(state, text);
      expect(r.outcome.kind).toBe('enqueued');
      state = r.state;
    }
    expect(state.entries.map((e) => e.text)).toEqual(['第一条', '第二条', '第三条']);
    expect(state.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(3);
    expect(state.entries[0]?.id).toBe(followUpId(1));
  });

  it('dequeueHead 严格队首出队：连续出队按入队顺序（FIFO 保序证明）', () => {
    let state = createQueueState();
    for (const text of ['a', 'b', 'c']) state = enqueueFollowUp(state, text).state;
    const first = dequeueHead(state);
    expect(first.entry?.text).toBe('a');
    const second = dequeueHead(first.state);
    expect(second.entry?.text).toBe('b');
    const third = dequeueHead(second.state);
    expect(third.entry?.text).toBe('c');
    expect(third.state.entries).toEqual([]); // 耗尽后为空
  });

  it('dequeueHead 空队列：entry undefined、状态原引用（调用方据此判定无可发送）', () => {
    const state = createQueueState();
    const r = dequeueHead(state);
    expect(r.entry).toBeUndefined();
    expect(r.state).toBe(state);
  });

  it('removeFollowUpById：按 id 移除中间条目、余序保持；未知 id 原引用返回', () => {
    let state = createQueueState();
    for (const text of ['a', 'b', 'c']) state = enqueueFollowUp(state, text).state;
    const victim = state.entries[1];
    const r = removeFollowUpById(state, victim?.id ?? '');
    expect(r.removed?.text).toBe('b');
    expect(r.state.entries.map((e) => e.text)).toEqual(['a', 'c']);
    const miss = removeFollowUpById(r.state, 'fu-999');
    expect(miss.removed).toBeUndefined();
    expect(miss.state).toBe(r.state);
  });
});

describe('G-26 入队边界（不造假、草稿保留）', () => {
  it('空白文本拒绝入队：draftKept=true（对齐 buildSteerRequest 空白 → null 的口径）', () => {
    const state = createQueueState();
    for (const text of ['', '   ', '\n\t']) {
      const r = enqueueFollowUp(state, text);
      expect(r.outcome).toMatchObject({ kind: 'rejected', reason: 'blank', draftKept: true });
      expect(r.state).toBe(state); // 状态不变
    }
  });

  it('容量满拒绝入队：draftKept=true + 提示（core QUEUE_MAX 注释语义：超限保留 draft 并提示）', () => {
    let state = createQueueState('queue', 2);
    state = enqueueFollowUp(state, 'a').state;
    state = enqueueFollowUp(state, 'b').state;
    const r = enqueueFollowUp(state, 'c');
    expect(r.outcome).toMatchObject({ kind: 'rejected', reason: 'full', draftKept: true });
    expect(r.state.entries.map((e) => e.text)).toEqual(['a', 'b']); // 不静默丢弃
  });
});

describe('G-26 follow_up_behavior 两态切换', () => {
  it('setFollowUpBehavior：异值切换出新状态 + 事件；同值幂等返回原引用', () => {
    const state = createQueueState();
    const toSteer = setFollowUpBehavior(state, 'steer');
    expect(toSteer.event).toEqual({ type: 'follow-up-behavior-switched', from: 'queue', to: 'steer' });
    expect(toSteer.state.behavior).toBe('steer');
    const again = setFollowUpBehavior(toSteer.state, 'steer');
    expect(again.event).toBeNull();
    expect(again.state).toBe(toSteer.state);
  });

  it('切换不改队内条目与序号水位（行为只影响路由，不动数据）', () => {
    let state = createQueueState();
    state = enqueueFollowUp(state, 'a').state;
    const switched = setFollowUpBehavior(state, 'steer').state;
    expect(switched.entries).toEqual(state.entries);
    expect(switched.nextSeq).toBe(state.nextSeq);
  });
});

describe('G-26 steer 请求构造（复用 cli steer.ts 纯函数，不猜 turnId）', () => {
  it('turnId 已知 + 非空文本 → SteerRequest（expectedTurnId = 当前 turn）', () => {
    const req = buildFollowUpSteer({ turnId: 'turn-1', seq: 7, text: '改走 B 方案' });
    expect(req).toEqual({ id: expect.stringContaining('cli-steer-'), expectedTurnId: 'turn-1', text: '改走 B 方案' });
  });

  it('turnId 未知 → null（草稿保留路径，绝不猜 turnId——对齐 chat-setup.submitSteer unknown）', () => {
    expect(buildFollowUpSteer({ turnId: undefined, seq: 1, text: 'x' })).toBeNull();
  });

  it('空白文本 → null（buildSteerRequest 同口径）', () => {
    expect(buildFollowUpSteer({ turnId: 'turn-1', seq: 1, text: '  ' })).toBeNull();
  });
});

describe('G-26 配置解析（消费端兜底）', () => {
  it('未配置 → 缺省 queue 无告警；合法两值生效', () => {
    expect(resolveFollowUpBehavior(undefined)).toEqual({ behavior: 'queue', warning: null });
    expect(resolveFollowUpBehavior({ ui: {} })).toEqual({ behavior: 'queue', warning: null });
    expect(resolveFollowUpBehavior({ ui: { follow_up_behavior: 'steer' } })).toEqual({
      behavior: 'steer',
      warning: null,
    });
  });

  it('非法值 → 回退 queue + 一行告警（风格对齐 mode.parseScreenModeConfig）', () => {
    const r = resolveFollowUpBehavior({ ui: { follow_up_behavior: 'interrupt' } });
    expect(r.behavior).toBe('queue');
    expect(r.warning).toContain(FOLLOW_UP_CONFIG_PATH);
    expect(r.warning).toContain('interrupt');
  });
});
