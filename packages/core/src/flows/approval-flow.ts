// H-66 审批 flow（阶段 7）：决策键 o 一次 / s 会话内永久 / a 全局 / d 拒绝，
// 以及「本会话总是」/「全局总是」授权缓存（per-tool 粒度，跨会话隔离）。
//
// 与既有设施的关系：`interaction/types.ts` 的 ApprovalScope 只有 once/session；
// 本文件在其上**加性**引入 'always'（全局）语义，并提供到 ApprovalScope 的映射，
// 让 serve 侧既有审批队列（approval-queue.ts）可直接消费 once/session 两种作用域。
//
// 与既有 policy（approval/policy.ts，四模式 default/acceptEdits/bypass/plan + per-tool 规则）
// 的**组合语义**（调用方按此顺序组合，serve 侧 makeApprovalHandler 已是同序）：
//   1) 授权缓存命中（本会话 always 或全局 always）→ 直接 allow，**不再落策略、不再问 UI**；
//   2) 否则走 policy.decide：per-tool 规则 > mode 推导；返回 'allow' 直接放行、'deny' 直接拒绝；
//   3) 仅当 policy 返回 'ask' 时才发 flow 审批请求，用户 o/s/a/d 决定本次是否放行；
//   4) o 只放行本次（不写缓存）；s/a 落缓存（a 为全局）后，后续同工具调用走第 1 步短路。
// 即：**缓存只加宽 ask 的放行面，不能绕过 policy 的 allow/deny**（deny 永不被缓存解禁）。
import type { ApprovalScope } from '../interaction/types.js';
import type { ApprovalFlowDecision, FlowApprovalScopeMode, FlowSessionId } from './types.js';

/** 审批作用域（加性：在既有 ApprovalScope 之上补 'always'） */
export type FlowApprovalScope = ApprovalScope | { mode: 'always' };

/**
 * 解析审批决策键（大小写不敏感；中英双写）。
 * `allowSession`/`allowAlways` 为 false 时对应选项返回 null（壳不展示即不应收到）。
 * 无法识别 → null（调用方保持卡片不落定，提示重选）。
 */
export function parseApprovalChoice(
  input: string,
  options: { allowSession?: boolean; allowAlways?: boolean } = {},
): ApprovalFlowDecision | null {
  const allowSession = options.allowSession !== false;
  const allowAlways = options.allowAlways !== false;
  const t = input.trim().toLowerCase();
  if (t.length === 0) return null;
  if (t === 'o' || t === 'once' || t === '1' || t === '一次' || t === '仅一次') return 'allow_once';
  if (t === 's' || t === 'session' || t === '2' || t === '会话' || t === '本会话') {
    return allowSession ? 'allow_session' : null;
  }
  if (t === 'a' || t === 'always' || t === 'global' || t === 'all' || t === '3' || t === '全局' || t === '总是') {
    return allowAlways ? 'allow_always' : null;
  }
  if (
    t === 'd' ||
    t === 'deny' ||
    t === 'no' ||
    t === 'n' ||
    t === '4' ||
    t === '拒绝' ||
    t === 'esc' ||
    t === 'escape'
  ) {
    return 'deny';
  }
  return null;
}

/** 决策 → 作用域模式（deny → null） */
export function decisionScopeMode(decision: ApprovalFlowDecision): FlowApprovalScopeMode | null {
  switch (decision) {
    case 'allow_once':
      return 'once';
    case 'allow_session':
      return 'session';
    case 'allow_always':
      return 'always';
    case 'deny':
      return null;
    default: {
      const never: never = decision;
      return never;
    }
  }
}

/**
 * 决策 → 可交给既有 serve 审批队列（ApprovalScope）的作用域。
 * 'always' 不属于单会话作用域，返回 null（由 ApprovalGrantStore 全局授权承接）。
 */
export function approvalDecisionToScope(
  decision: ApprovalFlowDecision,
  sessionId: FlowSessionId,
): ApprovalScope | null {
  switch (decision) {
    case 'allow_once':
      return { mode: 'once' };
    case 'allow_session':
      return { mode: 'session', sessionId };
    case 'allow_always':
    case 'deny':
      return null;
    default: {
      const never: never = decision;
      return never;
    }
  }
}

/** 全局授权持久化缝（对齐 config.command_allowlist 的注入点；缺省不落盘） */
export interface ApprovalGrantPersistence {
  load(): readonly string[];
  save(patterns: readonly string[]): void;
}

export interface ApprovalGrantStoreOptions {
  persistence?: ApprovalGrantPersistence;
}

/**
 * 授权缓存：
 *   - session 授权：`sessionId → tool 集合`，**绝不跨会话泄漏**；
 *   - always 授权：全局 `tool 集合`，经 persistence 缝落盘（可选）。
 * 粒度 = 工具名（与既有 approval-queue 的 grantFor(sessionId).has(tool) 口径一致）。
 */
export class ApprovalGrantStore {
  private readonly sessionGrants = new Map<FlowSessionId, Set<string>>();
  private readonly alwaysGrants = new Set<string>();

  constructor(private readonly options: ApprovalGrantStoreOptions = {}) {
    const persisted = this.options.persistence?.load() ?? [];
    for (const tool of persisted) this.alwaysGrants.add(tool);
  }

  grantSession(sessionId: FlowSessionId, tool: string): void {
    let set = this.sessionGrants.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.sessionGrants.set(sessionId, set);
    }
    set.add(tool);
  }

  grantAlways(tool: string): void {
    if (this.alwaysGrants.has(tool)) return;
    this.alwaysGrants.add(tool);
    this.options.persistence?.save([...this.alwaysGrants]);
  }

  isGranted(sessionId: FlowSessionId, tool: string): boolean {
    return this.alwaysGrants.has(tool) || (this.sessionGrants.get(sessionId)?.has(tool) ?? false);
  }

  isGrantedGlobally(tool: string): boolean {
    return this.alwaysGrants.has(tool);
  }

  listSession(sessionId: FlowSessionId): string[] {
    return [...(this.sessionGrants.get(sessionId) ?? new Set<string>())].sort();
  }

  listAlways(): string[] {
    return [...this.alwaysGrants].sort();
  }

  revokeSession(sessionId: FlowSessionId, tool: string): boolean {
    return this.sessionGrants.get(sessionId)?.delete(tool) ?? false;
  }

  revokeAlways(tool: string): boolean {
    const removed = this.alwaysGrants.delete(tool);
    if (removed) this.options.persistence?.save([...this.alwaysGrants]);
    return removed;
  }
}

export interface ApplyApprovalDecisionResult {
  scope: FlowApprovalScopeMode | null;
  /** 是否写入了授权缓存（allow_session / allow_always） */
  granted: boolean;
}

/**
 * 落定一次审批决策：allow_session → session 缓存；allow_always → 全局缓存；其余不写。
 * 返回作用域模式与是否授权，供审计记账。
 */
export function applyApprovalDecision(
  store: ApprovalGrantStore,
  decision: ApprovalFlowDecision,
  target: { sessionId: FlowSessionId; tool: string },
): ApplyApprovalDecisionResult {
  const scope = decisionScopeMode(decision);
  if (decision === 'allow_session') {
    store.grantSession(target.sessionId, target.tool);
    return { scope, granted: true };
  }
  if (decision === 'allow_always') {
    store.grantAlways(target.tool);
    return { scope, granted: true };
  }
  return { scope, granted: false };
}
