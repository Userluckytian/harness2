// 时间概览（D-42 + D-43）：真实开始时间/耗时的左→右投影 + 全套交互。
//
// D-42：条带按真实时间投影；助手条在**有首 token 观测**时分成 TTFT / 解码两段，
//        否则画单段（`data-split=single`，提示「TTFT 未观测」），绝不估算 Split。
// D-43：悬停 500ms 出详情（揭示状态由父级 `useHoverDetail` 提供）、拖选区间过滤、
//        滚轮缩放（指针位置为锚点）、右键清除、放大后右键拖动平移。
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react';
import { formatClock, formatDurationMs } from './format.js';
import {
  clearViewport,
  dragPan,
  isZoomed,
  MIN_OVERVIEW_ZOOM,
  pixelToTimeMs,
  segmentExtent,
  selectionFromDrag,
  viewportDomain,
  wheelZoom,
  type OverviewSelection,
  type OverviewViewport,
  type TimeDomain,
  type TimelineSegment,
} from './overview.js';

/** 概览轨道缺省宽度（px；布局不可测量时的换算基准，不用于伪装真实测量） */
export const DEFAULT_OVERVIEW_WIDTH_PX = 600;
/** 判定「拖动」而非「单击」的像素阈值 */
export const DRAG_THRESHOLD_PX = 3;

export interface TimelineOverviewProps {
  readonly segments: readonly TimelineSegment[];
  /** 基准时间域（未经缩放）；null = 没有任何带时间的记录 → 不渲染概览 */
  readonly baseDomain: TimeDomain | null;
  readonly viewport: OverviewViewport;
  readonly selection: OverviewSelection | null;
  /** 悬停 500ms 后应显示详情的段键（null = 不显示） */
  readonly revealedKey: string | null;
  readonly hoveredKey?: string | null;
  readonly selectedKey?: string | null;
  readonly onViewportChange: (viewport: OverviewViewport) => void;
  readonly onSelectionChange: (selection: OverviewSelection | null) => void;
  readonly onHoverSegment: (key: string | null) => void;
  readonly onSelectSegment?: (key: string) => void;
  readonly widthPx?: number;
}

interface DragState {
  readonly startMs: number;
  readonly startClientX: number;
  moved: boolean;
}

