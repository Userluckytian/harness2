// 服务内会话注册表（SessionHub）：HTTP 控制面与 WS 事件面共用的唯一内核操作层。
// 单一事实源约束：hub 只经内核原语操作会话——SessionManager（create/resume/locate/list）、
// SessionWriter（append 唯一写入口）、runTurn、undoLastTurn/redoLastUndo；hub 自身不写日志、
// 不组装模型上下文（runTurn 内部照旧从日志投影重建请求）。
//
// 两类观察输出（都不旁路事实源）：
//   - 落盘事件镜像：EventMirrorWriter 包裹真实 writer，append 返回后原样回调（WS event 帧）；
//   - 流式增量（delta）：runTurn 的 onStream 观察缝转发，是唯一允许的"未落盘"推送，
//     且必然与随后落盘的最终事件一致（text 拼接 = assistant/message.text；reasoning 同理）。
//
// 审批上抛：Ph2 审批缝 onAsk → 待处理请求表（requestId → settle），等待
// HTTP/WS 客户端的 approval-response；超时（默认 120s）与 turn 取消（abort）都按拒绝处理
// （与 chat REPL P2-2 的"等待可取消"口径一致）。
//
// turn 串行语义：同会话用户消息排队（同 REPL busy 队列），跨会话并行互不阻塞；
// undo/redo 与 turn 互斥（busy 会话上拒绝，避免 rewind marker 与 turn 事件交错落盘）。
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { runTurn } from '../agent/loop.js';
import type { CompactionOptions, TurnResult, TurnStreamEvent } from '../agent/types.js';
import type { ApprovalDecision, ApprovalInput, ApprovalHandler, ToolResult } from '../tools/types.js';
import type {
  ApprovalRequestContract,
  ApprovalResponseAck,
  ApprovalResponseDecision,
  AttemptFinalFrame,
  AttemptSnapshot,
  CancelAck,
  CancelRequest,
  DeliveryDeltaFrame,
  ResumeSnapshot,
  ResumeSubscriptionRequest,
  SteerRequest,
  SteerResult,
  SubmitAck,
  SubmitRequest,
  TaskContract,
  TaskId,
  TaskState,
  TurnId,
  ClientMessageId,
  SessionId,
} from '../interaction/types.js';
import { SessionSteerSink } from '../interaction/steer-sink.js';
import { isApprovalDecision, TASK_STATES, matchTurnGeneration } from '../interaction/types.js';
import { RUNTIME_JOURNAL_FILE, RuntimeJournal, readEntries } from '../interaction/runtime-journal.js';
import type { TaskTransitionEntry } from '../interaction/runtime-journal.js';
import { buildEffectiveRunConfig, type EffectiveRunConfig, type EffectiveRunConfigInput } from '../interaction/run-config.js';
import { loadPlanState, type PlanState } from '../interaction/plan-state.js';
import { buildToolExecutionView, type ToolExecutionTrace, type ToolExecutionView } from '../interaction/execution-view.js';
import { reviewChangeSet, type ChangeSet } from '../interaction/change-review.js';
import type { RetryBudgetState } from '../interaction/retry-policy.js';
import type { ApprovalConfig, MemoryMode } from '../config/schema.js';
import { createDeliverySession, recoverQueue, submitDelivery, continueQueue } from '../interaction/delivery.js';
import type { DeliverySession } from '../interaction/delivery.js';
import { TaskCoordinator, reconstructTasks } from '../agent/task-coordinator.js';
import type { TaskRunResult, TaskSpec, TaskTransitionRecorder, TaskWriteMode } from '../agent/task-coordinator.js';
import { WatermarkCursor } from '../interaction/resume-state.js';
import type { ResumeStateProvider } from '../interaction/resume-state.js';
import { ApprovalQueue, type ApprovalQueueCard } from '../interaction/approval-queue.js';
import type { ToolExecutionRequest } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createMemoryToolForMode, runNudgeReview, type NudgeResult } from '../memory/nudge.js';
import type { PendingMemoryStore } from '../memory/pending.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';
import type { ChatProvider, ToolCallRequest } from '../provider/types.js';
import { redactSecrets } from '../config/redact.js';
import { createBrowserTools, type BrowserPool } from '../tools/predefined/browser.js';
import { computeProjection, loadSession, type LoadedEvent } from '../session/reader.js';
import { SnapshotStore } from '../session/snapshots.js';
import { SessionManager, SESSION_ID_PATTERN } from '../session/manager.js';
import { forkSession, ForkError, type ForkResult } from '../session/fork.js';
import { redoLastUndo, undoLastTurn, UndoRedoError, type UndoRedoResult } from '../session/undo.js';
import { createSubagentTools, SUBAGENT_TOOL_NAMES } from '../agent/subagent.js';
import type { PluginBus } from '../plugins/bus.js';
import type {
  AnySessionEvent,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionHeaderPayload,
} from '../session/types.js';
import type { SessionWriter } from '../session/writer.js';

/** hub 层可定位错误：HTTP/WS 出口据此映射状态码（message 一行友好中文） */
export class HubError extends Error {
  constructor(
    readonly code: 'not_found' | 'locked' | 'busy' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

/** 流式增量（唯一允许的未落盘推送；与随后落盘的最终事件一致） */
export type TurnDelta =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; call: ToolCallRequest };

/** S2 历史类型（API 面兼容保留）：审批上抛已升级为 ApprovalRequestContract（含 scope/expiresAt/cwd） */
export interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  args: unknown;
}

export type ApprovalSettleReason = 'response' | 'timeout' | 'cancelled' | 'expired';

/** S7：provider 装配元数据（run-config 只读投影的装配来源；与 config.roles/providers 同源，非第二套配置存储） */
export interface SessionHubProviderMeta {
  role: string;
  channel: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  /** provider 标识（channel/model；与 ChatProvider.name 一致） */
  name: string;
}

/** hub 级记忆装配（阶段 6）：mode ≠ off 时由启动器注入；off 不传 = 零记忆行为 */
export interface SessionHubMemory {
  store: MemoryStore;
  mode: 'ask' | 'auto';
  /** 每 N 个用户 turn 触发一次后台复盘（模型调过 memory 工具的 turn 重置计数） */
  nudgeInterval: number;
  /** 复盘 provider（roles.small）；缺省 = 主 provider */
  reviewProvider?: ChatProvider;
  /** ask 模式暂存区；缺省 = store.root/pending */
  pending?: PendingMemoryStore;
}

/** hub 级 subagent 装配（阶段 8）：注入后每次 turn 按会话 id 重绑 subagent 工具（血缘/审批按子会话上抛） */
export interface SessionHubSubagent {
  /** 子会话 provider（roles.subagent 派生；缺省回退主 provider） */
  provider: ChatProvider;
  /** 深度上限（config.subagent.maxDepth；默认 1 = 子内无 subagent 工具） */
  maxDepth: number;
  /** 子会话单 turn 最大 step 数（config.subagent.maxTurns） */
  maxTurns: number;
  /** S5：subagent_start 是否注册为后台任务（走协调器只读 K=2 / 写串行；缺省 false = 同步 inline）。
   *  开启时 subagent_start 立返 taskId，不阻塞父 turn；subagent_continue 接 taskId 取 status/结果。 */
  backgroundTasks?: boolean;
  /** S5：后台子代理任务的资源型（仅 backgroundTasks 时生效；缺省 'write' = 子会话可能写文件）。 */
  taskWriteMode?: TaskWriteMode;
}

/** hub 级插件装配（阶段 8）：工具链已在共享注册表；这里只桥接事件总线（插件 on 订阅） */
export interface SessionHubPlugins {
  bus: PluginBus;
}

export interface SessionHubHooks {
  /** 落盘事件镜像（append 返回后同步回调；含 rewind/marker） */
  onEvent?(sessionId: string, event: AnySessionEvent): void;
  /** 流式增量（turn 进行中逐片回调；text/reasoning 与随后 assistant/message 一致） */
  onDelta?(sessionId: string, delta: TurnDelta): void;
  /** S3c2 带水位的增量帧（展示投影；与 onDelta 同源，但带真实 turnId + 合成 attemptId + chunkOffset） */
  onDeliveryDelta?(sessionId: string, frame: DeliveryDeltaFrame): void;
  /** S3c2 turn 落定帧（display 终态归属：completed/failed/cancelled；对应 attempt-final 帧） */
  onAttemptFinal?(sessionId: string, frame: AttemptFinalFrame): void;
  /** turn 结束（stopReason：end_turn/error/cancelled/max_steps/…） */
  onTurnEnd?(sessionId: string, result: TurnResult): void;
  /**
   * 审批上抛：进入待处理队列后回调。deliverTo = 送达链（自身会话 + 祖先父子会话）——
   * 父/子/孙订阅者都能收到该卡（child 审批在子会话结束前对父可见）。
   */
  onApprovalRequest?(approval: ApprovalRequestContract, deliverTo: string[]): void;
  /** 审批落定（响应/超时/取消；false = 按拒绝处理） */
  onApprovalSettled?(requestId: string, allowed: boolean, reason: ApprovalSettleReason): void;
  /** 后台复盘开始（turn-end 之后异步触发；提示帧，UI 自行决定展示） */
  onNudgeStarted?(sessionId: string): void;
  /** 后台复盘结束（产出 = 记忆写入或 pending 暂存；error 存在 = 复盘失败，主对话不受影响） */
  onNudgeFinished?(sessionId: string, result: NudgeResult): void;
  /** 工具执行生命周期（S1，S3 delivery / S7 toolExecutionView 消费；纯观察，不落第二套日志） */
  onExecuteStart?(sessionId: string, req: ToolExecutionRequest): void;
  onExecuteEnd?(sessionId: string, req: ToolExecutionRequest, result: ToolResult): void;
  /** S6 会话级 steer 回帧（loop 在安全 step 边界消费后 resolve；accepted/stale/rejected） */
  onSteerResult?(sessionId: string, result: SteerResult): void;
}

