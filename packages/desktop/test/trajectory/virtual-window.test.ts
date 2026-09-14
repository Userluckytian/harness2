// 虚拟化窗口测试（D-45）：尾部 50 / 前向补页 / 可见窗口 + 缓冲 / 稳定行键与 ARIA 索引。
import { describe, expect, it } from 'vitest';
import { projectTrajectory } from '../../src/renderer/trajectory/projection.js';
import {
  INITIAL_TAIL_ROWS,
  ariaRowCountOf,
  ariaRowIndexOf,
  assertUniqueRowKeys,
  computeRowWindow,
  defaultMetrics,
  initialScrollTopPx,
  maxLoadedPages,
  mountedIndices,
  resolveLoadedPages,
  rowKeys,
  semanticRowKey,
} from '../../src/renderer/trajectory/virtual-window.js';
import { conversationFixture, manyRowsFixture } from './fixtures.js';

const ROW_HEIGHT = 28;
const VIEWPORT = 480;

function metricsFor(total: number, scrollTopPx: number) {
  return defaultMetrics(total, { rowHeightPx: ROW_HEIGHT, viewportHeightPx: VIEWPORT, scrollTopPx });
}

describe('尾部 50（D-45 挂载口径）', () => {
  it('常量就是 50，且 0 页时物化区 = 末尾 50 行', () => {
    expect(INITIAL_TAIL_ROWS).toBe(50);
    const window = computeRowWindow(metricsFor(200, 0), 0);
    expect(window.mountedStart).toBe(150);
    expect(window.mountedEnd).toBe(200);
  });

  it('行数少于 50：物化全部行（不越界）', () => {
    const window = computeRowWindow(metricsFor(12, 0), 0);
    expect(window.mountedStart).toBe(0);
    expect(window.renderStart).toBe(0);
    expect(window.renderEnd).toBe(12);
    expect(window.needsPageIn).toBe(false);
  });
});

describe('可见窗口 + 缓冲（D-45 只挂可见窗口）', () => {
  it('默认停在底部：渲染窗口 = 可见窗口 ± 缓冲，且不超出物化区', () => {
    const total = 200;
    const top = initialScrollTopPx(metricsFor(total, 0));
    expect(top).toBe(total * ROW_HEIGHT - VIEWPORT); // 5600 - 480
    const window = computeRowWindow(metricsFor(total, top), 0);
    const visibleStart = Math.floor(top / ROW_HEIGHT); // 182
    const visibleEnd = Math.ceil((top + VIEWPORT) / ROW_HEIGHT); // 200
    expect(window.renderStart).toBe(Math.max(visibleStart - 8, window.mountedStart));
    expect(window.renderEnd).toBe(Math.min(visibleEnd + 8, window.mountedEnd));
    // 只挂可见 + 缓冲：DOM 行数 <= 可见行数 + 2*overscan
    expect(window.renderEnd - window.renderStart).toBeLessThanOrEqual(visibleEnd - visibleStart + 16);
    expect(window.renderEnd - window.renderStart).toBeLessThan(total);
  });

  it('mountedIndices 与窗口一致（升序、不含区间外）', () => {
    const window = computeRowWindow(metricsFor(200, 3000), 1);
    expect(window.renderEnd).toBeGreaterThan(window.renderStart);
    const indices = mountedIndices(window);
    expect(indices[0]).toBe(window.renderStart);
    expect(indices.at(-1)).toBe(window.renderEnd - 1);
    expect(indices).toHaveLength(window.renderEnd - window.renderStart);
  });

  it('空列表：窗口退化为零宽，不产生负高度', () => {
    const window = computeRowWindow(metricsFor(0, 0), 0);
    expect(window).toMatchObject({ mountedStart: 0, mountedEnd: 0, renderStart: 0, renderEnd: 0 });
  });
});

