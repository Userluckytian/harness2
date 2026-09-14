// tool 导出面（D-6x `ui-tool` 对应物）。
//   纯模型（tool-model）—— 工具分类 / 参数摘要 / 状态文案 / D-86 单视图口径；
//   跳转契约（tool-navigation）—— openFile→右栏、inspect→轨迹，含 A 棒轨迹视图的注册面；
//   卡片（ToolCard）与右栏文件预览（ToolFilePreviewPanel）—— 只呈现与回调。
// 边界：不 import main / preload，不用浏览器存储；数据与动作由宿主经 props / ctx 注入。
export {
  DIFF_TOOL_NAMES,
  TERMINAL_TOOL_NAMES,
  TOOL_CARD_SINGLE_VIEW,
  isDiffTool,
  isTerminalTool,
  shouldRenderCommandLog,
  summarizeToolArgs,
  toolCardFromItem,
  toolDiffTargetFile,
  toolFileTarget,
  toolStatusLabel,
  toolStatusOf,
  type ToolCardModel,
  type ToolStatus,
} from './tool-model.js';
export {
  TOOL_INSPECT_TARGET,
  TOOL_OPEN_FILE_TARGET,
  TRAJECTORY_VIEW_KEY,
  ToolNavigationProvider,
  createToolNavigation,
  toolJumpActions,
  toolNavigation,
  useToolFilePreview,
  useToolNavigation,
  type ToolFileOpenRequest,
  type ToolFilePreview,
  type ToolInspectRequest,
  type ToolNavigation,
  type ToolNavigationFailureReason,
  type ToolNavigationResult,
  type ToolNavigationState,
  type ToolNavigationTarget,
  type TrajectoryViewConsumer,
} from './tool-navigation.js';
export { ToolCard, controllerToolActions, type ToolCardActions, type ToolCardProps } from './ToolCard.js';
export {
  ToolFilePreviewPanel,
  type FilePreviewReadResult,
  type FilePreviewReader,
  type ToolFilePreviewProps,
} from './FilePreview.js';
