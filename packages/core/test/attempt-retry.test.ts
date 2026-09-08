// S4a 有界重试策略纯逻辑测试（预算/退避/分类/Retry-After/可取消等待）。
// 只测 interaction/retry-policy.ts 纯函数与状态机：不接 provider/loop/agent（那是 S4b），
// 不真实等 120s（全部用 fake timers 或纯调度断言）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RetryAbortError,
  backoffSeconds,
  classifyAttemptError,
  createRetryBudget,
  effectiveDelay,
  waitWithAbort,
  withJitter,
} from '../src/interaction/retry-policy.js';
import {
  RETRY_BACKOFF_SECONDS,
  RETRY_MAX_EXTRA_ATTEMPTS,
  RETRY_MAX_EXTRA_PER_TURN,
  RETRY_MAX_TOTAL_WAIT_SECONDS,
} from '../src/interaction/types.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyAttemptError：复用 classifyRetryable', () => {
  it('可恢复（429/503/network/timeout/stream_truncated/rate_limit/server_5xx）→ retryable', () => {
    for (const code of ['429', '503', 'network', 'timeout', 'stream_truncated', 'rate_limit', 'server_5xx']) {
      const r = classifyAttemptError({ code });
      expect(r.retryable).toBe(true);
      expect(r.category).toBe('retryable');
      expect(r.reason?.length).toBeGreaterThan(0);
    }
  });

  it('不可恢复（401/403/参数/quota/用户取消/拒绝/内容过滤）→ 不重试', () => {
    for (const code of ['401', '403', 'invalid_request', 'quota', 'user_cancelled', 'refusal', 'content_filter']) {
      expect(classifyAttemptError({ code })).toMatchObject({ retryable: false, category: 'non_retryable' });
    }
  });

  it('unknown：未知码/无码/非对象 → 不默认重试', () => {
    expect(classifyAttemptError({ code: 'weird_code' })).toMatchObject({ retryable: false, category: 'unknown' });
    expect(classifyAttemptError(new Error('boom'))).toMatchObject({ retryable: false, category: 'unknown' });
    expect(classifyAttemptError(Object.assign(new Error('429'), { code: '429' }))).toMatchObject({
      retryable: true,
      category: 'retryable',
    });
    expect(classifyAttemptError(undefined)).toMatchObject({ retryable: false, category: 'unknown' });
    expect(classifyAttemptError(null)).toMatchObject({ retryable: false, category: 'unknown' });
    expect(classifyAttemptError('oops')).toMatchObject({ retryable: false, category: 'unknown' });
  });

  it('错误携带 retryAfter 时透出为秒（Retry-After 优先的输入）', () => {
    expect(classifyAttemptError({ code: '429', retryAfter: 12 })).toMatchObject({
      retryable: true,
      retryAfterSeconds: 12,
    });
    expect(classifyAttemptError({ code: '429', retryAfterSeconds: 3 })).toMatchObject({
      retryable: true,
      retryAfterSeconds: 3,
    });
    expect(classifyAttemptError({ code: '429' }).retryAfterSeconds).toBeUndefined();
  });
});

