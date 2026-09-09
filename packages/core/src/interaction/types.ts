// 共享交互契约类型 v2 —— 激进底座 S0 冻结（对齐 I1 §6）。
// 只含纯类型 + 纯函数（校验/常量），不做任何文件 I/O（拨归 S3 runtime-journal/delivery）。
// 身份语义（禁止取「日志最后 turn」猜终态归属，各 id 用途分开）：
//   sessionId=会话 / turnId=模型轮次 / stepId=step 边界 / attemptId=模型重试尝试 /
//   callId=工具调用 / taskId=后台任务 / clientMessageId=客户端提交幂等键 / requestId=请求-响应配对。
// protocolVersion=2 在 WS 层协商（S3/S6 接线），本文件只冻结形状与常量。

/** WS 能力协商版本：旧客户端继续既有帧，未协商不突然切形状 */
export const PROTOCOL_VERSION = 2;

/** queue 每 session 默认上限（可配置）；超限保留 draft 并提示 */
export const QUEUE_MAX_DEFAULT = 20;

/** 身份 id 别名（均为非空字符串，语义见文件头） */
export type SessionId = string;
export type TurnId = string;
export type StepId = string;
export type AttemptId = string;
export type CallId = string;
export type TaskId = string;
export type ClientMessageId = string;
export type RequestId = string;

/** 非负整数校验（epoch/lastSeq/chunkOffset/seq 共用水位原语） */
export function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// —— submit：客户端→服务端 提交 & 幂等 ack ——

export type SubmitIntent = 'queue' | 'steer';

export interface MessageReference {
  id: string;
  kind: 'file' | 'clipboard' | 'url';
  /** kind=file：路径 */
  path?: string;
  /** kind=clipboard：文本摘录 */
  text?: string;
  /** kind=url：链接 */
  url?: string;
  /** 选区范围（0 起始；缺省 = 全文/整块） */
  range?: { start: number; end: number };
}

export interface SubmitRequest {
  clientMessageId: ClientMessageId;
  sessionId: SessionId;
  /** 原始输入（模型上下文按会话日志投影重建，不入第二套正文账本） */
  rawText: string;
  /** 结构化引用（文件/剪贴板/URL），UI 侧组装、服务端核验路径边界 */
  references?: MessageReference[];
  intent: SubmitIntent;
  /** intent=steer 时必填：仅在该 turn 仍存在时接受 */
  expectedTurnId?: TurnId;
}

/**
 * submit ack：accepted/rejected 为服务端明确结论；
 * 超时/崩溃窗口只能回 unknown（≠rejected——调用方不得把 unknown 当拒绝处理）。
 */
export type SubmitAckState = 'accepted' | 'rejected' | 'unknown';

export interface SubmitAck {
  clientMessageId: ClientMessageId;
  sessionId: SessionId;
  state: SubmitAckState;
  /** rejected/unknown 的原因（rejected 必带，unknown 可带诊断） */
  reason?: string;
  /** state=accepted 时登记队列序号（同 id 同内容返回既有 receipt） */
  queueSeq?: number;
}

export function isSubmitIntent(v: unknown): v is SubmitIntent {
  return v === 'queue' || v === 'steer';
}

/** queue 是否还有空位（默认上限 QUEUE_MAX_DEFAULT，可配置） */
export function queueHasSlot(queued: number, max: number = QUEUE_MAX_DEFAULT): boolean {
  return Number.isInteger(queued) && queued >= 0 && Number.isInteger(max) && max > 0 && queued < max;
}

// —— queue（重启恢复默认 paused，不惊喜执行；编辑器/resumeSnapshot 共享形状） ——

export type QueueItemState = 'queued' | 'paused';

export interface QueueEntry {
  /** 幂等键 = 提交时的 clientMessageId */
  id: ClientMessageId;
  /** 未启动项可按 id+revision edit/remove（每次变更 +1） */
  revision: number;
  rawText: string;
  references?: MessageReference[];
  intent: SubmitIntent;
  state: QueueItemState;
}

