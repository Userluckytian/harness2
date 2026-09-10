// SessionHub 任务协调（A4 拆分自 sessions.ts，纯搬运）：后台任务注册、submit/cancel 接线、
// queue 派发、任务归属 journal 记录。
import type { TaskSpec, TaskTransitionRecorder } from '../agent/task-coordinator.js';
import { continueQueue, submitDelivery } from '../interaction/delivery.js';
import {
  type CancelAck,
  type CancelRequest,
  type ClientMessageId,
  type SessionId,
  type SubmitAck,
  type SubmitRequest,
  type TaskContract,
  type TaskId,
  matchTurnGeneration,
} from '../interaction/types.js';
import { loadSession } from '../session/reader.js';
import type { ApprovalHandler } from '../tools/types.js';
import { isTaskState } from './sessions-core.js';
import { SessionHubResume } from './sessions-resume.js';

export abstract class SessionHubTasks extends SessionHubResume {
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
}
