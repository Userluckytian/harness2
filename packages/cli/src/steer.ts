// CLI 侧 steer 控制输入接线（T5）。
//
// 背景：core 只把 `SteerSink` **接口**（`agent/types.ts`）与 `SteerRequest/SteerResult`
// （`interaction/types.ts`）从包根导出；参考实现 `SessionSteerSink`（`interaction/steer-sink.ts`）
// 仅 core 内部（server/sessions-*）使用，**未进入 `@harness2/core` 公开导出面**，
// 且 package `exports` 只暴露 "."，CLI 无法自子路径只读引入。
// 故本文件按同一语义在 CLI 内实现一个满足公开接口的会话级 sink——这是「接口在、实现不在」的
// 诚实兜底，不是把 core 编排逻辑搬进 CLI（消费仍由 core loop 在安全 step 边界完成）。
// 一旦 core 导出具体实现，应改为直接复用（见当天日志缺口登记）。
//
// 语义（与 core 权威实现一致）：
//   - push：同 id 全局只生效一次；重复 → 立即回帧 rejected 且不入队；
//   - take：loop 在安全 step 边界取一条；
//   - resolve：loop 回帧 accepted/stale/rejected（stale 带 draftKept，UI 必须保留草稿）；
//   - steer 是纯控制输入，不写 session.log，不进投影正文。
import type { SteerRequest, SteerResult, SteerSink } from '@harness2/core';

/** steer sink 观察者（UI 订阅 resolution 回帧以报告 accepted/stale/rejected） */
export interface SteerSinkObserver {
  onSteerResult?(result: SteerResult): void;
}

/** CLI 会话级 steer sink（接口见 core `SteerSink`） */
export class CliSteerSink implements SteerSink {
  private readonly queue: SteerRequest[] = [];
  /** 同 id 全局只生效一次（跨 turn 持续） */
  private readonly seenIds = new Set<string>();
  private readonly results: SteerResult[] = [];
  private readonly observers = new Set<SteerSinkObserver>();

  /** 入队：新 id → true；重复 id → 立即 rejected 回帧并返回 false（不占队位、不双注入） */
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
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** 回帧历史（诊断/测试） */
  history(): SteerResult[] {
    return [...this.results];
  }

  /** 当前排队条数（诊断） */
  get size(): number {
    return this.queue.length;
  }

  private emit(result: SteerResult): void {
    this.results.push(result);
    for (const o of this.observers) {
      try {
        o.onSteerResult?.(result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }
}

/** steer id 序列号（会话内唯一；带时间戳避免跨进程碰撞） */
export function makeSteerId(seq: number, now: number = Date.now()): string {
  return `cli-steer-${now}-${seq}`;
}

/**
 * 构造 steer 请求（纯函数）：turnId 未知或文本空白 → null。
 * 调用方据此「保留草稿并报 unknown」，绝不猜一个 turnId。
 */
export function buildSteerRequest(turnId: string | undefined, id: string, text: string): SteerRequest | null {
  if (turnId === undefined || turnId.length === 0) return null;
  if (text.trim().length === 0) return null;
  return { id, expectedTurnId: turnId, text };
}

/** 提交结转（同步）：submitted = 已入队待 boundary；unknown/rejected = 草稿保留 */
export type SteerSubmitOutcome =
  | { state: 'submitted'; id: string; turnId: string; message: string }
  | { state: 'unknown'; reason: string; draftKept: true; message: string }
  | { state: 'rejected'; id?: string; reason: string; draftKept: true; message: string };

/** 回帧 → UI 报告文案（stale 必须体现「草稿已保留」） */
export function describeSteerResult(result: SteerResult): { line: string; draftKept: boolean } {
  switch (result.state) {
    case 'accepted':
      return { line: `steer 已接受（已在安全 step 边界应用；不写日志正文）`, draftKept: false };
    case 'stale':
      return {
        line: `steer 已过期（expectedTurnId 与当前 turn 不匹配）· 草稿已保留（未 abort/未自动重发）`,
        draftKept: result.draftKept ?? true,
      };
    default:
      return { line: `steer 被拒绝（重复 id 或应用窗口已关闭）· 草稿已保留`, draftKept: true };
  }
}
