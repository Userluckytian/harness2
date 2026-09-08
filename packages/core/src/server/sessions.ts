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
import { resolve } from 'node:path';
import { runTurn } from '../agent/loop.js';
import type { CompactionOptions, TurnResult, TurnStreamEvent } from '../agent/types.js';
import type { ApprovalDecision, ApprovalInput, ToolResult } from '../tools/types.js';
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

/** 待处理审批请求（上抛给 HTTP/WS 客户端；decision 只有 allow/deny 两态） */
export interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  args: unknown;
}

export type ApprovalSettleReason = 'response' | 'timeout' | 'cancelled';

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
  /** turn 结束（stopReason：end_turn/error/cancelled/max_steps/…） */
  onTurnEnd?(sessionId: string, result: TurnResult): void;
  /** 审批上抛：进入待处理请求表后回调 */
  onApprovalRequest?(approval: PendingApproval): void;
  /** 审批落定（响应/超时/取消；false = 按拒绝处理） */
  onApprovalSettled?(requestId: string, allowed: boolean, reason: ApprovalSettleReason): void;
  /** 后台复盘开始（turn-end 之后异步触发；提示帧，UI 自行决定展示） */
  onNudgeStarted?(sessionId: string): void;
  /** 后台复盘结束（产出 = 记忆写入或 pending 暂存；error 存在 = 复盘失败，主对话不受影响） */
  onNudgeFinished?(sessionId: string, result: NudgeResult): void;
  /** 工具执行生命周期（S1，S3 delivery / S7 toolExecutionView 消费；纯观察，不落第二套日志） */
  onExecuteStart?(sessionId: string, req: ToolExecutionRequest): void;
  onExecuteEnd?(sessionId: string, req: ToolExecutionRequest, result: ToolResult): void;
}

export interface SessionHubOptions {
  manager: SessionManager;
  provider: ChatProvider;
  tools: ToolRegistry;
  /** 工具执行 cwd + 新会话分组目录 */
  cwd: string;
  /** 策略决策缝（缺省 allow-all；服务启动时由 config 构造注入） */
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
}

/** undo n>1 提示的层数上限（与 chat /undo 参数口径一致） */
const UNDO_MAX_N = 100;

