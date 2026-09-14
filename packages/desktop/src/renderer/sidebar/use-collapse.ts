// 收起动画状态机（D-22 的计时部分）：冻结展开宽度 → 落定切轨道布局 → 淘入。
// 冷启动即收起态：静态渲染轨道，不播动画（上游 figma 基线行为）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { RAIL_WIDTH, clampSidebarWidth } from './geometry.js';
import { collapsePhase, playsRailIn, settleDelayMs, type CollapsePhase } from './collapse.js';
import { useReducedMotion } from './use-reduced-motion.js';

export interface CollapseController {
  /** 当前相位：展开 / 淡出中 / 已是轨道 */
  phase: CollapsePhase;
  /** 是否渲染展开内容（轨道态只渲染图标列） */
  wide: boolean;
  /** 实时收起并落定后为 true：此时才播「淘入」动画 */
  railIn: boolean;
  /** 列的内联宽度（收起淡出期间保持冻结的展开宽度，避免滑动途中重排） */
  contentWidth: number;
  /** 当前是否降动效（D-16；外壳据此加状态类） */
  reducedMotion: boolean;
}

/**
 * 驱动收起相位与冻结宽度。
 * @param input - 是否收起与期望的展开宽度（D-11 264～420，越界自动钳制）。
 * @returns 相位、宽窄判定、淘入开关与内联宽度。
 */
export function useCollapse(input: { collapsed: boolean; width: number }): CollapseController {
  const reducedMotion = useReducedMotion();
  const [settledState, setSettledState] = useState(input.collapsed);
  // 落定值先过 ref 再 setState：同值不触发渲染（否则每次提交都会多渲染一轮）
  const settledRef = useRef(input.collapsed);
  const setSettled = useCallback((value: boolean): void => {
    if (settledRef.current === value) return;
    settledRef.current = value;
    setSettledState(value);
  }, []);
  // 冻结宽度只在展开时刷新：收起过程里沿用最后一次展开宽度（滑动 + 淡出不动版式）。
  const frozenWidth = useRef(clampSidebarWidth(input.width));
  const everExpanded = useRef(!input.collapsed);
  if (!input.collapsed) {
    frozenWidth.current = clampSidebarWidth(input.width);
    everExpanded.current = true;
  }

  useEffect(() => {
    if (!input.collapsed) {
      setSettled(false);
      return;
    }
    const delay = settleDelayMs(reducedMotion);
    if (delay <= 0) {
      setSettled(true);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), delay);
    return () => window.clearTimeout(timer);
  }, [input.collapsed, reducedMotion, setSettled]);

  const phase = collapsePhase({ collapsed: input.collapsed, settled: settledState });
  return {
    phase,
    wide: phase !== 'rail',
    railIn: playsRailIn(phase, everExpanded.current),
    contentWidth: phase === 'rail' ? RAIL_WIDTH : frozenWidth.current,
    reducedMotion,
  };
}
