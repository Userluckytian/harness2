// 用户问询队列（ZS3-T6）：镜像 ApprovalQueue 的 register/respond/settle/去重语义，
// 但答案为开放结构且无授权缓存——问询不是授权，不能被“本会话总是”短路。
import type {
  UserInputAnswer,
  UserInputRequestContract,
  UserInputResponseAck,
  UserInputSettleReason,
} from './user-input.js';
import { isUserInputExpired } from './user-input.js';

/** 已落定去重窗口上限：迟到响应 ack 可区分性 */
export const USER_INPUT_SETTLED_MAX = 512;

/** 待处理问询：契约 + hub 提供的落定回调（resolve producer 的 await、通知观察者） */
export interface UserInputQueueCard {
  request: UserInputRequestContract;
  settle: (answer: UserInputAnswer, reason: UserInputSettleReason) => void;
}

export class UserInputQueue {
  private readonly pendings = new Map<string, UserInputQueueCard>();
  /** 已落定记忆：requestId → 响应落定为 applied / 其余为 expired */
  private readonly settledRegistry = new Map<string, 'applied' | 'expired'>();

  /** 登记：重复 requestId → false（调用方按取消落定，不悬挂） */
  register(node: UserInputQueueCard): boolean {
    if (this.pendings.has(node.request.requestId)) return false;
    this.pendings.set(node.request.requestId, node);
    return true;
  }

  /**
   * 应答：live+未过期 → applied；live+已过期 → expired（fail-closed，按 cancel 落定）；
   * 迟到响应按已落定记忆返回（applied→duplicate，其余→expired）；从未见过 → unknown。
   */
  respond(requestId: string, answer: UserInputAnswer): UserInputResponseAck {
    const node = this.pendings.get(requestId);
    if (node !== undefined) {
      if (isUserInputExpired(node.request.expiresAt)) {
        this.settle(requestId, { action: 'cancel' }, 'expired');
        return { requestId, state: 'expired' };
      }
      this.settle(requestId, answer, 'response');
      return { requestId, state: 'applied' };
    }
    const prior = this.settledRegistry.get(requestId);
    if (prior !== undefined) {
      return { requestId, state: prior === 'applied' ? 'duplicate' : 'expired' };
    }
    return { requestId, state: 'unknown' };
  }

  /** 按原因落定（hub 超时/取消/关闭；重复落定幂等） */
  settle(requestId: string, answer: UserInputAnswer, reason: UserInputSettleReason): void {
    const node = this.pendings.get(requestId);
    if (node === undefined) return;
    this.pendings.delete(requestId);
    this.remember(requestId, reason === 'response' ? 'applied' : 'expired');
    node.settle(answer, reason);
  }

  /** 关闭兜底：全部待处理问询按 cancel 落定（producer 不悬挂） */
  settleAll(reason: UserInputSettleReason = 'cancelled'): void {
    for (const requestId of [...this.pendings.keys()]) {
      this.settle(requestId, { action: 'cancel' }, reason);
    }
  }

  /** 全部待处理问询（诊断/重连下发用） */
  listPending(): UserInputRequestContract[] {
    return [...this.pendings.values()].map((n) => n.request);
  }

  /** 指定会话归属的待处理问询（不含后代；后代展开在 hub 层） */
  listForSession(sessionId: string): UserInputRequestContract[] {
    return this.listPending().filter((r) => r.sessionId === sessionId);
  }

  private remember(requestId: string, state: 'applied' | 'expired'): void {
    if (this.settledRegistry.size >= USER_INPUT_SETTLED_MAX) {
      const oldest = this.settledRegistry.keys().next().value;
      if (oldest !== undefined) this.settledRegistry.delete(oldest);
    }
    this.settledRegistry.set(requestId, state);
  }
}
