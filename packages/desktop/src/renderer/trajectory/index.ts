// 轨迹视图（D-40～D-47）导出面：ui-trajectory。
//
// 分层（每层可独立单测）：
//   types.ts            数据模型（只读；未知一律 null）
//   projection.ts       事件流 → 轮次/步骤/Between turns（纯函数）
//   virtual-window.ts   虚拟化窗口（尾部 50 / 前向补页 / 可见窗口缓冲 / 稳定键）
//   overview.ts         时间概览模型 + D-43 交互状态机（纯函数）
//   timing.ts           首 token 观测（TTFT 的唯一诚实来源）
//   inspector.ts        检查器视图模型（字段齐全、缺数据如实「未记录」）
//   format.ts           展示格式化
//   record-table.tsx    记录表（D-41/D-45）
//   timeline-overview.tsx 时间概览（D-42/D-43）
//   inspector-panel.tsx 局部检查器（D-44）
//   trajectory-panel.tsx 面板组合（呈现层）
//   trajectory-view.tsx 视图定义 + 内容组件（D-40；只定义不注册）
//   shell-contract.ts   D-46 壳义务契约（composer 浮层预留高度）
export { BETWEEN_TURNS_LABEL, UNASSIGNED_TURN_ID } from './types.js';
export type {
  TrajectoryAttachment,
  TrajectoryBetweenTurnEntry,
  TrajectoryModel,
  TrajectoryRow,
  TrajectoryStep,
  TrajectoryStepRole,
  TrajectoryStepState,
  TrajectoryTiming,
  TrajectoryTurn,
  TrajectoryUsage,
} from './types.js';

export {
  BETWEEN_TURNS_SECTION_TITLE,
  extractAttachments,
  filterModelBySelection,
  isoToMs,
  projectTrajectory,
  rowCount,
} from './projection.js';
export type { TrajectoryProjectionInput } from './projection.js';

export {
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_PAGE_SIZE_ROWS,
  DEFAULT_ROW_HEIGHT_PX,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  INITIAL_TAIL_ROWS,
  ariaRowCountOf,
  ariaRowIndexOf,
  assertUniqueRowKeys,
  bottomSpacerPx,
  computeRowWindow,
  defaultMetrics,
  initialScrollTopPx,
  mountedIndices,
  resolveLoadedPages,
  rowKeys,
  semanticRowKey,
  topSpacerPx,
} from './virtual-window.js';
export type { RowWindow, RowWindowMetrics } from './virtual-window.js';

export {
  INITIAL_OVERVIEW_VIEWPORT,
  MAX_OVERVIEW_ZOOM,
  MIN_OVERVIEW_ZOOM,
  MIN_SELECTION_SPAN_MS,
  WHEEL_ZOOM_FACTOR,
  buildOverview,
  clearViewport,
  computeDomain,
  dragPan,
  filterSegments,
  isZoomed,
  orderedSelection,
  pixelToTimeMs,
  ratioToTime,
  segmentExtent,
  segmentIntersects,
  selectionFromDrag,
  timeToRatio,
  untimedSegmentCount,
  viewportDomain,
  wheelZoom,
} from './overview.js';
export type {
  OverviewSelection,
  OverviewViewport,
  TimeDomain,
  TimelineOverviewModel,
  TimelineSegment,
} from './overview.js';

export { TrajectoryTimingObserver, currentStreamingStepId } from './timing.js';
export type { TimingClock } from './timing.js';

export { createTrajectoryFocusStore, findFocusRowKey } from './inspect-focus.js';
export type { TrajectoryFocusRequest, TrajectoryFocusStore } from './inspect-focus.js';

export {
  deriveBetweenTurnsInspector,
  deriveInspectorForRow,
  deriveStepInspector,
  roleLabel,
  stateLabel,
  summarizeAttachments,
} from './inspector.js';
export type { InspectorAttachmentSummary, InspectorEntry, TrajectoryInspectorView } from './inspector.js';

export { MISSING_VALUE, formatClock, formatDurationMs, formatUsage, previewValue, truncate } from './format.js';

export { RecordTable } from './record-table.js';
export type { RecordTableProps } from './record-table.js';

export { DEFAULT_OVERVIEW_WIDTH_PX, DRAG_THRESHOLD_PX, TimelineOverview } from './timeline-overview.js';
export type { TimelineOverviewProps } from './timeline-overview.js';

export { InspectorPanel } from './inspector-panel.js';
export type { InspectorPanelProps } from './inspector-panel.js';

export { TrajectoryPanel } from './trajectory-panel.js';
export type { TrajectoryPanelProps } from './trajectory-panel.js';

export { HOVER_DETAIL_DELAY_MS, useHoverDetail } from './use-hover-detail.js';
export type { HoverDetail } from './use-hover-detail.js';

export {
  TRAJECTORY_OWNER,
  TRAJECTORY_VIEW_KEY,
  TRAJECTORY_VIEW_TITLE,
  TrajectoryViewContent,
  createTrajectoryViewDefinition,
  useComposerOverlayInset,
} from './trajectory-view.js';
export type { TrajectorySession, TrajectoryViewContentProps, TrajectoryViewOptions } from './trajectory-view.js';

export {
  COMPOSER_OVERLAY_GAP_PX,
  DEFAULT_COMPOSER_INSET_PX,
  TRAJECTORY_COMPOSER_INSET_VAR,
  composerInsetCssValue,
  composerOverlayInsetCss,
  composerOverlayInsetPx,
  composerOverlayStyle,
  createComposerOverlayHost,
  initialComposerOverlayState,
  overlayInsetFromHost,
  parseComposerInsetPx,
} from './shell-contract.js';
export type { ComposerOverlayHost, ComposerOverlayState, TrajectoryOverlayInset } from './shell-contract.js';
