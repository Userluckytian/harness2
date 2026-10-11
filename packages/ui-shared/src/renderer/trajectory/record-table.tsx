// 记录表（D-41 + D-45）：按轮次组织的虚拟化记录表。
//
// D-41：轮次边界 = **粗分割线**行；步骤 = **行内紧凑标记**（`#N` + 角色 + 工具/模型名 + Time 列）。
// D-45：虚拟化 —— 初始物化尾部 50、可见窗口顶越过物化起点时前向补页、只挂可见窗口 + 缓冲、
//        行键来自模型（`row.key`）且 ARIA 行索引用**全局下标**（滚动/补页不会让同一条记录换索引）。
// D-47：Time 列对未知耗时**留空**（进行中的行绝不显示「已耗时」）。浮层预留高度由
//        `paddingBottomPx`（D-46 契约）落实，保证最后一条记录不被 composer 浮层遮住。
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDurationMs, formatUsage } from './format.js';
import { roleLabel, stateLabel } from './inspector.js';
import { composerInsetCssValue } from './shell-contract.js';
import { BETWEEN_TURNS_LABEL, type TrajectoryRow } from './types.js';
import {
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_PAGE_SIZE_ROWS,
  DEFAULT_ROW_HEIGHT_PX,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  ariaRowCountOf,
  ariaRowIndexOf,
  bottomSpacerPx,
  computeRowWindow,
  defaultMetrics,
  initialScrollTopPx,
  resolveLoadedPages,
  topSpacerPx,
} from './virtual-window.js';

export interface RecordTableProps {
  readonly rows: readonly TrajectoryRow[];
  readonly selectedKey?: string | null;
  readonly onSelectRow?: (row: TrajectoryRow) => void;
  readonly onHoverRow?: (key: string | null) => void;
  /** 行高（px；样式表 `--trajectory-row-height` 必须与此一致） */
  readonly rowHeightPx?: number;
  /** 视口高度兜底（布局测量缺失时用；不用于冒充真实测量） */
  readonly viewportHeightPx?: number;
  readonly overscan?: number;
  readonly pageSize?: number;
  /** D-46：composer 浮层预留的底部内边距（px）；缺省读 CSS 变量 `--trajectory-composer-inset` */
  readonly paddingBottomPx?: number;
  /**
   * P2-5：定位到指定行键（D-86 ② inspect 带 `callId`/`seq`）——滚过去并补足物化页。
   * 只在该键**变化**时生效，不因新事件/重投影抢走用户的滚动位置。
   */
  readonly scrollToKey?: string | null;
  /** 区域标题（无障碍名） */
  readonly label?: string;
}

