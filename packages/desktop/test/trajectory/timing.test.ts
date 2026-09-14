// 首 token 观测测试（TTFT 的唯一诚实来源）。
import { describe, expect, it } from 'vitest';
import { TrajectoryTimingObserver, currentStreamingStepId } from '../../src/renderer/trajectory/timing.js';
import { conversationFixture, runningFixture } from './fixtures.js';

describe('TrajectoryTimingObserver', () => {
  it('只记录第一次有输出的时刻（后续同 step 不再覆盖）', () => {
    let now = 1000;
    const observer = new TrajectoryTimingObserver(() => now);
    expect(observer.observe('step-1', false)).toBe(false);
    expect(observer.size()).toBe(0);
    now = 1500;
    expect(observer.observe('step-1', true)).toBe(true);
    expect(observer.snapshot()).toEqual({ 'step-1': 1500 });
    now = 2000;
    expect(observer.observe('step-1', true)).toBe(false);
    expect(observer.snapshot()['step-1']).toBe(1500);
  });

  it('空 stepId 不记录（避免把「未开始」记成观测）', () => {
    const observer = new TrajectoryTimingObserver(() => 42);
    expect(observer.observe('', true)).toBe(false);
    expect(observer.size()).toBe(0);
  });

  it('无变化时快照引用稳定（可直接作 useMemo 依赖）', () => {
    const observer = new TrajectoryTimingObserver(() => 7);
    observer.observe('a', true);
    const snapshot = observer.snapshot();
    expect(observer.snapshot()).toBe(snapshot);
    observer.observe('a', true);
    expect(observer.snapshot()).toBe(snapshot);
  });

  it('forget/clear 精确回收（重试新 attempt 从零开始时调用）', () => {
    const observer = new TrajectoryTimingObserver(() => 1);
    observer.observe('a', true);
    observer.observe('b', true);
    observer.forget('a');
    expect(observer.snapshot()).toEqual({ b: 1 });
    observer.clear();
    expect(observer.snapshot()).toEqual({});
    expect(observer.size()).toBe(0);
  });
});

describe('currentStreamingStepId', () => {
  it('最后一个 step/start 之后没有 assistant/message → 该 step 仍在产出', () => {
    expect(currentStreamingStepId(runningFixture())).toBe('step-t1-1');
  });

  it('assistant/message 落盘后该 step 的模型流已结束 → undefined', () => {
    expect(currentStreamingStepId(conversationFixture())).toBeUndefined();
  });

  it('影子事件不参与判定；缺 stepId 字段 → undefined', () => {
    const shadowed = runningFixture().map((event) => ({ ...event, active: false }));
    expect(currentStreamingStepId(shadowed)).toBeUndefined();
    expect(currentStreamingStepId([{ active: true, type: 'step/start', payload: {} }])).toBeUndefined();
  });
});
