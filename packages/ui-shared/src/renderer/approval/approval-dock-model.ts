// 审批 dock 的选项纯模型（D-6x `ui-approval` 对应物的 Z-20 呈现半部）。
//
// 依据：docs/refs/refs-zcode-layout.md `Z-20`（权限 = 底部 dock 卡片）+ docs/refs/refs-zcode.md
// §8 `PermissionDialog` 行（numbered listbox + 确认按钮 + 键盘）。
//
// 语义归 core（见 approval-model.ts 头注）：Z10-5 决定五态 —— allow（本次）/ allow-session（本会话）/
// allow-always（始终允许，全局）/ deny（本次）/ deny-always（始终拒绝，全局）。选项集**严格等于
// core 真支持的 decision 集合**：core 不认的选项（如 bypass「完全访问」、拒绝理由输入）不摆。
//
// 本文件不 import main / preload，不碰浏览器存储（纯函数，node 环境可测）。

import {
  APPROVAL_DECISION_LABEL,
  approvalScopeLabel,
  type ApprovalCardModel,
  type ApprovalDecision,
} from './approval-model.js';

/** listbox 的一行（序号由渲染层按数组下标 +1 给出） */
export interface ApprovalDockOption {
  /** 稳定 id（requestId + decision；listbox 的 aria-activedescendant 用） */
  readonly id: string;
  /** 该行提交的决定（与 core 协议五态同值域） */
  readonly decision: ApprovalDecision;
  /** 行标签（允许 / 本会话内允许 / 始终允许 / 拒绝 / 始终拒绝） */
  readonly label: string;
  /** 范围 chip 文案（本次 / 本会话 / 全局；无范围声明 = undefined → 不渲染 chip，不猜） */
  readonly scopeLabel?: string;
}

/** dock 底部提示（Z-20：使用 Tab / 上下键选择，回车确认） */
export const APPROVAL_DOCK_HINT = '使用 Tab / 上下键选择，回车确认';
/** dock 主按钮文案（Z-20：底部右侧「确认」） */
export const APPROVAL_DOCK_CONFIRM_LABEL = '确认';
/** 拒绝行文案（与右栏「拒绝（不执行）」区分：dock 用短文案，语义同 deny） */
export const APPROVAL_DOCK_DENY_LABEL = '拒绝';

/** 允许行标签：范围已知则括注（允许（一次）/ 允许（本会话））；卡未声明范围 → 仅「允许」 */
function allowOptionLabel(scope: ApprovalCardModel['scope']): string {
  const scopeText = approvalScopeLabel(scope);
  return scopeText === undefined ? APPROVAL_DECISION_LABEL.allow : `${APPROVAL_DECISION_LABEL.allow}（${scopeText}）`;
}

/**
 * 由请求卡摊平出选项行（Z-20 numbered listbox）。
 *
 * 行集（Z10-5 五态，与 core 协议一一对应）：
 *   1. 允许（allow）—— 范围取请求卡声明的 scope（once → 「允许（一次）」；session → 「允许（本会话）」）；
 *   2. 本会话内允许（allow-session）—— 本会话内该工具后续调用不再问；chip「本会话」；
 *   3. 始终允许（allow-always）—— 全局写 config.approval.tools.<tool>='allow'；chip「全局」；
 *   4. 拒绝（deny）—— 仅本次；无 chip；
 *   5. 始终拒绝（deny-always）—— 全局写 config.approval.tools.<tool>='deny'；chip「全局」。
 *
 * 「始终」两行会持久化到全局配置（跨会话/重启生效），故带「全局」chip 如实说明影响面。
 */
export function approvalDockOptions(card: ApprovalCardModel): ApprovalDockOption[] {
  const scopeLabel = approvalScopeLabel(card.scope);
  return [
    {
      id: `${card.requestId}:allow`,
      decision: 'allow',
      label: allowOptionLabel(card.scope),
      ...(scopeLabel !== undefined ? { scopeLabel } : {}),
    },
    {
      id: `${card.requestId}:allow-session`,
      decision: 'allow-session',
      label: APPROVAL_DECISION_LABEL['allow-session'],
      scopeLabel: '本会话',
    },
    {
      id: `${card.requestId}:allow-always`,
      decision: 'allow-always',
      label: APPROVAL_DECISION_LABEL['allow-always'],
      scopeLabel: '全局',
    },
    { id: `${card.requestId}:deny`, decision: 'deny', label: APPROVAL_DOCK_DENY_LABEL },
    {
      id: `${card.requestId}:deny-always`,
      decision: 'deny-always',
      label: APPROVAL_DECISION_LABEL['deny-always'],
      scopeLabel: '全局',
    },
  ];
}

/**
 * 高亮移动（↑↓ / Tab）：到边界即停（clamp，不回卷）。
 * 返回与入参相同 = 未移动（组件据此决定 Tab 是否放行、方向键是否吞掉滚动）。
 */
export function moveApprovalHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > count - 1) return count - 1;
  return next;
}
