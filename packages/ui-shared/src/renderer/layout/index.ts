// layout 导出面（壳无关，Z7 下沉 ui-shared）：四席位声明与帧容器（D-10）、几何与让步链（D-11～D-13）、
// 即时状态（D-14）、降动效（D-16）、左上浮层条（Z-01）、分屏工作台（Z2-06 / Z-19）。
// 说明：应用装配（注册表单例 / 席位内容）与 D-15 主题四要素仍留各壳；本 barrel 只导出可复用的
// 纯逻辑与视图容器，测试（node 环境）也能放心 import。
export { AppFrame } from './AppFrame.js';
export { FrameTopOverlay, type FrameTopOverlayProps } from './top-overlay.js';
export {
  AUTO_COLLAPSE_RESIZE_IDLE_MS,
  AUTO_COLLAPSE_RIGHTBAR_CONVERSATION_WIDTH,
  AUTO_COLLAPSE_SIDEBAR_CONVERSATION_WIDTH,
  CONVERSATION_DEFAULT_RATIO,
  CONVERSATION_MIN_RATIO,
  RIGHTBAR_DEFAULT_RATIO,
  RIGHTBAR_EXPANDED_RATIO,
  RIGHTBAR_MAX_RATIO,
  RIGHTBAR_MIN_PX,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH_RATIO,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP_PX,
  TERMINAL_DEFAULT_RATIO,
  TERMINAL_EXPANDED_RATIO,
  TERMINAL_MAX_RATIO,
  TERMINAL_MIN_PX,
  MAIN_MIN_WIDTH,
  clampTerminalHeight,
  clampWidth,
  computeFrameGeometry,
  defaultRightbarWidth,
  resolveAutoCollapse,
  resolveContentWidth,
  resolveTerminalHeight,
  shouldAutoCollapseRightbar,
  shouldAutoCollapseSidebar,
  sidebarMaxWidth,
  terminalMaxHeight,
  type AutoCollapseDecision,
  type AutoCollapseInput,
  type FrameGeometry,
  type FrameGeometryInput,
  type ShortageOwner,
} from './geometry.js';
export {
  applyFrameAction,
  contentWidthOf,
  initialFrameState,
  rightbarMaxWidth,
  MAIN_CONVERSATION_KEY,
  type FrameAction,
  type FrameState,
} from './frame-state.js';
export { FrameProvider, useFrame, useOptionalFrame, type FrameController } from './frame-context.js';
export {
  declareFrameSeats,
  registerFrameSeats,
  FRAME_ROOT_SEAT,
  FRAME_SEAT,
  FRAME_SEAT_DECLARATIONS,
  FRAME_SEAT_ORDER,
  MAIN_PANEL_KEYS,
  TERMINAL_SEAT,
  type FrameSeatId,
} from './frame-seats.js';
export { FRAME_SEAT_VIEWS } from './frame-seat-views.js';
export {
  REDUCED_MOTION_ATTRIBUTE,
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  reducedMotionAttribute,
  resolveMatchMedia,
  type MatchMediaLike,
} from './reduced-motion.js';
export { useFrameState, useReducedMotion, useViewportWidth, type UseFrameOptions } from './use-frame.js';
export { WorkbenchHost, type WorkbenchComposerControls, type WorkbenchHostProps } from './workbench/host.js';
export {
  MAX_PANES,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
  createInitialSnapshot,
  dropSideForRect,
  type SplitSide,
  type WorkbenchNode,
  type WorkbenchSnapshot,
} from './workbench/model.js';
export { WorkbenchStore, workbenchStore, type DropOutcome, type DropReason } from './workbench/store.js';
export { workbenchDrag } from './workbench/drag.js';
