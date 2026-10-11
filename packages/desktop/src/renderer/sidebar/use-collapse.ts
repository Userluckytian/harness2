// 侧栏折叠状态（依据 docs/refs/refs-zcode-layout.md Z-06）：
//   折叠后只剩 4px，内容只隐藏不卸载（opacity-0 + pointer-events-none），无图标轨道。
//   展开内容始终按展开宽度排版（折叠时被 4px 容器裁切），避免收起途中重排。
import { useReducedMotion } from './use-reduced-motion.js';

export interface CollapseController {
  /** 是否折叠（透传；不持久化，刷新回展开） */
  collapsed: boolean;
  /** 内容排版宽度（始终为展开宽度；折叠时被容器裁切 + 透明） */
  contentWidth: number;
  /** 当前是否降动效（D-16；外壳据此加状态类） */
  reducedMotion: boolean;
}

/**
 * 侧栏折叠状态。
 * @param input - 是否折叠与期望的展开宽度（Z-05：264～容器 50%，越界由几何层钳制）。
 * @returns 折叠标记、内容宽度与降动效标记。
 */
export function useCollapse(input: { collapsed: boolean; width: number }): CollapseController {
  const reducedMotion = useReducedMotion();
  return { collapsed: input.collapsed, contentWidth: input.width, reducedMotion };
}
