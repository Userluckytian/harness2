// 轨迹记录表虚拟化（D-45）：纯逻辑，无 React/DOM —— 组件只消费这里的窗口结果。
//
// 三条口径：
//   1. **挂载时尾部 50 个节点**：初始已物化区 = 末尾 `INITIAL_TAIL_ROWS`（列表默认停在最新记录）；
//   2. **按需前向补页**：可见窗口顶越过已物化区起点时，向前整页（`pageSize`）扩展；
//   3. **只挂可见窗口 + 缓冲**：DOM 里只出现 `[renderStart, renderEnd)`，其余用等高占位撑住
//      绝对位置；**语义行键与 ARIA 索引稳定** —— 键来自模型（`row.key`），ARIA 索引用
//      全局下标 + 1（与已挂载窗口无关，滚动不会让同一条记录换索引）。
import type { TrajectoryRow } from './types.js';

/** 初始挂载的尾部节点数（D-45 原文：尾部 50 个节点） */
export const INITIAL_TAIL_ROWS = 50;
/** 前向补页的页大小（与尾部初始量同档，便于断言） */
export const DEFAULT_PAGE_SIZE_ROWS = 50;
/** 可见窗口上下各多挂的缓冲行数 */
export const DEFAULT_OVERSCAN_ROWS = 8;
/** 记录表缺省行高（px）—— 虚拟化按固定行高计算，样式表必须与之保持一致 */
export const DEFAULT_ROW_HEIGHT_PX = 28;
/** 记录表缺省视口高度（px，布局测量缺失时的兜底；不用于伪装真实测量） */
export const DEFAULT_VIEWPORT_HEIGHT_PX = 480;

export interface RowWindowMetrics {
  readonly total: number;
  readonly rowHeightPx: number;
  readonly viewportHeightPx: number;
  readonly scrollTopPx: number;
  readonly overscan: number;
  readonly pageSize: number;
}

export interface RowWindow {
  /** 已物化数据区（含补页扩展）：[mountedStart, mountedEnd) */
  readonly mountedStart: number;
  readonly mountedEnd: number;
  /** 实际挂载 DOM 的行区间（可见窗口 ± overscan，∩ 已物化区） */
  readonly renderStart: number;
  readonly renderEnd: number;
  /** 可见窗口顶已越过物化起点 → 需要前向补页 */
  readonly needsPageIn: boolean;
  readonly loadedPages: number;
}

export function defaultMetrics(
  total: number,
  overrides: Partial<Omit<RowWindowMetrics, 'total'>> = {},
): RowWindowMetrics {
  return {
    total,
    rowHeightPx: overrides.rowHeightPx ?? DEFAULT_ROW_HEIGHT_PX,
    viewportHeightPx: overrides.viewportHeightPx ?? DEFAULT_VIEWPORT_HEIGHT_PX,
    scrollTopPx: overrides.scrollTopPx ?? 0,
    overscan: overrides.overscan ?? DEFAULT_OVERSCAN_ROWS,
    pageSize: overrides.pageSize ?? DEFAULT_PAGE_SIZE_ROWS,
  };
}

/** 初始滚动位置：停在列表底部（最新记录）—— 与「挂载时尾部 50 个节点」配套 */
export function initialScrollTopPx(metrics: RowWindowMetrics): number {
  const maxScroll = Math.max(0, metrics.total * metrics.rowHeightPx - metrics.viewportHeightPx);
  return maxScroll;
}

