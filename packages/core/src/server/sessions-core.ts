// SessionHub 共享状态与观察者分发（A4 拆分自 sessions.ts，纯搬运）：会话注册表/运行状态字段、
// 构造与 hooks 注册、emit* 观察者分发、出口断言，以及 EventMirrorWriter 与内部条目类型。
import { TaskCoordinator, type TaskTransitionRecorder } from '../agent/task-coordinator.js';
import type { TurnResult } from '../agent/types.js';
import { ApprovalQueue } from '../interaction/approval-queue.js';
import type { DeliverySession } from '../interaction/delivery.js';
import { WatermarkCursor } from '../interaction/resume-state.js';
import type { RetryBudgetState } from '../interaction/retry-policy.js';
import { RuntimeJournal } from '../interaction/runtime-journal.js';
import { SessionSteerSink } from '../interaction/steer-sink.js';
import {
  type AttemptFinalFrame,
  type DeliveryDeltaFrame,
  type SessionId,
  type SteerResult,
  TASK_STATES,
  type TaskId,
  type TaskState,
  type TurnId,
} from '../interaction/types.js';
import type { NudgeResult } from '../memory/nudge.js';
import { SESSION_ID_PATTERN, SessionManager } from '../session/manager.js';
import type { AnySessionEvent, SessionEvent, SessionEventMap, SessionEventType } from '../session/types.js';
import type { SessionWriter } from '../session/writer.js';
import type { ToolExecutionRequest } from '../tools/executor.js';
import type { ToolResult } from '../tools/types.js';
import { HubError, type SessionHubHooks, type SessionHubOptions, type TurnDelta } from './sessions-types.js';

/** undo n>1 提示的层数上限（与 chat /undo 参数口径一致） */
export const UNDO_MAX_N = 100;

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}

/** header.cwd 有效时原样返回（旧日志可缺省），否则回退全局 cwd */
export function headerCwdOr(headerCwd: string | undefined | null, fallback: string): string {
  return typeof headerCwd === 'string' && headerCwd.trim().length > 0 ? headerCwd : fallback;
}

/** 实际 shell（S7 execution-view 记录来源；Windows = %ComSpec%，POSIX = /bin/sh；缺省不臆造） */
export function detectShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return '/bin/sh';
}

/** S7 执行视图生命周期记录（hub 内存纯观察，不落盘） */
export interface ExecTraceRecord {
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

/**
 * EventMirrorWriter：真实 writer 的观察包裹——append 先落盘、后镜像回调。
 * 结构化匹配 SessionWriter 的公开形态（runTurn/undo 只消费这些成员），
 * 不绕过任何写入路径（单一写者不变量保持）。
 */
export class EventMirrorWriter {
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

export interface HubEntry {
  id: string;
  dir: string;
  /** 每会话真实 cwd（header 真值；S1 起工具执行基于它，A/B 会话互不串） */
  cwd: string;
  writer: EventMirrorWriter;
}

/** S3c2：会话级 delivery（journal 单写 + queue）。journal 落在会话目录 runtime.v1.jsonl */
export interface HubDelivery {
  session: DeliverySession;
  journal: RuntimeJournal;
}

export abstract class SessionHubCore {
  protected readonly entries = new Map<string, HubEntry>();
  /** 每会话待处理用户消息队列（busy 时入队，turn 结束后 pump——同 REPL 语义） */
  protected readonly pendingTexts = new Map<string, string[]>();
  /** 每会话运行中的 turn 取消源 */
  protected readonly running = new Map<string, AbortController>();
  /** 多并发结构化审批队列（requestId 级独立卡片；含授权缓存与已落定记忆） */
  protected readonly approvals = new ApprovalQueue();
  /** subagent 血缘：childId → parentId（hub 层记录；交付链 / 后代待审批展开用） */
  protected readonly subagentChildren = new Map<string, string>();
  /** 运行中 turn 的 promise 集（close 时等待收尾） */
  protected readonly inflight = new Set<Promise<void>>();
  /** 每会话 nudge 计数（用户 turn 完成时 +1；turn 内调过 memory 工具 → 归零） */
  protected readonly nudgeCounts = new Map<string, number>();
  /** 运行中 turn 是否调过 memory 工具（EventMirrorWriter 事件侧记） */
  protected readonly memoryToolUseInTurn = new Set<string>();
  /** 运行中复盘 turn 的取消源（close 时全部取消；同会话连续复盘各自独立） */
  protected readonly reviewRunning = new Set<AbortController>();
  /** 已告警过的 subagent 重名工具（P1-3：每名只告警一次，不随每 turn 刷屏） */
  protected readonly subagentNameConflictsWarned = new Set<string>();
  /** S3c2：每会话 delivery（journal 单写 + queue；journal 在会话目录 runtime.v1.jsonl） */
  protected readonly deliveries = new Map<string, HubDelivery>();
  /** 已被派发进 turn 管线的 queue 下标（防 submit 幂等回执重复派发） */
  protected readonly dispatched = new Map<string, number>();
  /** 运行中 turn 的展示投影身份（real turnId 来自 loop；attemptId 由 hub 按 turn 合成） */
  protected readonly turnDisplay = new Map<
    string,
    { turnId: string; attemptId: string; textLen: number; reasoningLen: number }
  >();
  /** turnId → sessionId（cancel 按 turnId 定位会话语境；turn 结束清理） */
  protected readonly runningTurnId = new Map<string, string>();
  /** 本进程内已确认取消的 turnId（cancel-ack=cancelled 依据；一次性语义） */
  protected readonly cancelledTurns = new Set<string>();
  /** FixB：每会话运行中 turn 的代次（runOne 启动时递增；只区分本进程内 turn 发起序） */
  protected readonly turnGenerations = new Map<SessionId, number>();
  /** FixB：turnId → 该 turn 的代次（首次见到 turnId 时绑定；turn 结束清理） */
  protected readonly turnGenerationByTurnId = new Map<TurnId, number>();
  /** FixB：已确认取消 turn 的代次（cancel-ack=cancelled 依据；turnId 复用时不串代次） */
  protected readonly cancelledTurnGeneration = new Map<TurnId, number>();
  /** 带水位的 delta 展示投影映射（跨会话共享；每 (session, attempt, kind) 独立） */
  protected readonly watermark = new WatermarkCursor();
  /** S5 后台任务协调器（跨会话共享；同进程单例 → 共享写锁全局串行） */
  readonly tasks: TaskCoordinator;
  /** 任务归属会话（taskId → 会话 id；task/transition 落该会话 journal） */
  protected readonly taskSessions = new Map<TaskId, SessionId>();
  /** S7 执行视图源：sessionId → callId → 生命周期观察记录（内存纯观察，不落盘、不写第二套日志） */
  protected readonly execTraces = new Map<string, Map<string, ExecTraceRecord>>();
  /** S7：每会话已生效配置 revision（turn 启动时 +1；run-config 只读投影的 snapshot 来源） */
  protected readonly configRevisions = new Map<string, number>();
  /** FixC D1：每会话最近 turn 的重试预算快照（run-config retry.budget 来源；不持久化，随进程） */
  protected readonly lastRetryBudgets = new Map<string, RetryBudgetState>();
  /** S6 会话级 steer sink（接收/去重/排队跨 turn 持续；loop 只在安全 step 边界消费） */
  protected readonly steerSinks = new Map<SessionId, SessionSteerSink>();

