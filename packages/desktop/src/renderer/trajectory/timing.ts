// 首 token 观测（TTFT 的唯一诚实来源）。
//
// 事实：core 的会话事件日志**不落首 token 时刻**（`assistant/message` 只带结束时的 ts，
// `step/end` 只带总 durationMs）。因此桌面端 TTFT 只能来自**运行时观测**：
// 视图订阅 store 时，某模型 step 从「无输出」变为「有输出」的那一刻（真实墙上时间）。
//
// 两条红线：
//   1. 没观测到 = 没有 TTFT（投影里留 null，UI 留空）——绝不用「总耗时的一半」之类的估算冒充；
//   2. 观测值只在**同一次会话进程内**有效，刷新/换会话即失效（内存态，不落盘、不持久化）。
export type TimingClock = () => number;

export class TrajectoryTimingObserver {
  private readonly clock: TimingClock;
  private readonly firstOutput = new Map<string, number>();
  private cache: Readonly<Record<string, number>> = Object.freeze({});

  constructor(clock: TimingClock = () => Date.now()) {
    this.clock = clock;
  }

  /**
   * 观测一步：`hasOutput=true` 且此前未记录 → 记下当前时刻。
   * 返回 true = 产生了新观测（调用方据此触发一次重渲染）。
   */
  observe(stepId: string, hasOutput: boolean): boolean {
    if (!hasOutput || stepId.length === 0) return false;
    if (this.firstOutput.has(stepId)) return false;
    this.firstOutput.set(stepId, this.clock());
    this.cache = Object.freeze(Object.fromEntries(this.firstOutput));
    return true;
  }

  /** 观测快照（无变化时引用稳定 —— 可直接作 useMemo 依赖） */
  snapshot(): Readonly<Record<string, number>> {
    return this.cache;
  }

  /** 已观测的 stepId 数（调试/测试） */
  size(): number {
    return this.firstOutput.size;
  }

  /** 丢弃某步观测（step 被重试/新 attempt 从零开始时调用） */
  forget(stepId: string): void {
    if (!this.firstOutput.delete(stepId)) return;
    this.cache = Object.freeze(Object.fromEntries(this.firstOutput));
  }

  clear(): void {
    if (this.firstOutput.size === 0) return;
    this.firstOutput.clear();
    this.cache = Object.freeze({});
  }
}

/**
 * 从会话流推导「当前正在模型流式输出的 step」。
 * 依据真实事件顺序：最后一个 `step/start` 之后若还没有对应的 `assistant/message`，
 * 该 step 仍在产出 —— 只有这时才需要观测首 token。
 */
export function currentStreamingStepId(
  events: readonly { readonly active: boolean; readonly type: string; readonly payload: Record<string, unknown> }[],
): string | undefined {
  let activeStep: string | undefined;
  for (const event of events) {
    if (!event.active) continue;
    if (event.type === 'step/start') {
      const stepId = event.payload['stepId'];
      activeStep = typeof stepId === 'string' ? stepId : undefined;
    } else if (event.type === 'assistant/message') {
      activeStep = undefined; // 该 step 的模型流已结束
    }
  }
  return activeStep;
}
