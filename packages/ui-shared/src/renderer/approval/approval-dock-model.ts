// 审批 dock 的选项纯模型（D-6x `ui-approval` 对应物的 Z-20 呈现半部）。
//
// 依据：docs/refs/refs-zcode-layout.md `Z-20`（权限 = 底部 dock 卡片）+ docs/refs/refs-zcode.md
// §8 `PermissionDialog` 行（numbered listbox + 确认按钮 + 键盘）。
//
// 语义仍归 core（见 approval-model.ts 头注）：决定只有 allow | deny；范围（once | session）由
// **服务端请求卡**声明，客户端只能如实呈现，**不能**在应答里改范围 —— serve 的 `respondApproval`
// 契约只带 `decision`，没有 scope 字段。因此每张卡只有一个「允许」行（范围取卡自身声明），
// 不会出现「让用户挑范围」的假选项（那需要协议里不存在的 scope 回传通道）。
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
  /** 该行提交的决定（协议值域只有 allow | deny） */
  readonly decision: ApprovalDecision;
  /** 行标签（允许（一次）/ 允许（本会话）/ 拒绝） */
  readonly label: string;
  /** 范围 chip 文案（无范围声明 = undefined → 不渲染 chip，不猜） */
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
 * 行集：
 *   1. 允许 —— 范围取**请求卡声明的 scope**（once → 「允许（一次）」；session → 「允许（本会话）」；
 *      未声明 → 「允许」）；
 *   2. 拒绝 —— deny 无范围语义，恒不带 chip。
 *
 * 协议只有 allow | deny 两态、应答不携带 scope，故「一次 / 本会话」不是本行可选的范围：
 * 范围由服务端按卡声明落定，客户端只呈现。**不臆造服务端没有的范围**（core 契约冻结）。
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
    { id: `${card.requestId}:deny`, decision: 'deny', label: APPROVAL_DOCK_DENY_LABEL },
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
