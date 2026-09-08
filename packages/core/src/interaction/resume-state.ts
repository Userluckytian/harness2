// S3c1/S3c2 共享：resume/cancel/submit 接线缝 + 带水位的 delta 展示投影映射（纯逻辑层）。
// 无 server/agent 依赖（只依赖 interaction/types）——sessions.ts（hub）与 ws.ts（传输）都可
// 安全引用，不引入 sessions↔ws 模块环。事件溯源不破坏：这里只做「展示投影」的水位映射，
// 不写任何 session 日志事件；模型可见输入仍由 session.log 投影重建。
import type {
  CancelAck,
  CancelRequest,
  DeliveryDeltaFrame,
  ResumeSnapshot,
  ResumeSubscriptionRequest,
  SubmitAck,
  SubmitRequest,
} from './types.js';
import { assertSequentialChunk } from './types.js';

/** delta 展示投影的归属（turn/attempt 身份）
 *  - turnId：loop 单点生成的真实 turn id（经 TurnStreamEvent/TurnResult 透出）；
 *  - attemptId：hub 按 turn 合成的尝试 id（loop 未外露 attempt 边界，S5/S6 深化）。
 */
export interface DeltaAttribution {
  turnId: string;
  attemptId: string;
}

/**
 * 带水位的 delta 传输映射：每个 (session, attempt, kind) 维护独立 text/reasoning 水位。
 * accept 按调用方给出的 chunkOffset（对齐 S0 DeliveryDeltaFrame）判定连续性：首块必须 offset==0，
 * 续块必须 offset == 上一块 offset + 上一块文本长度（S0 assertSequentialChunk）；重复/重叠（迟到 offset）
 * 与缺口（超前 offset）丢弃返回 null。
 */
export class WatermarkCursor {
  /** key = sessionId\0attemptId → 最新已放行块（kind 各自独立） */
  private readonly textLast = new Map<string, { offset: number; text: string }>();
  private readonly reasoningLast = new Map<string, { offset: number; text: string }>();

  private key(sessionId: string, attemptId: string): string {
    return `${sessionId}\u0000${attemptId}`;
  }

  /** 判定并登记一块连续 delta；不连续（重复/重叠/缺口）丢弃返回 null。chunkOffset 由调用方（流/重放源）给定。 */
  accept(
    sessionId: string,
    delta: { kind: 'text' | 'reasoning'; text: string },
    att: DeltaAttribution,
    chunkOffset: number,
  ): DeliveryDeltaFrame | null {
    const map = delta.kind === 'text' ? this.textLast : this.reasoningLast;
    const key = this.key(sessionId, att.attemptId);
    const prev = map.get(key);
    // 首块：chunkOffset 必须为 0；续块：必须严格接续（assertSequentialChunk）
    const ok = prev === undefined
      ? chunkOffset === 0 && isValidOffset(chunkOffset)
      : assertSequentialChunk({ chunkOffset: prev.offset, text: prev.text }, chunkOffset);
    if (!ok) return null;
    const frame: DeliveryDeltaFrame =
      delta.kind === 'text'
        ? { type: 'text-delta', sessionId, turnId: att.turnId, attemptId: att.attemptId, chunkOffset, text: delta.text }
        : { type: 'reasoning-delta', sessionId, turnId: att.turnId, attemptId: att.attemptId, chunkOffset, text: delta.text };
    map.set(key, { offset: chunkOffset, text: delta.text });
    return frame;
  }

  /** 重置某会话指定 attempt 水位（attempt-final 落定后调用；新 attempt 从 0 计数） */
  reset(sessionId: string, attemptId: string): void {
    this.textLast.delete(this.key(sessionId, attemptId));
    this.reasoningLast.delete(this.key(sessionId, attemptId));
  }
}

function isValidOffset(v: number): boolean {
  return Number.isInteger(v) && v >= 0;
}

/**
 * S3c2 接线缝：resume/cancel/submit 的实际执行/队列状态提供者（由 hub 实现；ws.ts 传输层经此转发）。
 * 未接线（不注入 provider）时：resumeSnapshot 无法协商 → 会话已存在则回 error 帧告知未支持；
 * submitAck 回 unknown（≠rejected，调用方不得当拒绝）；cancelAck 回 unknown。
 */
export interface ResumeStateProvider {
  /** 构造 resume-snapshot 的除 epoch/replay 外的在途/队列状态；null = 会话不存在或未接线 */
  resumeSnapshot(req: ResumeSubscriptionRequest): Omit<ResumeSnapshot, 'epoch' | 'replay'> | null;
  /** submit 帧的幂等 ack（durable 先行，后 ack；实际入队/派发由此层接线） */
  submitAck(req: SubmitRequest): SubmitAck;
  /** cancel 帧的三态 ack（实际取消传播由此层接线） */
  cancelAck(req: CancelRequest): CancelAck;
}