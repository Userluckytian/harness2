// approval 导出面（D-6x `ui-approval` 对应物）：
//   语义/文案纯模型（approval-model）—— 决定值域、范围文案、参数摘要、过期判定、待批项→卡片映射；
//   卡片（ApprovalCard，card/bar 两形态）与内联条（ApprovalBar）—— 只呈现与回传决定；
//   dock（ApprovalDock + approval-dock-model）—— Z-20 的会话底部落点（numbered listbox + 确认）。
// 边界：不 import main / preload，不用浏览器存储；数据与动作都由宿主经 props 注入。
export {
  APPROVAL_DECISION_LABEL,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_FAILURE_PREFIX,
  APPROVAL_PENDING_TEXT,
  APPROVAL_SCOPE_LABEL,
  approvalScopeLabel,
  canRespondApproval,
  isApprovalDecision,
  isApprovalExpired,
  summarizeApprovalArgs,
  toApprovalCardModel,
  type ApprovalCardModel,
  type ApprovalDecision,
  type ApprovalScope,
  type ApprovalSource,
} from './approval-model.js';
export {
  APPROVAL_DOCK_CONFIRM_LABEL,
  APPROVAL_DOCK_DENY_LABEL,
  APPROVAL_DOCK_HINT,
  approvalDockOptions,
  moveApprovalHighlight,
  type ApprovalDockOption,
} from './approval-dock-model.js';
export {
  ApprovalCard,
  type ApprovalCardLabels,
  type ApprovalCardProps,
  type ApprovalCardVariant,
} from './ApprovalCard.js';
export { ApprovalBar, type ApprovalBarProps } from './ApprovalBar.js';
export { ApprovalDock, type ApprovalDockProps } from './ApprovalDock.js';
