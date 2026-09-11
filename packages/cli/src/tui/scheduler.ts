// T4 有界 UI 调度器（纯逻辑，无 ink/react 依赖）：
//   - 合并：push 后在 flushMs 窗口内合并为一批 onFlush，长流不逐事件重绘；
//   - 有界：单次 flush 最多 maxBatch 条，溢出留队并重新排期（不长时间独占主线程）；
//   - 输入优先：setInputPriority(true) 挂起后台（timer 驱动）flush，队列保留；解除后立即补发；
//     flushNow()（输入驱动/final flush）不受输入优先影响，始终立即生效；
//   - 退出干净：flushNow() 排空全部待处理；dispose() 清 timer、拒绝后续 flush（无残留 timer）。

export interface UiSchedulerOptions<T> {
  /** 合并窗口（ms）；缺省 16（约一帧） */
  flushMs?: number;
  /** 单次 flush 上限（条）；缺省 64 */
  maxBatch?: number;
  onFlush: (batch: T[]) => void;
}

export interface UiScheduler<T> {
  push(e: T): void;
  setInputPriority(on: boolean): void;
  /** final flush：排空全部待处理（按 maxBatch 分批，不丢事件） */
  flushNow(): void;
  dispose(): void;
  pending(): number;
}

export const UI_FLUSH_MS_DEFAULT = 16;
export const UI_MAX_BATCH_DEFAULT = 64;

export function createUiScheduler<T>(opts: UiSchedulerOptions<T>): UiScheduler<T> {
  const flushMs = Math.max(0, opts.flushMs ?? UI_FLUSH_MS_DEFAULT);
  const maxBatch = Math.max(1, Math.floor(opts.maxBatch ?? UI_MAX_BATCH_DEFAULT));
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let inputPriority = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 取一批（≤maxBatch）回调；返回是否仍有剩余 */
  const drainBounded = (): boolean => {
    if (disposed || queue.length === 0) return false;
    const batch = queue.slice(0, maxBatch);
    queue = queue.slice(maxBatch);
    opts.onFlush(batch);
    return queue.length > 0;
  };

  const schedule = (): void => {
    if (disposed || timer !== null || inputPriority || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || inputPriority) return;
      // 单批后若仍有剩余，重新排期（有界，不一次吃满主线程）
      if (drainBounded()) schedule();
    }, flushMs);
  };

  return {
    push(e) {
      if (disposed) return;
      queue.push(e);
      schedule();
    },
    setInputPriority(on) {
      inputPriority = on;
      if (on) {
        clearTimer(); // 挂起后台 flush（队列保留）
        return;
      }
      if (!disposed && queue.length > 0) {
        if (drainBounded()) schedule();
        else clearTimer();
      }
    },
    flushNow() {
      if (disposed) return;
      clearTimer();
      // 输入驱动/final flush：同步排空（每批仍受 maxBatch 约束）
      while (drainBounded()) {
        /* 继续分批 */
      }
    },
    dispose() {
      disposed = true;
      clearTimer();
      queue = [];
    },
    pending: () => queue.length,
  };
}

// —— retry 倒计时纯模型（供 retry-panel 使用；真值来源为冻结的 RetryBudgetState） ——

export interface RetryCountdownModel {
  /** 本次退避等待总时长（ms） */
  delayMs: number;
  /** 本次等待起点（epoch ms） */
  startedAt: number;
}

/** 剩余等待秒数：向上取整、夹取到 ≥0；非法输入按 0（fail-safe，不显示负数倒计时） */
export function retryCountdownSeconds(model: RetryCountdownModel, now: number): number {
  if (!Number.isFinite(model.delayMs) || !Number.isFinite(model.startedAt) || !Number.isFinite(now)) return 0;
  const remainingMs = model.startedAt + model.delayMs - now;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

/** 等待是否仍在进行 */
export function retryCountdownActive(model: RetryCountdownModel, now: number): boolean {
  if (!Number.isFinite(model.delayMs) || !Number.isFinite(model.startedAt) || !Number.isFinite(now)) return false;
  return now < model.startedAt + model.delayMs;
}
