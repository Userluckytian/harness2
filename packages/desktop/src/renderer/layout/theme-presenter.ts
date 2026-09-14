// 主题呈现器（D-15）+ 降动效（D-16）。
// D-15：一次应用写四处 —— html{color-scheme}、body[data-ds-dark-theme]、
//       html 的 --dsh-content-font-size、<meta name="theme-color">。
// D-16：prefers-reduced-motion 时禁过渡 —— CSS 侧见 layout/app-frame.css 的 media query，
//       同时把解析结果写到帧根属性 data-reduced-motion（供测试与调试观测，避免「看不见的开关」）。
// data-theme（既有 B2 主题变量切换）仍由 theme.ts 负责，本模块只补 D-15 的四要素。
import type { SettingsTheme } from '../../shared/protocol.js';
import { resolvedTheme } from '../theme.js';

/** 深色主题在 body 上的属性名（D-15） */
export const DARK_THEME_ATTRIBUTE = 'data-ds-dark-theme';
/** 正文字号 CSS 变量名（D-15） */
export const CONTENT_FONT_SIZE_VAR = '--dsh-content-font-size';
/** 正文字号默认值（px） */
export const DEFAULT_CONTENT_FONT_SIZE = 14;
/** 主题色（与 styles.css 的 --bg 保持一致） */
export const THEME_COLOR = { light: '#f6efe3', dark: '#1b1d21' } as const;
/** 降动效 media query（D-16） */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** 系统深色 media query（theme.ts 同源） */
const DARK_QUERY = '(prefers-color-scheme: dark)';
/** 降动效标记属性（挂在帧根上，D-16） */
export const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion';

/** matchMedia 的最小形状（jsdom 无原生实现 → 测试注入；生产走 window.matchMedia） */
export type MatchMediaLike = (
  query: string,
) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

export interface ThemePresentation {
  readonly dark: boolean;
  /** html{color-scheme} 的取值 */
  readonly colorScheme: 'light' | 'dark';
  /** html 上 --dsh-content-font-size 的取值 */
  readonly contentFontSize: string;
  /** <meta name="theme-color"> 的取值 */
  readonly themeColor: string;
}

/** 取原生/注入的 matchMedia（保留 window 绑定，避免 detached 调用抛 Illegal invocation） */
export function resolveMatchMedia(override?: MatchMediaLike): MatchMediaLike | undefined {
  if (override !== undefined) return override;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return (query) => window.matchMedia(query);
}

/** theme 偏好 → 四下要写的呈现值（纯函数；system 由 prefers-color-scheme 解析） */
export function resolveThemePresentation(
  theme: SettingsTheme,
  opts: { contentFontSize?: number } = {},
): ThemePresentation {
  const dark = resolvedTheme(theme) === 'dark';
  const size = opts.contentFontSize ?? DEFAULT_CONTENT_FONT_SIZE;
  return {
    dark,
    colorScheme: dark ? 'dark' : 'light',
    contentFontSize: `${size}px`,
    themeColor: dark ? THEME_COLOR.dark : THEME_COLOR.light,
  };
}

/** 取/建 <meta name="theme-color">（不存在则创建并插入 head） */
export function ensureThemeColorMeta(doc: Document): HTMLMetaElement {
  const existing = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (existing !== null) return existing;
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  doc.head.appendChild(meta);
  return meta;
}

/** 把一份呈现值应用到 DOM（返回该 meta 元素，便于调用方/测试核对） */
export function applyThemePresentationValues(doc: Document, p: ThemePresentation): HTMLMetaElement {
  const html = doc.documentElement;
  html.style.colorScheme = p.colorScheme; // html{color-scheme}
  html.style.setProperty(CONTENT_FONT_SIZE_VAR, p.contentFontSize);
  if (p.dark) doc.body.setAttribute(DARK_THEME_ATTRIBUTE, '');
  else doc.body.removeAttribute(DARK_THEME_ATTRIBUTE);
  const meta = ensureThemeColorMeta(doc);
  meta.setAttribute('content', p.themeColor);
  return meta;
}

/**
 * 应用主题呈现（D-15）；system 模式下跟随系统变化重放四要素。
 * 返回取消函数（system 监听退订；其余为空操作）。
 */
export function applyThemePresentation(
  theme: SettingsTheme,
  opts: {
    contentFontSize?: number;
    doc?: Document;
    matchMedia?: MatchMediaLike;
    /** 关掉 system 监听（渲染端一致性无需要，测试/一次性应用可关） */
    watchSystem?: boolean;
  } = {},
): () => void {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (doc === undefined) return () => {};
  const apply = (): void => {
    applyThemePresentationValues(doc, resolveThemePresentation(theme, opts));
  };
  apply();
  if (theme !== 'system' || opts.watchSystem === false) return () => {};
  const mq = resolveMatchMedia(opts.matchMedia)?.(DARK_QUERY);
  if (mq === undefined || typeof mq.addEventListener !== 'function') return () => {};
  mq.addEventListener('change', apply);
  return () => mq.removeEventListener('change', apply);
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
