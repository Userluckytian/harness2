// 侧栏目录对外出口（Z7 下沉 ui-shared）：接线阶段（slots/layout 装配）从这里取组件与类型。
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
export type { SessionBrowserProps, SessionRowDrag, WorkspacesOwnerProps } from './SessionBrowser.js';

// 任务工具栏与视图逻辑（Z8-1 / Z-07 #5～#8 / Z-08 / Z-09）
export { TaskToolbar } from './TaskToolbar.js';
export type { TaskToolbarProps } from './TaskToolbar.js';
export {
  DEFAULT_SIDEBAR_TASK_PREFERENCES,
  PINNED_COLLAPSE_LIMIT,
  buildSidebarSections,
  filterSessionItems,
  groupSessionsByProject,
  leadingSlot,
  projectName,
  relativeTime,
  resolveTaskViewMode,
  sortSessionItems,
  splitPinned,
} from './task-view.js';
export type {
  SidebarFilter,
  SidebarLeadingKind,
  SidebarProjectGroup,
  SidebarSection,
  SidebarSectionsInput,
  SidebarSortBy,
  SidebarTaskPreferences,
  SidebarTaskViewMode,
  SidebarViewMode,
} from './task-view.js';

// 几何（Z-05 / Z-06）
export {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH_RATIO,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  sidebarMaxWidth,
} from './geometry.js';

// 品牌徐标（D-20 / D-25）
export { COMMIT_SHORT_LENGTH, BUILD_VERSION_ENV_KEYS, formatBuildVersion, resolveBuildVersion } from './brand.js';
export type { BuildVersionInput } from './brand.js';

// 新会话作用域（D-21）
export { resolveNewSessionScope } from './new-session-scope.js';
export type { NewSessionScope, NewSessionScopeInput } from './new-session-scope.js';

// 折叠形态（Z-06）
export { COLLAPSE_TRANSITION_MS, sidebarStateClasses } from './collapse.js';
export type { SidebarClassInput } from './collapse.js';

// 滚动条可供性（D-24）
export { SCROLLBAR_LINGER_MS, scrollAffordance } from './scroll-affordance.js';
export type { ScrollAffordanceEvent, ScrollAffordanceState } from './scroll-affordance.js';

// 会话行视图模型（D-23）
export { UNTITLED_SESSION_LABEL, buildSessionItems, toSessionItem } from './session-items.js';
export type { SidebarSessionFlags, SidebarSessionItem, SidebarSessionSource } from './session-items.js';

// 文案
export { DEFAULT_SIDEBAR_LABELS } from './labels.js';
export type { SidebarLabels } from './labels.js';
