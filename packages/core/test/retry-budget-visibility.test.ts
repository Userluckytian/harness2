// FixC D1 — retry 预算语义明确 + 桌面可读状态（方案二：不持久化，暴露 budgetState）。
// 验收判定 D（P0-2c）：
//   - retry-policy 暴露 budgetState：used / remaining / stopReason（none | budget-exhausted | timeout | retry-after）；
//   - 预算超限有明确停因（不能只静默停）；
//   - run-config 视图提供可读的已耗/剩余/停因字段（桌面可展示「为什么停」）；
//   - 语义 = per-attempt 会话独立计数（重启清零是设计语义，不持久化）。
// 纯策略层 + runTurn 接线层 + run-config 视图层三层断言。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRetryBudget,
  effectiveDelay,
  type BudgetStopReason,
  type RetryBudgetState,
} from '../src/interaction/retry-policy.js';
import { buildEffectiveRunConfig, type EffectiveRunConfigInput } from '../src/interaction/run-config.js';
import { MockProvider } from '../src/provider/mock.js';
import { runTurn } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RETRY_MAX_EXTRA_PER_TURN, RETRY_MAX_TOTAL_WAIT_SECONDS } from '../src/interaction/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-budget-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('budgetState 可读快照（used / remaining / stopReason）', () => {
  it('初始：used=0、remaining=6、remainingWait=120s、stopReason=none', () => {
    const b = createRetryBudget();
    const s: RetryBudgetState = b.budgetState();
    expect(s.usedAttempts).toBe(0);
    expect(s.remainingAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(s.remainingWaitMs).toBe(RETRY_MAX_TOTAL_WAIT_SECONDS * 1000);
    expect(s.stopReason).toBe('none');
  });

  it('[核心] 次数预算超限 → stopReason=budget-exhausted（明确停因，非静默）', () => {
    const b = createRetryBudget();
    for (let i = 0; i < RETRY_MAX_EXTRA_PER_TURN; i++) b.record(0);
    const s = b.budgetState();
    expect(s.usedAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(s.remainingAttempts).toBe(0);
    expect(b.canRetry()).toBe(false);
    expect(s.stopReason).toBe('budget-exhausted');
  });

  it('[核心] 累计等待预算超限 → stopReason=timeout（即使次数未满）', () => {
    const b = createRetryBudget();
    b.record(60_000);
    b.record(60_000);
    const s = b.budgetState();
    expect(s.remainingWaitMs).toBe(0);
    expect(s.usedAttempts).toBe(2);
    expect(b.canRetry()).toBe(false);
    expect(s.stopReason).toBe('timeout');
  });

  it('[核心] Retry-After 超出剩余预算 → 停因 retry-after（可标记进 budgetState）', () => {
    const b = createRetryBudget();
    b.record(100_000); // 剩 20s
    const eff = effectiveDelay(30, b); // Retry-After 30s > 剩 20s
    expect(eff.stop).toBe(true);
    b.markStop('retry-after');
    expect(b.budgetState().stopReason).toBe('retry-after');
  });

  it('remainingAttempts/remainingWaitMs 随 record 单调递减且恒 ≥ 0', () => {
    const b = createRetryBudget();
    b.record(10_000);
    const s1 = b.budgetState();
    expect(s1.remainingAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN - 1);
    expect(s1.remainingWaitMs).toBe((RETRY_MAX_TOTAL_WAIT_SECONDS - 10) * 1000);
    b.record(Number.MAX_SAFE_INTEGER); // 超预算 record：clamp 到 0，不越界
    expect(b.budgetState().remainingWaitMs).toBe(0);
    expect(b.budgetState().remainingAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN - 2);
  });

  it('stopReason 类型集合冻结（桌面契约枚举）', () => {
    const reasons: BudgetStopReason[] = ['none', 'budget-exhausted', 'timeout', 'retry-after'];
    for (const r of reasons) {
      const b = createRetryBudget();
      if (r === 'budget-exhausted') for (let i = 0; i < RETRY_MAX_EXTRA_PER_TURN; i++) b.record(0);
      if (r === 'timeout') {
        b.record(60_000);
        b.record(60_000);
      }
      if (r === 'retry-after') b.markStop('retry-after');
      expect(b.budgetState().stopReason).toBe(r);
    }
  });
});

