// 主题/字号/设置壳主题状态运行时（Z7 自桌面下沉，桌面/web 共享）。
export { THEME_STORAGE_KEY, applyTheme, resolvedTheme, themeLabel, type ResolvedTheme } from './theme.js';
export {
  CONTENT_FONT_SIZE_VAR,
  DARK_THEME_ATTRIBUTE,
  DEFAULT_CONTENT_FONT_SIZE,
  THEME_COLOR,
  applyThemePresentation,
  applyThemePresentationValues,
  ensureThemeColorMeta,
  resolveThemePresentation,
  type ThemePresentation,
} from './theme-presenter.js';
export {
  UI_FONT_SIZE_CSS_VAR,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_STORAGE_KEY,
  applyUiFontSize,
  clampUiFontSize,
  currentUiFontSize,
  initUiFontSize,
  readStoredUiFontSize,
} from './ui-font-size.js';
export {
  getShellTheme,
  setShellTheme,
  shellThemeLabel,
  shellThemeStore,
  useShellTheme,
  type ShellThemeState,
} from './shell-theme.js';
