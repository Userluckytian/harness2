// 侧栏几何（依据 refs-deepseek-harness.md D-11 / D-13）：
//   D-11 左栏可拖宽 264～420px，默认 280px；
//   D-13 收起后保留 56px 控制轨道（不是彻底消失）。
// 这些常量只描述侧栏自身的几何；拖拽手势与栅格轨道归 layout（A 棒装配层），
// 本模块只提供钳制函数，避免两处各写一份边界。

/** 收起态控制轨道宽度（D-13：收起后保留 56px 轨道） */
export const RAIL_WIDTH = 56;

/** 展开态最小宽度（D-11） */
export const SIDEBAR_MIN_WIDTH = 264;

/** 展开态最大宽度（D-11） */
export const SIDEBAR_MAX_WIDTH = 420;

/** 展开态默认宽度（D-11） */
export const SIDEBAR_DEFAULT_WIDTH = 280;

/**
 * 把任意输入宽度钳制进 D-11 的 264～420 区间。
 * 非有限数（NaN/Infinity/undefined 折算值）回落默认宽度——宁可给默认值，也不给 0 宽侧栏。
 */
export function clampSidebarWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