/** header.cwd 有效时原样返回（旧日志可缺省），否则回退全局 cwd */
function headerCwdOr(headerCwd: string | undefined | null, fallback: string): string {
  return typeof headerCwd === 'string' && headerCwd.trim().length > 0 ? headerCwd : fallback;
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

interface PendingApprovalEntry {
  approval: PendingApproval;
  settle: (allowed: boolean, reason: ApprovalSettleReason) => void;
}

export class SessionHub {
  private readonly entries = new Map<string, HubEntry>();
  /** 每会话待处理用户消息队列（busy 时入队，turn 结束后 pump——同 REPL 语义） */
  private readonly pendingTexts = new Map<string, string[]>();
  /** 每会话运行中的 turn 取消源 */
  private readonly running = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApprovalEntry>();
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

  readonly approvalTimeoutMs: number;
  /** 观察者集合（WS 事件面 / 测试；addHooks 注册，返回退订函数） */
  private readonly listeners = new Set<SessionHubHooks>();

  constructor(private readonly options: SessionHubOptions) {
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
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
        // 审查 P1-1：serve/desktop 路径同样注入记忆 store（缺此前主会话零快照、system 恒空）
        ...(this.options.memory !== undefined ? { memory: this.options.memory.store } : {}),
        // 阶段 10：Skills 列表注入（每 turn 重扫磁盘；全文走 skill 工具）
        ...(this.options.skills !== undefined ? { skills: this.options.skills } : {}),
        // 阶段 7：上下文压缩装配（启动器按 config 派生；缺省不压缩）
        ...(this.options.compaction !== undefined ? { compaction: this.options.compaction } : {}),
      });
      this.emitTurnEnd(id, result);
      this.bumpNudge(id); // turn-end 回调之后计数/触发复盘（异步，不阻塞主对话）
    } catch (e) {
      // 复审 P2-3：非预期异常（provider 抛错之外的装配/快照/写盘错误）也要给客户端
      // turn-end 收口——否则 pump 的防御性静默 catch 会让消息凭空消失。
      // error 消息过 redactSecrets 再出站（错误路径最后闸门）。
      this.emitTurnEnd(id, {
        stopReason: 'error',
        steps: 0,
        toolCalls: 0,
        durationMs: 0,
        error: redactSecrets((e as Error)?.message ?? String(e)),
      });
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
        parentSessionId: sessionId,
        depth: 0,
        // 子会话事件/turn-end 桥接进 hub 观察者（WS 面可见子会话流量）
        hooks: {
          onChildEvent: (childId, event) => this.emitEvent(childId, event),
          onChildTurnEnd: (childId, result) => this.emitTurnEnd(childId, result),
        },
        // 子会话 ask 上抛同一待审批表（requestId 全局可应答；payload.sessionId = 子会话）
        approvalFactory: (childId, signal) => this.makeApprovalHandler(childId, signal),
        // 阶段 11 口径统一（加性）：子会话注入宿主同款 skills 列表（与 chat REPL 一致）
        ...(this.options.skills !== undefined ? { skills: this.options.skills } : {}),
      })) {
        registry.register(def);
      }
    }
    return registry;
  }

  /** EventMirrorWriter 事件侧记：运行中 turn 调过 memory 工具（nudge 计数归零依据） */
  private noteTurnEvent(sessionId: string, event: AnySessionEvent): void {
    if (event.type === 'tool/call' && event.payload.tool === 'memory') {
      this.memoryToolUseInTurn.add(sessionId);
    }
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
    if (event.type === 'text-delta') {
      this.emitDelta(id, { kind: 'text', text: event.text });
    } else if (event.type === 'reasoning-delta') {
      this.emitDelta(id, { kind: 'reasoning', text: event.text });
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

  /** 待处理审批表快照（诊断用） */
  listPendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()].map((p) => p.approval);
  }

  /** 审批响应：命中待处理请求则落定；返回 false = requestId 不存在（已超时/已取消） */
  respondApproval(requestId: string, decision: 'allow' | 'deny'): boolean {
    const pending = this.approvals.get(requestId);
    if (!pending) return false;
    pending.settle(decision === 'allow', 'response');
    return true;
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

  private emitTurnEnd(sessionId: string, result: TurnResult): void {
    for (const l of this.listeners) {
      try {
        l.onTurnEnd?.(sessionId, result);
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
    for (const l of this.listeners) {
      try {
        l.onExecuteStart?.(sessionId, req);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private emitExecuteEnd(sessionId: string, req: ToolExecutionRequest, result: ToolResult): void {
    for (const l of this.listeners) {
      try {
        l.onExecuteEnd?.(sessionId, req, result);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }

  private makeApprovalHandler(sessionId: string, signal: AbortSignal) {
    const decide = this.options.decide;
    return {
      decide: (input: ApprovalInput): ApprovalDecision => decide?.(input) ?? 'allow',
      onAsk: async (input: ApprovalInput): Promise<boolean> => {
        const approval: PendingApproval = {
          requestId: randomUUID(),
          sessionId,
          tool: input.tool,
          args: input.args,
        };
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (allowed: boolean, reason: ApprovalSettleReason): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            this.approvals.delete(approval.requestId);
            for (const l of this.listeners) l.onApprovalSettled?.(approval.requestId, allowed, reason);
            resolve(allowed);
          };
          const timer = setTimeout(() => settle(false, 'timeout'), this.approvalTimeoutMs);
          const onAbort = (): void => settle(false, 'cancelled');
          if (signal.aborted) {
            settle(false, 'cancelled');
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          this.approvals.set(approval.requestId, { approval, settle });
          for (const l of this.listeners) l.onApprovalRequest?.(approval);
        });
      },
    };
  }

  // —— 收尾 ——

  /** 关闭：进入即清排队消息（排队 turn 不再在关闭后继续跑）→ 取消运行中 turn 与复盘
   *  → 拒绝全部待审批 → 等待收尾 → 关闭全部 writer（释放目录锁） */
  async close(): Promise<void> {
    this.pendingTexts.clear();
    for (const ac of this.running.values()) ac.abort();
    for (const ac of this.reviewRunning.values()) ac.abort();
    for (const pending of this.approvals.values()) pending.settle(false, 'cancelled');
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
    for (const entry of this.entries.values()) entry.writer.close();
    this.entries.clear();
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
