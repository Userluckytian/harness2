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
import type { ApprovalQueueCard } from '../interaction/approval-queue.js';
import type { ResumeStateProvider } from '../interaction/resume-state.js';
import {
  type ApprovalRequestContract,
  type ApprovalResponseAck,
  type ApprovalResponseDecision,
  type TaskId,
  isApprovalDecision,
} from '../interaction/types.js';
import type { ApprovalDecision, ApprovalHandler, ApprovalInput } from '../tools/types.js';
import { SessionHubTasks } from './sessions-tasks.js';
import type { ApprovalSettleReason } from './sessions-types.js';
import { randomUUID } from 'node:crypto';

// 公开导出面保持不变：契约类型经此原样再导出。
export * from './sessions-types.js';

export class SessionHub extends SessionHubTasks implements ResumeStateProvider {
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
