// 时间概览模型与交互测试（D-42/D-43）：真实时间投影、TTFT/解码分段、缩放/平移/拖选/清除。
import { describe, expect, it } from 'vitest';
import { projectTrajectory } from '../../src/renderer/trajectory/projection.js';
import {
  INITIAL_OVERVIEW_VIEWPORT,
  MIN_OVERVIEW_ZOOM,
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
} from '../../src/renderer/trajectory/overview.js';
import { conversationFixture, firstOutputObservation, runningFixture, T0 } from './fixtures.js';

describe('buildOverview（D-42 左→右真实时间投影）', () => {
  it('段按记录表行顺序生成，rowIndex 对齐记录表行', () => {
    const model = projectTrajectory({ events: conversationFixture(), sessionId: 's' });
    const overview = buildOverview(model);
    model.rows.forEach((row, rowIndex) => {
      if (row.kind === 'turn-boundary') return;
      const segment = overview.segments.find((item) => item.key === row.key);
      expect(segment?.rowIndex).toBe(rowIndex);
    });
    // 轮次分割线不产生段
    expect(overview.segments).toHaveLength(model.rows.filter((row) => row.kind !== 'turn-boundary').length);
  });

  it('起点/结束来自真实事件时间戳，域 = 全部真实时间戳的并集', () => {
    const model = projectTrajectory({ events: conversationFixture(), sessionId: 's' });
    const overview = buildOverview(model);
    // 域两端都来自真实步骤时间戳（step/end 不是步骤，不参与）
    expect(overview.domain).toEqual({ startMs: T0 + 100, endMs: T0 + 3100 });
    const user = overview.segments.find((segment) => segment.kind === 'user');
    expect(user?.startMs).toBe(T0 + 100);
    // 用户消息是时间点：没有结束时间（不发明）
    expect(user?.endMs).toBeNull();
    expect(user?.durationMs).toBeNull();
    expect(user?.split).toBe('point');
  });

  it('助手条：有首 token 观测 → 两段（ttft-decode）；无观测 → 单段', () => {
    const withObs = buildOverview(
      projectTrajectory({ events: conversationFixture(), sessionId: 's', firstOutputAtMs: firstOutputObservation() }),
    );
    const assistant = withObs.segments.find((segment) => segment.kind === 'assistant');
    expect(assistant).toMatchObject({ split: 'ttft-decode', ttftMs: 100, decodeMs: 900, durationMs: 1000 });

    const noObs = buildOverview(projectTrajectory({ events: conversationFixture(), sessionId: 's' }));
    const single = noObs.segments.find((segment) => segment.kind === 'assistant');
    expect(single).toMatchObject({ split: 'single', ttftMs: null, decodeMs: null, durationMs: 1000 });
  });

  it('进行中的步骤只是点标记（不虚构宽度）', () => {
    const model = projectTrajectory({ events: runningFixture(), running: true, sessionId: 's' });
    const overview = buildOverview(model);
    const tool = overview.segments.find((segment) => segment.kind === 'tool');
    expect(tool).toMatchObject({ split: 'point', running: true, durationMs: null, startMs: T0 + 300 });
  });

  it('没有任何带时间的段 → domain 为 null（UI 显示「无法投影」）', () => {
    expect(computeDomain([])).toBeNull();
    const empty = buildOverview(projectTrajectory({ events: [], sessionId: 's' }));
    expect(empty.domain).toBeNull();
    expect(empty.segments).toEqual([]);
  });

  it('单点时间域给 1ms 宽度（避免除零，不发明时间）', () => {
    expect(
      computeDomain([
        {
          key: 'k',
          kind: 'user',
          label: '',
          startMs: 5,
          endMs: null,
          durationMs: null,
          ttftMs: null,
          decodeMs: null,
          running: false,
          rowIndex: 0,
          split: 'point',
        },
      ]),
    ).toEqual({ startMs: 5, endMs: 6 });
  });
});

