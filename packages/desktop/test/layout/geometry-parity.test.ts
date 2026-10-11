// 跨棒几何常量一致守卫（防漂移）。
// A 棒 `layout/geometry.ts` 与 B 棒 `sidebar/geometry.ts` 各自写了一份侧栏几何常量
// （264 / 264 / 容器 50% / 折叠 4）——规格同源（Z-05 / Z-06 / §8），两处必须逐字一致：
// 帧算出的 4px 折叠宽若与侧栏自己渲染的折叠宽不同，折叠态就会「容器 4px / 内容另算」错位。
// 任一处改了常量，本用例先红。
import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_COLLAPSED_WIDTH as FRAME_SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT_WIDTH as FRAME_SIDEBAR_DEFAULT,
  SIDEBAR_MAX_WIDTH_RATIO as FRAME_SIDEBAR_MAX_RATIO,
  SIDEBAR_MIN_WIDTH as FRAME_SIDEBAR_MIN,
  clampWidth,
  computeFrameGeometry,
  sidebarMaxWidth as frameSidebarMaxWidth,
} from '@harness2/ui-shared/renderer/layout/geometry.js';
import {
  SIDEBAR_COLLAPSED_WIDTH as SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT_WIDTH as SIDEBAR_DEFAULT,
  SIDEBAR_MAX_WIDTH_RATIO as SIDEBAR_MAX_RATIO,
  SIDEBAR_MIN_WIDTH as SIDEBAR_MIN,
  clampSidebarWidth,
  sidebarMaxWidth as sidebarMaxWidthLocal,
} from '@harness2/ui-shared/renderer/sidebar/geometry.js';

/** 帧渲染出的侧栏宽度（与 scene 无关的最小入参） */
function frameSidebarWidth(sidebarWidth: number, sidebarCollapsed = false): number {
  return computeFrameGeometry({
    viewportWidth: 1400,
    sidebarWidth,
    sidebarCollapsed,
    rightbarOpen: false,
    rightbarWidth: null,
  }).sidebar;
}

describe('跨棒几何常量一致（layout/geometry.ts ↔ sidebar/geometry.ts）', () => {
  it('264 / 264 / 0.5 / 4 两处同值，且等于 Z-05 / Z-06 规格字面量', () => {
    expect({
      min: FRAME_SIDEBAR_MIN,
      default: FRAME_SIDEBAR_DEFAULT,
      maxRatio: FRAME_SIDEBAR_MAX_RATIO,
      collapsed: FRAME_SIDEBAR_COLLAPSED,
    }).toEqual({
      min: SIDEBAR_MIN,
      default: SIDEBAR_DEFAULT,
      maxRatio: SIDEBAR_MAX_RATIO,
      collapsed: SIDEBAR_COLLAPSED,
    });
    // 规格字面量锚点：即使两边被一起改成别的数（上面那条会一起变绿），这条仍会红
    expect([FRAME_SIDEBAR_MIN, FRAME_SIDEBAR_DEFAULT, FRAME_SIDEBAR_MAX_RATIO, FRAME_SIDEBAR_COLLAPSED]).toEqual([
      264, 264, 0.5, 4,
    ]);
    expect([SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX_RATIO, SIDEBAR_COLLAPSED]).toEqual([264, 264, 0.5, 4]);
  });

  it('上限求解同源：两处 sidebarMaxWidth 同值', () => {
    for (const containerWidth of [400, 1000, 1400, 2000, 0, Number.NaN]) {
      expect(frameSidebarMaxWidth(containerWidth)).toBe(sidebarMaxWidthLocal(containerWidth));
    }
  });

  it('钳制语义同源：展开宽度的区间内外取值一致（含小数取整）', () => {
    for (const width of [SIDEBAR_MIN, SIDEBAR_DEFAULT, 300.6, 699, 700, 100, 900]) {
      expect(clampWidth(width, FRAME_SIDEBAR_MIN, frameSidebarMaxWidth(1400))).toBe(clampSidebarWidth(width, 1400));
    }
  });

  it('非有限输入与折叠态的实际落点一致：NaN → 默认 264、折叠 → 4（不给 0 宽侧栏）', () => {
    // 注：裸函数 clampWidth 对 NaN 落到「下界」、clampSidebarWidth 落到「默认」——
    // 但 computeFrameGeometry 会先把非有限 sidebarWidth 归一为默认宽度再进 clampWidth
    //（见 layout/geometry.ts 的 preference），故**帧渲染路径**与侧栏自身口径一致。
    expect(frameSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    expect(frameSidebarWidth(Number.NaN)).toBe(clampSidebarWidth(Number.NaN, 1400));
    // 折叠态：帧容器宽度 = 侧栏折叠宽度 = 4px
    expect(frameSidebarWidth(300, true)).toBe(FRAME_SIDEBAR_COLLAPSED);
    expect(FRAME_SIDEBAR_COLLAPSED).toBe(SIDEBAR_COLLAPSED);
  });
});
