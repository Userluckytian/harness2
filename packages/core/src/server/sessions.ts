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
import { type TaskSpec, type TaskTransitionRecorder, reconstructTasks } from '../agent/task-coordinator.js';
import type { TurnResult } from '../agent/types.js';
import type { ApprovalQueueCard } from '../interaction/approval-queue.js';
import { continueQueue, createDeliverySession, recoverQueue, submitDelivery } from '../interaction/delivery.js';
import type { ResumeStateProvider } from '../interaction/resume-state.js';
import { RUNTIME_JOURNAL_FILE, RuntimeJournal } from '../interaction/runtime-journal.js';
import {
  type ApprovalRequestContract,
  type ApprovalResponseAck,
  type ApprovalResponseDecision,
  type AttemptFinalFrame,
  type AttemptSnapshot,
  type CancelAck,
  type CancelRequest,
  type ClientMessageId,
  type ResumeSnapshot,
  type ResumeSubscriptionRequest,
  type SessionId,
  type SubmitAck,
  type SubmitRequest,
  type TaskContract,
  type TaskId,
  isApprovalDecision,
  matchTurnGeneration,
} from '../interaction/types.js';
import { loadSession } from '../session/reader.js';
import type { ApprovalDecision, ApprovalHandler, ApprovalInput } from '../tools/types.js';
import { type HubDelivery, isTaskState } from './sessions-core.js';
import { SessionHubTurn } from './sessions-turn.js';
import { type ApprovalSettleReason, HubError } from './sessions-types.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// 公开导出面保持不变：契约类型经此原样再导出。
export * from './sessions-types.js';

export class SessionHub extends SessionHubTurn implements ResumeStateProvider {
  // —— S3c2 submit / cancel / resumeSnapshot（实现 ResumeStateProvider 缝；ws.ts 传输层经此转发） ——

  /** 会话级 delivery：打开/新建 runtime journal 并恢复 queue（重启默认 paused，不自动执行）。
   *   journal 单写 = 本 hub（进程内 RuntimeJournal 守卫 + pid 锁文件）；与 session.log 写者协调同一
   *   hub 出口，不引入双写冲突。会话锁被占 → HubError('locked')；未知会话 → HubError('not_found')。 */
  protected deliveryFor(id: string): HubDelivery {
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
  protected activeAttemptFor(sessionId: string): AttemptSnapshot | undefined {
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
  protected tasksFor(id: string): TaskContract[] {
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
  protected turnDisplayFor(
    sessionId: string,
    turnId: string,
  ): { turnId: string; attemptId: string; textLen: number; reasoningLen: number } {
    const existing = this.turnDisplay.get(sessionId);
    if (existing !== undefined && existing.turnId === turnId) return existing;
    const created = { turnId, attemptId: `att-${turnId.slice(0, 8)}`, textLen: 0, reasoningLen: 0 };
    this.turnDisplay.set(sessionId, created);
    this.bindRunningTurn(sessionId, turnId);
    return created;
  }

  /** WatermarkCursor 接流事件：接受连续块 → onDeliveryDelta；同 attempt 内重启（provider 重试从 0 重流）
   *   先重置水位再接受（展示投影连续，不丢重试内容）。 */
  protected acceptWatermark(
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
  protected finalizeAttempt(sessionId: string, result: TurnResult): void {
    const disp = this.turnDisplay.get(sessionId);
    if (disp === undefined) return;
    const state =
      result.stopReason === 'cancelled' ? 'cancelled' : result.stopReason === 'error' ? 'failed' : 'completed';
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
  protected deliveryChain(sessionId: string): string[] {
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

  /** task/transition 落到任务归属会话的 runtime journal（recorder 适配；S3a 账本单写） */
  protected makeTaskRecorder(): TaskTransitionRecorder {
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
  protected sessionLogLastSeq(sessionId: SessionId): number | undefined {
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
  protected dispatchQueued(sessionId: string): void {
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

  protected makeApprovalHandler(
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
          timer = setTimeout(() => this.approvals.settle(approval.requestId, false, 'timeout'), this.approvalTimeoutMs);
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

  protected emitApprovalSettled(requestId: string, allowed: boolean, reason: ApprovalSettleReason): void {
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
}