// —— resumeSubscription：with-watermark replay + 在途状态快照 ——

export interface ResumeSubscriptionRequest {
  sessionId: SessionId;
  /** 客户端已持久化的最后事件 seq（0 = 空）；服务端从此处之后回放 */
  lastSeq: number;
  /** 连接代次（只区分连接，不改变持久事件身份）；旧 epoch 直接丢弃 */
  epoch: number;
}

export interface ReplayRange {
  fromSeq: number;
  toSeq: number;
}

/** 在途模型 attempt 快照：chunkOffset 水位 = 客户端已收到多少本尝试的文本 */
export interface AttemptSnapshot {
  attemptId: AttemptId;
  turnId: TurnId;
  textChunkOffset: number;
  reasoningChunkOffset: number;
  status: 'running' | 'waiting-approval' | 'unknown';
  /** FixB 加性：本 turn 的代次（重连快照据此发正确代次的 cancel；旧客户端忽略） */
  generation?: number;
}

export interface ResumeSnapshot {
  epoch: number;
  replay: ReplayRange;
  activeAttempt?: AttemptSnapshot;
  tasks: TaskContract[];
  pendingApprovals: ApprovalRequestContract[];
  queue: QueueEntry[];
}

export function isValidChunkOffset(v: unknown): v is number {
  return isNonNegativeInteger(v);
}

export function isValidLastSeq(v: unknown): v is number {
  return isNonNegativeInteger(v);
}

export function isValidEpoch(v: unknown): v is number {
  return isNonNegativeInteger(v);
}

/** delta 连续性：下一块 chunkOffset 必须等于上一块 chunkOffset + 上一块文本长度（无缺口、无重叠/迟到） */
export function assertSequentialChunk(prev: { chunkOffset: number; text: string }, nextOffset: number): boolean {
  if (!isValidChunkOffset(nextOffset)) return false;
  if (!isValidChunkOffset(prev.chunkOffset) || typeof prev.text !== 'string') return false;
  return nextOffset === prev.chunkOffset + prev.text.length;
}

// —— approval：requestId/session/parent/task/tool/args/cwd/scope/expiresAt + decision ack ——

/** 作用域：once=一次；session=「本会话总是」，必须携带所属 sessionId（不得跨 session 泄漏） */
export type ApprovalScope = { mode: 'once' } | { mode: 'session'; sessionId: SessionId };

export interface ApprovalRequestContract {
  requestId: RequestId;
  sessionId: SessionId;
  parentTaskId?: TaskId;
  taskId?: TaskId;
  tool: string;
  /** 已脱敏参数（调用方负责剔除敏感值；出站前再过 redactSecrets） */
  args: unknown;
  cwd?: string;
  scope: ApprovalScope;
  /** ISO8601 过期时间；过期结果必须明确返回 */
  expiresAt: string;
}

/** respond 的决策只有 allow | deny（区别于 tools.types 的策略决策 allow|deny|ask） */
export type ApprovalResponseDecision = 'allow' | 'deny';

export interface ApprovalResponse {
  requestId: RequestId;
  decision: ApprovalResponseDecision;
}

/** respond 的 decision ack：重复/过期/无法定位结果都要明确，失败卡保留 */
export type ApprovalResponseAckState = 'applied' | 'duplicate' | 'expired' | 'unknown';

export interface ApprovalResponseAck {
  requestId: RequestId;
  state: ApprovalResponseAckState;
}

export function isApprovalDecision(v: unknown): v is ApprovalResponseDecision {
  return v === 'allow' || v === 'deny';
}

/** 过期判定：ISO8601 已过/非法（无法解析）→ 视为过期，fail-closed */
export function isApprovalExpired(expiresAt: unknown, now: number = Date.now()): boolean {
  if (typeof expiresAt !== 'string') return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t <= now;
}

