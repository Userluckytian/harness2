// 帧状态 hook（Z2-01a / D-14）：几何/开合状态只存在 React state 里（不落盘、不写 storage）。
// 视口宽度与降动效偏好来自浏览器 API（渲染进程零 Node）。
// Z-15 自动收起：只在**窗口 resize 之后 idle 300ms** 判定（判定依据 = 会话列宽，不是视口宽）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SlotRegistry } from '../slots/index.js';
import {
  AUTO_COLLAPSE_RESIZE_IDLE_MS,
  computeFrameGeometry,
  resolveAutoCollapse,
  type FrameGeometry,
} from './geometry.js';
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

  // D-13（上游 setViewportWidth）：视口变化写回状态 —— 只记录测量值，
  // 不做阈值跨界重置（自动收起改由下面的 resize idle 判定，见 Z-15）。
  useEffect(() => {
    setState((prev) => applyFrameAction(prev, { type: 'viewport', viewportWidth }));
  }, [viewportWidth]);

  // Z-15 自动收起：窗口 resize（= 视口宽变化）后等 300ms idle 再判定。
  // 判定依据是**会话列宽**（geometry.main = 视口 − 侧栏 − 右栏），不是视口宽；
  // 顺序**先右栏（< 480）后左栏（< 360）**（resolveAutoCollapse）。
  // 刻意**不监听会话列自身 ResizeObserver**：否则用户手动展开右栏/左栏后，会话列一变窄
  // 就会被策略立刻关回去；只在窗口 resize 后判定，手动展开能保持到下一次拖窗口。
  // 挂载不算 resize：首帧不判定（与上游 WorkspaceShellLayout.tsx:447-533 的 resize 监听同口径）。
  const stateRef = useRef(state);
  stateRef.current = state;
  const autoCollapseTimerRef = useRef<number | null>(null);
  const lastViewportRef = useRef<number | null>(null);
  useEffect(() => {
    const previousViewport = lastViewportRef.current;
    lastViewportRef.current = state.viewportWidth;
    // 挂载（previousViewport === null）或视口未变：不判定 —— 首帧不自动收起
    if (previousViewport === null || previousViewport === state.viewportWidth) return;
    if (autoCollapseTimerRef.current !== null) window.clearTimeout(autoCollapseTimerRef.current);
    autoCollapseTimerRef.current = window.setTimeout(() => {
      autoCollapseTimerRef.current = null;
      const current = stateRef.current;
      const g = computeFrameGeometry({
        viewportWidth: current.viewportWidth,
        sidebarWidth: current.sidebarWidth,
        sidebarCollapsed: current.sidebarCollapsed,
        rightbarOpen: current.rightbarOpen,
        rightbarWidth: current.rightbarWidth,
        rightbarFullscreen: current.rightbarFullscreen,
      });
      const decision = resolveAutoCollapse({
        conversationWidth: g.main,
        rightbarOpen: current.rightbarOpen,
        rightbarWidth: g.rightbar,
        sidebarCollapsed: current.sidebarCollapsed,
      });
      if (decision.collapseRightbar) dispatch({ type: 'rightbar/collapse' });
      if (decision.collapseSidebar) dispatch({ type: 'sidebar/collapse' });
    }, AUTO_COLLAPSE_RESIZE_IDLE_MS);
    return () => {
      if (autoCollapseTimerRef.current !== null) {
        window.clearTimeout(autoCollapseTimerRef.current);
        autoCollapseTimerRef.current = null;
      }
    };
  }, [state.viewportWidth, dispatch]);

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