export interface SessionHubOptions {
  manager: SessionManager;
  provider: ChatProvider;
  tools: ToolRegistry;
  /** 工具执行 cwd + 新会话分组目录 */
  cwd: string;
  /** 策略决策缝（ask/allow/deny/auto/bypass 落这里；hub 缺省 ask——绝不静默允许） */
  decide?: (input: ApprovalInput) => ApprovalDecision;
  /** 审批等待超时 ms（默认 120_000；超时按拒绝处理） */
  approvalTimeoutMs?: number;
  /** 记忆装配（mode ≠ off 时注入；缺省 = 无记忆行为） */
  memory?: SessionHubMemory;
  /** 上下文压缩装配（阶段 7；缺省 = 不压缩）。由启动器按 roles.main 容量 + roles.small 摘要派生 */
  compaction?: CompactionOptions;
  /** 浏览器装配（阶段 7；config.browser.enabled 时注入）——按会话绑定池键注册 browser_* 工具 */
  browser?: { pool: BrowserPool };
  /** subagent 装配（阶段 8；config.subagent 派生）——按会话 id 绑定血缘的 subagent 工具 */
  subagent?: SessionHubSubagent;
  /** Skills 装配（阶段 10）——每次 turn 扫描两级目录并把列表追加进 system（skill 工具在共享注册表） */
  skills?: SkillStore;
  /** 插件装配（阶段 8）——插件事件订阅的桥接（emitSessionEvent） */
  plugins?: SessionHubPlugins;
  hooks?: SessionHubHooks;
  /** S5 后台任务协调器（缺省 = hub 内部单例；跨会话共享写锁 = 全局串行） */
  taskCoordinator?: TaskCoordinator;
  /** S7：provider 装配元数据（启动器从已加载 config 派生；缺省 = 注入 provider 的 name 推导，见 runConfigView） */
  providerMeta?: SessionHubProviderMeta;
  /** S7：审批策略装配来源（config.approval 同源；缺省 = default 空规则） */
  approvalConfig?: ApprovalConfig;
  /** S7：roles.main 模型容量元数据（config.providers.<channel>.models 派生；缺省不声明） */
  contextWindow?: number;
  /** S7：roles.main 模型 maxOutputTokens（config.providers.<channel>.models 派生；缺省不声明） */
  maxOutputTokens?: number;
}

/** undo n>1 提示的层数上限（与 chat /undo 参数口径一致） */
const UNDO_MAX_N = 100;

function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}

/** header.cwd 有效时原样返回（旧日志可缺省），否则回退全局 cwd */
function headerCwdOr(headerCwd: string | undefined | null, fallback: string): string {
  return typeof headerCwd === 'string' && headerCwd.trim().length > 0 ? headerCwd : fallback;
}

/** 实际 shell（S7 execution-view 记录来源；Windows = %ComSpec%，POSIX = /bin/sh；缺省不臆造） */
function detectShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return '/bin/sh';
}

/** S7 执行视图生命周期记录（hub 内存纯观察，不落盘） */
interface ExecTraceRecord {
  startedAt?: string;
  executedArgs?: unknown;
  endedAt?: string;
  ok?: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
}

// sessionId 合法格式（SESSION_ID_PATTERN，自 session/manager.ts 导入）：路径穿越防御——
// id 会拼进会话目录路径，`../x` 之类的穿越原语必须在 hub 出口处拒绝；
// 任何不匹配格式一律 HubError('invalid')，不触达文件系统。

export interface SessionEventsPayload {
  id: string;
  dir: string;
  header: SessionHeaderPayload | null;
  /** 日志顺序的全部事件（active = 当前投影内；影子事件 false，渲染必须过滤） */
  events: Array<LoadedEvent['event'] & { active: boolean }>;
  warnings: string[];
  lastSeq: number;
}

/**
 * EventMirrorWriter：真实 writer 的观察包裹——append 先落盘、后镜像回调。
 * 结构化匹配 SessionWriter 的公开形态（runTurn/undo 只消费这些成员），
 * 不绕过任何写入路径（单一写者不变量保持）。
 */
class EventMirrorWriter {
  readonly dir: string;
  private closed = false;
  constructor(
    private readonly inner: SessionWriter,
    private readonly onEvent: (event: AnySessionEvent) => void,
  ) {
    this.dir = inner.dir;
  }
  get lastSeq(): number {
    return this.inner.lastSeq;
  }
  get recoveredBytes(): number {
    return this.inner.recoveredBytes;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  append<T extends SessionEventType>(type: T, payload: SessionEventMap[T]): SessionEvent<T> {
    const event = this.inner.append(type, payload);
    // event 由本方法按 T 构造，必属 AnySessionEvent 联合成员（此处收窄需显式断言）
    this.onEvent(event as AnySessionEvent);
    return event;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.close();
  }
}

interface HubEntry {
  id: string;
  dir: string;
  /** 每会话真实 cwd（header 真值；S1 起工具执行基于它，A/B 会话互不串） */
  cwd: string;
  writer: EventMirrorWriter;
}

/** S3c2：会话级 delivery（journal 单写 + queue）。journal 落在会话目录 runtime.v1.jsonl */
interface HubDelivery {
  session: DeliverySession;
  journal: RuntimeJournal;
}

export class SessionHub implements ResumeStateProvider {
  private readonly entries = new Map<string, HubEntry>();
  /** 每会话待处理用户消息队列（busy 时入队，turn 结束后 pump——同 REPL 语义） */
  private readonly pendingTexts = new Map<string, string[]>();
  /** 每会话运行中的 turn 取消源 */
  private readonly running = new Map<string, AbortController>();
  /** 多并发结构化审批队列（requestId 级独立卡片；含授权缓存与已落定记忆） */
  private readonly approvals = new ApprovalQueue();
  /** subagent 血缘：childId → parentId（hub 层记录；交付链 / 后代待审批展开用） */
  private readonly subagentChildren = new Map<string, string>();
  /** 运行中 turn 的 promise 集（close 时等待收尾） */
  private readonly inflight = new Set<Promise<void>>();
  /** 每会话 nudge 计数（用户 turn 完成时 +1；turn 内调过 memory 工具 → 归零） */
  private readonly nudgeCounts = new Map<string, number>();
  /** 运行中 turn 是否调过 memory 工具（EventMirrorWriter 事件侧记） */
  private readonly memoryToolUseInTurn = new Set<string>();
  /** 运行中复盘 turn 的取消源（close 时全部取消；同会话连续复盘各自独立） */
  private readonly reviewRunning = new Set<AbortController>();
  /** 已告警过的 subagent 重名工具（P1-3：每名只告警一次，不随每 turn 刷屏） */
  private readonly subagentNameConflictsWarned = new Set<string>();
  /** S3c2：每会话 delivery（journal 单写 + queue；journal 在会话目录 runtime.v1.jsonl） */
  private readonly deliveries = new Map<string, HubDelivery>();
  /** 已被派发进 turn 管线的 queue 下标（防 submit 幂等回执重复派发） */
  private readonly dispatched = new Map<string, number>();
  /** 运行中 turn 的展示投影身份（real turnId 来自 loop；attemptId 由 hub 按 turn 合成） */
  private readonly turnDisplay = new Map<string, { turnId: string; attemptId: string; textLen: number; reasoningLen: number }>();
  /** turnId → sessionId（cancel 按 turnId 定位会话语境；turn 结束清理） */
  private readonly runningTurnId = new Map<string, string>();
  /** 本进程内已确认取消的 turnId（cancel-ack=cancelled 依据；一次性语义） */
  private readonly cancelledTurns = new Set<string>();
  /** FixB：每会话运行中 turn 的代次（runOne 启动时递增；只区分本进程内 turn 发起序） */
  private readonly turnGenerations = new Map<SessionId, number>();
  /** FixB：turnId → 该 turn 的代次（首次见到 turnId 时绑定；turn 结束清理） */
  private readonly turnGenerationByTurnId = new Map<TurnId, number>();
  /** FixB：已确认取消 turn 的代次（cancel-ack=cancelled 依据；turnId 复用时不串代次） */
  private readonly cancelledTurnGeneration = new Map<TurnId, number>();
  /** 带水位的 delta 展示投影映射（跨会话共享；每 (session, attempt, kind) 独立） */
  private readonly watermark = new WatermarkCursor();
  /** S5 后台任务协调器（跨会话共享；同进程单例 → 共享写锁全局串行） */
  readonly tasks: TaskCoordinator;
  /** 任务归属会话（taskId → 会话 id；task/transition 落该会话 journal） */
  private readonly taskSessions = new Map<TaskId, SessionId>();
  /** S7 执行视图源：sessionId → callId → 生命周期观察记录（内存纯观察，不落盘、不写第二套日志） */
  private readonly execTraces = new Map<string, Map<string, ExecTraceRecord>>();
  /** S7：每会话已生效配置 revision（turn 启动时 +1；run-config 只读投影的 snapshot 来源） */
  private readonly configRevisions = new Map<string, number>();
  /** FixC D1：每会话最近 turn 的重试预算快照（run-config retry.budget 来源；不持久化，随进程） */
  private readonly lastRetryBudgets = new Map<string, RetryBudgetState>();
  /** S6 会话级 steer sink（接收/去重/排队跨 turn 持续；loop 只在安全 step 边界消费） */
  private readonly steerSinks = new Map<SessionId, SessionSteerSink>();

