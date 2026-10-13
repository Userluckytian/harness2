// code 导出面（Z10-7 代码查看器 + 外观代码设置/预览）：
//   纯逻辑：主题目录/语言探测（code-theme）、代码偏好运行时 store（code-preferences）、
//          查看器当前目标（code-viewer-target）；
//   呈现：CodeViewer（纯呈现）+ CodeViewerPane（数据/偏好装配）；
//   高亮：shiki 懒加载单例（shiki-loader，动态 import，CJS/ESM 双构建安全）。
export {
  CODE_FONT_SIZE_DEFAULT,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CODE_LANGUAGES,
  CODE_THEME_OPTIONS,
  DEFAULT_CODE_THEME_DARK,
  DEFAULT_CODE_THEME_LIGHT,
  clampCodeFontSize,
  codeThemeKind,
  codeThemeLabel,
  codeThemeOptionsOf,
  detectCodeLanguage,
  isCodeThemeId,
  type CodeLanguage,
  type CodeThemeId,
  type CodeThemeKind,
  type CodeThemeOption,
} from './code-theme.js';
export {
  CODE_PREFS_STORAGE_KEY,
  DEFAULT_CODE_PREFERENCES,
  applyCodePreferences,
  codePreferencesFromSettings,
  codePreferencesStore,
  codePreferencesToSettingsPatch,
  hydrateCodePreferences,
  initCodePreferences,
  normalizeCodePreferences,
  readStoredCodePreferences,
  useActiveCodeThemeId,
  useCodePreferences,
  type CodePreferences,
} from './code-preferences.js';
export {
  clearCodeViewer,
  openCodeViewer,
  peekCodeViewerTarget,
  resetCodeViewerForTests,
  useCodeViewerTarget,
  type CodeViewerTarget,
} from './code-viewer-target.js';
export { CodeViewer, type CodeViewerProps } from './CodeViewer.js';
export {
  CodeViewerPane,
  type CodeViewerPaneProps,
  type CodeViewerReadResult,
  type CodeViewerReader,
} from './CodeViewerPane.js';
export { CODE_PREVIEW_SAMPLE } from './preview-sample.js';
export {
  LOADED_LANGUAGES,
  LOADED_THEMES,
  loadCodeHighlighter,
  resetCodeHighlighterForTests,
  type CodeHighlighter,
  type CodeToken,
  type CodeTokensResult,
} from './shiki-loader.js';