export function RecordTable(props: RecordTableProps): ReactNode {
  const {
    rows,
    selectedKey = null,
    onSelectRow,
    onHoverRow,
    rowHeightPx = DEFAULT_ROW_HEIGHT_PX,
    viewportHeightPx = DEFAULT_VIEWPORT_HEIGHT_PX,
    overscan = DEFAULT_OVERSCAN_ROWS,
    pageSize = DEFAULT_PAGE_SIZE_ROWS,
    label = '轨迹记录表',
  } = props;
  const focusKey = props.scrollToKey ?? null;
  // D-46：显式高度优先；未注入时读壳写的 CSS 变量（变量缺失 → 0px，不假装预留）
  const paddingBottom = props.paddingBottomPx !== undefined ? `${props.paddingBottomPx}px` : composerInsetCssValue;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTopPx, setScrollTopPx] = useState(0);
  const [measuredHeightPx, setMeasuredHeightPx] = useState<number | null>(null);
  /** 用户是否停在底部（新记录到达时贴底；用户往上滚则不动视野） */
  const stickRef = useRef(true);
  /** 挂载时的贴底目标（只算一次：渲染期纯计算） */
  const initialTopRef = useRef<number | null>(null);
  if (initialTopRef.current === null) {
    initialTopRef.current = initialScrollTopPx(
      defaultMetrics(rows.length, { rowHeightPx, viewportHeightPx, overscan, pageSize }),
    );
  }

  /**
   * P2-7（D-45 高视口）：初始物化窗口按**视口高度**算，而不是固定尾部 50 行。
   * 4K 全屏下可见区可能 > 50 × rowHeight，只挂尾部 50 会在视图顶部留下未物化空白
   * （且仅靠 onScroll 补页不能自愈：初始就没有可滚动的余量）。
   * 以「贴底滚动位 + 当前视口」求最少页数；仍保留 `onScroll` 的前向按需补页。
   */
  const [loadedPages, setLoadedPages] = useState(() =>
    resolveLoadedPages(
      defaultMetrics(rows.length, {
        rowHeightPx,
        viewportHeightPx,
        scrollTopPx: initialTopRef.current ?? 0,
        overscan,
        pageSize,
      }),
      0,
    ),
  );
  /** 最近一次已知滚动位（挂载/贴底/handleScroll 同步）——补页 effect 读它，避免读到首帧未写入的 state */
  const scrollTopRef = useRef<number>(initialTopRef.current);

  const effectiveViewportPx = measuredHeightPx !== null && measuredHeightPx > 0 ? measuredHeightPx : viewportHeightPx;
  const metrics = defaultMetrics(rows.length, {
    rowHeightPx,
    viewportHeightPx: effectiveViewportPx,
    scrollTopPx,
    overscan,
    pageSize,
  });
  const window = computeRowWindow(metrics, loadedPages);

  // 挂载：滚到底部（「挂载时尾部 50 个节点」的配套位置语义）
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const top = initialTopRef.current ?? 0;
    element.scrollTop = top;
    scrollTopRef.current = top;
    setScrollTopPx(top);
  }, []);

  // 布局测量（真实高度优先；无 ResizeObserver/无布局的环境退回 props 兜底）
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) return;
      const height = Math.round(entry.contentRect.height);
      setMeasuredHeightPx(height > 0 ? height : null);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 新记录到达：只有用户本来就在底部才贴底（否则不夺走阅读位置）
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || !stickRef.current) return;
    const top = initialScrollTopPx(defaultMetrics(rows.length, { rowHeightPx, viewportHeightPx: effectiveViewportPx }));
    if (element.scrollTop === top) return;
    element.scrollTop = top;
    scrollTopRef.current = top;
    setScrollTopPx(top);
    // 只在行数/视口变化时对齐
  }, [rows.length, rowHeightPx, effectiveViewportPx]);

  // P2-7：视口（实测/兜底 props）或行数变化后，按**当前滚动位**把物化窗口补足到覆盖可见区 + overscan。
  // 读 scrollTopRef（上面两个 effect 会先同步它），不读 state —— 否则首帧会误判「在顶部」而全量物化。
  useEffect(() => {
    const metricsNow = defaultMetrics(rows.length, {
      rowHeightPx,
      viewportHeightPx: effectiveViewportPx,
      scrollTopPx: scrollTopRef.current,
      overscan,
      pageSize,
    });
    setLoadedPages((pages) => resolveLoadedPages(metricsNow, pages));
  }, [rows.length, rowHeightPx, effectiveViewportPx, overscan, pageSize]);

  // P2-5：定位到指定行键（D-86 ② inspect 带 callId/seq）——滚过去并补足物化页。
  // 依赖只有 focusKey：模型重投影/新事件不得反复抢走用户的滚动位置。
  useEffect(() => {
    if (focusKey === null) return;
    const element = scrollRef.current;
    if (element === null) return;
    const index = rows.findIndex((row) => row.key === focusKey);
    if (index < 0) return;
    const top = Math.max(0, index * rowHeightPx - rowHeightPx * 2); // 上方留 2 行上下文
    element.scrollTop = top;
    scrollTopRef.current = top;
    setScrollTopPx(top);
    setLoadedPages((pages) =>
      resolveLoadedPages(
        defaultMetrics(rows.length, {
          rowHeightPx,
          viewportHeightPx: effectiveViewportPx,
          scrollTopPx: top,
          overscan,
          pageSize,
        }),
        pages,
      ),
    );
    const maxScroll = Math.max(0, rows.length * rowHeightPx - effectiveViewportPx);
    stickRef.current = maxScroll - top <= rowHeightPx * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const handleScroll = (element: HTMLDivElement): void => {
    const top = element.scrollTop;
    scrollTopRef.current = top;
    setScrollTopPx(top);
    const maxScroll = Math.max(0, rows.length * rowHeightPx - effectiveViewportPx);
    stickRef.current = maxScroll - top <= rowHeightPx * 2;
    const nextPages = resolveLoadedPages({ ...metrics, scrollTopPx: top }, loadedPages);
    if (nextPages !== loadedPages) setLoadedPages(nextPages);
  };

  const rowNodes: ReactNode[] = [];
  for (let index = window.renderStart; index < window.renderEnd; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    rowNodes.push(
      <RecordRow
        key={row.key}
        row={row}
        index={index}
        total={rows.length}
        selected={selectedKey !== null && row.key === selectedKey}
        {...(onSelectRow !== undefined ? { onSelect: onSelectRow } : {})}
        {...(onHoverRow !== undefined ? { onHoverRow } : {})}
      />,
    );
  }

  return (
    <div
      className="trajectory-records"
      role="grid"
      aria-label={label}
      aria-rowcount={ariaRowCountOf(rows)}
      data-testid="trajectory-records"
      data-mounted-start={window.renderStart}
      data-mounted-end={window.renderEnd}
      data-loaded-pages={window.loadedPages}
      data-materialized-start={window.mountedStart}
      data-row-total={rows.length}
    >
      <div
        ref={scrollRef}
        className="trajectory-records-scroll"
        data-testid="trajectory-records-scroll"
        style={{ height: `${effectiveViewportPx}px`, paddingBottom }}
        onScroll={(event) => handleScroll(event.currentTarget)}
      >
        <div className="trajectory-spacer" style={{ height: `${topSpacerPx(window, rowHeightPx)}px` }} aria-hidden />
        <div role="rowgroup">{rowNodes}</div>
        <div className="trajectory-spacer" style={{ height: `${bottomSpacerPx(window, rowHeightPx)}px` }} aria-hidden />
      </div>
    </div>
  );
}

interface RecordRowProps {
  readonly row: TrajectoryRow;
  readonly index: number;
  readonly total: number;
  readonly selected: boolean;
  readonly onSelect?: (row: TrajectoryRow) => void;
  readonly onHoverRow?: (key: string | null) => void;
}

function RecordRow({ row, index, total, selected, onSelect, onHoverRow }: RecordRowProps): ReactNode {
  const common = {
    role: 'row' as const,
    'aria-rowindex': ariaRowIndexOf(index),
    'aria-rowcount': total,
    'data-row-key': row.key,
    'data-row-index': index,
  };

  if (row.kind === 'turn-boundary') {
    const duration = formatDurationMs(row.turn.timing.durationMs);
    return (
      <div
        {...common}
        className={`trajectory-row trajectory-turn-boundary${selected ? ' is-selected' : ''}`}
        data-row-kind="turn-boundary"
        data-turn-index={row.turnIndex}
        data-running={row.turn.running}
      >
        <div role="gridcell" className="trajectory-turn-divider">
          <span className="trajectory-turn-label">{row.turn.label}</span>
          <span
            className="trajectory-turn-time"
            data-missing={duration.length === 0}
            title={duration.length === 0 ? '耗时未记录（轮次未结束或日志缺时间戳）' : undefined}
          >
            {duration}
          </span>
          <span className="trajectory-turn-usage">{formatUsage(row.turn.usage)}</span>
          {row.turn.running && <span className="trajectory-running-flag">进行中</span>}
        </div>
      </div>
    );
  }

  if (row.kind === 'between-turns-boundary') {
    return (
      <div {...common} className="trajectory-row trajectory-between-boundary" data-row-kind="between-turns-boundary">
        <div role="gridcell" className="trajectory-turn-divider trajectory-between-divider">
          <span className="trajectory-turn-label">{BETWEEN_TURNS_LABEL}</span>
          <span className="trajectory-between-hint">独立压缩请求</span>
        </div>
      </div>
    );
  }

  if (row.kind === 'between-turns') {
    const duration = formatDurationMs(row.entry.timing.durationMs);
    return (
      <div
        {...common}
        className={`trajectory-row trajectory-step${selected ? ' is-selected' : ''}`}
        data-row-kind="between-turns"
        data-role="between-turns"
        onClick={() => onSelect?.(row)}
        onMouseEnter={() => onHoverRow?.(row.key)}
        onMouseLeave={() => onHoverRow?.(null)}
      >
        <div role="gridcell" className="trajectory-step-cell">
          <span className="trajectory-step-marker">#0</span>
          <span className="trajectory-role-badge" data-role="between-turns">
            压缩
          </span>
          <span className="trajectory-step-label">{`覆盖 ≤ seq ${row.entry.coveredUpToSeq}`}</span>
          <span className="trajectory-step-text">{row.entry.summary}</span>
          <span className="trajectory-step-time" data-missing={duration.length === 0}>
            {duration}
          </span>
        </div>
      </div>
    );
  }

  const { step } = row;
  const duration = formatDurationMs(step.timing.durationMs);
  const canSelect = onSelect !== undefined;
  return (
    <div
      {...common}
      className={`trajectory-row trajectory-step${selected ? ' is-selected' : ''}`}
      data-row-kind="step"
      data-role={step.role}
      data-state={step.state}
      data-depth={step.depth}
      data-selected={selected}
      onClick={canSelect ? () => onSelect(row) : undefined}
      onMouseEnter={() => onHoverRow?.(row.key)}
      onMouseLeave={() => onHoverRow?.(null)}
    >
      <div role="gridcell" className="trajectory-step-cell" style={{ paddingLeft: `${step.depth * 14}px` }}>
        <span className="trajectory-step-marker" aria-label={`步骤 ${step.stepMarker}`}>
          {`#${step.stepMarker}`}
        </span>
        <span className="trajectory-role-badge" data-role={step.role}>
          {roleLabel(step.role, step.depth)}
        </span>
        <span className="trajectory-step-label">{step.label}</span>
        {step.state !== 'ok' && (
          <span className="trajectory-state-badge" data-state={step.state}>
            {stateLabel(step.state)}
          </span>
        )}
        {step.attachments.length > 0 && (
          <span className="trajectory-attach-badge" title="附件摘要见检查器">
            {`附件 ${step.attachments.length}`}
          </span>
        )}
        {step.text !== undefined && step.text.length > 0 && (
          <span className="trajectory-step-text">{step.text.replace(/\s+/g, ' ')}</span>
        )}
        {/* D-47：耗时未知（含进行中）时该列留空，仅留可断言的状态标记 */}
        <span className="trajectory-step-time" data-missing={duration.length === 0} title="Time">
          {duration}
        </span>
      </div>
    </div>
  );
}