/** 「本会话总是」作用域必须框定在请求自身的 sessionId 内 */
export function scopeConfinesToSession(scope: ApprovalScope, sessionId: SessionId): boolean {
  if (scope.mode === 'once') return true;
  return scope.sessionId === sessionId;
}

// —— cancel：requestId+target(turn/task)+expectedId；ack 三态 ——

export type CancelTargetKind = 'turn' | 'task';

export interface CancelRequest {
  requestId: RequestId;
  target: { kind: CancelTargetKind; id: string };
  /** 并发防护：目标已变（如 turn 已完成）时拒绝，不误伤新目标 */
  expectedId?: string;
  /**
   * FixB 加性：turn 目标的代次（>=1 单调递增，等价 turn 发起时点序）。cancel 只命中
   * 该代次的 turn；重连重放旧代次帧 → ack=unknown（不误杀复用同 turnId 的新 turn）。
   * 旧客户端不带本字段 → 回退 expectedId/target.id 匹配（文档化取舍，见 FixB 报告）。
   */
  expectedTurnGeneration?: number;
}

/** stopping=已受理（UI 立即展示）；cancelled=确认已取消；unknown=连接不明/工具不配合 */
export type CancelAckState = 'stopping' | 'cancelled' | 'unknown';

export interface CancelAck {
  requestId: RequestId;
  state: CancelAckState;
}

export function isCancelTargetKind(v: unknown): v is CancelTargetKind {
  return v === 'turn' || v === 'task';
}

export function isCancelAckState(v: unknown): v is CancelAckState {
  return v === 'stopping' || v === 'cancelled' || v === 'unknown';
}

