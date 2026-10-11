// 降动效探测（D-16 / D-22）：`prefers-reduced-motion: reduce` 时禁用过渡与动画。
// matchMedia 在 jsdom 里可能缺失或只有旧版 addListener，统一做存在性防护。
import { useCallback, useEffect, useRef, useState } from 'react';

/** 降动效媒体查询（唯一字符串来源，测试与 hook 共用） */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** 读一次当前是否降动效（无 matchMedia 的环境按「不降」处理） */
export function matchesReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/** 订阅降动效偏好；运行中切换系统设置会即时生效（收起动画随之即时落定） */
export function useReducedMotion(): boolean {
  const [reduced, setReducedState] = useState(matchesReducedMotion);
  // 先过 ref 再 setState：同值不触发渲染（初始读数与订阅回调常常同值）
  const reducedRef = useRef(reduced);
  const setReduced = useCallback((value: boolean): void => {
    if (reducedRef.current === value) return;
    reducedRef.current = value;
    setReducedState(value);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(query.matches);
    onChange();
    // jsdom 的 MediaQueryList 不保证有事件方法：两种 API 都试，都没有就退化为初始读数。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      return () => query.removeListener(onChange);
    }
    return;
  }, [setReduced]);
  return reduced;
}
