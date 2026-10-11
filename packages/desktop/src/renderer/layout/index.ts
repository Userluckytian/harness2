// layout 导出面（桌面侧）：壳无关部分（帧容器 / 几何 / 即时状态 / 降动效 / 浮层 / 分屏工作台）
// 已随 Z7 下沉 `@harness2/ui-shared/renderer/layout/*`，本 barrel 原样再导出，既有
// `./layout/index.js` 引用面不变；桌面专属（窗口外壳浮层包装、覆层开关、壳主题、D-15 主题呈现）
// 仍由本目录模块提供。
//
// 注意：应用装配（shellSlots / assembleFrame）与席位内容（injectShellSeatContents）会 import
// app-shared（依赖 window.harness2），故**不**经本文件导出 —— 由 App.tsx 直接引对应模块，
// 纯逻辑测试（node 环境）也能放心 import 本 barrel。
export { AppFrame, FrameTopOverlay, type FrameTopOverlayProps } from '@harness2/ui-shared/renderer/layout/index.js';
export { DesktopTopOverlay, type DesktopTopOverlayProps } from './DesktopTopOverlay.js';
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
} from '@harness2/ui-shared/renderer/layout/geometry.js';
export {
  applyFrameAction,
  contentWidthOf,
  initialFrameState,
  rightbarMaxWidth,
  MAIN_CONVERSATION_KEY,
  type FrameAction,
  type FrameState,
} from '@harness2/ui-shared/renderer/layout/frame-state.js';
export { FrameProvider, useFrame, type FrameController } from '@harness2/ui-shared/renderer/layout/frame-context.js';
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
} from '@harness2/ui-shared/renderer/layout/frame-seats.js';
export { ShellPaletteProvider, useShellPalette, type ShellPaletteValue } from './shell-context.js';
export {
  closeAllOverlays,
  setOverlay,
  shellOverlayStore,
  toggleOverlay,
  useOverlayOpen,
  type ShellOverlayId,
} from './shell-overlays.js';
export { createShellStore, useShellStore, type ShellStore } from './shell-store.js';
export { getShellTheme, setShellTheme, shellThemeLabel, shellThemeStore, useShellTheme } from './shell-theme.js';
export {
  applyThemePresentation,
  applyThemePresentationValues,
  CONTENT_FONT_SIZE_VAR,
  DARK_THEME_ATTRIBUTE,
  DEFAULT_CONTENT_FONT_SIZE,
  ensureThemeColorMeta,
  prefersReducedMotion,
  reducedMotionAttribute,
  REDUCED_MOTION_ATTRIBUTE,
  REDUCED_MOTION_QUERY,
  resolveThemePresentation,
  THEME_COLOR,
  type MatchMediaLike,
  type ThemePresentation,
} from './theme-presenter.js';
export {
  useFrameState,
  useReducedMotion,
  useViewportWidth,
  type UseFrameOptions,
} from '@harness2/ui-shared/renderer/layout/use-frame.js';
