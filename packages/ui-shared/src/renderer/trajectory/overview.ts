// 时间概览模型与交互（D-42/D-43）：纯逻辑，无 React/DOM。
//
// D-42：条带**左→右按真实开始时间投影**，宽度 = 真实耗时；助手条区分 TTFT 与解码段。
//   - 无结束时间（进行中）→ 点标记，条宽 0：**不虚构耗时**（D-47）；
//   - 有耗时但无首 token 观测 → 单段（`split: 'single'`），UI 标注 TTFT 未观测；
//   - 首 token 观测 + 结束时间都有 → 两段 `ttft` / `decode`。
// D-43 交互的状态机全部落在这里（缩放 / 平移 / 拖选 / 清除），组件只做事件→动作的翻译。
import type { TrajectoryModel, TrajectoryRow, TrajectoryStep, TrajectoryTiming } from './types.js';

export interface TimelineSegment {
  /** 稳定键（= 记录表行键，概览与记录表用同一语义键对齐） */
  readonly key: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'between-turns';
  readonly label: string;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly durationMs: number | null;
  readonly ttftMs: number | null;
  readonly decodeMs: number | null;
  /** 进行中：只有起点，没有宽度 */
  readonly running: boolean;
  /** 记录表中的行下标（点击概览可滚动/选中对应记录） */
  readonly rowIndex: number;
  /** 段形态：两段（TTFT+解码）/ 单段（总耗时）/ 点（无耗时） */
  readonly split: 'ttft-decode' | 'single' | 'point';
}

export interface TimeDomain {
  readonly startMs: number;
  readonly endMs: number;
}

export interface TimelineOverviewModel {
  readonly segments: readonly TimelineSegment[];
  /** 全部段的真实时间域；无任何时间信息 = null */
  readonly domain: TimeDomain | null;
}

function stepSegment(row: TrajectoryRow, rowIndex: number): TimelineSegment | null {
  if (row.kind === 'between-turns') {
    const timing = row.entry.timing;
    return {
      key: row.key,
      kind: 'between-turns',
      label: 'Compaction',
      startMs: timing.startedAtMs,
      endMs: timing.endedAtMs,
      durationMs: timing.durationMs,
      ttftMs: null,
      decodeMs: null,
      running: false,
      rowIndex,
      split: splitOf(timing),
    };
  }
  if (row.kind !== 'step') return null;
  const step: TrajectoryStep = row.step;
  const timing = step.timing;
  const kind: TimelineSegment['kind'] =
    step.role === 'user' ? 'user' : step.role === 'assistant' ? 'assistant' : 'tool';
  return {
    key: row.key,
    kind,
    label: step.label,
    startMs: timing.startedAtMs,
    endMs: timing.endedAtMs,
    durationMs: timing.durationMs,
    ttftMs: timing.ttftMs,
    decodeMs: timing.decodeMs,
    running: step.state === 'running',
    rowIndex,
    split: splitOf(timing),
  };
}

function splitOf(timing: TrajectoryTiming): TimelineSegment['split'] {
  if (timing.ttftMs !== null && timing.decodeMs !== null && timing.durationMs !== null) return 'ttft-decode';
  if (timing.durationMs !== null && timing.durationMs > 0) return 'single';
  return 'point';
}

/** 记录表行 → 概览段（跳过轮次分割线；顺序与记录表一致，供 rowIndex 对齐） */
export function buildOverview(model: TrajectoryModel): TimelineOverviewModel {
  const segments: TimelineSegment[] = [];
  model.rows.forEach((row, rowIndex) => {
    const segment = stepSegment(row, rowIndex);
    if (segment !== null) segments.push(segment);
  });
  return { segments, domain: computeDomain(segments) };
}

/** 时间域 = 全部真实时间戳的并集（只看有时间的段；无 → null） */
export function computeDomain(segments: readonly TimelineSegment[]): TimeDomain | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    if (segment.startMs !== null) {
      start = Math.min(start, segment.startMs);
      end = Math.max(end, segment.endMs ?? segment.startMs);
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // 单点域：给 1ms 宽度避免除零（不发明时间，只是显示刻度）
  return end > start ? { startMs: start, endMs: end } : { startMs: start, endMs: start + 1 };
}

// —— D-43 视口：缩放 / 平移 / 清除 ——

export interface OverviewViewport {
  /** 1 = 全量；>1 = 放大 */
  readonly zoom: number;
  /** 时间域左端相对基准域左端的偏移（ms）；仅 zoom>1 时有效 */
  readonly panMs: number;
}

export const INITIAL_OVERVIEW_VIEWPORT: OverviewViewport = { zoom: 1, panMs: 0 };
/** 滚轮每档缩放倍率（上滚放大 / 下滚缩小） */
export const WHEEL_ZOOM_FACTOR = 1.25;
export const MIN_OVERVIEW_ZOOM = 1;
export const MAX_OVERVIEW_ZOOM = 64;
/** 拖选小于该跨度视为单击（不是区间选择） */
export const MIN_SELECTION_SPAN_MS = 1;

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export function isZoomed(viewport: OverviewViewport): boolean {
  return viewport.zoom > MIN_OVERVIEW_ZOOM;
}

/** 视口 → 可见时间域（左端夹在基准域内，不会拖出基准范围） */
export function viewportDomain(base: TimeDomain, viewport: OverviewViewport): TimeDomain {
  const baseWidth = Math.max(1, base.endMs - base.startMs);
  const zoom = clamp(viewport.zoom, MIN_OVERVIEW_ZOOM, MAX_OVERVIEW_ZOOM);
  const width = baseWidth / zoom;
  const maxLeft = baseWidth - width;
  const left = clamp(viewport.panMs, 0, Math.max(0, maxLeft));
  return { startMs: base.startMs + left, endMs: base.startMs + left + width };
}