export function TimelineOverview(props: TimelineOverviewProps): ReactNode {
  const {
    segments,
    baseDomain,
    viewport,
    selection,
    revealedKey,
    hoveredKey = null,
    selectedKey = null,
    onViewportChange,
    onSelectionChange,
    onHoverSegment,
    onSelectSegment,
    widthPx = DEFAULT_OVERVIEW_WIDTH_PX,
  } = props;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rightDragRef = useRef<DragState | null>(null);
  const [trackWidthPx, setTrackWidthPx] = useState(widthPx);

  useEffect(() => {
    const element = trackRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) return;
      const width = Math.round(entry.contentRect.width);
      if (width > 0) setTrackWidthPx(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (baseDomain === null) {
    return (
      <div
        className="trajectory-overview trajectory-overview-empty"
        data-testid="trajectory-overview"
        data-empty="true"
      >
        <p className="trajectory-overview-empty-text">没有带真实时间戳的记录，无法投影时间概览</p>
      </div>
    );
  }

  const domain = viewportDomain(baseDomain, viewport);
  const domainWidthMs = Math.max(1, domain.endMs - domain.startMs);

  const timeAtClientX = (clientX: number): number => {
    const element = trackRef.current;
    const rect = element?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const width = rect !== undefined && rect.width > 0 ? rect.width : trackWidthPx;
    return pixelToTimeMs(domain, clientX - left, width);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const anchorMs = timeAtClientX(event.clientX);
    const next = wheelZoom(baseDomain, viewport, event.deltaY, anchorMs);
    if (next !== viewport) onViewportChange(next);
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button === 0) {
      dragRef.current = { startMs: timeAtClientX(event.clientX), startClientX: event.clientX, moved: false };
    } else if (event.button === 2) {
      // 右键：可能是「放大后拖动平移」，也可能是「清除」——按下时先起手，抬起/菜单时判定
      rightDragRef.current = { startMs: timeAtClientX(event.clientX), startClientX: event.clientX, moved: false };
      event.preventDefault();
    }
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag !== null && (event.buttons & 1) !== 0) {
      if (Math.abs(event.clientX - drag.startClientX) > DRAG_THRESHOLD_PX) drag.moved = true;
      const currentMs = timeAtClientX(event.clientX);
      onSelectionChange(selectionFromDrag(drag.startMs, currentMs));
      return;
    }
    const rightDrag = rightDragRef.current;
    if (rightDrag !== null && (event.buttons & 2) !== 0) {
      const deltaPx = event.clientX - rightDrag.startClientX;
      if (Math.abs(deltaPx) > DRAG_THRESHOLD_PX) rightDrag.moved = true;
      // 像素 → 时间：向右拖 = 时间域左移（内容右移）
      const deltaMs = -(deltaPx / Math.max(1, trackWidthPx)) * domainWidthMs;
      const next = dragPan(baseDomain, viewport, deltaMs);
      if (next !== viewport) onViewportChange(next);
    }
  };

  const handleMouseUp = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    // 未拖动 = 单击；只有点在轨道空白处才清除区间（点条带 = 选中该记录）
    if (!drag.moved && event.target === event.currentTarget) onSelectionChange(null);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault(); // 不弹宿主菜单：右键在本视图是「清除」
    const rightDrag = rightDragRef.current;
    rightDragRef.current = null;
    if (rightDrag !== null && rightDrag.moved) return; // 刚才那下是平移手势，不清除
    onSelectionChange(null);
    onViewportChange(clearViewport());
  };

  const revealed = revealedKey === null ? undefined : segments.find((segment) => segment.key === revealedKey);

  return (
    <div
      className="trajectory-overview"
      data-testid="trajectory-overview"
      data-zoom={viewport.zoom}
      data-pan-ms={viewport.panMs}
      data-selection-start={selection?.startMs ?? ''}
      data-selection-end={selection?.endMs ?? ''}
      data-revealed-key={revealedKey ?? ''}
      data-zoomed={isZoomed(viewport)}
    >
      <div className="trajectory-overview-hint">
        <span>滚轮缩放</span>
        <span>拖选区间过滤</span>
        <span>右键清除</span>
        <span>放大后右键拖动平移</span>
      </div>
      <div
        ref={trackRef}
        className="trajectory-overview-track"
        data-testid="trajectory-overview-track"
        role="list"
        aria-label="时间概览"
        style={{ height: `${Math.max(1, segments.length) * OVERVIEW_ROW_HEIGHT_PX}px` }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => onHoverSegment(null)}
        onContextMenu={handleContextMenu}
      >
        {selection !== null && (
          <div
            className="trajectory-overview-selection"
            data-testid="trajectory-overview-selection"
            style={{
              left: `${extent(domain, selection.startMs).leftPercent}%`,
              width: `${Math.max(
                0,
                extent(domain, selection.endMs).leftPercent - extent(domain, selection.startMs).leftPercent,
              )}%`,
            }}
          />
        )}
        {segments.map((segment, index) => (
          <OverviewBar
            key={segment.key}
            segment={segment}
            domain={domain}
            topPx={index * OVERVIEW_ROW_HEIGHT_PX}
            hovered={hoveredKey === segment.key}
            selected={selectedKey === segment.key}
            onHoverSegment={onHoverSegment}
            {...(onSelectSegment !== undefined ? { onSelectSegment } : {})}
          />
        ))}
      </div>
      {revealed !== undefined && (
        <div className="trajectory-overview-detail" data-testid="trajectory-overview-detail" role="tooltip">
          <span className="trajectory-overview-detail-title">{revealed.label}</span>
          <span>{`开始 ${formatClock(revealed.startMs) || '未记录'}`}</span>
          <span>{`耗时 ${formatDurationMs(revealed.durationMs) || '未记录'}`}</span>
          {revealed.kind === 'assistant' && (
            <span>{`TTFT ${formatDurationMs(revealed.ttftMs) || '未观测'} / 解码 ${
              formatDurationMs(revealed.decodeMs) || '未观测'
            }`}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 概览每段占一行（多轨投影：轮次/步骤重叠时可读） */
export const OVERVIEW_ROW_HEIGHT_PX = 10;

function extent(domain: TimeDomain, ms: number): { leftPercent: number; widthPercent: number } {
  const width = Math.max(1, domain.endMs - domain.startMs);
  return { leftPercent: ((ms - domain.startMs) / width) * 100, widthPercent: 0 };
}

interface OverviewBarProps {
  readonly segment: TimelineSegment;
  readonly domain: TimeDomain;
  readonly topPx: number;
  readonly hovered: boolean;
  readonly selected: boolean;
  readonly onHoverSegment: (key: string | null) => void;
  readonly onSelectSegment?: (key: string) => void;
}

function OverviewBar({
  segment,
  domain,
  topPx,
  hovered,
  selected,
  onHoverSegment,
  onSelectSegment,
}: OverviewBarProps): ReactNode {
  const { leftPercent, widthPercent } = segmentExtent(segment, domain);
  const isPoint = segment.split === 'point';
  return (
    <div
      className={`trajectory-overview-bar is-${segment.kind}${hovered ? ' is-hovered' : ''}${
        selected ? ' is-selected' : ''
      }${isPoint ? ' is-point' : ''}`}
      role="listitem"
      data-testid="trajectory-overview-bar"
      data-segment-key={segment.key}
      data-segment-kind={segment.kind}
      data-split={segment.split}
      data-start-ms={segment.startMs ?? ''}
      data-end-ms={segment.endMs ?? ''}
      data-duration-ms={segment.durationMs ?? ''}
      data-ttft-ms={segment.ttftMs ?? ''}
      data-decode-ms={segment.decodeMs ?? ''}
      data-running={segment.running}
      style={{ left: `${leftPercent}%`, width: `${isPoint ? 0 : widthPercent}%`, top: `${topPx}px` }}
      aria-label={barLabel(segment)}
      onMouseEnter={() => onHoverSegment(segment.key)}
      onMouseLeave={() => onHoverSegment(null)}
      onClick={
        onSelectSegment !== undefined
          ? (event) => {
              event.stopPropagation();
              onSelectSegment(segment.key);
            }
          : undefined
      }
    >
      {segment.split === 'ttft-decode' ? (
        <>
          <span
            className="trajectory-overview-seg is-ttft"
            data-testid="trajectory-overview-ttft"
            // TTFT 段占整条的比例 = ttft/总耗时；换算成轨道百分比即 × widthPercent
            style={{ width: `${ratio(segment.ttftMs, segment.durationMs) * widthPercent}%` }}
          />
          <span className="trajectory-overview-seg is-decode" data-testid="trajectory-overview-decode" />
        </>
      ) : (
        <span className={`trajectory-overview-seg is-${segment.split}`} />
      )}
    </div>
  );
}

function ratio(part: number | null, total: number | null): number {
  if (part === null || total === null || total <= 0) return 0;
  return Math.max(0, Math.min(1, part / total));
}

function barLabel(segment: TimelineSegment): string {
  const parts = [`${segment.kind} ${segment.label}`];
  parts.push(`开始 ${formatClock(segment.startMs) || '未记录'}`);
  parts.push(`耗时 ${formatDurationMs(segment.durationMs) || '未记录'}`);
  if (segment.kind === 'assistant') {
    parts.push(`TTFT ${formatDurationMs(segment.ttftMs) || '未观测'}`);
    parts.push(`解码 ${formatDurationMs(segment.decodeMs) || '未观测'}`);
  }
  return parts.join(' · ');
}

/** 供测试/调试：当前最小缩放（1 = 全量） */
export { MIN_OVERVIEW_ZOOM };
