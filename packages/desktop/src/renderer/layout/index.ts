// layout 导出面（纯/视图层）：四席位声明与帧容器（D-10）、几何与让步链（D-11～D-13）、
// 即时状态（D-14）、主题呈现与降动效（D-15/D-16）。
// 注意：应用装配（shellSlots / assembleFrame）与席位内容（injectShellSeatContents）会 import
// app-shared（依赖 window.harness2），故**不**经本文件导出 —— 由 App.tsx 直接引对应模块，
// 纯逻辑测试（node 环境）也能放心 import 本 barrel。
export { AppFrame } from './AppFrame.js';
export {
  AUTO_COLLAPSE_VIEWPORT,
  RIGHTBAR_DEFAULT_RATIO,
  RIGHTBAR_GIVE_MIN_WIDTH,
  RIGHTBAR_MAX_RATIO,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  MAIN_MIN_WIDTH,
  clampWidth,
  computeFrameGeometry,
  defaultRightbarWidth,
  shouldAutoCollapse,
  type FrameGeometry,
  type FrameGeometryInput,
  type ShortageOwner,
} from './geometry.js';
export {
  applyFrameAction,
  initialFrameState,
  rightbarMaxWidth,
  MAIN_CONVERSATION_KEY,
  type FrameAction,
  type FrameState,
} from './frame-state.js';
export { FrameProvider, useFrame, type FrameController } from './frame-context.js';
export {
  declareFrameSeats,
  registerFrameSeats,
  FRAME_ROOT_SEAT,
  FRAME_SEAT,
  FRAME_SEAT_DECLARATIONS,
  FRAME_SEAT_ORDER,
  MAIN_PANEL_KEYS,
  type FrameSeatId,
} from './frame-seats.js';
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
export { useFrameState, useReducedMotion, useViewportWidth, type UseFrameOptions } from './use-frame.js';