  readonly approvalTimeoutMs: number;
  /** 观察者集合（WS 事件面 / 测试；addHooks 注册，返回退订函数） */
  private readonly listeners = new Set<SessionHubHooks>();

  constructor(private readonly options: SessionHubOptions) {
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    // S5：协调器缺省由 hub 自建（recorder 落到任务归属会话的 runtime journal；S3a 账本单写）
    this.tasks = options.taskCoordinator ?? new TaskCoordinator({ recorder: this.makeTaskRecorder() });
    // 审查 P2-1 fail-fast：ask 模式缺 pending 装配时 buildTurnTools 每次 turn 抛错、
    // 被 pump 的 catch 吞掉（消息凭空消失）——装配残缺在构造期即拒绝，不给静默失败留窗口。
    if (options.memory?.mode === 'ask' && options.memory.pending === undefined) {
      throw new HubError('invalid', 'memory.mode=ask 需要装配 pending 暂存区（SessionHubMemory.pending），拒绝静默吞消息的残缺装配');
    }
    if (options.hooks !== undefined) this.addHooks(options.hooks);
    // 插件事件桥接（阶段 8）：hub 落盘事件镜像 → 插件事件总线（插件 on 订阅的来源）
    if (options.plugins !== undefined) {
      const bus = options.plugins.bus;
      this.addHooks({ onEvent: (sessionId, event) => bus.emitSessionEvent(sessionId, event) });
    }
  }

  /** 注册观察者（幂等性由调用方保证）；返回退订函数 */
  addHooks(hooks: SessionHubHooks): () => void {
    this.listeners.add(hooks);
    return () => {
      this.listeners.delete(hooks);
    };
  }

  /** S6 会话级 steer sink：按会话惰性创建，跨 turn 持久（去重/排队/回帧观察都在 sink） */
  private steerSinkFor(id: string): SessionSteerSink {
    const existing = this.steerSinks.get(id);
    if (existing !== undefined) return existing;
    const sink = new SessionSteerSink((result) => this.emitSteerResult(id, result));
    this.steerSinks.set(id, sink);
    return sink;
  }

  /** S6 会话级 steer 回帧历史（诊断/测试；与 hooks.onSteerResult 同源） */
  steerHistory(id: string): SteerResult[] {
    this.assertValidSessionId(id);
    return this.steerSinks.get(id)?.history() ?? [];
  }

  /** S6：外部提交一条 steer 进会话级 sink（跨 turn 去重/排队）；true = 新 id 已入队 */
  submitSteer(sessionId: string, req: SteerRequest): boolean {
    this.assertValidSessionId(sessionId);
    this.ensureOpen(sessionId);
    return this.steerSinkFor(sessionId).push(req);
  }

  get manager(): SessionManager {
    return this.options.manager;
  }

  /** 全量工具注册表（按会话绑定 memory/browser 变体）——cron 调度执行复用同一装配 */
  toolsForSession(sessionId: string): ToolRegistry {
    return this.buildTurnTools(sessionId);
  }

  // —— 会话生命周期 ——

  /** 新建会话并保持 writer 打开（服务持有，close 时统一释放） */
  create(cwd: string): { id: string; dir: string } {
    this.assertNonEmpty(cwd, 'cwd');
    const created = this.options.manager.create(cwd);
    // entry.cwd = header 真值（manager.create 落盘 resolve(cwd)）——工具执行与快照解析都用它
    const entry: HubEntry = {
      id: created.id,
      dir: created.dir,
      cwd: resolve(cwd),
      writer: new EventMirrorWriter(created.writer, (event) => {
        this.noteTurnEvent(created.id, event);
        this.emitEvent(created.id, event);
      }),
    };
    this.entries.set(created.id, entry);
    return { id: created.id, dir: created.dir };
  }

  /** 会话摘要列表（manager.list 同源；cwd 缺省 = 全库） */
  list(cwd?: string): ReturnType<SessionManager['list']> {
    return this.options.manager.list(cwd);
  }

  /** 只读定位会话目录（不取锁；与持锁写者并存） */
  locate(id: string, cwd?: string): string {
    this.assertValidSessionId(id);
    try {
      return this.options.manager.locate(id, cwd !== undefined ? { cwd } : {});
    } catch {
      throw new HubError('not_found', `session not found: ${id}`);
    }
  }

  /** 恢复会话到注册表（幂等：已在册直接返回）；锁被占（如 CLI chat 同时打开）→ HubError('locked') */
  ensureOpen(id: string): { id: string; dir: string } {
    this.assertValidSessionId(id);
    const entry = this.entryFor(id);
    return { id: entry.id, dir: entry.dir };
  }

