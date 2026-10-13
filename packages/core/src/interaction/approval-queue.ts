// 结构化审批队列（S2）：多并发审批卡按 requestId 独立保存、各自应答。
// 队列是**操作状态**（不入事件溯源日志；S3 runtime-journal 对齐时落盘），
// 复用 S0 冻结契约（ApprovalRequestContract/ApprovalResponseAck）与校验函数。
// 语义：
//   - 卡片必须 self-contain：scope「本会话总是」只能框定自身 sessionId（跨 session 拒，fail-closed）；
//   - respond 明确 ack（applied/duplicate/expired/unknown）：
//       live+未过期=applied；live+已过期=按拒绝落定并回 expired（fail-closed，绝不事后放行）；
//       迟到响应按已落定记忆返回（response 落定→duplicate；超时/取消/过期→expired）；未知=unknown；
//   - 「本会话总是」授权缓存（sessionId→工具集）：仅在该 session + 该工具上生效，
//     allow 时写入，供策略决策缝预检（不泄漏到其他会话/工具）。
import type { ApprovalRequestContract, ApprovalResponseAck, ApprovalResponseDecision } from './types.js';
import { isApprovalExpired, scopeConfinesToSession } from './types.js';

/** 落定原因（含过期：S2 新增位；响应/超时/取消沿用既有口径） */
export type ApprovalSettleReason = 'response' | 'timeout' | 'cancelled' | 'expired';

/** 待处理卡：卡片 + hub 提供的落定回调（resolve 等待中的 onAsk、通知观察者） */
export interface ApprovalQueueCard {
  approval: ApprovalRequestContract;
  settle: (allowed: boolean, reason: ApprovalSettleReason) => void;
}

/** 已落定去重窗口上限：迟到响应 ack 可区分性（超限最早条目按 unknown 回落） */
export const APPROVAL_SETTLED_MAX = 512;

/** 空授权集缓存（避免每次 grantFor 分配） */
const EMPTY_GRANT: ReadonlySet<string> = new Set();

/** 全局「始终」规则值域（写 config.approval.tools 的两种取值） */
export type ApprovalAlwaysRule = 'allow' | 'deny';

/** 「始终允许 / 始终拒绝」落定后的持久化缝（hub 注入；缺省 = 仅进程内生效、不落盘） */
export interface ApprovalQueueOptions {
  /**
   * allow-always / deny-always 落定后回调（hub 据此写 config.approval.tools；best-effort）。
   * 无论是否注入，进程内 alwaysRules 都会生效（后续同类调用短路），回调只负责跨重启持久化。
   */
  onAlways?: (sessionId: string, tool: string, rule: ApprovalAlwaysRule) => void;
}

export class ApprovalQueue {
  private readonly pendings = new Map<string, ApprovalQueueCard>();
  /** 已落定记忆：requestId → 响应落定为 applied / 其余为 expired */
  private readonly settledRegistry = new Map<string, 'applied' | 'expired'>();
  /** 「本会话总是」授权缓存：sessionId → 已授权工具集 */
  private readonly grants = new Map<string, Set<string>>();
  /** 「始终允许 / 始终拒绝」全局规则（进程内；tool → allow|deny）；deny 优先于会话授权 */
  private readonly alwaysRules = new Map<string, ApprovalAlwaysRule>();

  constructor(private readonly options: ApprovalQueueOptions = {}) {}

  /** 校验并登记：scope 跨 session（或重复 requestId）→ false（调用方按拒绝处理，不悬挂） */
  register(node: ApprovalQueueCard): boolean {
    if (!scopeConfinesToSession(node.approval.scope, node.approval.sessionId)) return false;
    if (this.pendings.has(node.approval.requestId)) return false;
    this.pendings.set(node.approval.requestId, node);
    return true;
  }

