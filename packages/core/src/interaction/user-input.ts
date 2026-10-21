// 用户问询（elicitation / AskUserQuestion）往返原语 —— ZS3-T6 core 最小加性面。
// 与 approval 通道并列而不复用：approval 的五态 decision/授权缓存语义与 userInput
// 的开放答案形状不同（映射详表 §3.5；提案 docs/research/2026-10-21-zs3-elicitation-core-proposal.md）。
// 只冻结往返契约；producer（内置 ask_user / MCP elicitation）归后续阶段。
import type { RequestId, SessionId } from './types.js';

/** respond 的 ack：重复/过期/无法定位结果都要明确 */
export type UserInputResponseAckState = 'applied' | 'duplicate' | 'expired' | 'unknown';

export interface UserInputOption {
  optionId: string;
  label: string;
}

export interface UserInputQuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface UserInputQuestion {
  question: string;
  header: string;
  options: UserInputQuestionOption[];
  multiSelect?: boolean;
}

/** 问询请求契约（形状对齐 ZCode userInputRequestPayloadSchema） */
export interface UserInputRequestContract {
  /** 幂等键 */
  requestId: RequestId;
  sessionId: SessionId;
  prompt: string;
  freeText: boolean;
  /** 简单选项（V4UserInputDialog 路径） */
  options?: UserInputOption[];
  /** true → 客户端按敏感输入处理 */
  sensitive?: boolean;
  toolName?: string;
  toolCallId?: string;
  traceId?: string;
  /** JSON Schema 驱动的表单（ElicitationDialog 路径） */
  input?: unknown;
  schema?: unknown;
  questions?: UserInputQuestion[];
  currentQuestionIndex?: number;
  answerDrafts?: Record<string, string[]>;
  /** ISO8601；hub 用 userInputTimeoutMs 派生 */
  expiresAt: string;
  createdAt: string;
}

/** 开放答案：optionId/freeText 兼容路径，action/content 承载 elicitation 回执 */
export interface UserInputAnswer {
  optionId?: string;
  freeText?: string;
  action?: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface UserInputResponseAck {
  requestId: RequestId;
  state: UserInputResponseAckState;
}

export type UserInputSettleReason = 'response' | 'timeout' | 'cancelled' | 'expired';

/** 答案形状守卫（未知值一律 false，调用方按 unknown 处理） */
export function isUserInputAnswer(v: unknown): v is UserInputAnswer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.optionId !== undefined && typeof o.optionId !== 'string') return false;
  if (o.freeText !== undefined && typeof o.freeText !== 'string') return false;
  if (o.action !== undefined && o.action !== 'accept' && o.action !== 'decline' && o.action !== 'cancel') {
    return false;
  }
  if (o.content !== undefined && (typeof o.content !== 'object' || o.content === null)) return false;
  return true;
}

/** 过期判定：ISO8601 已过/非法（无法解析）→ 视为过期，fail-closed */
export function isUserInputExpired(expiresAt: unknown, now: number = Date.now()): boolean {
  if (typeof expiresAt !== 'string') return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t <= now;
}