  /** 注册表条目（内部）：不存在则从磁盘恢复；锁冲突 → HubError('locked')，未知 id → HubError('not_found') */
  private entryFor(id: string): HubEntry {
    const existing = this.entries.get(id);
    if (existing) return existing;
    let resumed: ReturnType<SessionManager['resume']>;
    try {
      resumed = this.options.manager.resume(id);
    } catch (e) {
      if ((e as Error).name === 'SessionLockedError') {
        throw new HubError('locked', `会话被其他进程占用（${(e as Error).message}）`);
      }
      throw new HubError('not_found', (e as Error).message);
    }
    const entry: HubEntry = {
      id,
      dir: resumed.dir,
      // S1：每会话真实 cwd 从 header 读（旧日志缺 header.cwd 时回退 hub 全局 cwd）
      cwd: headerCwdOr(resumed.header?.cwd, this.options.cwd),
      writer: new EventMirrorWriter(resumed.writer, (event) => {
        this.noteTurnEvent(id, event);
        this.emitEvent(id, event);
      }),
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** S1：会话执行 cwd（entries 内存值；未注册回退 hub 全局 cwd） */
  private sessionCwd(id: string): string {
    return this.entries.get(id)?.cwd ?? this.options.cwd;
  }

  /** 全量事件（含 active 标记）：切换会话时的重放来源；只读、不取锁 */
  events(id: string): SessionEventsPayload {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    const session = loadSession(dir);
    computeProjection(session); // 就地标记每个事件的活动性（影子事件 false）
    return {
      id,
      dir,
      header: session.header,
      events: session.events.map(({ event, active }) => ({ ...event, active })),
      warnings: session.warnings,
      lastSeq: session.events.at(-1)?.event.seq ?? 0,
    };
  }

  // —— S7 四契约只读查询（桌面接线；全部只读投影，不触发执行/写/审批） ——

  /** run-config：有效运行配置只读视图（脱敏 + 深度冻结）。装配来源 = hub 真实状态
   *  （provider 元数据/审批策略/工具集/每会话 cwd/容量），不建第二套配置存储。 */
  runConfigView(id: string): EffectiveRunConfig {
    this.assertValidSessionId(id);
    this.locate(id); // 404 校验会话存在（只读定位，不取锁）；未注册会话回退全局 cwd
    const root = this.options.cwd;
    const cwd = this.sessionCwd(id);
    const now = new Date().toISOString();
    const input: EffectiveRunConfigInput = {
      session: { sessionId: id, root, cwd, cwdFromHeader: cwd !== root },
      provider: this.options.providerMeta ?? this.fallbackProviderMeta(),
      ...(this.options.approvalConfig !== undefined ? { approval: this.options.approvalConfig } : {}),
      memoryMode: this.options.memory?.mode ?? 'off',
      tools: this.toolsForSession(id).list().map((d) => d.name),
      ...(this.options.skills !== undefined
        ? { skills: this.options.skills.scan().skills.map((s) => ({ name: s.name, source: s.source })) }
        : {}),
      ...(this.options.contextWindow !== undefined ? { contextWindow: this.options.contextWindow } : {}),
      ...(this.options.maxOutputTokens !== undefined ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      snapshot: { revision: this.configRevisions.get(id) ?? 0, capturedAt: now, effectiveAt: now },
      ...(this.lastRetryBudgets.get(id) !== undefined ? { retryBudget: this.lastRetryBudgets.get(id) } : {}),
    };
    return buildEffectiveRunConfig(input);
  }

  /** plan-state：从磁盘账本/会话日志重建计划状态（只读；无 task/transition 账本 → null） */
  planStateView(id: string): PlanState | null {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    return loadPlanState(dir);
  }

  /** execution-view：命令执行只读视图（真实 shell/exitCode 归属）。来源 = 会话日志 tool/call
   *  （plannedArgs/turnId）+ hub 生命周期观察记录（startedAt/终态）+ env（cwd/shell）。
   *  纯投影：不执行、不写盘。 */
  executionViews(id: string): ToolExecutionView[] {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    const cwd = this.sessionCwd(id);
    const shell = detectShell();
    const session = loadSession(dir);
    computeProjection(session); // 只取当前投影内的活动 tool/call（影子事件不展示）
    const perCall = this.execTraces.get(id) ?? new Map<string, ExecTraceRecord>();
    // taskId 归属：journal call/started 账本（S3a 单写；只读扫描）
    const taskOfCall = new Map<string, string>();
    for (const e of readEntries(dir).entries) {
      if (e.kind === 'call/started' && e.taskId !== undefined) taskOfCall.set(e.callId, e.taskId);
    }
    const views: ToolExecutionView[] = [];
    for (const { event, active } of session.events) {
      if (!active || event.type !== 'tool/call') continue;
      const call = event.payload;
      const rec = perCall.get(call.callId);
      const trace: ToolExecutionTrace = {
        callId: call.callId,
        ...(taskOfCall.get(call.callId) !== undefined ? { taskId: taskOfCall.get(call.callId) } : {}),
        ...(call.turnId !== undefined ? { turnId: call.turnId } : {}),
        tool: call.tool,
        plannedArgs: call.args,
        cwd,
        ...(shell !== undefined ? { shell } : {}),
        ...(rec?.startedAt !== undefined ? { executedArgs: rec.executedArgs, startedAt: rec.startedAt } : {}),
        ...(rec?.endedAt !== undefined
          ? { endedAt: rec.endedAt, ok: rec.ok, output: rec.output, error: rec.error, durationMs: rec.durationMs }
          : {}),
      };
      views.push(buildToolExecutionView(trace));
    }
    return views;
  }

  /** change-review：变更审查只读报告（拟议 vs 真实 diff / 外部修改标 dirty；不触发恢复/写盘） */
  changeReviewView(id: string): ChangeSet {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    return reviewChangeSet(new SnapshotStore(dir));
  }

  /** 注入 provider 而无装配元数据时的诚实回退：从 ChatProvider.name 推导（channel/model）；protocol 缺省按 openai（桌面配置路径恒走真实元数据） */
  private fallbackProviderMeta(): SessionHubProviderMeta {
    const name = this.options.provider.name;
    const [channel, model] = name.split('/');
    return {
      role: 'main',
      channel: channel ?? name,
      model: model ?? name,
      protocol: 'openai',
      name,
    };
  }

  // —— turn 流转 ——

  /** 用户消息：入该会话串行队列（busy 即排队，同 REPL）；未知会话先 ensureOpen */
  sendUserMessage(id: string, text: string): void {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new HubError('invalid', 'text 必须是非空字符串');
    }
    this.assertValidSessionId(id);
    this.ensureOpen(id);
    const queue = this.pendingTexts.get(id) ?? [];
    queue.push(text);
    this.pendingTexts.set(id, queue);
    this.pump(id);
  }

  /** 取消当前 turn（无运行中 turn 时 no-op）；turn 以 cancelled 收尾（loop 取消语义） */
  abort(id: string): boolean {
    const ac = this.running.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  isBusy(id: string): boolean {
    return this.running.has(id) || (this.pendingTexts.get(id)?.length ?? 0) > 0;
  }

  private pump(id: string): void {
    if (this.running.has(id)) return;
    const entry = this.entries.get(id);
    const queue = this.pendingTexts.get(id);
    if (!entry || !queue || queue.length === 0) return;
    const text = queue.shift()!;
    const run = this.runOne(id, entry, text).catch(() => {}); // runOne 内部已收口，防御性兜底
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  private async runOne(id: string, entry: HubEntry, text: string): Promise<void> {
    const ac = new AbortController();
    this.running.set(id, ac);
    // FixB：turn 启动 = 新代次（per-session 单调递增；与 turnId 分配解耦，只在运行中有效）
    this.turnGenerations.set(id, (this.turnGenerations.get(id) ?? 0) + 1);
    // S7：turn 启动 = 新配置 revision（run-config 只读投影的 snapshot 依据）
    this.configRevisions.set(id, (this.configRevisions.get(id) ?? 0) + 1);
    const snapshots = new SnapshotStore(entry.dir);
    this.memoryToolUseInTurn.delete(id); // 每 turn 重置 memory 工具使用标记
    try {
      const result = await runTurn(entry.writer, {
        provider: this.options.provider,
        tools: this.buildTurnTools(id),
        approval: this.makeApprovalHandler(id, ac.signal),
        cwd: entry.cwd, // S1：每会话真实 cwd（从此前审计的 this.options.cwd 改为 header 真值）
        userText: text,
        signal: ac.signal,
        snapshots,
        // S1：执行生命周期观察接线（S3 delivery / S7 toolExecutionView 消费；纯观察）
        executionObserver: {
          onExecuteStart: (req) => this.emitExecuteStart(id, req),
          onExecuteEnd: (req, result) => this.emitExecuteEnd(id, req, result),
        },
        onStream: (event: TurnStreamEvent) => this.forwardStream(id, event),
        // S6 会话级 steer sink：跨 turn 持久，loop 在每个安全 step 边界取「本 turn 未消费」的 steer
        steer: this.steerSinkFor(id),
        // 审查 P1-1：serve/desktop 路径同样注入记忆 store（缺此前主会话零快照、system 恒空）
        ...(this.options.memory !== undefined ? { memory: this.options.memory.store } : {}),
        // 阶段 10：Skills 列表注入（每 turn 重扫磁盘；全文走 skill 工具）
        ...(this.options.skills !== undefined ? { skills: this.options.skills } : {}),
        // 阶段 7：上下文压缩装配（启动器按 config 派生；缺省不压缩）
        ...(this.options.compaction !== undefined ? { compaction: this.options.compaction } : {}),
      });
      if (result.retryBudget !== undefined) this.lastRetryBudgets.set(id, result.retryBudget);
      this.emitTurnEnd(id, result);
      this.finalizeAttempt(id, result);
      this.bumpNudge(id); // turn-end 回调之后计数/触发复盘（异步，不阻塞主对话）
    } catch (e) {
      // 复审 P2-3：非预期异常（provider 抛错之外的装配/快照/写盘错误）也要给客户端
      // turn-end 收口——否则 pump 的防御性静默 catch 会让消息凭空消失。
      // error 消息过 redactSecrets 再出站（错误路径最后闸门）。
      const errorResult: TurnResult = {
        stopReason: 'error',
        steps: 0,
        toolCalls: 0,
        durationMs: 0,
        error: redactSecrets((e as Error)?.message ?? String(e)),
      };
      this.emitTurnEnd(id, errorResult);
      this.finalizeAttempt(id, errorResult);
      throw e; // rethrow-safe：pump 已有防御性兜底，不留未处理拒绝
    } finally {
      this.running.delete(id);
      // 队列里还有同会话消息 → 继续泵（保持 await 顺序，串行语义）
      this.pump(id);
    }
  }

  /**
   * turn 工具注册表：无记忆/浏览器/subagent 装配时直接复用共享注册表；有则按会话换装——
   * memory 工具按模式绑定 store/pending，browser_* 工具按会话 id 绑定池键，
   * subagent 工具按会话 id 绑定血缘（父子审批/取消传播随之按会话上抛）。
   */
  private buildTurnTools(sessionId: string): ToolRegistry {
    const memory = this.options.memory;
    const browser = this.options.browser;
    const subagent = this.options.subagent;
    if (memory === undefined && browser === undefined && subagent === undefined) return this.options.tools;
    const registry = new ToolRegistry();
    const subNames = new Set<string>(SUBAGENT_TOOL_NAMES);
    for (const def of this.options.tools.list()) {
      if (def.name === 'memory') continue; // 换装按会话绑定的变体
      if (subagent !== undefined && subNames.has(def.name)) {
        // P1-3：插件抢占 subagent 权威工具名 → per-turn 换装天然剔除插件版（权威版随后重挂），
        // 但不静默——首次命中时告警一次（stderr，与 McpManager 缺省 sink 同口径）
        if (!this.subagentNameConflictsWarned.has(def.name)) {
          this.subagentNameConflictsWarned.add(def.name);
          console.error(
            `warning: 工具 "${def.name}" 与 subagent 权威工具重名，turn 工具集使用权威版本（冲突插件工具被过滤）`,
          );
        }
        continue;
      }
      registry.register(def);
    }
    if (memory !== undefined) {
      registry.register(createMemoryToolForMode(memory.store, memory.mode, memory.pending, sessionId));
    }
    if (browser !== undefined) {
      for (const def of createBrowserTools(sessionId, browser.pool)) registry.register(def);
    }
    if (subagent !== undefined) {
      for (const def of createSubagentTools({
        manager: this.options.manager,
        provider: subagent.provider,
        baseTools: this.options.tools,
        cwd: this.sessionCwd(sessionId), // S1：子会话默认 root = 父会话真实 cwd（不取 hub 全局）
        maxDepth: subagent.maxDepth,
        maxTurns: subagent.maxTurns,
        // S5：后台任务协调器（可选路由进 coordinator：subagent_start 注册为后台任务，后台并发/写串行）
        coordinator: this.tasks,
        registerTask: this.registerTask.bind(this),
        background: subagent.backgroundTasks ?? false,
        ...(subagent.taskWriteMode !== undefined ? { taskWriteMode: subagent.taskWriteMode } : {}),
        parentSessionId: sessionId,
        depth: 0,
        // 子会话事件/turn-end 桥接进 hub 观察者（WS 面可见子会话流量）
        hooks: {
          onChildEvent: (childId, event) => this.emitEvent(childId, event),
          onChildTurnEnd: (childId, result) => this.emitTurnEnd(childId, result),
        },
        // 子会话 ask 上抛同一待审批队列（requestId 全局可应答；payload.sessionId = 子会话）。
        // S2：血缘在工厂闭包记录（childId→parentId），工厂三参签名修 maxDepth>1 血缘——
        // 孙会话父 = 落地子会话（非顶父；交付链/后代 BFS 随之准确）
        approvalFactory: (childId, parentId, signal) => {
          this.subagentChildren.set(childId, parentId);
          return this.makeApprovalHandler(childId, signal);
        },
        // 阶段 11 口径统一（加性）：子会话注入宿主同款 skills 列表（与 chat REPL 一致）
        ...(this.options.skills !== undefined ? { skills: this.options.skills } : {}),
      })) {
        registry.register(def);
      }
    }
    return registry;
  }

  /** EventMirrorWriter 事件侧记：运行中 turn 调过 memory 工具（nudge 计数归零依据）；
   *  以及 user/message 即本 turn 的日志投影起点 → 绑定运行身份（turnId→会话+代次），
   *  cancel 在首个流事件之前即可定位（FixB：代次绑定与 turnId 分配自洽）。 */
  private noteTurnEvent(sessionId: string, event: AnySessionEvent): void {
    if (event.type === 'tool/call' && event.payload.tool === 'memory') {
      this.memoryToolUseInTurn.add(sessionId);
    }
    if (event.type === 'user/message' && event.payload.turnId !== undefined && this.running.has(sessionId)) {
      this.bindRunningTurn(sessionId, event.payload.turnId);
    }
  }

  /** 绑定运行中 turn 身份：turnId → 会话 + 代次。幂等（同 turnId 已绑定则跳过）；
   *  首个可见点（user/message 事件 / 首个流事件）调用，二者同源同一 turn。 */
  private bindRunningTurn(sessionId: string, turnId: string): void {
    if (this.runningTurnId.has(turnId)) return;
    this.runningTurnId.set(turnId, sessionId);
    const gen = this.turnGenerations.get(sessionId);
    if (gen !== undefined) this.turnGenerationByTurnId.set(turnId, gen);
  }

  /** nudge 计数：turn 完成 +1（调过 memory 工具 → 归零）；到 nudgeInterval 触发后台复盘并归零 */
  private bumpNudge(id: string): void {
    const memory = this.options.memory;
    if (memory === undefined) return;
    if (this.memoryToolUseInTurn.has(id)) {
      this.memoryToolUseInTurn.delete(id);
      this.nudgeCounts.set(id, 0);
      return;
    }
    const count = (this.nudgeCounts.get(id) ?? 0) + 1;
    if (count < memory.nudgeInterval) {
      this.nudgeCounts.set(id, count);
      return;
    }
    this.nudgeCounts.set(id, 0);
    this.startNudgeReview(id);
  }

  /** 后台复盘：fire-and-forget（inflight 跟踪，close 时取消并等待）；异常在 runNudgeReview 内收口 */
  private startNudgeReview(id: string): void {
    const memory = this.options.memory;
    const entry = this.entries.get(id);
    if (memory === undefined || entry === undefined) return;
    const ac = new AbortController();
    this.reviewRunning.add(ac);
    const run = runNudgeReview({
      provider: memory.reviewProvider ?? this.options.provider,
      store: memory.store,
      mode: memory.mode,
      sessionId: id,
      sessionDir: entry.dir,
      cwd: entry.cwd, // 复盘与主 turn 同款：用会话真实 cwd（不取 hub 全局）
      ...(memory.pending !== undefined ? { pending: memory.pending } : {}),
      signal: ac.signal,
      onStarted: (sessionId) => this.emitNudgeStarted(sessionId),
      onFinished: (result) => this.emitNudgeFinished(result.sessionId, result),
    })
      .then(() => {})
      .catch(() => {});
    this.inflight.add(run);
    void run.finally(() => {
      this.inflight.delete(run);
      this.reviewRunning.delete(ac);
    });
  }

  /** 测试/诊断用：nudge 计数快照 */
  nudgeCount(id: string): number {
    return this.nudgeCounts.get(id) ?? 0;
  }

  private forwardStream(id: string, event: TurnStreamEvent): void {
    // S3c2：任一流事件都登记 running turn 展示身份（real turnId 来自 loop；activeAttempt/水位依据）
    const disp = this.turnDisplayFor(id, event.turnId);
    if (event.type === 'text-delta') {
      this.emitDelta(id, { kind: 'text', text: event.text });
      disp.textLen += event.text.length;
      this.acceptWatermark(id, { kind: 'text', text: event.text }, disp, disp.textLen - event.text.length);
    } else if (event.type === 'reasoning-delta') {
      this.emitDelta(id, { kind: 'reasoning', text: event.text });
      disp.reasoningLen += event.text.length;
      this.acceptWatermark(id, { kind: 'reasoning', text: event.text }, disp, disp.reasoningLen - event.text.length);
    } else if (event.type === 'tool-call') {
      this.emitDelta(id, { kind: 'tool', call: event.call });
    }
    // tool-result 不发增量：落盘 tool/result 事件镜像已覆盖（delta 只做"未落盘"内容）
  }

  // —— undo / redo（直调 Ph4 内核；busy 会话拒绝） ——

  undo(id: string, opts: { n?: number; dryRun?: boolean } = {}): { results: UndoRedoResult[]; error?: string } {
    this.assertValidSessionId(id);
    const n = opts.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > UNDO_MAX_N) {
      throw new HubError('invalid', `无效的撤回层数 ${n}（应为 1..${UNDO_MAX_N} 整数）`);
    }
    if (this.isBusy(id)) {
      throw new HubError('busy', 'turn 进行中，无法 undo（先停止当前 turn）');
    }
    const entry = this.entryFor(id);
    const snapshots = new SnapshotStore(entry.dir);
    const dryRun = opts.dryRun === true;
    return this.applyUndoRedo(n, () =>
      undoLastTurn(entry.writer, { snapshots, ...(dryRun ? { dryRun: true } : {}) }),
    );
  }

  redo(id: string): { results: UndoRedoResult[]; error?: string } {
    this.assertValidSessionId(id);
    if (this.isBusy(id)) {
      throw new HubError('busy', 'turn 进行中，无法 redo（先停止当前 turn）');
    }
    const entry = this.entryFor(id);
    return this.applyUndoRedo(1, () => redoLastUndo(entry.writer, { snapshots: new SnapshotStore(entry.dir) }));
  }

  /**
   * 连续执行 n 层（同 chat /undo n 口径）：UndoRedoError 停止——
   * 第 1 层即失败 = 抛 HubError（HTTP 错误路径）；后续层失败 = 带部分结果与 error 返回。
   */
  private applyUndoRedo(n: number, once: () => UndoRedoResult): { results: UndoRedoResult[]; error?: string } {
    const results: UndoRedoResult[] = [];
    for (let i = 0; i < n; i++) {
      try {
        results.push(once());
      } catch (e) {
        if ((e as Error).name !== 'UndoRedoError') throw e;
        if (results.length === 0) throw new HubError('invalid', (e as Error).message);
        return { results, error: (e as Error).message };
      }
    }
    return { results };
  }

  // —— fork（阶段 6：血缘派生，只读原会话，busy 会话也允许——append-only 日志并发读安全） ——

  fork(id: string, opts: { atSeq?: number } = {}): ForkResult {
    this.assertValidSessionId(id);
    try {
      return forkSession(this.options.manager, id, opts.atSeq !== undefined ? { atSeq: opts.atSeq } : {});
    } catch (e) {
      if (e instanceof ForkError) throw new HubError(e.code, e.message);
      throw e;
    }
  }

  // —— 审批上抛 ——

  /** 全部待处理审批快照（含 scope/expiresAt 全量契约；诊断/订阅重放用） */
  listPendingApprovals(): ApprovalRequestContract[] {
    return this.approvals.listPending();
  }

  /** 指定会话可见的待处理审批：自身 + 后代（subagent 血缘 BFS 展开）——重连恢复/父侧下钻用 */
  pendingApprovalsFor(sessionId: string): ApprovalRequestContract[] {
    this.assertValidSessionId(sessionId);
    const childrenOf = new Map<string, string[]>(); // parentId → childIds
    for (const [child, parent] of this.subagentChildren) {
      const list = childrenOf.get(parent) ?? [];
      list.push(child);
      childrenOf.set(parent, list);
    }
    const scope = new Set<string>([sessionId]);
    const queue = [sessionId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (!scope.has(child)) {
          scope.add(child);
          queue.push(child);
        }
      }
    }
    return this.approvals.listPending().filter((a) => scope.has(a.sessionId));
  }

  /** 审批响应：明确 ack（applied/duplicate/expired/unknown）；非法/未知 requestId 不抛错 */
  respondApproval(requestId: string, decision: ApprovalResponseDecision): ApprovalResponseAck {
    if (!isApprovalDecision(decision)) {
      return { requestId, state: 'unknown' };
    }
    return this.approvals.respond(requestId, decision);
  }

  /** S5 任务用审批缝：task 运行（子会话 runTurn）内工具审批借此上抛，并把 taskId/parentTaskId
   *   带入 ApprovalRequestContract（父侧据此归属子任务审批；仍然 fail-closed——无授权不自allow）。 */
  taskApprovalHandler(
    childSessionId: string,
    signal: AbortSignal,
    task?: { taskId?: TaskId; parentTaskId?: TaskId },
  ): ApprovalHandler {
    return this.makeApprovalHandler(childSessionId, signal, task);
  }

  /** S5 任务/子代理血缘登记：把 child 会话挂到 parent 下（交付链/后代 BFS/审批上抛据此归属）。 */
  linkChildSession(parentId: string, childId: string): void {
    this.assertValidSessionId(parentId);
    this.assertValidSessionId(childId);
    this.subagentChildren.set(childId, parentId);
  }

  // —— S3c2 submit / cancel / resumeSnapshot（实现 ResumeStateProvider 缝；ws.ts 传输层经此转发） ——

  /** 会话级 delivery：打开/新建 runtime journal 并恢复 queue（重启默认 paused，不自动执行）。
   *   journal 单写 = 本 hub（进程内 RuntimeJournal 守卫 + pid 锁文件）；与 session.log 写者协调同一
   *   hub 出口，不引入双写冲突。会话锁被占 → HubError('locked')；未知会话 → HubError('not_found')。 */
  private deliveryFor(id: string): HubDelivery {
    const entry = this.entryFor(id);
    const existing = this.deliveries.get(id);
    if (existing !== undefined) return existing;
    const journalPath = join(entry.dir, RUNTIME_JOURNAL_FILE);
    const journalExists = existsSync(journalPath);
    let journal: RuntimeJournal;
    try {
      journal = journalExists ? RuntimeJournal.open(entry.dir) : RuntimeJournal.create(entry.dir);
    } catch (e) {
      if ((e as Error).name === 'RuntimeJournalLockedError') {
        throw new HubError('locked', (e as Error).message);
      }
      throw e;
    }
    const session = createDeliverySession(journal, id);
    if (journalExists) {
      // 重启恢复：先前 durable accepted 一律 state:paused（正文置空，不惊喜执行；S5 补任务化）
      for (const q of recoverQueue(entry.dir, { sessionId: id })) session.queue.push(q);
    }
    const hd: HubDelivery = { session, journal };
    this.deliveries.set(id, hd);
    return hd;
  }

  /** task/transition 落到任务归属会话的 runtime journal（recorder 适配；S3a 账本单写） */
  private makeTaskRecorder(): TaskTransitionRecorder {
    return {
      appendTaskTransition: (i) => {
        const sessionId = this.taskSessions.get(i.taskId);
        if (sessionId === undefined) return; // 未知任务归属（不应发生）：不落账
        const hd = this.deliveries.get(sessionId);
        if (hd === undefined) return;
        hd.journal.append({
          kind: 'task/transition',
          taskId: i.taskId,
          parentTaskId: i.parentTaskId,
          clientMessageId: i.clientMessageId,
          background: i.background,
          from: i.from,
          to: i.to,
          // FixC E1：记录写入时 session.log lastSeq 水位（plan-state 目标 seq 锚定；缺日志回退 ts）
          ...(this.sessionLogLastSeq(sessionId) !== undefined
            ? { sessionLogSeq: this.sessionLogLastSeq(sessionId) }
            : {}),
        });
      },
    };
  }

  /** FixC E1：该会话 session.log 的当前 lastSeq（只读；缺日志/损坏 → undefined，plan-state 回退 ts 锚定） */
  private sessionLogLastSeq(sessionId: SessionId): number | undefined {
    try {
      const dir = this.locate(sessionId);
      const { events } = loadSession(dir);
      return events.at(-1)?.event.seq ?? 0;
    } catch {
      return undefined;
    }
  }

  /**
   * S5 后台任务注册：登记任务归属会话（task/transition 落该会话 journal）后交给协调器立即调度。
   * 返回 background 任务的可分离 handle（state 已入账；协调器负责并发/资源锁/生命周期）。
   */
  registerTask(spec: TaskSpec): TaskContract {
    this.assertValidSessionId(spec.sessionId);
    // 确保该会话 journal 已打开（任务归属会话的账本目标）
    this.deliveryFor(spec.sessionId);
    this.taskSessions.set(spec.taskId, spec.sessionId);
    return this.tasks.register(spec);
  }

  /** S5 queue continue 清场：把恢复的 paused 项出队（delivery 层），并按需回填正文后真正派发执行。 */
  continueQueue(sessionId: SessionId, resolveText?: (clientMessageId: ClientMessageId) => string | undefined): number {
    this.assertValidSessionId(sessionId);
    const hd = this.deliveries.get(sessionId);
    if (hd === undefined) return 0;
    const cleared = continueQueue(hd.session);
    for (const item of cleared) {
      const body = resolveText?.(item.id) ?? item.rawText;
      if (body.trim().length > 0) {
        try {
          this.sendUserMessage(sessionId, body);
        } catch {
          // 派发失败不阻断 continue；幂等键已出队
        }
      }
    }
    return cleared.length;
  }

  /** submit 走 delivery：S3b 幂等原语（durable-then-ack）；accepted 后按顺序派发进既有 turn 管线。
   *   S6：intent=steer 不走 delivery journal——steer 是**控制输入**（不落 session.log、不伪造
   *   用户正文），接收/去重/排队在会话级 sink（跨 turn 持续），loop 在安全 step 边界消费。 */
  submitAck(req: SubmitRequest): SubmitAck {
    this.assertValidSessionId(req.sessionId);
    this.ensureOpen(req.sessionId);
    if (req.intent === 'steer') {
      if (req.expectedTurnId === undefined || req.expectedTurnId.length === 0) {
        return {
          clientMessageId: req.clientMessageId,
          sessionId: req.sessionId,
          state: 'rejected',
          reason: 'intent=steer 需要 expectedTurnId（仅在该 turn 仍存在时接受）',
        };
      }
      if (typeof req.rawText !== 'string' || req.rawText.trim().length === 0) {
        return {
          clientMessageId: req.clientMessageId,
          sessionId: req.sessionId,
          state: 'rejected',
          reason: 'intent=steer 的 rawText 必须是非空字符串',
        };
      }
      const registered = this.steerSinkFor(req.sessionId).push({
        id: req.clientMessageId,
        expectedTurnId: req.expectedTurnId,
        text: req.rawText,
      });
      return registered
        ? { clientMessageId: req.clientMessageId, sessionId: req.sessionId, state: 'accepted' }
        : {
            clientMessageId: req.clientMessageId,
            sessionId: req.sessionId,
            state: 'rejected',
            reason: '重复 steer id（同 id 会话内只生效一次）',
          };
    }
    const hd = this.deliveryFor(req.sessionId);
    const ack = submitDelivery(hd.session, req);
    if (ack.state === 'accepted') this.dispatchQueued(req.sessionId);
    return ack;
  }

  /** queue 启动：把 durable accepted 项按顺序送进既有 turn 启动路径（sendUserMessage → runTurn）。
   *   已 paused（重启恢复）/ 已派发（dispatched 水位）项跳过；不写第二套正文，turn 启动仍由
   *   session.log 投影驱动（事件溯源不破坏）。 */
  private dispatchQueued(sessionId: string): void {
    const hd = this.deliveries.get(sessionId);
    if (hd === undefined) return;
    const start = this.dispatched.get(sessionId) ?? 0;
    for (let i = start; i < hd.session.queue.length; i++) {
      const item = hd.session.queue[i]!;
      if (item.state !== 'queued') continue;
      if (item.rawText.trim().length === 0) continue; // 空正文不派发（恢复项 paused 不会走到）
      this.dispatched.set(sessionId, i + 1);
      try {
        this.sendUserMessage(sessionId, item.rawText);
      } catch {
        // 派发失败（如会话被其他进程锁定）不阻断 ack；幂等键保留，客户端重试经 judgeSubmission 收敛
      }
    }
  }

  /**
   * cancel 接线。expectedId 语义按 target 分：
   *   - target.turn：期望目标身份（= target.id 时通过）+ FixB 代次（expectedTurnGeneration
   *     与目标当前代次严格相等才命中）——代次不匹配（重连重放旧代次帧）→ unknown，不误杀
   *     复用同 turnId 的新 turn；旧客户端无代次字段 → 回退 target.id 匹配（文档化取舍）；
   *   - target.task：期望任务当前状态（S5 协调器 expectedId 校验）——陈旧期望被拒。
   * turn：运行中 turnId → abort（stopping）；已确认取消 → cancelled；其余 → unknown。
   * task：协调器任务注册表 → stopping/cancelled/unknown。
   */
  cancelAck(req: CancelRequest): CancelAck {
    if (req.target.kind === 'turn') {
      // 身份并发防护（S3c2 carry-over）：期望身份与目标不一致 → 拒绝，不触达新目标
      if (req.expectedId !== undefined && req.expectedId !== req.target.id) {
        return { requestId: req.requestId, state: 'unknown' };
      }
      const sessionId = this.runningTurnId.get(req.target.id);
      if (sessionId !== undefined) {
        // FixB：代次不匹配（旧代次帧）→ unknown，不 abort 运行中的新 turn
        const gen = this.turnGenerationByTurnId.get(req.target.id);
        if (matchTurnGeneration(req.expectedTurnGeneration, gen) === 'stale') {
          return { requestId: req.requestId, state: 'unknown' };
        }
        this.abort(sessionId); // 取消当前 turn；已完成工具变更不撤销（executor 不因 abort 回滚文件）
        return { requestId: req.requestId, state: 'stopping' };
      }
      if (this.cancelledTurns.has(req.target.id)) {
        // FixB：确认记忆带代次（turnId 复用时不串）；旧代次确认帧 → unknown
        const gen = this.cancelledTurnGeneration.get(req.target.id);
        if (matchTurnGeneration(req.expectedTurnGeneration, gen) === 'stale') {
          return { requestId: req.requestId, state: 'unknown' };
        }
        return { requestId: req.requestId, state: 'cancelled' };
      }
      return { requestId: req.requestId, state: 'unknown' };
    }
    // target.task：协调器任务注册表；expectedId = 期望任务当前状态（陈旧期望被拒）
    const taskState = this.tasks.status(req.target.id)?.state;
    if (taskState === undefined) return { requestId: req.requestId, state: 'unknown' };
    const ack = this.tasks.cancel(req.target.id, {
      expectedId: isTaskState(req.expectedId) ? req.expectedId : undefined,
    });
    // 父 cancel → 子 abort：协调器经其 controller signal 驱动任务 run 中止（run 把 signal 传给
    // 子会话 runTurn，子 turn 随之取消）；此处不 abort 归属父会话——父会话自己的 turn 不得被
    // 子任务的取消误伤（父子隔离）。coordinator 已驱动 abort，故不再额外 abort 任何 session。
    return { requestId: req.requestId, state: ack.state };
  }

  /** resume-snapshot 在途/队列状态组装（replay 范围由 ws.ts 层以磁盘投影计算）。
   *   activeAttempt 由运行中 turn 的展示投影给出；tasks 由 journal task/transition 重建；
   *   pendingApprovals 由 hub 审批队列提供；queue = 活队列（重启恢复 = paused）。 */
  resumeSnapshot(req: ResumeSubscriptionRequest): Omit<ResumeSnapshot, 'epoch' | 'replay'> | null {
    this.assertValidSessionId(req.sessionId);
    let hd: HubDelivery;
    try {
      hd = this.deliveryFor(req.sessionId);
    } catch (e) {
      if (e instanceof HubError && e.code === 'not_found') return null;
      throw e;
    }
    const active = this.activeAttemptFor(req.sessionId);
    return {
      ...(active !== undefined ? { activeAttempt: active } : {}),
      tasks: this.tasksFor(req.sessionId),
      pendingApprovals: this.pendingApprovalsFor(req.sessionId),
      queue: hd.session.queue,
    };
  }

  /** 运行中 turn 的 attempt 展示快照（S0 AttemptSnapshot）；未运行/无流事件 → undefined */
  private activeAttemptFor(sessionId: string): AttemptSnapshot | undefined {
    if (!this.running.has(sessionId)) return undefined;
    const disp = this.turnDisplay.get(sessionId);
    if (disp === undefined) return undefined;
    const generation = this.turnGenerationByTurnId.get(disp.turnId);
    return {
      attemptId: disp.attemptId,
      turnId: disp.turnId,
      textChunkOffset: disp.textLen,
      reasoningChunkOffset: disp.reasoningLen,
      status: this.pendingApprovalsFor(sessionId).length > 0 ? 'waiting-approval' : 'running',
      // FixB 加性：当前 turn 代次（重连快照据其发正确代次的 cancel）
      ...(generation !== undefined ? { generation } : {}),
    };
  }

  /** tasks：由 journal task/transition 重建（最后一条迁移 = 当前状态）；无任务记录 = [] */
  private tasksFor(id: string): TaskContract[] {
    const hd = this.deliveries.get(id);
    if (hd === undefined) return [];
    const transitions = hd.journal
      .readEntries()
      .entries.filter((e) => e.kind === 'task/transition')
      .map((e) => ({
        taskId: e.taskId,
        ...(e.parentTaskId !== undefined ? { parentTaskId: e.parentTaskId } : {}),
        background: e.payload.background,
        from: e.payload.from,
        to: e.payload.to,
        ...(e.ts !== undefined ? { ts: e.ts } : {}),
      }));
    return reconstructTasks(transitions);
  }

  // —— S3c2 展示投影：流事件 → 带水位 delta 帧 / turn 落定帧 ——

  /** 取/建运行中 turn 的展示身份（real turnId 来自 loop 单点生成；attemptId 按 turn 合成） */
  private turnDisplayFor(sessionId: string, turnId: string): { turnId: string; attemptId: string; textLen: number; reasoningLen: number } {
    const existing = this.turnDisplay.get(sessionId);
    if (existing !== undefined && existing.turnId === turnId) return existing;
    const created = { turnId, attemptId: `att-${turnId.slice(0, 8)}`, textLen: 0, reasoningLen: 0 };
    this.turnDisplay.set(sessionId, created);
    this.bindRunningTurn(sessionId, turnId);
    return created;
  }

  /** WatermarkCursor 接流事件：接受连续块 → onDeliveryDelta；同 attempt 内重启（provider 重试从 0 重流）
   *   先重置水位再接受（展示投影连续，不丢重试内容）。 */
  private acceptWatermark(
    sessionId: string,
    delta: { kind: 'text' | 'reasoning'; text: string },
    disp: { turnId: string; attemptId: string },
    offset: number,
  ): void {
    let frame = this.watermark.accept(sessionId, delta, disp, offset);
    if (frame === null && offset === 0) {
      this.watermark.reset(sessionId, disp.attemptId);
      frame = this.watermark.accept(sessionId, delta, disp, offset);
    }
    if (frame !== null) this.emitDeliveryDelta(sessionId, frame);
  }

  /** turn 落定：display 终态帧（attempt-final）+ cancel 确认记忆 + 运行身份清理 */
  private finalizeAttempt(sessionId: string, result: TurnResult): void {
    const disp = this.turnDisplay.get(sessionId);
    if (disp === undefined) return;
    const state = result.stopReason === 'cancelled' ? 'cancelled' : result.stopReason === 'error' ? 'failed' : 'completed';
    const frame: AttemptFinalFrame = {
      type: 'attempt-final',
      sessionId,
      turnId: disp.turnId,
      attemptId: disp.attemptId,
      state,
      ...(result.finalText !== undefined ? { finalText: result.finalText } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    this.emitAttemptFinal(sessionId, frame);
    if (result.stopReason === 'cancelled') {
      this.cancelledTurns.add(disp.turnId);
      // FixB：确认记忆带代次（旧代次确认帧 → unknown；turnId 复用不串）
      const gen = this.turnGenerationByTurnId.get(disp.turnId);
      if (gen !== undefined) this.cancelledTurnGeneration.set(disp.turnId, gen);
    }
    this.runningTurnId.delete(disp.turnId);
    this.turnGenerationByTurnId.delete(disp.turnId);
    this.turnDisplay.delete(sessionId);
  }

  /** 送达链：自身会话 + 祖先（subagent 血缘；父审批请求投递给落地父 + 全程祖先，child 结束前父可见） */
  private deliveryChain(sessionId: string): string[] {
    const chain = [sessionId];
    let current = sessionId;
    for (let i = 0; i < 64; i++) {
      const parent = this.subagentChildren.get(current);
      if (parent === undefined) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  // —— 观察者分发（异常互不影响：单观察者抛错不阻断其他分发与内核） ——

  private emitEvent(sessionId: string, event: AnySessionEvent): void {
    for (const l of this.listeners) {
      try {
        l.onEvent?.(sessionId, event);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitDelta(sessionId: string, delta: TurnDelta): void {
    for (const l of this.listeners) {
      try {
        l.onDelta?.(sessionId, delta);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitDeliveryDelta(sessionId: string, frame: DeliveryDeltaFrame): void {
    for (const l of this.listeners) {
      try {
        l.onDeliveryDelta?.(sessionId, frame);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitAttemptFinal(sessionId: string, frame: AttemptFinalFrame): void {
    for (const l of this.listeners) {
      try {
        l.onAttemptFinal?.(sessionId, frame);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitTurnEnd(sessionId: string, result: TurnResult): void {
    for (const l of this.listeners) {
      try {
        l.onTurnEnd?.(sessionId, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  /** S6 会话级 steer 回帧分发（loop resolve 后经 sink notify 回调本方法） */
  private emitSteerResult(sessionId: string, result: SteerResult): void {
    for (const l of this.listeners) {
      try {
        l.onSteerResult?.(sessionId, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitNudgeStarted(sessionId: string): void {
    for (const l of this.listeners) {
      try {
        l.onNudgeStarted?.(sessionId);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitNudgeFinished(sessionId: string, result: NudgeResult): void {
    for (const l of this.listeners) {
      try {
        l.onNudgeFinished?.(sessionId, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitExecuteStart(sessionId: string, req: ToolExecutionRequest): void {
    // S7 记录（内存观察）：工具真正启动时点 + 真实执行参数（onExecuteStart 的 req 即真实参数）
    const perSession = this.execTraces.get(sessionId) ?? new Map<string, ExecTraceRecord>();
    perSession.set(req.callId, {
      ...(perSession.get(req.callId) ?? {}),
      startedAt: new Date().toISOString(),
      executedArgs: req.args,
    });
    this.execTraces.set(sessionId, perSession);
    for (const l of this.listeners) {
      try {
        l.onExecuteStart?.(sessionId, req);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitExecuteEnd(sessionId: string, req: ToolExecutionRequest, result: ToolResult): void {
    // S7 记录（内存观察）：终态一次（含未启动的拒绝/取消/未知工具）
    const perSession = this.execTraces.get(sessionId) ?? new Map<string, ExecTraceRecord>();
    perSession.set(req.callId, {
      ...(perSession.get(req.callId) ?? {}),
      endedAt: new Date().toISOString(),
      ok: result.ok,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    });
    this.execTraces.set(sessionId, perSession);
    for (const l of this.listeners) {
      try {
        l.onExecuteEnd?.(sessionId, req, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private makeApprovalHandler(
    sessionId: string,
    signal: AbortSignal,
    taskMeta?: { taskId?: TaskId; parentTaskId?: TaskId },
  ): ApprovalHandler {
    const decide = this.options.decide;
    return {
      // 「本会话总是」授权缓存预检：已授权工具直接 allow（队列授权语义，不重问 UI）；
      // 否则落策略（缺省 ask——绝不静默允许；旧执行器级 allow-all 默认仍由 loop 级保留）。
      decide: (input: ApprovalInput): ApprovalDecision => {
        if (this.approvals.grantFor(sessionId).has(input.tool)) return 'allow';
        return decide?.(input) ?? 'ask';
      },
      onAsk: async (input: ApprovalInput): Promise<boolean> => {
        // onAsk 只在 decide='ask' 时被 loop 调用：卡片协议 = 一次性授权（scope.once）。
        const approval: ApprovalRequestContract = {
          requestId: randomUUID(),
          sessionId,
          tool: input.tool,
          args: input.args,
          cwd: this.sessionCwd(sessionId),
          scope: { mode: 'once' },
          expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
          ...(taskMeta?.taskId !== undefined ? { taskId: taskMeta.taskId } : {}),
          ...(taskMeta?.parentTaskId !== undefined ? { parentTaskId: taskMeta.parentTaskId } : {}),
        };
        return new Promise<boolean>((resolve) => {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          const notify = (allowed: boolean, reason: ApprovalSettleReason): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            this.emitApprovalSettled(approval.requestId, allowed, reason);
            resolve(allowed);
          };
          // 登记失败（卡片 self-contain 校验不过，如 scope 越界/重复 id）：**不进队列**、按拒绝
          // 落定（fail-closed，无悬挂卡、不下发 UI）
          const node: ApprovalQueueCard = {
            approval,
            settle: (allowed, reason) => notify(allowed, reason),
          };
          timer = setTimeout(
            () => this.approvals.settle(approval.requestId, false, 'timeout'),
            this.approvalTimeoutMs,
          );
          if (!this.approvals.register(node)) {
            clearTimeout(timer);
            notify(false, 'cancelled');
            return;
          }
          const onAbort = (): void => this.approvals.settle(approval.requestId, false, 'cancelled');
          if (signal.aborted) {
            this.approvals.settle(approval.requestId, false, 'cancelled');
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          // 多点送达：自身 + 祖先（hub 层决定，观察者只广播）
          const deliverTo = this.deliveryChain(sessionId);
          for (const l of this.listeners) {
            try {
              l.onApprovalRequest?.(approval, deliverTo);
            } catch {
              // 观察者异常不回写内核
            }
          }
        });
      },
    };
  }

  private emitApprovalSettled(requestId: string, allowed: boolean, reason: ApprovalSettleReason): void {
    for (const l of this.listeners) {
      try {
        l.onApprovalSettled?.(requestId, allowed, reason);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  // —— 收尾 ——

  /** 关闭：进入即清排队消息（排队 turn 不再在关闭后继续跑）→ 取消运行中 turn 与复盘
   *  → 拒绝全部待审批 → 等待收尾 → 关闭全部 writer（释放目录锁） */
  async close(): Promise<void> {
    this.pendingTexts.clear();
    for (const ac of this.running.values()) ac.abort();
    for (const ac of this.reviewRunning.values()) ac.abort();
    this.approvals.settleAll('cancelled');
    // S5：取消全部后台任务并等待其收敛到终态（abort 落定、task/transition 落账完毕）
    // —— 必须在关闭/清理 deliveries 之前，否则仍在收尾的任务 onFinish 会向已关闭的 journal append。
    await this.tasks.settleAll();
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
    for (const entry of this.entries.values()) entry.writer.close();
    this.entries.clear();
    // S3c2：关闭各会话 delivery journal（释放 pid 锁；与 session.log writer 顺次收口）
    for (const hd of this.deliveries.values()) hd.journal.close();
    this.deliveries.clear();
    this.steerSinks.clear();
    this.pendingTexts.clear();
  }

  private assertNonEmpty(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new HubError('invalid', `${name} 必须是非空字符串`);
    }
  }

  /** sessionId 出口校验（复审 P2-1，路径穿越原语）：非法格式 → HubError('invalid')，不触达文件系统 */
  private assertValidSessionId(id: string): void {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
      throw new HubError('invalid', '无效的会话 id（应为 YYYYMMDD-HHMMSS-xxxxxx 格式）');
    }
  }
}