describe('backoffSeconds：2/10/30 档 + ±20% 抖动；4th+ 封顶 30', () => {
  const noJitter = () => 0.5;

  it('无抖动路径（rand=0.5 → ×1.0）：单失败链档位 2/10/30', () => {
    expect(RETRY_BACKOFF_SECONDS).toEqual([2, 10, 30]);
    expect(backoffSeconds(0, noJitter)).toBe(2);
    expect(backoffSeconds(1, noJitter)).toBe(10);
    expect(backoffSeconds(2, noJitter)).toBe(30);
  });

  it('第 4 次起继续 30 档封顶（per-attempt cap=3 外应由 loop 拒绝，这里只钉调度档）', () => {
    expect(backoffSeconds(3, noJitter)).toBe(30);
    expect(backoffSeconds(4, noJitter)).toBe(30);
  });

  it('抖动 ±20%：rand=0 → 0.8×，rand=1 → 1.2×', () => {
    expect(backoffSeconds(0, () => 0)).toBeCloseTo(2 * 0.8, 6);
    expect(backoffSeconds(1, () => 1)).toBeCloseTo(10 * 1.2, 6);
    expect(backoffSeconds(2, () => 1)).toBeCloseTo(30 * 1.2, 6);
    expect(backoffSeconds(3, () => 0)).toBeCloseTo(30 * 0.8, 6);
  });

  it('真实随机路径保留：任意 rand 输出稳定落在 [0.8×,1.2×] 内', () => {
    for (let i = 0; i < 200; i++) {
      const chain = i % 4;
      const v = backoffSeconds(chain, Math.random);
      const tier = RETRY_BACKOFF_SECONDS[Math.min(chain, RETRY_BACKOFF_SECONDS.length - 1)]!;
      expect(v).toBeGreaterThanOrEqual(tier * 0.8 - 1e-9);
      expect(v).toBeLessThanOrEqual(tier * 1.2 + 1e-9);
    }
  });

  it('withJitter(seed)：同 seed 序列确定一致，不同 seed 不同', () => {
    const a1 = withJitter(42);
    const a2 = withJitter(42);
    const b1 = withJitter(7);
    const seqA = [a1(), a1(), a1()];
    const seqA2 = [a2(), a2(), a2()];
    const seqB = [b1(), b1(), b1()];
    expect(seqA).toEqual(seqA2);
    expect(seqA).not.toEqual(seqB);
    for (const v of [...seqA, ...seqA2, ...seqB]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('createRetryBudget：per-turn 上限 6 + 累计等待 ≤120s', () => {
  it('初始可用；每次 record 计一次额外，cap=6 后第 7 次拒绝', () => {
    const b = createRetryBudget();
    expect(b.usedAttempts).toBe(0);
    expect(b.waitMs).toBe(0);
    expect(b.canRetry()).toBe(true);
    for (let i = 1; i <= RETRY_MAX_EXTRA_PER_TURN; i++) {
      expect(b.canRetry()).toBe(true);
      b.record(0);
    }
    expect(b.usedAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(b.canRetry()).toBe(false);
  });

  it('累计等待封顶 120s：耗尽后 canRetry 拒绝（即使次数未满）', () => {
    const b = createRetryBudget();
    b.record(60_000);
    b.record(60_000);
    expect(b.waitMs).toBe(RETRY_MAX_TOTAL_WAIT_SECONDS * 1000);
    expect(b.remainingWaitMs()).toBe(0);
    expect(b.usedAttempts).toBe(2);
    expect(b.canRetry()).toBe(false);
  });
});

describe('effectiveDelay：Retry-After 优先；超剩余预算 → stop', () => {
  it('预算内：Retry-After（秒）→ delayMs 全额放行', () => {
    const b = createRetryBudget();
    expect(effectiveDelay(2, b)).toEqual({ stop: false, delayMs: 2000 });
    expect(effectiveDelay(30, b)).toEqual({ stop: false, delayMs: 30_000 });
  });

  it('恰好等于剩余预算 → 允许', () => {
    const b = createRetryBudget();
    b.record(100_000);
    expect(effectiveDelay(20, b)).toEqual({ stop: false, delayMs: 20_000 });
  });

  it('超剩余预算（剩 20s，Retry-After 30s）→ stop 并告知，不提前违规重试', () => {
    const b = createRetryBudget();
    b.record(100_000);
    const r = effectiveDelay(30, b);
    expect(r.stop).toBe(true);
    if (r.stop) {
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('累计 120s 已耗尽 → 任何正 Retry-After 都 stop', () => {
    const b = createRetryBudget();
    b.record(30_000);
    b.record(30_000);
    b.record(30_000);
    b.record(30_000);
    expect(b.remainingWaitMs()).toBe(0);
    expect(effectiveDelay(backoffSeconds(0, () => 0.5), b).stop).toBe(true);
  });

  it('Retry-After 非法（0/负/NaN/Infinity）→ 忽略为即时（delayMs 0）', () => {
    const b = createRetryBudget();
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveDelay(v, b)).toEqual({ stop: false, delayMs: 0 });
    }
  });
});

describe('waitWithAbort：可取消等待（虚拟时钟，不真实等）', () => {
  it('到时 resolve（advanceTimersByTimeAsync 推进）', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = waitWithAbort(30_000, ac.signal);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBeUndefined();
  });

  it('abort 中断等待 → 拒绝为 cancel 分类错误（user_cancelled，不自动重试）', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = waitWithAbort(30_000, ac.signal);
    ac.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAbortError);
    expect((err as RetryAbortError).code).toBe('user_cancelled');
  });

  it('signal 已 abort 时立即拒绝（不悬挂到计时结束）', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    ac.abort();
    await expect(waitWithAbort(0, ac.signal)).rejects.toBeInstanceOf(RetryAbortError);
  });

  it('RetryAbortError 被分类为 user_cancelled：用户取消 → 不自动重试', () => {
    expect(classifyAttemptError(new RetryAbortError('cancelled'))).toMatchObject({
      retryable: false,
      category: 'non_retryable',
    });
  });
});

describe('整合调度：429 单失败链档位 + per-turn 停止边界', () => {
  it('429 → 3 次额外重试档位 2/10/30，累计 42s，可继续新失败', () => {
    const budget = createRetryBudget();
    const error = { code: '429' };
    const got: number[] = [];
    let chain = 0;
    while (chain < RETRY_MAX_EXTRA_ATTEMPTS) {
      expect(classifyAttemptError(error).retryable).toBe(true);
      if (!budget.canRetry()) break;
      const eff = effectiveDelay(backoffSeconds(chain, () => 0.5), budget);
      if (eff.stop) break;
      budget.record(eff.delayMs);
      got.push(eff.delayMs);
      chain++;
    }
    expect(got).toEqual([2000, 10_000, 30_000]);
    expect(budget.usedAttempts).toBe(RETRY_MAX_EXTRA_ATTEMPTS);
    expect(budget.waitMs).toBe(42_000);
    expect(budget.canRetry()).toBe(true);
  });

  it('整 turn 混合失败：per-turn cap=6 先到（累计 84s < 120s）→ 第 7 次拒绝', () => {
    const budget = createRetryBudget();
    const noJitter = () => 0.5;
    let extraUsed = 0;
    for (let chain = 0; budget.canRetry(); chain++) {
      const eff = effectiveDelay(backoffSeconds(chain % (RETRY_MAX_EXTRA_ATTEMPTS + 1), noJitter), budget);
      if (eff.stop) break;
      budget.record(eff.delayMs);
      extraUsed++;
    }
    expect(extraUsed).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(budget.usedAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(budget.waitMs).toBe(84_000);
    expect(budget.canRetry()).toBe(false);
  });

  it('S0 冻结数字自洽：3（单失败链）< 6（整 turn）；档位 2+10+30+30=72s ≤120s', () => {
    expect(RETRY_MAX_EXTRA_ATTEMPTS).toBe(3);
    expect(RETRY_MAX_EXTRA_PER_TURN).toBe(6);
    expect(RETRY_MAX_EXTRA_ATTEMPTS).toBeLessThan(RETRY_MAX_EXTRA_PER_TURN);
    const sum = RETRY_BACKOFF_SECONDS.reduce((a, b) => a + b, 0) + RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1]!;
    expect(sum).toBe(72);
    expect(sum).toBeLessThanOrEqual(RETRY_MAX_TOTAL_WAIT_SECONDS);
  });
});