  readonly approvalTimeoutMs: number;
  /** 观察者集合（WS 事件面 / 测试；addHooks 注册，返回退订函数） */
  protected readonly listeners = new Set<SessionHubHooks>();

  constructor(protected readonly options: SessionHubOptions) {
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    // S5：协调器缺省由 hub 自建（recorder 落到任务归属会话的 runtime journal；S3a 账本单写）
    this.tasks = options.taskCoordinator ?? new TaskCoordinator({ recorder: this.makeTaskRecorder() });
    // 审查 P2-1 fail-fast：ask 模式缺 pending 装配时 buildTurnTools 每次 turn 抛错、
    // 被 pump 的 catch 吞掉（消息凭空消失）——装配残缺在构造期即拒绝，不给静默失败留窗口。
    if (options.memory?.mode === 'ask' && options.memory.pending === undefined) {
      throw new HubError(
        'invalid',
        'memory.mode=ask 需要装配 pending 暂存区（SessionHubMemory.pending），拒绝静默吞消息的残缺装配',
      );
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

  get manager(): SessionManager {
    return this.options.manager;
  }

  // —— 观察者分发（异常互不影响：单观察者抛错不阻断其他分发与内核） ——

  protected emitEvent(sessionId: string, event: AnySessionEvent): void {
    for (const l of this.listeners) {
      try {
        l.onEvent?.(sessionId, event);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitDelta(sessionId: string, delta: TurnDelta): void {
    for (const l of this.listeners) {
      try {
        l.onDelta?.(sessionId, delta);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitDeliveryDelta(sessionId: string, frame: DeliveryDeltaFrame): void {
    for (const l of this.listeners) {
      try {
        l.onDeliveryDelta?.(sessionId, frame);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitAttemptFinal(sessionId: string, frame: AttemptFinalFrame): void {
    for (const l of this.listeners) {
      try {
        l.onAttemptFinal?.(sessionId, frame);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitTurnEnd(sessionId: string, result: TurnResult): void {
    for (const l of this.listeners) {
      try {
        l.onTurnEnd?.(sessionId, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  /** S6 会话级 steer 回帧分发（loop resolve 后经 sink notify 回调本方法） */
  protected emitSteerResult(sessionId: string, result: SteerResult): void {
    for (const l of this.listeners) {
      try {
        l.onSteerResult?.(sessionId, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitNudgeStarted(sessionId: string): void {
    for (const l of this.listeners) {
      try {
        l.onNudgeStarted?.(sessionId);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitNudgeFinished(sessionId: string, result: NudgeResult): void {
    for (const l of this.listeners) {
      try {
        l.onNudgeFinished?.(sessionId, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  protected emitExecuteStart(sessionId: string, req: ToolExecutionRequest): void {
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

  protected emitExecuteEnd(sessionId: string, req: ToolExecutionRequest, result: ToolResult): void {
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

  protected assertNonEmpty(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new HubError('invalid', `${name} 必须是非空字符串`);
    }
  }

  /** sessionId 出口校验（复审 P2-1，路径穿越原语）：非法格式 → HubError('invalid')，不触达文件系统 */
  protected assertValidSessionId(id: string): void {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
      throw new HubError('invalid', '无效的会话 id（应为 YYYYMMDD-HHMMSS-xxxxxx 格式）');
    }
  }

  /** S5：任务/transition 记录器（实现见 sessions-tasks.ts）。 */
  protected abstract makeTaskRecorder(): TaskTransitionRecorder;
}
