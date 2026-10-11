// A05-2 压缩断路器：自动压缩连续失败 N 次 → 本会话熔断（停用自动压缩），对齐
// agent/loop.ts 既有工具熔断口径（连续计数 + 阈值 + 一次性明确告知）。
//
// 为什么是会话级状态：压缩失败发生在 turn 开始（runCompactionIfNeeded），每 turn 至多
// 一次尝试——per-turn 计数无意义，必须跨 turn 持续。状态由装配方持有（hub 按会话 id
// 懒创建，见 server/sessions-turn.ts；直连 runTurn 的壳可自持），经
// CompactionOptions.breaker 传入；不传 = 熔断不启用（零行为变化）。
//
// 口径：
//   - 任一次压缩成功（compaction/applied 落盘）即清零计数（对齐工具熔断「成功即重置」）；
//   - 熔断为粘性：一旦触发，本会话内不再自动尝试（手动 /compact 不经本断路器，不受影响）；
//   - 阈值 <= 0 = 关闭熔断（只记录计数，永不触发）。
/** 默认熔断阈值：连续 3 次自动压缩失败 */
export const DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

/** 断路器状态快照（测试 / GUI 展示用；纯观察） */
export interface CompactionBreakerSnapshot {
  /** 当前连续失败计数（成功清零；熔断后冻结） */
  consecutiveFailures: number;
  /** 是否已熔断（true = 本会话停用自动压缩） */
  tripped: boolean;
}

export class CompactionBreaker {
  private consecutiveFailures = 0;
  private tripped = false;

  constructor(private readonly threshold: number = DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES) {}

  /** 自动压缩是否还可尝试（已熔断 → false；调用方静默跳过——trip 那轮已明确 warning 一次） */
  canAttempt(): boolean {
    return !this.tripped;
  }

  /**
   * 记一次压缩失败。达到阈值 → 熔断并返回 true（调用方据此给一次性 warning）；
   * 未达阈值 / 阈值关闭（<= 0）返回 false。
   */
  recordFailure(): boolean {
    if (this.tripped) return false;
    this.consecutiveFailures += 1;
    if (this.threshold > 0 && this.consecutiveFailures >= this.threshold) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  /** 记一次压缩成功：连续失败清零（熔断为粘性，不因此解除——熔断后不会再有尝试） */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** 当前状态快照 */
  snapshot(): CompactionBreakerSnapshot {
    return { consecutiveFailures: this.consecutiveFailures, tripped: this.tripped };
  }
}
