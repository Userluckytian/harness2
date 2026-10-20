// chat-error-model.ts — Z-96 composer 错误横幅的**纯决策**（零 React / 零 DOM）：
//   1) `latestSubmitAckError`：从 store 的 submitAcks（唯一事实源：controller 失败即
//      applyFrame `submit-ack unknown`（含 5s 超时兜底 expirePendingSubmits），serve 拒绝
//      则 `rejected`）取**最后一条**结论——unknown/rejected → 横幅，accepted → null
//      （重发成功自然清除，无需手动关）；
//   2) `errorFingerprint`：按「state + reason」构成的指纹（Z-96「关横幅按错误指纹去重」
//      ——关掉同一条错误后，同一错误不立刻顶回；新错误不同指纹，照常出现）；
//   3) `mergeErrorDetail`：把 composer onSubmitError 拿到的**底层 error**（含 stack）并入
//      横幅 detail（「查看详情」Dialog 与「复制完整报错」的原文），并配对同一次失败。
import type { SubmitAckStateShape } from '../../shared/protocol.js';

export interface ChatErrorMessage {
  /** 横幅展示消息（单行截断） */
  message: string;
  /** 完整原文（详情 Dialog / 复制用）；缺 = 只有 message */
  detail?: string | undefined;
  /** 去重指纹（X 关闭后同指纹不再顶回） */
  fingerprint: string;
}

/** store submitAcks 的最小形状（结构子集，避免绑死 SessionStream） */
export interface SubmitAckLike {
  state: SubmitAckStateShape;
  reason?: string | undefined;
}

/** 指纹 = state + reason（不含 clientMessageId：同一原因重试视作同一错误，去重成立） */
export function errorFingerprint(state: SubmitAckStateShape, reason: string | undefined): string {
  return `${state}:${reason ?? ''}`;
}

/**
 * 最新一次提交的结论（对象键序 = 插入序：store 每次 `{ ...prev, [id]: ack }` 重建）。
 * 最后一条 ack 为 `unknown` / `rejected` → 横幅候选；为 `accepted` → null（用户重发成功后
 * 旧失败自然消失，无需手动关——失败横幅反映的是**最近一次**提交的真实结论）。
 * unknown ≠ rejected 语义区别保留在文案里（F7：不假报、不诱导重发）。
 */
export function latestSubmitAckError(acks: Readonly<Record<string, SubmitAckLike>>): ChatErrorMessage | null {
  let last: SubmitAckLike | null = null;
  for (const ack of Object.values(acks)) last = ack;
  if (last === null) return null;
  if (last.state !== 'unknown' && last.state !== 'rejected') return null;
  const message =
    last.reason ??
    (last.state === 'rejected' ? '服务端拒绝了本次提交（未给出原因）' : '提交未送达（未收到服务端确认）');
  return { message, fingerprint: errorFingerprint(last.state, last.reason) };
}

/** 底层提交失败（composer onSubmitError 回传；装配层按此并入 detail） */
export interface SubmitFailureInfo {
  /** error.message（与 ack reason 配对：channel 失败时 reason = `提交未送达: ${message}`） */
  message: string;
  /** error.stack（可缺；详情/复制的完整原文优先 stack） */
  stack?: string | undefined;
}

/**
 * 把底层 error 并入横幅 detail：仅当 error 与 ack 指纹同源（message 相等，或
 * ack.reason = `提交未送达: message`）时附带 —— 避免上一条失败的旧 error 串到新横幅上。
 */
export function mergeErrorDetail(base: ChatErrorMessage, failure: SubmitFailureInfo | null): ChatErrorMessage {
  if (failure === null) return base;
  const sameOrigin = base.message === failure.message || base.message === `提交未送达: ${failure.message}`;
  if (!sameOrigin) return base;
  const detail = failure.stack !== undefined && failure.stack.length > 0 ? failure.stack : failure.message;
  return { ...base, detail };
}

/** X 关闭去重集合（指纹有界，防无界增长；最新插入者保留在尾部） */
export const DISMISSED_FINGERPRINT_LIMIT = 50;

export function withDismissedFingerprint(dismissed: ReadonlySet<string>, fingerprint: string): Set<string> {
  const next = new Set(dismissed);
  next.add(fingerprint);
  if (next.size > DISMISSED_FINGERPRINT_LIMIT) {
    const oldest = next.values().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next;
}
