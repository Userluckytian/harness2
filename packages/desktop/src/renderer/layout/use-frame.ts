// 帧状态 hook（D-11～D-14）：几何/开合状态只存在 React state 里（不落盘、不写 storage）。
// 视口宽度与降动效偏好来自浏览器 API（渲染进程零 Node）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlotRegistry } from '../slots/index.js';
import { computeFrameGeometry, type FrameGeometry } from './geometry.js';
import {
  applyFrameAction,
  initialFrameState,
  isSidebarCollapsed,
  type FrameAction,
  type FrameState,
} from './frame-state.js';
import { prefersReducedMotion, resolveMatchMedia, REDUCED_MOTION_QUERY } from './theme-presenter.js';
import type { FrameController } from './frame-context.js';

/** 视口宽度（window.innerWidth + resize 监听；无 window 环境返回 0） */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    onResize(); // 挂载即校准（模块级初值可能早于窗口尺寸就绪）
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** 降动效偏好（D-16）：跟随 prefers-reduced-motion 变化 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    const mq = resolveMatchMedia()?.(REDUCED_MOTION_QUERY);
    if (mq === undefined || typeof mq.addEventListener !== 'function') return;
    const onChange = (): void => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export interface UseFrameOptions {
  registry: SlotRegistry;
  /** 显式视口宽（测试/宿主注入用）；缺省取 window.innerWidth 并跟随 resize */
  viewportWidth?: number;
}

/** 帧控制器：状态 + 几何 + 派发（D-14：每次挂载都从 initialFrameState 开始） */
export function useFrameState(opts: UseFrameOptions): FrameController {
  const measured = useViewportWidth();
  const viewportWidth = opts.viewportWidth ?? measured;
  const reducedMotion = useReducedMotion();
  // 首帧就用当前测量值建状态（上游 stores.ts:84 `viewportWidth: window.innerWidth`）：
  // 避免「首帧按宽屏算、effect 后才发现是窄屏」的一帧错位。
  const [state, setState] = useState<FrameState>(() =>
    applyFrameAction(initialFrameState(), { type: 'viewport', viewportWidth }),
  );

  const dispatch = useCallback((action: FrameAction): void => {
    setState((prev) => applyFrameAction(prev, action));
  }, []);

  // D-13（上游 setViewportWidth）：视口变化写回状态 —— 跨 1024 阈值双向重置窄屏 override，
  // 不写宽屏偏好（同宽重复测量在 reducer 里直接返回原状态引用，不发无意义渲染）。
  useEffect(() => {
    setState((prev) => applyFrameAction(prev, { type: 'viewport', viewportWidth }));
  }, [viewportWidth]);

  const geometry: FrameGeometry = useMemo(() => {
    const collapsed = isSidebarCollapsed(state);
    return computeFrameGeometry({
      viewportWidth: state.viewportWidth,
      sidebarWidth: state.sidebarWidth,
      sidebarCollapsed: collapsed,
      rightbarOpen: state.rightbarOpen,
      rightbarWidth: state.rightbarWidth,
      rightbarFullscreen: state.rightbarFullscreen,
    });
  }, [state]);

  return {
    state,
    geometry,
    registry: opts.registry,
    viewportWidth: state.viewportWidth,
    reducedMotion,
    dispatch,
  };
}