describe('run-config 视图暴露 retry.budget（桌面可读 used/remaining/stopReason）', () => {
  function baseInput(retryBudget?: RetryBudgetState): EffectiveRunConfigInput {
    return {
      session: { sessionId: 's1', root: tmpDir(), cwd: tmpDir(), cwdFromHeader: true },
      provider: { role: 'main', channel: 'c', model: 'm', protocol: 'openai', name: 'c/m' },
      memoryMode: 'off',
      tools: ['bash'],
      snapshot: { revision: 1, capturedAt: '2026-09-09T00:00:00.000Z', effectiveAt: '2026-09-09T00:00:00.000Z' },
      ...(retryBudget !== undefined ? { retryBudget } : {}),
    };
  }

  it('提供 budgetState → 视图 context.retry.budget 原样暴露 used/remaining/stopReason 且深度冻结', () => {
    const b = createRetryBudget();
    for (let i = 0; i < RETRY_MAX_EXTRA_PER_TURN; i++) b.record(0);
    const budget = b.budgetState();
    const view = buildEffectiveRunConfig(baseInput(budget));

    expect(view.context.retry.budget).toBeDefined();
    expect(view.context.retry.budget?.usedAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(view.context.retry.budget?.remainingAttempts).toBe(0);
    expect(view.context.retry.budget?.stopReason).toBe('budget-exhausted');
    expect(Object.isFrozen(view.context.retry.budget)).toBe(true);
  });

  it('未提供 budgetState（如从未发生重试）→ 字段缺省不出现（不臆造）', () => {
    const view = buildEffectiveRunConfig(baseInput());
    expect(view.context.retry.budget).toBeUndefined();
  });

  it('retry-after 停因经视图可读：桌面能展示「为什么停」', () => {
    const b = createRetryBudget();
    b.record(100_000);
    expect(effectiveDelay(30, b).stop).toBe(true);
    b.markStop('retry-after');
    const view = buildEffectiveRunConfig(baseInput(b.budgetState()));
    expect(view.context.retry.budget?.stopReason).toBe('retry-after');
  });
});

describe('runTurn 接线：预算停因随 TurnResult.retryBudget 暴露', () => {
  it('整 turn 次数耗尽 → result.retryBudget.stopReason=budget-exhausted（used=6/remaining=0）', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const dir = tmpDir();
    const script = Array.from({ length: RETRY_MAX_EXTRA_PER_TURN + 1 }, () => ({
      error: '429',
      retryAfterSeconds: 0.01,
    }));
    const provider = new MockProvider(script as never[]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    const flush = async (): Promise<void> => {
      let settled = false;
      pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      let waited = 0;
      while (!settled && waited < 400_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
    };
    await flush();
    const result = await pending;

    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('重试预算已耗尽');
    expect(result.retryBudget?.stopReason).toBe('budget-exhausted');
    expect(result.retryBudget?.usedAttempts).toBe(RETRY_MAX_EXTRA_PER_TURN);
    expect(result.retryBudget?.remainingAttempts).toBe(0);
  });

  it('Retry-After 超剩余预算 → result.retryBudget.stopReason=retry-after', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    // 第一次错误 Retry-After 100s > 120s 预算不超；构造：先耗 100s，再遇 30s Retry-After 只剩 20s → 停
    const provider = new MockProvider([
      { error: 429, retryAfterSeconds: 100 },
      { error: 429, retryAfterSeconds: 30 },
      { text: '不该到达' },
    ]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    const flush = async (): Promise<void> => {
      let settled = false;
      pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      let waited = 0;
      while (!settled && waited < 200_000) {
        await vi.advanceTimersByTimeAsync(1000);
        waited += 1000;
      }
    };
    await flush();
    const result = await pending;

    expect(result.stopReason).toBe('error');
    expect(result.retryBudget?.stopReason).toBe('retry-after');
    expect(result.retryBudget?.usedAttempts).toBe(1);
    expect(result.error).toContain('Retry-After');
  });
});
