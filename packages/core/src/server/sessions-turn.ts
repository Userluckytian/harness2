// SessionHub turn 流转（A4 拆分自 sessions.ts，纯搬运）：用户消息串行队列、runTurn 装配、
// 流式增量转发、nudge 复盘、undo/redo/fork。
import { runTurn } from '../agent/loop.js';
import { SUBAGENT_TOOL_NAMES, createSubagentTools } from '../agent/subagent.js';
import type { TaskSpec } from '../agent/task-coordinator.js';
import type { TurnResult, TurnStreamEvent } from '../agent/types.js';
import { redactSecrets } from '../config/redact.js';
import type { TaskContract, TaskId } from '../interaction/types.js';
import { createMemoryToolForMode, runNudgeReview } from '../memory/nudge.js';
import { ForkError, type ForkResult, forkSession } from '../session/fork.js';
import { SnapshotStore } from '../session/snapshots.js';
import type { AnySessionEvent } from '../session/types.js';
import { type UndoRedoResult, redoLastUndo, undoLastTurn } from '../session/undo.js';
import { createBrowserTools } from '../tools/predefined/browser.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ApprovalHandler } from '../tools/types.js';
import { SessionHubAssembly } from './sessions-assembly.js';
import { type HubEntry, UNDO_MAX_N } from './sessions-core.js';
import { HubError } from './sessions-types.js';

export abstract class SessionHubTurn extends SessionHubAssembly {
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

  protected pump(id: string): void {
    if (this.running.has(id)) return;
    const entry = this.entries.get(id);
    const queue = this.pendingTexts.get(id);
    if (!entry || !queue || queue.length === 0) return;
    const text = queue.shift()!;
    const run = this.runOne(id, entry, text).catch(() => {}); // runOne 内部已收口，防御性兜底
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  protected async runOne(id: string, entry: HubEntry, text: string): Promise<void> {
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
  protected buildTurnTools(sessionId: string): ToolRegistry {
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
  protected noteTurnEvent(sessionId: string, event: AnySessionEvent): void {
    if (event.type === 'tool/call' && event.payload.tool === 'memory') {
      this.memoryToolUseInTurn.add(sessionId);
    }
    if (event.type === 'user/message' && event.payload.turnId !== undefined && this.running.has(sessionId)) {
      this.bindRunningTurn(sessionId, event.payload.turnId);
    }
  }

  /** 绑定运行中 turn 身份：turnId → 会话 + 代次。幂等（同 turnId 已绑定则跳过）；
   *  首个可见点（user/message 事件 / 首个流事件）调用，二者同源同一 turn。 */
  protected bindRunningTurn(sessionId: string, turnId: string): void {
    if (this.runningTurnId.has(turnId)) return;
    this.runningTurnId.set(turnId, sessionId);
    const gen = this.turnGenerations.get(sessionId);
    if (gen !== undefined) this.turnGenerationByTurnId.set(turnId, gen);
  }

  /** nudge 计数：turn 完成 +1（调过 memory 工具 → 归零）；到 nudgeInterval 触发后台复盘并归零 */
  protected bumpNudge(id: string): void {
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
  protected startNudgeReview(id: string): void {
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

  protected forwardStream(id: string, event: TurnStreamEvent): void {
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
    return this.applyUndoRedo(n, () => undoLastTurn(entry.writer, { snapshots, ...(dryRun ? { dryRun: true } : {}) }));
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
  protected applyUndoRedo(n: number, once: () => UndoRedoResult): { results: UndoRedoResult[]; error?: string } {
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

  // —— 后续模块实现的抽象缝（实现见 sessions-resume / sessions-tasks / sessions-approval） ——
  protected abstract turnDisplayFor(
    sessionId: string,
    turnId: string,
  ): { turnId: string; attemptId: string; textLen: number; reasoningLen: number };
  protected abstract acceptWatermark(
    sessionId: string,
    delta: { kind: 'text' | 'reasoning'; text: string },
    disp: { turnId: string; attemptId: string },
    offset: number,
  ): void;
  protected abstract finalizeAttempt(sessionId: string, result: TurnResult): void;
  protected abstract makeApprovalHandler(
    sessionId: string,
    signal: AbortSignal,
    taskMeta?: { taskId?: TaskId; parentTaskId?: TaskId },
  ): ApprovalHandler;
  abstract registerTask(spec: TaskSpec): TaskContract;
}
