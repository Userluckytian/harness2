// 侧栏几何（依据 docs/refs/refs-zcode-layout.md Z-05 / Z-06 / §8）：
//   Z-05 左栏默认 264、最小 264、最大 = 容器 × 0.5、键盘步长 16；
//   Z-06 折叠后 4px（无图标轨道）。
// 这些常量只描述侧栏自身的几何；拖拽手势与栅格轨道归 layout（装配层），
// 本模块只提供钳制函数，避免两处各写一份边界。

/** 折叠态宽度（Z-05 / Z-06：桌面 4px，无图标轨道） */
export const SIDEBAR_COLLAPSED_WIDTH = 4;

/** 展开态最小宽度（Z-05：264） */
export const SIDEBAR_MIN_WIDTH = 264;

/** 展开态默认宽度（Z-05：264） */
export const SIDEBAR_DEFAULT_WIDTH = 264;

/** 展开态最大宽度比例（Z-05 / §8：容器 × 0.5） */
export const SIDEBAR_MAX_WIDTH_RATIO = 0.5;

/** 展开宽度上限 = 容器 × 0.5；容器宽未知/非正时只受下界约束（返回 +Infinity） */
export function sidebarMaxWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.round(containerWidth * SIDEBAR_MAX_WIDTH_RATIO));
}

/**
 * 把任意输入宽度钳制进 [264, 容器 × 0.5]。
 * 非有限数（NaN/Infinity/undefined 折算值）回落默认宽度——宁可给默认值，也不给 0 宽侧栏。
 * @param width - 偏好宽度。
 * @param containerWidth - 容器宽度（缺省不设上限）。
 */
export function clampSidebarWidth(width: number | undefined, containerWidth?: number): number {
  if (width === undefined || !Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  const max = sidebarMaxWidth(containerWidth ?? Number.POSITIVE_INFINITY);
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
