// T4 有界 UI 调度器测试（纯逻辑；fake timers 验证合并/有界/输入优先/final flush/timer 无残留）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUiScheduler, retryCountdownActive, retryCountdownSeconds } from '../../src/tui/scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createUiScheduler：窗口内合并', () => {
  it('flushMs 窗口内多次 push 合并为一批 onFlush', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const s = createUiScheduler<number>({ flushMs: 20, onFlush: (b) => batches.push(b) });
    s.push(1);
    s.push(2);
    s.push(3);
    expect(batches).toEqual([]);
    expect(s.pending()).toBe(3);
    vi.advanceTimersByTime(20);
    expect(batches).toEqual([[1, 2, 3]]);
    expect(s.pending()).toBe(0);
    s.dispose();
  });
});

describe('createUiScheduler：maxBatch 有界 + 溢出延后', () => {
  it('单次 flush 不超过 maxBatch，溢出留队并重新排期', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const s = createUiScheduler<number>({ flushMs: 10, maxBatch: 2, onFlush: (b) => batches.push(b) });
    for (const n of [1, 2, 3, 4, 5]) s.push(n);
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([[1, 2]]);
    expect(s.pending()).toBe(3); // 溢出延后，未丢
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(s.pending()).toBe(1);
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(s.pending()).toBe(0);
    s.dispose();
  });
});

describe('createUiScheduler：输入优先挂起后台 flush', () => {
  it('setInputPriority(true) 时 timer flush 被推迟，队列保留', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const s = createUiScheduler<string>({ flushMs: 10, maxBatch: 8, onFlush: (b) => batches.push(b) });
    s.setInputPriority(true);
    s.push('a');
    s.push('b');
    vi.advanceTimersByTime(50);
    expect(batches).toEqual([]); // 后台 flush 被挂起
    expect(s.pending()).toBe(2);
    s.setInputPriority(false);
    expect(batches).toEqual([['a', 'b']]); // 解除后立即补 flush，不丢
    expect(s.pending()).toBe(0);
    s.dispose();
  });

  it('输入优先期间 flushNow 仍立即生效（输入驱动）', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const s = createUiScheduler<string>({ flushMs: 10, onFlush: (b) => batches.push(b) });
    s.setInputPriority(true);
    s.push('x');
    s.flushNow();
    expect(batches).toEqual([['x']]);
    s.dispose();
  });
});

describe('createUiScheduler：flushNow final flush', () => {
  it('flushNow 排空全部待处理事件（按 maxBatch 分批，不丢）', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const s = createUiScheduler<number>({ flushMs: 10, maxBatch: 2, onFlush: (b) => batches.push(b) });
    for (const n of [1, 2, 3, 4, 5]) s.push(n);
    s.flushNow();
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(s.pending()).toBe(0);
    // 已 clear timer：继续推进时间不再产生新 flush
    vi.advanceTimersByTime(100);
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    s.dispose();
  });
});

describe('createUiScheduler：dispose 清 timer、拒绝后续 flush', () => {
  it('dispose 后无残留 timer，push/flushNow 不再回调', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const s = createUiScheduler<number>({ flushMs: 10, onFlush: (b) => batches.push(b) });
    s.push(1);
    expect(vi.getTimerCount()).toBe(1);
    s.dispose();
    expect(vi.getTimerCount()).toBe(0); // 无残留 timer（T0/T5 新鲜度要求）
    expect(s.pending()).toBe(0);
    s.push(2);
    s.flushNow();
    vi.advanceTimersByTime(100);
    expect(batches).toEqual([]);
  });
});

describe('retryCountdown：纯倒计时模型', () => {
  it('剩余秒数按 ceil 计算并夹取到 0', () => {
    const model = { delayMs: 2500, startedAt: 1000 };
    expect(retryCountdownSeconds(model, 1000)).toBe(3); // 2.5s → 3
    expect(retryCountdownSeconds(model, 2500)).toBe(1);
    expect(retryCountdownSeconds(model, 3500)).toBe(0); // 到期
    expect(retryCountdownSeconds(model, 9000)).toBe(0); // 已过
  });

  it('active 判定：未到期 true，到期/非法 false', () => {
    const model = { delayMs: 1000, startedAt: 0 };
    expect(retryCountdownActive(model, 500)).toBe(true);
    expect(retryCountdownActive(model, 1000)).toBe(false);
    expect(retryCountdownActive({ delayMs: Number.NaN, startedAt: 0 }, 0)).toBe(false);
  });
});
