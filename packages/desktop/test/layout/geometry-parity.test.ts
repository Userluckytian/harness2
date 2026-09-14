// 跨棒几何常量一致守卫（P4-② ③，防漂移）。
// A 棒 `layout/geometry.ts` 与 B 棒 `sidebar/geometry.ts` 各自写了一份侧栏几何常量
// （264 / 280 / 420 / 56）——这是 P4 三棒并行留下的重复，规格同源（D-11 / D-13），
// 两处必须逐字一致：帧算出的 56px 轨道若与侧栏自己渲染的轨道宽度不同，收起态就会
// 「容器 56px / 内容 58px」错位（帧与会话列各算一份）。任一处改了常量，本用例先红。
import { describe, expect, it } from 'vitest';
import {
  clampWidth,
  computeFrameGeometry,
  SIDEBAR_DEFAULT_WIDTH as FRAME_SIDEBAR_DEFAULT,
  SIDEBAR_MAX_WIDTH as FRAME_SIDEBAR_MAX,
  SIDEBAR_MIN_WIDTH as FRAME_SIDEBAR_MIN,
  SIDEBAR_RAIL_WIDTH as FRAME_SIDEBAR_RAIL,
} from '../../src/renderer/layout/geometry.js';
import {
  clampSidebarWidth,
  RAIL_WIDTH as SIDEBAR_RAIL,
  SIDEBAR_DEFAULT_WIDTH as SIDEBAR_DEFAULT,
  SIDEBAR_MAX_WIDTH as SIDEBAR_MAX,
  SIDEBAR_MIN_WIDTH as SIDEBAR_MIN,
} from '../../src/renderer/sidebar/geometry.js';

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
  it('264 / 280 / 420 / 56 两处同值，且等于 D-11 / D-13 规格字面量', () => {
    // 两处同值：同名常量逐一对齐（layout 的 SIDEBAR_RAIL_WIDTH ↔ sidebar 的 RAIL_WIDTH）
    expect({
      min: FRAME_SIDEBAR_MIN,
      max: FRAME_SIDEBAR_MAX,
      default: FRAME_SIDEBAR_DEFAULT,
      rail: FRAME_SIDEBAR_RAIL,
    }).toEqual({ min: SIDEBAR_MIN, max: SIDEBAR_MAX, default: SIDEBAR_DEFAULT, rail: SIDEBAR_RAIL });
    // 规格字面量锚点：即使两边被一起改成别的数（上面那条会一起变绿），这条仍会红
    expect([FRAME_SIDEBAR_MIN, FRAME_SIDEBAR_MAX, FRAME_SIDEBAR_DEFAULT, FRAME_SIDEBAR_RAIL]).toEqual([
      264, 420, 280, 56,
    ]);
    expect([SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, SIDEBAR_RAIL]).toEqual([264, 420, 280, 56]);
  });

  it('钳制语义同源：展开宽度的区间内外取值一致（含小数取整）', () => {
    for (const width of [SIDEBAR_MIN, SIDEBAR_DEFAULT, 300.6, SIDEBAR_MAX, 100, 900]) {
      expect(clampWidth(width, FRAME_SIDEBAR_MIN, FRAME_SIDEBAR_MAX)).toBe(clampSidebarWidth(width));
    }
  });

  it('非有限输入与收起态的实际落点一致：NaN → 默认 280、收起 → 56（不给 0 宽侧栏）', () => {
    // 注：裸函数 clampWidth 对 NaN 落到「下界」、clampSidebarWidth 落到「默认」——
    // 但 computeFrameGeometry 会先把非有限 sidebarWidth 归一为默认宽度再进 clampWidth
    //（见 layout/geometry.ts 的 insufficient），故**帧渲染路径**与侧栏自身口径一致。
    expect(frameSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
    expect(frameSidebarWidth(Number.NaN)).toBe(clampSidebarWidth(Number.NaN));
    // 收起态：帧容器宽度 = 侧栏内容宽度 = 56px
    expect(frameSidebarWidth(300, true)).toBe(FRAME_SIDEBAR_RAIL);
    expect(FRAME_SIDEBAR_RAIL).toBe(SIDEBAR_RAIL);
  });
});
