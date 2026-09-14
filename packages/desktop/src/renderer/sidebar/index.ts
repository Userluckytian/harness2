// 侧栏目录对外出口：接线阶段（A 棒 slots/layout 装配）从这里取组件与类型。
// 只导出接口与实现，不导出内部细节（hook 仅在包内使用；纯函数导出供装配层直接调用）。

// 外壳与区域席位
export { SidebarRoot } from './SidebarRoot.js';
export type {
  BrandMarkOwnerProps,
  BrandNameOwnerProps,
  SettingsOwnerProps,
  SidebarRootProps,
  SidebarSeats,
} from './SidebarRoot.js';
export { SessionBrowser } from './SessionBrowser.js';
export type { SessionBrowserProps, WorkspacesOwnerProps } from './SessionBrowser.js';

// 几何（D-11 / D-13）
export {
  RAIL_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from './geometry.js';

// 品牌徐标（D-20 / D-25）
export { COMMIT_SHORT_LENGTH, BUILD_VERSION_ENV_KEYS, formatBuildVersion, resolveBuildVersion } from './brand.js';
export type { BuildVersionInput } from './brand.js';

// 新会话作用域（D-21）
export { resolveNewSessionScope } from './new-session-scope.js';
export type { NewSessionScope, NewSessionScopeInput } from './new-session-scope.js';

// 收起相位（D-22）
export { COLLAPSE_SETTLE_MS, collapsePhase, playsRailIn, settleDelayMs, sidebarStateClasses } from './collapse.js';
export type { CollapsePhase, SidebarClassInput } from './collapse.js';

// 滚动条可供性（D-24）
export { SCROLLBAR_LINGER_MS, scrollAffordance } from './scroll-affordance.js';
export type { ScrollAffordanceEvent, ScrollAffordanceState } from './scroll-affordance.js';

// 会话行视图模型（D-23）
export { UNTITLED_SESSION_LABEL, buildSessionItems, toSessionItem } from './session-items.js';
export type { SidebarSessionFlags, SidebarSessionItem, SidebarSessionSource } from './session-items.js';

// 文案
export { DEFAULT_SIDEBAR_LABELS } from './labels.js';
export type { SidebarLabels } from './labels.js';
