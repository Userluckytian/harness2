// 会话级 steer sink（S6 会话级接线，FixD F2）：hub 按会话持有，跨 turn 持久。
// 接收/去重/排队都在本 sink 完成（会话级），loop 只在安全 step 边界 take() 消费。
// 语义：
//   - push()：外部提交（submit/WS）入队；**会话级去重在入队时完成**——同 id 全局只生效
//     一次（跨 turn 持续），重复提交立刻 resolve('rejected')（不占队位、不双注入）；
//   - take()：loop 在安全 step 边界取一条待应用 steer；turn 间未被消费的保持排队，
//     expectedTurnId 是否匹配当前 turn 由 loop 判定（stale → draftKept 拒绝，不应用）；
//   - resolve()：loop 回帧（accepted/stale/rejected）→ 记录历史 + 观察者回调（WS/测试）。
// 纯控制输入：不写 session.log（事件溯源不破坏，steer 不进投影正文）。
import type { SteerSink } from '../agent/types.js';
import type { SteerRequest, SteerResult } from './types.js';

/** 会话级 steer sink 的观察者（WS/测试订阅 resolution 回帧） */
export interface SteerSinkObserver {
  onSteerResult?(result: SteerResult): void;
}

export class SessionSteerSink implements SteerSink {
  private readonly queue: SteerRequest[] = [];
  /** 会话级去重集合：同 id 全局只生效一次（跨 turn 持续，不随 turn 清理） */
  private readonly seenIds = new Set<string>();
  private readonly results: SteerResult[] = [];
  private readonly observers: SteerSinkObserver[] = [];

  constructor(private readonly notify?: (result: SteerResult) => void) {}

  /** 外部提交入队：新 id → 入队并返回 true；重复 id → 立即 rejected 回帧并返回 false */
  push(req: SteerRequest): boolean {
    if (this.seenIds.has(req.id)) {
      this.emit({ id: req.id, expectedTurnId: req.expectedTurnId, state: 'rejected' });
      return false;
    }
    this.seenIds.add(req.id);
    this.queue.push(req);
    return true;
  }

  take(): SteerRequest | undefined {
    return this.queue.shift();
  }

  resolve(result: SteerResult): void {
    this.emit(result);
  }

  observe(observer: SteerSinkObserver): () => void {
    this.observers.push(observer);
    return () => {
      const i = this.observers.indexOf(observer);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  /** 回帧历史（诊断/测试；与观察者回调同源） */
  history(): SteerResult[] {
    return [...this.results];
  }

  /** 当前排队条数（诊断） */
  get size(): number {
    return this.queue.length;
  }

  private emit(result: SteerResult): void {
    this.results.push(result);
    try {
      this.notify?.(result);
    } catch {
      // 观察者异常不回写内核
    }
    for (const o of this.observers) {
      try {
        o.onSteerResult?.(result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }
}
