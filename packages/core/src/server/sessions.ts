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
import { runTurn } from '../agent/loop.js';
import type { TurnResult, TurnStreamEvent } from '../agent/types.js';
import type { ApprovalDecision, ApprovalInput } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { createMemoryToolForMode, runNudgeReview, type NudgeResult } from '../memory/nudge.js';
import type { PendingMemoryStore } from '../memory/pending.js';
import type { MemoryStore } from '../memory/store.js';
import type { ChatProvider, ToolCallRequest } from '../provider/types.js';
import { computeProjection, loadSession, type LoadedEvent } from '../session/reader.js';
import { SnapshotStore } from '../session/snapshots.js';
import { SessionManager } from '../session/manager.js';
import { forkSession, ForkError, type ForkResult } from '../session/fork.js';
import { redoLastUndo, undoLastTurn, UndoRedoError, type UndoRedoResult } from '../session/undo.js';
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
  hooks?: SessionHubHooks;
}

/** undo n>1 提示的层数上限（与 chat /undo 参数口径一致） */
const UNDO_MAX_N = 100;

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

  readonly approvalTimeoutMs: number;
  /** 观察者集合（WS 事件面 / 测试；addHooks 注册，返回退订函数） */
  private readonly listeners = new Set<SessionHubHooks>();

  constructor(private readonly options: SessionHubOptions) {
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    if (options.hooks !== undefined) this.addHooks(options.hooks);
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

  // —— 会话生命周期 ——

  /** 新建会话并保持 writer 打开（服务持有，close 时统一释放） */
  create(cwd: string): { id: string; dir: string } {
    this.assertNonEmpty(cwd, 'cwd');
    const created = this.options.manager.create(cwd);
    const entry: HubEntry = {
      id: created.id,
      dir: created.dir,
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
    try {
      return this.options.manager.locate(id, cwd !== undefined ? { cwd } : {});
    } catch {
      throw new HubError('not_found', `session not found: ${id}`);
    }
  }

  /** 恢复会话到注册表（幂等：已在册直接返回）；锁被占（如 CLI chat 同时打开）→ HubError('locked') */
  ensureOpen(id: string): { id: string; dir: string } {
    const entry = this.entryFor(id);
    return { id: entry.id, dir: entry.dir };
  }

  /** 注册表条目（内部）：不存在则从磁盘恢复；锁冲突 → HubError('locked')，未知 id → HubError('not_found') */
  private entryFor(id: string): HubEntry {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const dir = this.locate(id);
    let writer: SessionWriter;
    try {
      writer = this.options.manager.resume(id).writer;
    } catch (e) {
      if ((e as Error).name === 'SessionLockedError') {
        throw new HubError('locked', `会话被其他进程占用（${(e as Error).message}）`);
      }
      throw new HubError('not_found', (e as Error).message);
    }
    const entry: HubEntry = {
      id,
      dir,
      writer: new EventMirrorWriter(writer, (event) => {
        this.noteTurnEvent(id, event);
        this.emitEvent(id, event);
      }),
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** 全量事件（含 active 标记）：切换会话时的重放来源；只读、不取锁 */
  events(id: string): SessionEventsPayload {
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
        cwd: this.options.cwd,
        userText: text,
        signal: ac.signal,
        snapshots,
        onStream: (event: TurnStreamEvent) => this.forwardStream(id, event),
      });
      this.emitTurnEnd(id, result);
      this.bumpNudge(id); // turn-end 回调之后计数/触发复盘（异步，不阻塞主对话）
    } finally {
      this.running.delete(id);
      // 队列里还有同会话消息 → 继续泵（保持 await 顺序，串行语义）
      this.pump(id);
    }
  }

  /**
   * turn 工具注册表：无记忆装配时直接复用共享注册表；有则按会话换装 memory 工具
   * （auto = 直写 store；ask = 暂存 pending，来源会话归因到当前会话）。
   */
  private buildTurnTools(sessionId: string): ToolRegistry {
    const memory = this.options.memory;
    if (memory === undefined) return this.options.tools;
    const registry = new ToolRegistry();
    for (const def of this.options.tools.list()) {
      if (def.name === 'memory') continue; // 换装按会话绑定的变体
      registry.register(def);
    }
    registry.register(createMemoryToolForMode(memory.store, memory.mode, memory.pending, sessionId));
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
      cwd: this.options.cwd,
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

  /** 关闭：取消运行中 turn 与复盘 → 拒绝全部待审批 → 等待收尾 → 关闭全部 writer（释放目录锁） */
  async close(): Promise<void> {
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
}