/** turn 代次（>=1 整数；0/非法 = 帧无效代次，fail-closed 拒绝） */
export function isTurnGeneration(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/**
 * FixB：turn cancel 帧代次命中判定（与既有 turnId 生成自洽：代次只区分本进程内
 * turn 发起序，不改变 turnId 身份）。三态：
 * - 'match'：帧带合法代次且与目标当前代次严格相等 → 命中；
 * - 'stale'：帧带代次但与目标代次不等 / 目标无代次 / 帧代次非法 → 拒（不误伤新 turn）；
 * - 'missing'：帧无代次（旧客户端）→ 调用方回退 target.id 匹配语义。
 */
export type TurnGenerationMatch = 'match' | 'stale' | 'missing';

export function matchTurnGeneration(expected: number | undefined, current: number | undefined): TurnGenerationMatch {
  if (expected === undefined) return 'missing';
  if (!isTurnGeneration(expected) || current === undefined) return 'stale';
  return expected === current ? 'match' : 'stale';
}

// —— task：registered→queued→starting→running/waiting-approval→stopping→completed/failed/cancelled/unknown ——

export const TASK_STATES = [
  'registered',
  'queued',
  'starting',
  'running',
  'waiting-approval',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** 终态集合：进入后单调（不再迁移） */
export const TASK_TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled', 'unknown']);

export interface TaskContract {
  taskId: TaskId;
  parentTaskId?: TaskId;
  /** background:true 注册后立即返回 handle（status/wait/continue/cancel 分离，S5 接线） */
  background: boolean;
  state: TaskState;
  expectedTurnId?: TurnId;
  updatedAt?: string;
}

/** 合法迁移表（§6 链路 + 取消/自然完成路径）；终态无出边 */
const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  registered: ['queued'],
  queued: ['starting', 'cancelled'],
  starting: ['running', 'waiting-approval', 'cancelled', 'failed', 'unknown'],
  'waiting-approval': ['running', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'],
  running: ['waiting-approval', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'],
  stopping: ['completed', 'failed', 'cancelled', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  unknown: [],
};

export function isTerminalTaskState(
  s: unknown,
): s is Extract<TaskState, 'completed' | 'failed' | 'cancelled' | 'unknown'> {
  return TASK_TERMINAL_STATES.has(s as TaskState);
}

/** 终态单调校验：非法状态/自转移/回归/终态出边一律 false */
export function canTaskTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return false;
  if (!TASK_TRANSITIONS[from]) return false;
  return TASK_TRANSITIONS[from].includes(to as TaskState);
}

// —— steer：绑定 expectedTurnId + 唯一 id，仅下一安全 model step 边界接受（S6 实现） ——

export interface SteerRequest {
  id: string;
  expectedTurnId: TurnId;
  text: string;
}

export type SteerResultState = 'accepted' | 'stale' | 'rejected';

export interface SteerResult {
  id: string;
  expectedTurnId: TurnId;
  state: SteerResultState;
  /** state=stale 时保留 draft 提示，服务端不得偷偷 abort/resend */
  draftKept?: boolean;
}

export function isValidSteerRequest(v: unknown): v is SteerRequest {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['id'] === 'string' &&
    s['id'].length > 0 &&
    typeof s['expectedTurnId'] === 'string' &&
    s['expectedTurnId'].length > 0 &&
    typeof s['text'] === 'string' &&
    s['text'].length > 0
  );
}

// —— attempt / delivery：delta 带完整归属 + chunkOffset 水位；终态带 turnId/attemptId ——

export interface TextDeltaFrame {
  type: 'text-delta';
  sessionId: SessionId;
  turnId: TurnId;
  attemptId: AttemptId;
  /** 单调水位：0 起始，续块 = 上一块 offset + 该块文本长度 */
  chunkOffset: number;
  text: string;
}

export interface ReasoningDeltaFrame {
  type: 'reasoning-delta';
  sessionId: SessionId;
  turnId: TurnId;
  attemptId: AttemptId;
  chunkOffset: number;
  text: string;
}

export type DeliveryDeltaFrame = TextDeltaFrame | ReasoningDeltaFrame;

export type AttemptFinalState = 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface AttemptFinalFrame {
  type: 'attempt-final';
  sessionId: SessionId;
  turnId: TurnId;
  attemptId: AttemptId;
  state: AttemptFinalState;
  finalText?: string;
  error?: string;
}

// —— 重试默认策略（S4 实现预算/Retry-After/退避；S0 只冻结枚举位与常量） ——

/** 可恢复错误码（network/timeout/429/可恢复 5xx/stream_truncated） */
export const RETRYABLE_ERROR_KINDS: readonly string[] = [
  'network',
  'timeout',
  'rate_limit',
  'server_5xx',
  'stream_truncated',
  '429',
  '503',
];

/** 不可恢复错误码（401/403/参数错/quota/用户取消/拒绝/内容过滤） */
export const NON_RETRYABLE_ERROR_KINDS: readonly string[] = [
  '401',
  '403',
  'invalid_request',
  'quota',
  'user_cancelled',
  'refusal',
  'content_filter',
];

export type ErrorCategory = 'retryable' | 'non_retryable' | 'unknown';

const RETRYABLE_SET: ReadonlySet<string> = new Set(RETRYABLE_ERROR_KINDS);
const NON_RETRYABLE_SET: ReadonlySet<string> = new Set(NON_RETRYABLE_ERROR_KINDS);

/** 错误码分类：命中可恢复 → retryable；命中不可恢复 → non_retryable；未知/空 → unknown（不默认重试） */
export function classifyRetryable(code: string): ErrorCategory {
  if (RETRYABLE_SET.has(code)) return 'retryable';
  if (NON_RETRYABLE_SET.has(code)) return 'non_retryable';
  return 'unknown';
}

/** 重试预算默认值（新产品决定，不照抄上游；S4 具体实现） */
export const RETRY_MAX_EXTRA_ATTEMPTS = 3;
export const RETRY_BACKOFF_SECONDS: readonly number[] = [2, 10, 30];
export const RETRY_MAX_EXTRA_PER_TURN = 6;
export const RETRY_MAX_TOTAL_WAIT_SECONDS = 120;
