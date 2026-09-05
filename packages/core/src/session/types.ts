// 会话事件类型 v1 —— 唯一事实源的 schema。
// 命名对齐 deepseek-harness known-event-types.ts，便于后续迁移。
// 红线：API key 等凭证不得写入任何事件 payload。

/** 当前会话日志格式代际（不可变代际文件：session.vN.jsonl） */
export const SESSION_FORMAT_VERSION = 1;

/** 会话主日志文件名（代际号与 SESSION_FORMAT_VERSION 同步） */
export const SESSION_LOG_FILE = 'session.v1.jsonl';

/** 目录锁文件名 */
export const SESSION_LOCK_FILE = 'lock';

export type SessionEventType =
  | 'session/header'
  | 'user/message'
  | 'assistant/message'
  | 'assistant/attempt'
  | 'step/start'
  | 'step/end'
  | 'tool/call'
  | 'tool/result'
  | 'rewind/marker';

export const KNOWN_EVENT_TYPES: readonly SessionEventType[] = [
  'session/header',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'rewind/marker',
];

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface SessionHeaderPayload {
  sessionId: string;
  cwd?: string;
  createdAt?: string;
  /** fork 血缘：派生自哪个会话（P1 分叉用） */
  parentSession?: string;
  isSeeded?: boolean;
}

export interface UserMessagePayload {
  text: string;
  turnId?: string;
}

export interface AssistantMessagePayload {
  text: string;
  model?: string;
  usage?: TokenUsage;
  turnId?: string;
}

/** 失败/被取消的模型尝试单独记录（对照 dsh assistant/attempt） */
export interface AssistantAttemptPayload {
  error: string;
  model?: string;
  turnId?: string;
}

export interface StepStartPayload {
  stepId: string;
  turnId?: string;
}

export interface StepEndPayload {
  stepId: string;
  turnId?: string;
  durationMs?: number;
}

export interface ToolCallPayload {
  callId: string;
  tool: string;
  /** 已消毒的参数快照；调用方负责剔除敏感值 */
  args?: unknown;
  turnId?: string;
}

export interface ToolResultPayload {
  callId: string;
  tool?: string;
  ok: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
}

/**
 * 回退标记：追加式撤回。语义为「活动投影收缩为 seq <= rewindToSeq 的事件」，
 * 标记之后新追加的事件属于新分支、默认活动；被收缩的历史事件保留在日志中
 * （影子事件），可全量导出，但不再进入当前上下文（对照 grok RewindMarker）。
 */
export interface RewindMarkerPayload {
  rewindToSeq: number;
  reason?: string;
}

export interface SessionEventMap {
  'session/header': SessionHeaderPayload;
  'user/message': UserMessagePayload;
  'assistant/message': AssistantMessagePayload;
  'assistant/attempt': AssistantAttemptPayload;
  'step/start': StepStartPayload;
  'step/end': StepEndPayload;
  'tool/call': ToolCallPayload;
  'tool/result': ToolResultPayload;
  'rewind/marker': RewindMarkerPayload;
}

/** 事件信封：日志中一行一个 JSON */
export interface SessionEvent<T extends SessionEventType = SessionEventType> {
  /** 格式代际 */
  v: 1;
  /** 会话内单调递增序号，从 1 开始 */
  seq: number;
  /** ISO8601 UTC 时间戳 */
  ts: string;
  type: T;
  payload: SessionEventMap[T];
}

export type AnySessionEvent = SessionEvent;

/** 解析一行日志；非法行返回 null（调用方负责跳过并告警） */
export function parseEventLine(line: string): AnySessionEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (e.v !== SESSION_FORMAT_VERSION) return null;
  if (typeof e.seq !== 'number' || typeof e.ts !== 'string') return null;
  if (typeof e.type !== 'string') return null;
  if (!isSessionEventType(e.type)) return null;
  if (typeof e.payload !== 'object' || e.payload === null) return null;
  return obj as AnySessionEvent;
}

export function isSessionEventType(t: string): t is SessionEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(t);
}