  /**
   * 审批响应：live+未过期 → applied（按 decision 落定）；live+已过期 → expired（按拒绝落定）；
   * 迟到响应按已落定记忆返回（applied→duplicate，其余→expired）；从未见过 → unknown。
   *
   * Z10-5 语义落点（五态）：
   *   - allow / deny：仅本次放行 / 拒绝；
   *   - allow-session：本次放行 + 写入本会话授权缓存（后续同会话同工具直接 allow）；
   *   - allow-always：本次放行 + 记全局规则 allow（后续任意会话同工具直接 allow；经 onAlways 持久化）；
   *   - deny-always：本次拒绝 + 记全局规则 deny（后续任意会话同工具直接 deny；经 onAlways 持久化）。
   * 过期一律 fail-closed（按拒绝落定），**不**写任何缓存 / 规则。
   */
  respond(requestId: string, decision: ApprovalResponseDecision): ApprovalResponseAck {
    const node = this.pendings.get(requestId);
    if (node !== undefined) {
      if (isApprovalExpired(node.approval.expiresAt)) {
        this.settle(requestId, false, 'expired');
        return { requestId, state: 'expired' };
      }
      const allow = decision === 'allow' || decision === 'allow-session' || decision === 'allow-always';
      this.settle(requestId, allow, 'response');
      if (allow) {
        if (decision === 'allow-session') {
          this.grant(node.approval.sessionId, node.approval.tool);
        } else if (decision === 'allow-always') {
          this.setAlwaysRule(node.approval.sessionId, node.approval.tool, 'allow');
        }
      } else if (decision === 'deny-always') {
        this.setAlwaysRule(node.approval.sessionId, node.approval.tool, 'deny');
      }
      return { requestId, state: 'applied' };
    }
    const prior = this.settledRegistry.get(requestId);
    if (prior !== undefined) {
      return { requestId, state: prior === 'applied' ? 'duplicate' : 'expired' };
    }
    return { requestId, state: 'unknown' };
  }

  /** 按原因落定（hub 超时/取消/关闭；重复落定幂等——已落定/未登记直接返回） */
  settle(requestId: string, allowed: boolean, reason: ApprovalSettleReason): void {
    const node = this.pendings.get(requestId);
    if (node === undefined) return;
    this.pendings.delete(requestId);
    this.remember(requestId, reason === 'response' ? 'applied' : 'expired');
    if (allowed && node.approval.scope.mode === 'session') {
      this.grant(node.approval.scope.sessionId, node.approval.tool);
    }
    node.settle(allowed, reason);
  }

  /** 关闭兜底：全部待处理卡按拒绝落定（页面不悬挂） */
  settleAll(reason: ApprovalSettleReason = 'cancelled'): void {
    for (const requestId of [...this.pendings.keys()]) {
      this.settle(requestId, false, reason);
    }
  }

  /** 全部待处理卡（含 scope/expiresAt 全量；诊断/重连下发用） */
  listPending(): ApprovalRequestContract[] {
    return [...this.pendings.values()].map((n) => n.approval);
  }

  /** 指定会话归属的待处理卡（不含后代；后代展开在 hub 层） */
  listForSession(sessionId: string): ApprovalRequestContract[] {
    return this.listPending().filter((a) => a.sessionId === sessionId);
  }

  /** 该会话已获「本会话总是」授权工具集（只读；未授权会话 = 空集） */
  grantFor(sessionId: string): ReadonlySet<string> {
    return this.grants.get(sessionId) ?? EMPTY_GRANT;
  }

  /** 该工具的全局「始终」规则（allow|deny）；未设置 = undefined。deny 优先于会话授权（策略缝先查它） */
  alwaysRuleFor(tool: string): ApprovalAlwaysRule | undefined {
    return this.alwaysRules.get(tool);
  }

  /** 记录全局「始终」规则并通知持久化缝（best-effort；回调异常不回写内核） */
  private setAlwaysRule(sessionId: string, tool: string, rule: ApprovalAlwaysRule): void {
    this.alwaysRules.set(tool, rule);
    try {
      this.options.onAlways?.(sessionId, tool, rule);
    } catch {
      // 持久化缝异常不影响落定（进程内规则已生效）
    }
  }

  private grant(sessionId: string, tool: string): void {
    let set = this.grants.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.grants.set(sessionId, set);
    }
    set.add(tool);
  }

  private remember(requestId: string, state: 'applied' | 'expired'): void {
    if (this.settledRegistry.size >= APPROVAL_SETTLED_MAX) {
      const oldest = this.settledRegistry.keys().next().value;
      if (oldest !== undefined) this.settledRegistry.delete(oldest);
    }
    this.settledRegistry.set(requestId, state);
  }
}
