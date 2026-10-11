// 降动效（D-16）—— 壳无关部分（原 desktop `layout/theme-presenter.ts` 的 D-16 半边下沉共享包）。
// D-15 的「主题四要素」（body[data-ds-dark-theme] / --dsh-content-font-size / <meta name=theme-color>）
// 仍留在桌面壳（依赖桌面主题解析），本模块只提供降动效判定：帧根属性 + CSS media query 两路。
// 抽出的原因：帧骨架（AppFrame / use-frame）随 Z7 下沉 ui-shared，二者都要读同一份降动效口径。

/** 降动效 media query（D-16） */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** 降动效标记属性（挂在帧根上，D-16） */
export const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion';

/** matchMedia 的最小形状（jsdom 无原生实现 → 测试注入；生产走 window.matchMedia） */
export type MatchMediaLike = (
  query: string,
) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

/** 取原生/注入的 matchMedia（保留 window 绑定，避免 detached 调用抛 Illegal invocation） */
export function resolveMatchMedia(override?: MatchMediaLike): MatchMediaLike | undefined {
  if (override !== undefined) return override;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return (query) => window.matchMedia(query);
}

/** 降动效偏好（D-16；无 matchMedia 环境视为 false） */
export function prefersReducedMotion(matchMedia?: MatchMediaLike): boolean {
  const mm = resolveMatchMedia(matchMedia);
  if (mm === undefined) return false;
  try {
    return mm(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

/** 降动效属性值（true → 'true'，否则 null → 不写属性） */
export function reducedMotionAttribute(prefersReduced: boolean): 'true' | null {
  return prefersReduced ? 'true' : null;
}
