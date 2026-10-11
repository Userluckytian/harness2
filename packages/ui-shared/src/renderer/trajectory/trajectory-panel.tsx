// 轨迹面板（呈现层装配）：时间概览 + 虚拟化记录表 + 局部检查器。
//
// 纯呈现：数据由 `TrajectoryModel` 传入（投影在 projection.ts），交互状态在本组件内。
// D-46：`composerInsetPx` 由壳注入（或读 CSS 变量）→ 记录表预留底部内边距。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionImageUrlResolver } from '../conversation/views/image-url-cache.js';
import { deriveInspectorForRow } from './inspector.js';
import './trajectory.css';
import { InspectorPanel } from './inspector-panel.js';
import {
  buildOverview,
  filterSegments,
  INITIAL_OVERVIEW_VIEWPORT,
  untimedSegmentCount,
  type OverviewSelection,
  type OverviewViewport,
} from './overview.js';
import { filterModelBySelection } from './projection.js';
import { RecordTable } from './record-table.js';
import { TimelineOverview } from './timeline-overview.js';
import { useHoverDetail } from './use-hover-detail.js';
import { BETWEEN_TURNS_LABEL, type TrajectoryModel, type TrajectoryRow } from './types.js';

export interface TrajectoryPanelProps {
  readonly model: TrajectoryModel;
  readonly imageUrl?: SessionImageUrlResolver;
  /** D-46：壳实测的 composer 浮层预留高度（px）；未注入时记录表读 CSS 变量 */
  readonly composerInsetPx?: number;
  /** P2-5：D-86 ② inspect 的定位目标行键（有则选中并滚动过去） */
  readonly focusKey?: string | null;
  readonly rowHeightPx?: number;
  readonly viewportHeightPx?: number;
  readonly overscan?: number;
  readonly pageSize?: number;
  readonly overviewWidthPx?: number;
}

export function TrajectoryPanel(props: TrajectoryPanelProps): ReactNode {
  const { model, imageUrl, composerInsetPx, rowHeightPx, viewportHeightPx, overscan, pageSize, overviewWidthPx } =
    props;
  const focusKey = props.focusKey ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewport, setViewport] = useState<OverviewViewport>(INITIAL_OVERVIEW_VIEWPORT);
  const [selection, setSelection] = useState<OverviewSelection | null>(null);
  const hover = useHoverDetail();

  const overview = useMemo(() => buildOverview(model), [model]);
  const visibleSegments = useMemo(() => filterSegments(overview.segments, selection), [overview.segments, selection]);
  const displayModel = useMemo(
    () => (selection === null ? model : filterModelBySelection(model, selection)),
    [model, selection],
  );

  const selectedRow: TrajectoryRow | undefined = useMemo(() => {
    if (selectedKey === null) return undefined;
    return model.rows.find((row) => row.key === selectedKey);
  }, [model.rows, selectedKey]);
  const inspectorView = useMemo(
    () => (selectedRow === undefined ? null : deriveInspectorForRow(selectedRow)),
    [selectedRow],
  );

  const handleSelectRow = useCallback((row: TrajectoryRow) => {
    if (row.kind === 'turn-boundary' || row.kind === 'between-turns-boundary') return; // 分割线不可选
    setSelectedKey(row.key);
  }, []);

  const handleSelectSegment = useCallback((key: string) => setSelectedKey(key), []);

  // P2-5：inspect 定位（D-86 ②）——目标行键变化时选中它；记录表另按同一键滚动过去。
  // 空键（未定位/找不到）不动用户当前选中。
  useEffect(() => {
    if (focusKey === null) return;
    setSelectedKey(focusKey);
  }, [focusKey]);

  if (model.rows.length === 0) {
    return (
      <section className="trajectory-panel" data-testid="trajectory-panel" data-empty="true">
        <p className="trajectory-empty">这个会话还没有可投影的事件（轨迹视图需要至少一条用户/助手/工具记录）</p>
      </section>
    );
  }

  const excludedUntimed = untimedSegmentCount(overview.segments, selection);

  return (
    <section
      className="trajectory-panel"
      data-testid="trajectory-panel"
      data-empty="false"
      data-turns={model.turns.length}
      data-rows={model.rows.length}
      data-between-turns={model.betweenTurns.length}
      data-running={model.hasRunningSteps}
      data-selection={selection !== null}
      data-composer-inset-px={composerInsetPx ?? ''}
    >
      <TimelineOverview
        segments={visibleSegments}
        baseDomain={overview.domain}
        viewport={viewport}
        selection={selection}
        revealedKey={hover.revealedKey}
        hoveredKey={hover.hoveredKey}
        selectedKey={selectedKey}
        onViewportChange={setViewport}
        onSelectionChange={setSelection}
        onHoverSegment={(key) => (key === null ? hover.leave() : hover.hover(key))}
        onSelectSegment={handleSelectSegment}
        {...(overviewWidthPx !== undefined ? { widthPx: overviewWidthPx } : {})}
      />
      {selection !== null && (
        <p className="trajectory-filter-note" data-testid="trajectory-filter-note">
          {`已按区间过滤：${displayModel.rows.length} / ${model.rows.length} 行`}
          {excludedUntimed > 0 ? `；${excludedUntimed} 条无时间戳记录不参与区间过滤` : ''}
        </p>
      )}
      <div className="trajectory-body">
        <RecordTable
          rows={displayModel.rows}
          selectedKey={selectedKey}
          scrollToKey={focusKey}
          onSelectRow={handleSelectRow}
          {...(rowHeightPx !== undefined ? { rowHeightPx } : {})}
          {...(viewportHeightPx !== undefined ? { viewportHeightPx } : {})}
          {...(overscan !== undefined ? { overscan } : {})}
          {...(pageSize !== undefined ? { pageSize } : {})}
          {...(composerInsetPx !== undefined ? { paddingBottomPx: composerInsetPx } : {})}
        />
        <InspectorPanel
          view={inspectorView}
          onClose={() => setSelectedKey(null)}
          {...(imageUrl !== undefined ? { imageUrl } : {})}
        />
      </div>
      {model.betweenTurns.length > 0 && (
        <p className="trajectory-between-note" data-testid="trajectory-between-note">
          {`${BETWEEN_TURNS_LABEL}：${model.betweenTurns.length} 条独立压缩请求`}
        </p>
      )}
    </section>
  );
}
