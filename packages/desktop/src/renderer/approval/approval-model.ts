// 审批卡的纯模型（D-6x `ui-approval` 对应物的语义半部）。
//
// 语义归 core（`packages/core/src/approval/**` + serve 的 `sessions-approval` 协议）：
//   决定只有 allow / deny 两态；scope 只有 once / session；过期卡片服务端拒收迟到决策。
// 桌面侧**只呈现与回传决定**，不推断、不放宽、不新增第三态（本模块无「总是允许」等假动作）。
//
// 本文件不 import main / preload，也不碰任何浏览器存储（纯函数，node 环境可测）。

/** 审批决定（与 core / serve 协议同值域：`respondApproval(requestId, 'allow' | 'deny')`） */
export type ApprovalDecision = 'allow' | 'deny';

/** 审批范围（store 把协议 `{ mode }` 摊平成这个值域；once = 仅此一次；session = 本会话） */
export type ApprovalScope = 'once' | 'session';

/**
 * 决定值域守卫（从线上帧/未知来源取决定时用；不合法一律 false，不默认放行）。
 */
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'allow' || value === 'deny';
}

/** 决定文案（审批卡按钮；allow/deny 的默认中文） */
export const APPROVAL_DECISION_LABEL: Record<ApprovalDecision, string> = {
  allow: '允许',
  deny: '拒绝（不执行）',
};

/** 范围文案（once → 一次；session → 本会话；缺省不显示该项） */
export const APPROVAL_SCOPE_LABEL: Record<ApprovalScope, string> = {
  once: '一次',
  session: '本会话',
};

/** 在途反馈文案（提交中：按钮被替换为这句，连点无入口） */
export const APPROVAL_PENDING_TEXT = '提交中…（防重复提交）';

/** 过期注记（服务端会拒收迟到决策） */
export const APPROVAL_EXPIRED_TEXT = '已过期（服务端会拒收迟到决策）';

/** 失败注记前缀（提交失败如实保留卡片可重试） */
export const APPROVAL_FAILURE_PREFIX = '审批提交失败';

/** 审批卡数据（字段全部来自服务端帧或 S7 快照，展示层不做推断） */
export interface ApprovalCardModel {
  readonly requestId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly scope?: ApprovalScope;
  readonly cwd?: string;
  readonly expiresAt?: string;
  readonly taskId?: string;
  readonly parentTaskId?: string;
  /** 已过期（由分组/装饰层判定；缺省 undefined = 未判定，不默认过期） */
  readonly expired?: boolean;
  /** 任务状态标签（任务账本侧给的人类可读态） */
  readonly taskStateLabel?: string;
}

/** 单行参数摘要（工具行/审批卡共用口径；超出截断加省略号） */
export function summarizeApprovalArgs(args: unknown, maxLength = 120): string {
  if (args === undefined) return '';
  const one = JSON.stringify(args) ?? '';
  return one.length <= maxLength ? one : `${one.slice(0, maxLength)}…`;
}

/** scope → 中文范围文案（未知/缺省 → undefined，不猜） */
export function approvalScopeLabel(scope: ApprovalScope | undefined): string | undefined {
  return scope === 'once' || scope === 'session' ? APPROVAL_SCOPE_LABEL[scope] : undefined;
}

/**
 * 过期判定（与 core `isApprovalExpired` 的 fail-closed 口径对齐）：
 *   - `expiresAt` 缺失 → **不判过期**（旧 serve 不发该字段时不误杀；桌面既有 plan-model 同口径）；
 *   - 存在但不可解析 → **过期**（core：`Number.isNaN(t) → true`，宁可不执行也不放过）；
 *   - 可解析 → `t <= now` 即过期。
 * @param now - 当前时间戳（测试注入；缺省 Date.now()）
 */
export function isApprovalExpired(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true; // fail-closed（core 同口径）
  return at <= now;
}

/** 卡片是否可提交决定（过期 / 在途 → 不可提交；UI 据此不给可点按钮） */
export function canRespondApproval(card: ApprovalCardModel, responding: boolean): boolean {
  return !responding && card.expired !== true;
}
