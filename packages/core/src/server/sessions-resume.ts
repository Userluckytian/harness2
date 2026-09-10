// SessionHub 订阅恢复（A4 拆分自 sessions.ts，纯搬运）：delivery journal、resume-snapshot、
// 带水位 delta 展示投影、attempt 落定与送达链。
import { reconstructTasks } from '../agent/task-coordinator.js';
import type { TurnResult } from '../agent/types.js';
import { createDeliverySession, recoverQueue } from '../interaction/delivery.js';
import { RUNTIME_JOURNAL_FILE, RuntimeJournal } from '../interaction/runtime-journal.js';
import type {
  ApprovalRequestContract,
  AttemptFinalFrame,
  AttemptSnapshot,
  ResumeSnapshot,
  ResumeSubscriptionRequest,
  TaskContract,
} from '../interaction/types.js';
import type { HubDelivery } from './sessions-core.js';
import { SessionHubTurn } from './sessions-turn.js';
import { HubError } from './sessions-types.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export abstract class SessionHubResume extends SessionHubTurn {
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

  /** 实现见 sessions-approval.ts（待审批 BFS 展开）。 */
  abstract pendingApprovalsFor(sessionId: string): ApprovalRequestContract[];
}