describe('视口：缩放 / 平移 / 清除（D-43）', () => {
  const base = { startMs: 0, endMs: 1000 };

  it('zoom=1 时域 = 基准域；放大后宽度收窄', () => {
    expect(viewportDomain(base, INITIAL_OVERVIEW_VIEWPORT)).toEqual({ startMs: 0, endMs: 1000 });
    const zoomed = viewportDomain(base, { zoom: 2, panMs: 0 });
    expect(zoomed).toEqual({ startMs: 0, endMs: 500 });
  });

  it('滚轮上滚放大、下滚缩小，且以指针位置为锚点（timeAtPointer 不动）', () => {
    const viewport = wheelZoom(base, INITIAL_OVERVIEW_VIEWPORT, -100, 500);
    expect(viewport.zoom).toBeCloseTo(1.25, 10);
    const domain = viewportDomain(base, viewport);
    // 锚点 500ms 在缩放前后落在同一比例位置
    const ratioBefore = timeToRatio({ startMs: 0, endMs: 1000 }, 500);
    const ratioAfter = timeToRatio(domain, 500);
    expect(ratioAfter).toBeCloseTo(ratioBefore, 6);

    const out = wheelZoom(base, viewport, 100, 500);
    expect(out.zoom).toBeCloseTo(1, 10);
    expect(out.zoom).toBe(MIN_OVERVIEW_ZOOM);
  });

  it('deltaY=0 / 已到极限 → 返回原引用（避免无谓重渲染）', () => {
    expect(wheelZoom(base, INITIAL_OVERVIEW_VIEWPORT, 0, 500)).toBe(INITIAL_OVERVIEW_VIEWPORT);
    const atMin = { zoom: MIN_OVERVIEW_ZOOM, panMs: 0 };
    expect(wheelZoom(base, atMin, 120, 500)).toBe(atMin);
  });

  it('平移只在放大后生效，并被夹在基准域内', () => {
    expect(dragPan(base, INITIAL_OVERVIEW_VIEWPORT, 100)).toBe(INITIAL_OVERVIEW_VIEWPORT);
    expect(isZoomed(INITIAL_OVERVIEW_VIEWPORT)).toBe(false);
    const zoomed = { zoom: 2, panMs: 0 };
    expect(dragPan(base, zoomed, 100)).toEqual({ zoom: 2, panMs: 100 });
    // 往左拖出界 → 夹到 0；往右拖出界 → 夹到 1000-500=500
    expect(dragPan(base, zoomed, -100).panMs).toBe(0);
    expect(dragPan(base, zoomed, 9999).panMs).toBe(500);
    expect(isZoomed({ zoom: 2, panMs: 0 })).toBe(true);
  });

  it('右键清除 = 回到全量 + 清掉平移', () => {
    expect(clearViewport()).toEqual(INITIAL_OVERVIEW_VIEWPORT);
  });
});

describe('拖选区间过滤（D-43）', () => {
  it('跨度小于 1ms 视为单击 → null；否则规范化 start<=end', () => {
    expect(selectionFromDrag(100, 100)).toBeNull();
    expect(selectionFromDrag(100, 100.5)).toBeNull();
    expect(selectionFromDrag(200, 100)).toEqual({ startMs: 100, endMs: 200 });
    expect(orderedSelection({ startMs: 5, endMs: 1 })).toEqual({ startMs: 1, endMs: 5 });
  });

  it('像素 ↔ 时间换算', () => {
    const domain = { startMs: 1000, endMs: 2000 };
    expect(timeToRatio(domain, 1500)).toBeCloseTo(0.5, 10);
    expect(timeToRatio(domain, 9999)).toBe(1);
    expect(ratioToTime(domain, 0.25)).toBeCloseTo(1250, 10);
    expect(pixelToTimeMs(domain, 300, 600)).toBeCloseTo(1500, 10);
    expect(pixelToTimeMs(domain, 10, 0)).toBe(1000); // 宽度未知 → 回落域起点
  });

  it('段占域百分比：点段宽度 0', () => {
    const model = projectTrajectory({ events: conversationFixture(), sessionId: 's' });
    const overview = buildOverview(model);
    const domain = overview.domain;
    if (domain === null) throw new Error('夹具应有时间域');
    const user = overview.segments.find((segment) => segment.kind === 'user');
    const tool = overview.segments.find((segment) => segment.kind === 'tool');
    if (user === undefined || tool === undefined) throw new Error('夹具应有用户/工具段');
    expect(segmentExtent(user, domain).widthPercent).toBe(0);
    const toolExtent = segmentExtent(tool, domain);
    expect(toolExtent.widthPercent).toBeGreaterThan(0);
    expect(toolExtent.leftPercent).toBeGreaterThanOrEqual(0);
  });

  it('区间相交判定：无时间戳的段不算命中', () => {
    const segment = {
      key: 'k',
      kind: 'tool' as const,
      label: '',
      startMs: T0 + 100,
      endMs: T0 + 200,
      durationMs: 100,
      ttftMs: null,
      decodeMs: null,
      running: false,
      rowIndex: 0,
      split: 'single' as const,
    };
    expect(segmentIntersects(segment, { startMs: T0 + 150, endMs: T0 + 160 })).toBe(true);
    expect(segmentIntersects(segment, { startMs: T0 + 300, endMs: T0 + 400 })).toBe(false);
    expect(segmentIntersects({ ...segment, startMs: null }, { startMs: T0, endMs: T0 + 9999 })).toBe(false);
  });

  it('filterSegments + untimedSegmentCount：无时间记录被如实排除并计数', () => {
    const model = projectTrajectory({ events: conversationFixture(), sessionId: 's' });
    const overview = buildOverview(model);
    const selection = { startMs: T0 + 1250, endMs: T0 + 1350 };
    const kept = filterSegments(overview.segments, selection);
    expect(kept.map((segment) => segment.kind)).toEqual(['tool']);
    expect(filterSegments(overview.segments, null)).toEqual([...overview.segments]);
    // 夹具里没有无时间戳的段 → 计数为 0
    expect(untimedSegmentCount(overview.segments, selection)).toBe(0);
    const untimed = [{ ...overview.segments[0]!, startMs: null, endMs: null }];
    expect(untimedSegmentCount(untimed, selection)).toBe(1);
    expect(untimedSegmentCount(untimed, null)).toBe(0);
  });
});
