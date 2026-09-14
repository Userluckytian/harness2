// @vitest-environment jsdom
// 主题呈现器（D-15）与降动效（D-16）测试。
// D-15 四要素：html{color-scheme}、body[data-ds-dark-theme]、--dsh-content-font-size、<meta name="theme-color">。
// D-16：prefers-reduced-motion 解析 + 帧根标记；CSS media query 侧在 app-frame.test.tsx 断言样式表文本。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchMediaLike } from '../../src/renderer/layout/theme-presenter.js';
import {
  applyThemePresentation,
  CONTENT_FONT_SIZE_VAR,
  DARK_THEME_ATTRIBUTE,
  DEFAULT_CONTENT_FONT_SIZE,
  prefersReducedMotion,
  reducedMotionAttribute,
  REDUCED_MOTION_QUERY,
  resolveThemePresentation,
  THEME_COLOR,
} from '../../src/renderer/layout/theme-presenter.js';
import { getShellTheme, setShellTheme, shellThemeStore } from '../../src/renderer/layout/shell-theme.js';

/** matchMedia 替身：按查询串给 matches，并记录监听器增减 */
function stubMatchMedia(predicate: (query: string) => boolean): { mm: MatchMediaLike; listenerCount: () => number } {
  let count = 0;
  const mm: MatchMediaLike = (query: string) => ({
    matches: predicate(query),
    addEventListener: () => {
      count += 1;
    },
    removeEventListener: () => {
      count -= 1;
    },
  });
  return { mm, listenerCount: () => count };
}

afterEach(() => {
  document.documentElement.style.cssText = '';
  document.body.removeAttribute(DARK_THEME_ATTRIBUTE);
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
});

describe('主题呈现（D-15）', () => {
  it('resolveThemePresentation：深色 → dark/深主题色；浅色 → light/暖纸色；字号写 px', () => {
    expect(resolveThemePresentation('dark')).toEqual({
      dark: true,
      colorScheme: 'dark',
      contentFontSize: `${DEFAULT_CONTENT_FONT_SIZE}px`,
      themeColor: THEME_COLOR.dark,
    });
    const light = resolveThemePresentation('warmPaper');
    expect(light.dark).toBe(false);
    expect(light.colorScheme).toBe('light');
    expect(light.themeColor).toBe(THEME_COLOR.light);
    expect(resolveThemePresentation('warmPaper', { contentFontSize: 16 }).contentFontSize).toBe('16px');
    // jsdom 无 matchMedia：system 视为浅色（与 theme.ts 既有口径一致）
    expect(resolveThemePresentation('system').colorScheme).toBe('light');
  });

  it('applyThemePresentation 一次写四处（html color-scheme / body 属性 / 字号变量 / theme-color）', () => {
    const dispose = applyThemePresentation('dark');
    const html = document.documentElement;
    expect(html.style.colorScheme).toBe('dark');
    expect(html.style.getPropertyValue(CONTENT_FONT_SIZE_VAR)).toBe(`${DEFAULT_CONTENT_FONT_SIZE}px`);
    expect(document.body.hasAttribute(DARK_THEME_ATTRIBUTE)).toBe(true);
    const meta = document.head.querySelector('meta[name="theme-color"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute('content')).toBe(THEME_COLOR.dark);
    dispose();

    applyThemePresentation('warmPaper');
    expect(html.style.colorScheme).toBe('light');
    expect(html.style.getPropertyValue(CONTENT_FONT_SIZE_VAR)).toBe(`${DEFAULT_CONTENT_FONT_SIZE}px`);
    expect(document.body.hasAttribute(DARK_THEME_ATTRIBUTE)).toBe(false);
    expect(meta?.getAttribute('content')).toBe(THEME_COLOR.light);
  });

  it('meta 复用：重复应用不重复插入 <meta name="theme-color">', () => {
    applyThemePresentation('dark');
    applyThemePresentation('dark');
    expect(document.head.querySelectorAll('meta[name="theme-color"]').length).toBe(1);
  });
});

describe('降动效（D-16）', () => {
  it('prefersReducedMotion：无 matchMedia → false；命中 reduce → true；标记属性两态', () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(prefersReducedMotion(stubMatchMedia((q) => q === REDUCED_MOTION_QUERY).mm)).toBe(true);
    expect(prefersReducedMotion(stubMatchMedia(() => false).mm)).toBe(false);
    expect(reducedMotionAttribute(true)).toBe('true');
    expect(reducedMotionAttribute(false)).toBeNull();
  });

  it('system 主题挂 prefers-color-scheme 监听（变化即重放四要素），返回的取消函数可退订', () => {
    const { mm, listenerCount } = stubMatchMedia(() => true);
    const dispose = applyThemePresentation('system', { matchMedia: mm });
    expect(listenerCount()).toBe(1);
    expect(document.documentElement.style.colorScheme).toBe('light'); // jsdom 里 system 读不到 matchMedia
    dispose();
    expect(listenerCount()).toBe(0);
    // 非 system 主题不挂监听
    const fixed = stubMatchMedia(() => true);
    applyThemePresentation('dark', { matchMedia: fixed.mm });
    expect(fixed.listenerCount()).toBe(0);
  });

  it('抛错的 matchMedia 不炸（fail-soft）', () => {
    const broken: MatchMediaLike = () => {
      throw new Error('matchMedia 不可用');
    };
    expect(prefersReducedMotion(broken)).toBe(false);
  });
});

describe('主题 store（内存态，D-14 口径）', () => {
  it('setShellTheme 立即呈现并更新快照；订阅者收到通知，退订后不再收到', () => {
    setShellTheme('warmPaper');
    expect(getShellTheme()).toBe('warmPaper');
    const listener = vi.fn();
    const unsub = shellThemeStore.subscribe(listener);
    setShellTheme('dark');
    expect(getShellTheme()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.body.hasAttribute(DARK_THEME_ATTRIBUTE)).toBe(true);
    unsub();
    setShellTheme('system');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.body.hasAttribute(DARK_THEME_ATTRIBUTE)).toBe(false);
  });
});
