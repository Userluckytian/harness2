// 收起动画相位（依据 refs-deepseek-harness.md D-22 + D-16）：
//   收起 = 展开内容在当前宽度「淘出」（冻结展开宽度就地淡出），随即「淘入」：
//   剩余控件向左位移进 56px 轨道；`prefers-reduced-motion` 时禁用两段过渡。
//   冷启动即收起态静态渲染轨道（不播动画）；只有实时收起才播。
// 纯函数描述相位与类名；计时与 matchMedia 在 hook 层（use-collapse.ts）。

/** 展开内容淡出时长，也是「冻结宽度 → 轨道布局」的落定时刻（ms） */
export const COLLAPSE_SETTLE_MS = 150;

/** 收起动画相位：展开 / 正在收起（冻结宽度淡出中）/ 已是轨道 */
export type CollapsePhase = 'expanded' | 'collapsing' | 'rail';

/**
 * 由（是否收起，是否已落定）推相位。
 * 收起但未落定 = 正在收起：此时内容仍按冻结的展开宽度排版、只做淡出，
 * 避免滑动途中重排（上游 figma 基线行为）。
 */
export function collapsePhase(input: { collapsed: boolean; settled: boolean }): CollapsePhase {
  if (!input.collapsed) return 'expanded';
  return input.settled ? 'rail' : 'collapsing';
}

/**
 * 落定延迟：常规 150ms（等淡出结束再切轨道布局）；
 * 降动效（prefers-reduced-motion）下 0ms——即时落定，不排队等一个看不见的过渡。
 */
export function settleDelayMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : COLLAPSE_SETTLE_MS;
}

/**
 * 实时收起才播「淘入」动画：冷启动即轨道态（从未展开过）不播。
 * @param phase - 当前相位。
 * @param everExpanded - 本次挂载内是否出现过展开态。
 */
export function playsRailIn(phase: CollapsePhase, everExpanded: boolean): boolean {
  return phase === 'rail' && everExpanded;
}

/** 侧栏根节点的状态类名（顺序稳定，便于测试与快照） */
export interface SidebarClassInput {
  phase: CollapsePhase;
  /** 轨道「淘入」动画是否生效（playsRailIn） */
  railIn: boolean;
  /** 滚动条是否处于静默（D-24：指针不在栏内） */
  quietBars: boolean;
  /** 降动效（D-16）：类名给 CSS 兜底，行为分支由 settleDelayMs 决定 */
  reducedMotion: boolean;
}

/** 状态类名列表（不含布局类名与调用方追加的 className） */
export function sidebarStateClasses(input: SidebarClassInput): string[] {
  return [
    ...(input.phase === 'rail' ? ['h2-sidebar-rail'] : []),
    ...(input.phase === 'collapsing' ? ['h2-sidebar-fading'] : []),
    ...(input.railIn ? ['h2-sidebar-rail-in'] : []),
    ...(input.quietBars ? ['h2-sidebar-quiet'] : []),
    ...(input.reducedMotion ? ['h2-sidebar-reduced-motion'] : []),
  ];
}
