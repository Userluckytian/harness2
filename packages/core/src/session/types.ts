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
  | 'memory/snapshot'
  | 'compaction/applied'
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
  'memory/snapshot',
  'compaction/applied',
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
  /** subagent 血缘（阶段 8）：本会话由 subagent_start 创建（加性字段，旧日志可缺省） */
  subagent?: boolean;
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
 * 回退标记：追加式撤回。语义为单调并集 + redo 链中立化——每个标记追溯遮蔽「标记
 * 之前已出现且 seq > rewindToSeq」的非标记事件；reason 以 'redo' 开头的标记额外中立化
 * seq = rewindToSeq + 1 处的标记（undo/redo 约定 redo.rewindToSeq = 被重做 undo 标记的
 * seq - 1，n 级链每次 redo 只复活一层，见 reader.computeProjection）；
 * 其余标记永不复活此前已被遮蔽的事件；标记之后新追加的事件属于新分支、默认活动。
 * 被遮蔽的历史事件保留在日志中（影子事件），可全量导出，但不再进入当前上下文
 * （对照 grok RewindMarker）。
 */
export interface RewindMarkerPayload {
  rewindToSeq: number;
  reason?: string;
}

/**
 * 记忆快照（阶段 6）：会话首个 user turn 前，把长期记忆注入内容整体冻结落盘。
 * content 即发到模型 ChatRequest.system 的原文（Model-visible ⟺ logged 扩展到
 * system：请求里的 system 必须可从本事件重建）；loop 后续轮复用快照不重读文件
 * （prefix cache 语义）。普通活动事件：参与 rewind 遮蔽、不进消息投影、渲染走
 * 通用兜底行。
 */
export interface MemorySnapshotPayload {
  content: string;
}

/**
 * 上下文压缩（阶段 7）：活动消息估算超过阈值时，把覆盖区（seq <= coveredUpToSeq 的
 * user/assistant 消息及其工具流量）折叠为一条摘要。普通活动事件：参与 rewind 遮蔽、
 * 不直接进消息投影——buildChatMessages 取**最新**一条生效（旧摘要被新摘要覆盖），
 * 把覆盖区替换为一条摘要消息（Model-visible ⟺ logged 延伸到压缩：摘要消息必须可从
 * 本事件重建）。
 */
export interface CompactionAppliedPayload {
  /** 覆盖区摘要（≤ COMPACTION_MAX_SUMMARY_CHARS 字符） */
  summary: string;
  /** 摘要覆盖到的最后一条 user/assistant 消息 seq（含） */
  coveredUpToSeq: number;
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
  'memory/snapshot': MemorySnapshotPayload;
  'compaction/applied': CompactionAppliedPayload;
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
  'memory/snapshot': (p) => typeof p.content === 'string' && p.content.length > 0,
  'compaction/applied': (p) =>
    typeof p.summary === 'string' &&
    p.summary.length > 0 &&
    typeof p.coveredUpToSeq === 'number' &&
    Number.isInteger(p.coveredUpToSeq) &&
    p.coveredUpToSeq >= 1,
  'rewind/marker': (p) => typeof p.rewindToSeq === 'number' && Number.isInteger(p.rewindToSeq),
};
