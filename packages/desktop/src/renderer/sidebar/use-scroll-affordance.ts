// D-24 的副作用层：指针是否在列内（含离开后 2 秒滞留）+ 内层滚动容器是否真的溢出。
// 判定逻辑全在 scroll-affordance.ts 的纯函数里，本 hook 只负责：
//   1) 用指针坐标对列矩形做几何判定（栏内嵌套固定浮层时 DOM 包含关系会骗人）；
//   2) 计时器的启动/取消与卸载清理；
//   3) 溢出测量（滚动容器与观察器都放 ref：登记容器不该额外触发一轮渲染）。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SCROLLBAR_LINGER_MS,
  armsLingerTimer,
  initialAffordanceState,
  isOverflowing,
  reduceScrollAffordance,
  scrollAffordance,
  type ScrollAffordanceEvent,
} from './scroll-affordance.js';

export interface ScrollAffordanceController {
  /** 滑块结论（'quiet' = 不画） */
  status: 'drawn' | 'quiet';
  /** 已登记的滚动容器当前是否溢出 */
  overflowing: boolean;
  /** 指针进出列的处理器（挂在列根节点） */
  handlers: { onPointerEnter: () => void; onPointerLeave: () => void };
  /** 区域席位把内部滚动容器登记给外壳（D-24 的溢出判定对象） */
  registerRegion: (element: HTMLElement | null) => void;
}

/** ResizeObserver 的存在性防护（jsdom 无此 API） */
function observeResize(element: HTMLElement, onResize: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  const observer = new ResizeObserver(() => onResize());
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * 跟踪指针与滚动容器，给出滑块是否绘制。
 * @param containerRef - 列根节点（几何判定对象）。
 * @returns 结论、处理器与滚动容器登记函数。
 */
export function useScrollAffordance(containerRef: React.RefObject<HTMLElement | null>): ScrollAffordanceController {
  const [state, setState] = useState(initialAffordanceState);
  const stateRef = useRef(state);
  const [overflowing, setOverflowing] = useState(false);
  // 测量值先过 ref 再 setState：同值不触发渲染（避免每次提交多渲染一轮）
  const overflowRef = useRef(false);
  const regionRef = useRef<HTMLElement | null>(null);
  const disposeObserver = useRef<(() => void) | undefined>(undefined);
  const lingerTimer = useRef<number | undefined>(undefined);

  const measure = useCallback((): void => {
    const next = isOverflowing(regionRef.current);
    if (next === overflowRef.current) return;
    overflowRef.current = next;
    setOverflowing(next);
  }, []);

  const cancelLinger = useCallback((): void => {
    if (lingerTimer.current === undefined) return;
    window.clearTimeout(lingerTimer.current);
    lingerTimer.current = undefined;
  }, []);

  const dispatch = useCallback(
    (event: ScrollAffordanceEvent): void => {
      const prev = stateRef.current;
      const next = reduceScrollAffordance(prev, event);
      if (next === prev) return; // 同一事件重复到达：不重启滞留窗
      stateRef.current = next;
      setState(next);
      if (armsLingerTimer(prev, next)) {
        cancelLinger();
        lingerTimer.current = window.setTimeout(() => dispatch('linger-elapsed'), SCROLLBAR_LINGER_MS);
      } else if (!next.lingering) {
        cancelLinger();
      }
    },
    [cancelLinger],
  );

  /** 滚动容器登记（装在区域席位的滚动元素上；返回清理函数供 React 19 ref 语义调用） */
  const registerRegion = useCallback(
    (element: HTMLElement | null): (() => void) | undefined => {
      disposeObserver.current?.();
      disposeObserver.current = undefined;
      regionRef.current = element;
      if (element === null) return;
      disposeObserver.current = observeResize(element, measure);
      return () => {
        disposeObserver.current?.();
        disposeObserver.current = undefined;
        regionRef.current = null;
      };
    },
    [measure],
  );

  // 每次渲染后重测溢出（列表行数变化在提交阶段反映到 scrollHeight），
  // 容器尺寸变化由 ResizeObserver 触发一次重测（measure 内部同值短路）。
  useEffect(measure);
  useEffect(() => () => disposeObserver.current?.(), []);

  // 指针在列内时按坐标判定进出；离开窗口不会再有 pointermove，故 onPointerLeave 兜底。
  useEffect(() => {
    if (!state.pointerInside) return;
    const onMove = (event: PointerEvent): void => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const inside =
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom;
      dispatch(inside ? 'move-inside' : 'move-outside');
    };
    document.addEventListener('pointermove', onMove);
    return () => document.removeEventListener('pointermove', onMove);
  }, [state.pointerInside, containerRef, dispatch]);

  useEffect(() => cancelLinger, [cancelLinger]);

  return {
    status: scrollAffordance({ overflowing, pointerInside: state.pointerInside, lingering: state.lingering }),
    overflowing,
    handlers: {
      onPointerEnter: () => dispatch('enter'),
      onPointerLeave: () => dispatch('leave'),
    },
    registerRegion,
  };
}
