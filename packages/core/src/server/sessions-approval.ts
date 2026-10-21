// SessionHub 审批上抛（A4 拆分自 sessions.ts，纯搬运）：待审批查询、响应落定、
// onAsk 卡片登记与多点送达。
import type { ApprovalQueueCard } from '../interaction/approval-queue.js';
import {
  type ApprovalRequestContract,
  type ApprovalResponseAck,
  type ApprovalResponseDecision,
  type TaskId,
  isApprovalDecision,
} from '../interaction/types.js';
import type { ApprovalDecision, ApprovalHandler, ApprovalInput } from '../tools/types.js';
import { isUserInputAnswer } from '../interaction/user-input.js';
import type {
  UserInputAnswer,
  UserInputRequestContract,
  UserInputResponseAck,
  UserInputSettleReason,
} from '../interaction/user-input.js';
import type { UserInputQueueCard } from '../interaction/user-input-queue.js';
import { SessionHubTasks } from './sessions-tasks.js';
import type { ApprovalSettleReason } from './sessions-types.js';
import { randomUUID } from 'node:crypto';

export abstract class SessionHubApproval extends SessionHubTasks {
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
      // 授权缓存预检（Z10-5 扩展）：
      //   1) 全局「始终」规则（allow-always / deny-always）优先——deny 永不被会话授权解禁；
      //   2) 「本会话总是」授权缓存命中 → 直接 allow；
      //   3) 否则落策略（缺省 ask——绝不静默允许；旧执行器级 allow-all 默认仍由 loop 级保留）。
      decide: (input: ApprovalInput): ApprovalDecision => {
        const always = this.approvals.alwaysRuleFor(input.tool);
        if (always === 'allow') return 'allow';
        if (always === 'deny') return 'deny';
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

  // —— 用户问询（ZS3-T6）——

  /** 全部待处理问询（诊断/重连下发用） */
  listPendingUserInputs(): UserInputRequestContract[] {
    return this.userInputs.listPending();
  }

  /** 指定会话可见的待处理问询：自身 + 后代（子代理血缘 BFS 展开） */
  pendingUserInputsFor(sessionId: string): UserInputRequestContract[] {
    this.assertValidSessionId(sessionId);
    const childrenOf = new Map<string, string[]>();
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
    return this.userInputs.listPending().filter((r) => scope.has(r.sessionId));
  }

  /** 问询应答：明确 ack（applied/duplicate/expired/unknown）；非法答案不抛错 */
  respondUserInput(requestId: string, answer: UserInputAnswer): UserInputResponseAck {
    if (!isUserInputAnswer(answer)) {
      return { requestId, state: 'unknown' };
    }
    return this.userInputs.respond(requestId, answer);
  }

  /**
   * 发起用户问询：登记 → 多点送达 onUserInputRequest → await 答案。
   * 超时/取消 fail-closed 落定为 {action:'cancel'}，producer 不会悬挂。
   */
  requestUserInput(
    sessionId: string,
    payload: Omit<UserInputRequestContract, 'requestId' | 'sessionId' | 'expiresAt' | 'createdAt'> & {
      expiresAt?: string;
    },
  ): Promise<UserInputAnswer> {
    this.assertValidSessionId(sessionId);
    const requestId = randomUUID();
    const now = Date.now();
    const request: UserInputRequestContract = {
      requestId,
      sessionId,
      ...payload,
      createdAt: new Date(now).toISOString(),
      expiresAt: payload.expiresAt ?? new Date(now + this.userInputTimeoutMs).toISOString(),
    };
    return new Promise<UserInputAnswer>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const notify = (answer: UserInputAnswer, reason: UserInputSettleReason): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitUserInputSettled(requestId, answer, reason);
        resolve(answer);
      };
      const node: UserInputQueueCard = { request, settle: notify };
      timer = setTimeout(
        () => this.userInputs.settle(requestId, { action: 'cancel' }, 'timeout'),
        this.userInputTimeoutMs,
      );
      if (!this.userInputs.register(node)) {
        clearTimeout(timer);
        notify({ action: 'cancel' }, 'cancelled');
        return;
      }
      const deliverTo = this.deliveryChain(sessionId);
      for (const l of this.listeners) {
        try {
          l.onUserInputRequest?.(request, deliverTo);
        } catch {
          // 观察者异常不回写内核
        }
      }
    });
  }

  protected emitUserInputSettled(requestId: string, answer: UserInputAnswer, reason: UserInputSettleReason): void {
    for (const l of this.listeners) {
      try {
        l.onUserInputSettled?.(requestId, answer, reason);
      } catch {
        // 观察者异常不回写内核
      }
    }
  }
}