describe('按需前向补页（D-45）', () => {
  it('停底时不需要补页', () => {
    const total = 200;
    const top = initialScrollTopPx(metricsFor(total, 0));
    expect(computeRowWindow(metricsFor(total, top), 0).needsPageIn).toBe(false);
  });

  it('可见窗口顶越过物化起点 → needsPageIn，resolveLoadedPages 一次补足到覆盖', () => {
    const total = 200;
    const windowTop = computeRowWindow(metricsFor(total, 0), 0);
    expect(windowTop.needsPageIn).toBe(true);
    const pages = resolveLoadedPages(metricsFor(total, 0), 0);
    expect(pages).toBe(maxLoadedPages(metricsFor(total, 0))); // ceil(200/50)-1 = 3
    const paged = computeRowWindow(metricsFor(total, 0), pages);
    expect(paged.mountedStart).toBe(0);
    expect(paged.needsPageIn).toBe(false);
    expect(paged.renderStart).toBe(0);
  });

  it('补页是逐页语义：只回到需要的页数，不多补', () => {
    const total = 200;
    // 滚到第 100 行附近：可见顶 ~ 100-8=92 → 需要覆盖到 92 → 物化起点 <= 92
    const scrollTop = 100 * ROW_HEIGHT;
    const pages = resolveLoadedPages(metricsFor(total, scrollTop), 0);
    expect(pages).toBe(2); // 200 - 50*(2+1) = 50 <= 92
    const window = computeRowWindow(metricsFor(total, scrollTop), pages);
    expect(window.mountedStart).toBe(50);
    expect(window.needsPageIn).toBe(false);
    expect(window.loadedPages).toBe(2);
  });

  it('无需补页时 resolveLoadedPages 返回原值（同一数字，组件据此避免重渲染）', () => {
    const total = 200;
    const top = initialScrollTopPx(metricsFor(total, 0));
    expect(resolveLoadedPages(metricsFor(total, top), 0)).toBe(0);
  });

  it('loadedPages 上限受总行数约束（不会无限补页）', () => {
    expect(maxLoadedPages(defaultMetrics(120, { pageSize: 50 }))).toBe(2);
    expect(resolveLoadedPages(metricsFor(120, 0), 0)).toBe(2);
    expect(computeRowWindow(metricsFor(120, 0), 99).loadedPages).toBe(2);
  });
});

describe('稳定行键与 ARIA 索引（D-45）', () => {
  it('ARIA 索引 = 全局下标 + 1，与已挂载窗口无关', () => {
    expect(ariaRowIndexOf(0)).toBe(1);
    expect(ariaRowIndexOf(174)).toBe(175);
  });

  it('行键来自模型且唯一（重复键会被断言挡下，而不是静默错位）', () => {
    const model = projectTrajectory({ events: manyRowsFixture(20), sessionId: 's' });
    const keys = rowKeys(model.rows);
    expect(keys).toEqual(model.rows.map((row) => row.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(ariaRowCountOf(model.rows)).toBe(model.rows.length);
    expect(() => assertUniqueRowKeys(model.rows)).not.toThrow();
    expect(() =>
      assertUniqueRowKeys([
        { kind: 'between-turns-boundary', key: 'dup' },
        { kind: 'between-turns-boundary', key: 'dup' },
      ]),
    ).toThrow(/行键重复/);
  });

  it('同一行在物化边界两侧的全局下标恒定（补页不改变语义索引）', () => {
    const model = projectTrajectory({ events: manyRowsFixture(60), sessionId: 's' });
    const targetKey = model.rows[20]?.key;
    expect(semanticRowKey(model.rows, 20)).toBe(targetKey);
    // 已物化区起点不同时，同一键仍解析到同一下标
    const before = computeRowWindow(metricsFor(model.rows.length, 0), 0);
    const after = computeRowWindow(metricsFor(model.rows.length, 0), maxLoadedPages(metricsFor(model.rows.length, 0)));
    expect(before.mountedStart).toBeGreaterThan(after.mountedStart);
    expect(model.rows.findIndex((row) => row.key === targetKey)).toBe(20);
  });

  it('越界下标返回 undefined（不合成假键）', () => {
    const model = projectTrajectory({ events: conversationFixture(), sessionId: 's' });
    expect(semanticRowKey(model.rows, 999)).toBeUndefined();
  });
});
