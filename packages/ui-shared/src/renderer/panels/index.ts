// 右栏面板导出面（Z7-a 从 desktop `renderer/features/*` 下沉）。
//
// 全部壳无关：数据源 = 壳注入的 `store` / `controller`（桌面 = app-shared 单例；web = serve 壳实例），
// 组件本身不 import 任何壳的全局对象（window.harness2 等）。壳可选端口（如上下文占用读取）
// 经 props 注入；缺失即如实降级（不摆假数据）。
export { PlanPanel, type PlanPanelProps } from './plan/PlanPanel.js';
export { TaskPanel, type TaskPanelProps } from './plan/TaskPanel.js';
export { ApprovalCenter, type ApprovalCenterProps } from './plan/ApprovalCenter.js';
export { ChangeReviewPanel, type ChangeReviewPanelProps } from './workspace/ChangeReviewPanel.js';
export { WorkspacePanel, type WorkspacePanelProps } from './workspace/WorkspacePanel.js';
export {
  EffectiveConfigPanel,
  type EffectiveConfigPanelProps,
  type ContextUsageReading,
} from './config/EffectiveConfigPanel.js';