export function maxLoadedPages(metrics: RowWindowMetrics): number {
  if (metrics.total <= 0 || metrics.pageSize <= 0) return 0;
  return Math.ceil(metrics.total / metrics.pageSize) - 1;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function mountedStartFor(metrics: RowWindowMetrics, loadedPages: number): number {
  const pages = clamp(loadedPages, 0, maxLoadedPages(metrics));
  return Math.max(0, metrics.total - metrics.pageSize * (pages + 1));
}

function visibleRange(metrics: RowWindowMetrics): { start: number; end: number } {
  if (metrics.total <= 0 || metrics.rowHeightPx <= 0) return { start: 0, end: 0 };
  const start = clamp(Math.floor(metrics.scrollTopPx / metrics.rowHeightPx), 0, metrics.total);
  const end = clamp(
    Math.ceil((metrics.scrollTopPx + metrics.viewportHeightPx) / metrics.rowHeightPx),
    start,
    metrics.total,
  );
  return { start, end };
}

/** 计算窗口（纯函数；同一输入必得同一输出） */
export function computeRowWindow(metrics: RowWindowMetrics, loadedPages: number): RowWindow {
  const mountedStart = mountedStartFor(metrics, loadedPages);
  const mountedEnd = Math.max(0, metrics.total);
  const visible = visibleRange(metrics);
  const wantedStart = visible.start - metrics.overscan;
  const wantedEnd = visible.end + metrics.overscan;
  const renderStart = clamp(wantedStart, mountedStart, mountedEnd);
  const renderEnd = clamp(Math.max(wantedEnd, renderStart), renderStart, mountedEnd);
  return {
    mountedStart,
    mountedEnd,
    renderStart,
    renderEnd,
    // 可见窗口（含缓冲）顶越过物化起点 = 需要把更旧的记录补进来
    needsPageIn: mountedStart > 0 && wantedStart < mountedStart,
    loadedPages: clamp(loadedPages, 0, maxLoadedPages(metrics)),
  };
}

/**
 * 一次补足：把 loadedPages 提升到「覆盖当前可见窗口顶（含缓冲）」所需的最少页数。
 * 返回原值 = 无需补页（组件据此避免无意义 setState / 重渲染）。
 */
export function resolveLoadedPages(metrics: RowWindowMetrics, loadedPages: number): number {
  const mountedStart = mountedStartFor(metrics, loadedPages);
  const visible = visibleRange(metrics);
  const wantedStart = visible.start - metrics.overscan;
  if (!(mountedStart > 0 && wantedStart < mountedStart)) return loadedPages;
  if (metrics.pageSize <= 0) return loadedPages;
  const needed = Math.ceil((metrics.total - wantedStart) / metrics.pageSize) - 1;
  return clamp(Math.max(loadedPages, needed), 0, maxLoadedPages(metrics));
}

/** 顶部占位高度：让已挂载行落在正确的绝对位置（未物化区就是等高空白，不伪造内容） */
export function topSpacerPx(window: RowWindow, rowHeightPx: number): number {
  return window.renderStart * rowHeightPx;
}

export function bottomSpacerPx(window: RowWindow, rowHeightPx: number): number {
  return Math.max(0, window.mountedEnd - window.renderEnd) * rowHeightPx;
}

/** 本窗口实际要挂载的行下标（升序） */
export function mountedIndices(window: RowWindow): number[] {
  const out: number[] = [];
  for (let i = window.renderStart; i < window.renderEnd; i += 1) out.push(i);
  return out;
}

/** 语义行键（来自模型；越界返回 undefined，不合成假键） */
export function semanticRowKey(rows: readonly TrajectoryRow[], index: number): string | undefined {
  return rows[index]?.key;
}

export function rowKeys(rows: readonly TrajectoryRow[]): string[] {
  return rows.map((row) => row.key);
}

/** ARIA 行索引（1 起，全局稳定；与已挂载窗口无关） */
export function ariaRowIndexOf(index: number): number {
  return index + 1;
}

/** ARIA 行总数（= 模型行数，不是已挂载行数） */
export function ariaRowCountOf(rows: readonly TrajectoryRow[]): number {
  return rows.length;
}

/** 校验行键唯一（重复键会让虚拟化错位；装配前用断言暴露而不是静默渲染错行） */
export function assertUniqueRowKeys(rows: readonly TrajectoryRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) throw new Error(`轨迹行键重复：${row.key}`);
    seen.add(row.key);
  }
}