/** 滚轮缩放：以 anchorMs（指针所在时间）为锚点保持不动；deltaY=0 原样返回 */
export function wheelZoom(
  base: TimeDomain,
  viewport: OverviewViewport,
  deltaY: number,
  anchorMs: number,
): OverviewViewport {
  if (deltaY === 0) return viewport;
  const factor = deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
  const nextZoom = clamp(viewport.zoom * factor, MIN_OVERVIEW_ZOOM, MAX_OVERVIEW_ZOOM);
  if (nextZoom === viewport.zoom) return viewport;
  const before = viewportDomain(base, viewport);
  const beforeWidth = Math.max(1, before.endMs - before.startMs);
  const ratio = clamp((anchorMs - before.startMs) / beforeWidth, 0, 1);
  const baseWidth = Math.max(1, base.endMs - base.startMs);
  const nextWidth = baseWidth / nextZoom;
  const left = anchorMs - base.startMs - ratio * nextWidth;
  return { zoom: nextZoom, panMs: clamp(left, 0, Math.max(0, baseWidth - nextWidth)) };
}

/** 拖动平移（D-43：**放大后**右键拖动才有平移语义；未放大不产生位移） */
export function dragPan(base: TimeDomain, viewport: OverviewViewport, deltaMs: number): OverviewViewport {
  if (!isZoomed(viewport) || deltaMs === 0) return viewport;
  const baseWidth = Math.max(1, base.endMs - base.startMs);
  const width = baseWidth / clamp(viewport.zoom, MIN_OVERVIEW_ZOOM, MAX_OVERVIEW_ZOOM);
  const next = clamp(viewport.panMs + deltaMs, 0, Math.max(0, baseWidth - width));
  if (next === viewport.panMs) return viewport;
  return { zoom: viewport.zoom, panMs: next };
}

/** 右键清除（D-43）：回到全量视图 */
export function clearViewport(): OverviewViewport {
  return INITIAL_OVERVIEW_VIEWPORT;
}

// —— D-43 拖选区间过滤 ——

export interface OverviewSelection {
  readonly startMs: number;
  readonly endMs: number;
}

/** 规范化（保证 start<=end） */
export function orderedSelection(selection: OverviewSelection): OverviewSelection {
  return selection.startMs <= selection.endMs ? selection : { startMs: selection.endMs, endMs: selection.startMs };
}

/** 拖动起止 → 区间；跨度 < MIN_SELECTION_SPAN_MS 视为单击（返回 null） */
export function selectionFromDrag(startMs: number, endMs: number): OverviewSelection | null {
  if (Math.abs(endMs - startMs) < MIN_SELECTION_SPAN_MS) return null;
  return orderedSelection({ startMs, endMs });
}

/** 时间 → 概览比例（0..1，夹紧；域宽 0 视为 0） */
export function timeToRatio(domain: TimeDomain, ms: number | null): number {
  if (ms === null) return 0;
  const width = domain.endMs - domain.startMs;
  if (!(width > 0)) return 0;
  return clamp((ms - domain.startMs) / width, 0, 1);
}

/** 比例 → 时间（域宽 0 → 域起点） */
export function ratioToTime(domain: TimeDomain, ratio: number): number {
  return domain.startMs + clamp(ratio, 0, 1) * (domain.endMs - domain.startMs);
}

/** 指针像素偏移 → 时间（供点击/拖选换算；width<=0 时回落域起点） */
export function pixelToTimeMs(domain: TimeDomain, offsetPx: number, widthPx: number): number {
  if (!(widthPx > 0)) return domain.startMs;
  return ratioToTime(domain, offsetPx / widthPx);
}

/** 段的左偏移与宽度（占域百分比）；点段宽度 0 */
export function segmentExtent(
  segment: TimelineSegment,
  domain: TimeDomain,
): { leftPercent: number; widthPercent: number } {
  const leftPercent = timeToRatio(domain, segment.startMs) * 100;
  const endMs = segment.endMs ?? segment.startMs;
  const widthPercent = endMs === null ? 0 : Math.max(0, (timeToRatio(domain, endMs) - leftPercent / 100) * 100);
  return { leftPercent, widthPercent };
}

/** 段是否与选中区间相交（无时间的段不参与区间过滤 —— 无法证明它在区间内） */
export function segmentIntersects(segment: TimelineSegment, selection: OverviewSelection): boolean {
  if (segment.startMs === null) return false;
  const end = segment.endMs ?? segment.startMs;
  const range = orderedSelection(selection);
  return end >= range.startMs && segment.startMs <= range.endMs;
}

/** 区间过滤后的段集合（顺序不变） */
export function filterSegments(
  segments: readonly TimelineSegment[],
  selection: OverviewSelection | null,
): TimelineSegment[] {
  if (selection === null) return [...segments];
  return segments.filter((segment) => segmentIntersects(segment, selection));
}

/** 被区间过滤排除且**没有时间戳**的段数（UI 如实提示「N 条无时间记录未参与区间过滤」） */
export function untimedSegmentCount(segments: readonly TimelineSegment[], selection: OverviewSelection | null): number {
  if (selection === null) return 0;
  return segments.filter((segment) => segment.startMs === null).length;
}
