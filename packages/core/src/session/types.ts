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
  /** 思考/推理文本（阶段 3 加性字段：reasoning_content / thinking 汇总；旧日志可缺省） */
  reasoning?: string;
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
  /** 归属 turn（阶段 2 起 loop 写入；旧日志可缺省，渲染归入 `── turn -`） */
  turnId?: string;
}

/**
 * 回退标记：追加式撤回。语义为单调并集——每个标记追溯遮蔽「标记之前已出现且
 * seq > rewindToSeq」的非标记事件，永不复活此前已被遮蔽的事件；标记之后新追加
 * 的事件属于新分支、默认活动。被遮蔽的历史事件保留在日志中（影子事件），可全量
 * 导出，但不再进入当前上下文（对照 grok RewindMarker）。
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

/** 判别联合：按 type 收窄后 payload 类型随之确定 */
export type AnySessionEvent = {
  [T in SessionEventType]: SessionEvent<T>;
}[SessionEventType];

/** 解析一行日志（含信封与按类型的最低 payload 校验）；非法行返回 null（调用方负责跳过并告警） */
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
  if (!PAYLOAD_VALIDATORS[e.type](e.payload as Record<string, unknown>)) return null;
  return obj as AnySessionEvent;
}

export function isSessionEventType(t: string): t is SessionEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * 按事件类型的最低 payload 校验：缺少必需字段或类型不符即视为非法行
 * （不合规 payload 会让投影/渲染拿到 undefined 字段而崩溃，必须在解析层拦截）。
 */
const PAYLOAD_VALIDATORS: Record<SessionEventType, (p: Record<string, unknown>) => boolean> = {
  'session/header': (p) => typeof p.sessionId === 'string',
  'user/message': (p) => typeof p.text === 'string',
  'assistant/message': (p) => typeof p.text === 'string',
  'assistant/attempt': (p) => typeof p.error === 'string',
  'step/start': (p) => typeof p.stepId === 'string',
  'step/end': (p) => typeof p.stepId === 'string',
  'tool/call': (p) => typeof p.callId === 'string' && typeof p.tool === 'string',
  'tool/result': (p) => typeof p.callId === 'string' && typeof p.ok === 'boolean',
  'rewind/marker': (p) => typeof p.rewindToSeq === 'number' && Number.isInteger(p.rewindToSeq),
};
