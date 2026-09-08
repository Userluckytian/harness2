// S4a 有界重试策略纯逻辑（I1 R2 §6 重试默认策略）。
// 只依赖 interaction/types.ts 冻结的 classifyRetryable + RETRY_* 常量；
// 禁止 import provider/loop/agent（那是 S4b 接线层）。
// 语义：
//   - 可恢复（network/timeout/429/可恢复5xx/stream_truncated）→ 最多额外 3 次（单失败链），
//     退避 2/10/30s 档 + ±20% 抖动，第 4 次起 30 档封顶；整 turn 最多额外 6 次且累计等待 ≤120s；
//   - Retry-After 优先但尊重剩余预算：超过剩余预算 → stop 并告知，不提前违规重试；
//   - 不可恢复（401/403/参数错/quota/用户取消/拒绝/内容过滤）不重试；paused 单独呈现（loop 层）；
//   - 预算/等待可取消（AbortSignal）。
import {
  RETRY_BACKOFF_SECONDS,
  RETRY_MAX_EXTRA_PER_TURN,
  RETRY_MAX_TOTAL_WAIT_SECONDS,
  classifyRetryable,
} from './types.js';
import type { ErrorCategory } from './types.js';

/** 累计等待预算（ms）：120s 封顶 */
const MAX_WAIT_MS = RETRY_MAX_TOTAL_WAIT_SECONDS * 1000;

/** 错误码分类结果（复用 S0 classifyRetryable；unknown 不默认重试） */
export interface AttemptErrorClassification {
  retryable: boolean;
  category: ErrorCategory;
  reason?: string;
  /** 错误携带的 Retry-After（秒），供 S4b 优先于退避档使用 */
  retryAfterSeconds?: number;
}

/** 提取错误码（ProviderError.code / 带 code 属性的 Error / 普通对象） */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  const code = rec['code'];
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** 提取 Retry-After（秒）：优先 retryAfterSeconds，其次 retryAfter；仅接受正有限数字 */
function retryAfterOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  for (const key of ['retryAfterSeconds', 'retryAfter'] as const) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/** 分类 attempt 错误：无码/未知码一律 unknown 且不默认重试 */
export function classifyAttemptError(err: unknown): AttemptErrorClassification {
  const code = errorCodeOf(err);
  const category: ErrorCategory = code === undefined ? 'unknown' : classifyRetryable(code);
  const base: AttemptErrorClassification = {
    retryable: category === 'retryable',
    category,
    reason:
      category === 'retryable'
        ? `可恢复错误(${code ?? 'no-code'})，允许自动重试`
        : category === 'non_retryable'
          ? `不可恢复错误(${code ?? 'no-code'})，不自动重试`
          : `未知错误码(${code ?? 'no-code'})，不默认重试`,
  };
  const retryAfterSeconds = retryAfterOf(err);
  if (retryAfterSeconds !== undefined) base.retryAfterSeconds = retryAfterSeconds;
  return base;
}

/** mulberry32 种子随机数生成器：固定 seed 产生固定序列（抖动确定性测试路径） */
export function withJitter(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 夹取 [0,1]；rand 异常输出也能得到安全抖动系数 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 第 n 次额外重试的退避档位（秒）：按 RETRY_BACKOFF_SECONDS 取档，
 * 第 4 次起继续 30 档（上限）；±20% 抖动。
 * rand 缺省 Math.random（真实路径）；测试可注入固定/种子 rand 走确定性路径。
 */
export function backoffSeconds(attempt: number, rand: () => number = Math.random): number {
  const idx = Math.min(Math.max(0, Math.floor(attempt)), RETRY_BACKOFF_SECONDS.length - 1);
  const baseSeconds = RETRY_BACKOFF_SECONDS[idx] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1]!;
  const factor = 0.8 + clamp01(rand()) * 0.4; // [0.8, 1.2]
  return baseSeconds * factor;
}

/** 整 turn 重试预算状态机：per-turn 额外次数 ≤6 + 累计等待 ≤120s */
export interface RetryBudget {
  /** 整 turn 已用额外次数（含等待均已记录） */
  readonly usedAttempts: number;
  /** 整 turn 已累计等待 ms */
  readonly waitMs: number;
  /** 剩余可等 ms（预算 - 已用，恒 ≥0） */
  remainingWaitMs(): number;
  /** next 是否可重试且未超预算（次数与累计等待任一超限即 false） */
  canRetry(): boolean;
  /** 登记一次额外重试与本轮等待 ms */
  record(delayMs: number): void;
}

export function createRetryBudget(): RetryBudget {
  let usedAttempts = 0;
  let waitMs = 0;
  return {
    get usedAttempts() {
      return usedAttempts;
    },
    get waitMs() {
      return waitMs;
    },
    remainingWaitMs() {
      return Math.max(0, MAX_WAIT_MS - waitMs);
    },
    canRetry() {
      return usedAttempts < RETRY_MAX_EXTRA_PER_TURN && waitMs < MAX_WAIT_MS;
    },
    record(delayMs: number) {
      usedAttempts += 1;
      if (Number.isFinite(delayMs) && delayMs > 0) waitMs += delayMs;
    },
  };
}

/** effectiveDelay 的结果：允许等待（delayMs）或停止（stop+reason） */
export type EffectiveDelay =
  | { stop: false; delayMs: number }
  | { stop: true; reason: string };

/**
 * Retry-After 处理：秒→ms 全额放行（≤ 剩余预算）；超剩余预算 → stop 并告知。
 * 非法 Retry-After（≤0/NaN/Infinity）→ 忽略为 delayMs 0（S4b 落回 backoff 档）。
 */
export function effectiveDelay(retryAfterSeconds: number, budget: RetryBudget): EffectiveDelay {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return { stop: false, delayMs: 0 };
  }
  const wantMs = retryAfterSeconds * 1000;
  if (wantMs > budget.remainingWaitMs()) {
    return {
      stop: true,
      reason: `Retry-After(${retryAfterSeconds}s)超出剩余预算(${budget.remainingWaitMs() / 1000}s)，停止重试并告知`,
    };
  }
  return { stop: false, delayMs: wantMs };
}

/** 取消分类错误：code=user_cancelled（归类 NON_RETRYABLE，loop 不再重试） */
export class RetryAbortError extends Error {
  readonly code = 'user_cancelled' as const;
  constructor(message = '重试等待被取消') {
    super(message);
    this.name = 'RetryAbortError';
  }
}

/**
 * 可取消等待：delayMs 后 resolve；signal 触发 abort → reject RetryAbortError。
 * 双向清理：到时移除 abort 监听；abort 时清除 timer。
 */
export function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}