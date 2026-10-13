// 桌面端纯 UI 偏好 schema（main/renderer 共享）：~/.harness2/desktop-preferences.json。
// 只存「不影响内核行为」的桌面 UI 偏好；模型/审批/记忆等正式配置一律走 config.json/auth.json
// （与 CLI 共用同一份，不建平行配置）。normalizePreferences 是文件读取与 IPC 保存的唯一校验口
// （损坏/越界一律回落默认值），复刻 shared/layout.ts 的 normalizeLayout 模式。
//
// Z10-7：新增代码查看器偏好（浅/深代码主题、行号、自动换行、代码字号）—— 形状与唯一事实源
// `@harness2/ui-shared/shared/settings.ts` 的 CodeThemeId 对齐（此处只做枚举校验，不另起命名）。
import type { CodeThemeId } from '@harness2/ui-shared/shared/settings.js';

export const THEMES = ['system', 'zai-light', 'zai-dark'] as const;
export type DesktopTheme = (typeof THEMES)[number];

export const NOTIFY_DETAILS = ['minimal', 'full'] as const;
export type NotifyDetails = (typeof NOTIFY_DETAILS)[number];

/** 代码主题可选项（与 shiki 内置主题名一一对应；顺序 = 外观「代码设置卡」下拉序） */
export const CODE_THEMES = [
  'github-light',
  'github-dark',
  'vitesse-light',
  'vitesse-dark',
  'min-light',
  'min-dark',
  'github-dark-high-contrast',
  'catppuccin-latte',
  'catppuccin-mocha',
  'one-dark-pro',
] as const satisfies readonly CodeThemeId[];

/** 代码字号范围（Z-90：12–20，默认 13；与渲染端 code-preferences 同值） */
export const CODE_FONT_SIZE_MIN = 12;
export const CODE_FONT_SIZE_MAX = 20;
export const CODE_FONT_SIZE_DEFAULT = 13;

export interface DesktopPreferences {
  /** 主题：跟随系统 / Zai 浅色 / Zai 深色（Z-66；渲染层据根 class 与 data-theme 切换） */
  theme: DesktopTheme;
  /** 启动默认分栏数（1..3） */
  defaultPaneCount: number;
  /** 是否显示欢迎页/引导（当前仅记录，欢迎页属后续阶段） */
  showWelcome: boolean;
  /** 任务完成系统通知详情级别 */
  notifyDetails: NotifyDetails;
  /** Z10-7：浅色代码主题（代码查看器 + 浅色预览卡） */
  codeThemeLight: CodeThemeId;
  /** Z10-7：深色代码主题（代码查看器 + 深色预览卡） */
  codeThemeDark: CodeThemeId;
  /** Z10-7：代码查看器显示行号 */
  codeLineNumbers: boolean;
  /** Z10-7：代码查看器长行自动换行 */
  codeWordWrap: boolean;
  /** Z10-7：代码字号（12–20，默认 13） */
  codeFontSize: number;
}

export function defaultPreferences(): DesktopPreferences {
  return {
    theme: 'system',
    defaultPaneCount: 1,
    showWelcome: true,
    notifyDetails: 'minimal',
    codeThemeLight: 'github-light',
    codeThemeDark: 'github-dark',
    codeLineNumbers: true,
    codeWordWrap: false,
    codeFontSize: CODE_FONT_SIZE_DEFAULT,
  };
}

/** 校验未知来源的偏好数据（磁盘文件/IPC）：形状非法/越界一律回落默认字段 */
export function normalizePreferences(raw: unknown): DesktopPreferences {
  const fallback = defaultPreferences();
  if (typeof raw !== 'object' || raw === null) return fallback;
  const o = raw as Record<string, unknown>;
  const codeFontSize =
    typeof o['codeFontSize'] === 'number' &&
    Number.isInteger(o['codeFontSize']) &&
    o['codeFontSize'] >= CODE_FONT_SIZE_MIN &&
    o['codeFontSize'] <= CODE_FONT_SIZE_MAX
      ? o['codeFontSize']
      : fallback.codeFontSize;
  return {
    theme: THEMES.includes(o['theme'] as DesktopTheme) ? (o['theme'] as DesktopTheme) : fallback.theme,
    defaultPaneCount:
      typeof o['defaultPaneCount'] === 'number' &&
      Number.isInteger(o['defaultPaneCount']) &&
      o['defaultPaneCount'] >= 1 &&
      o['defaultPaneCount'] <= 3
        ? o['defaultPaneCount']
        : fallback.defaultPaneCount,
    showWelcome: typeof o['showWelcome'] === 'boolean' ? o['showWelcome'] : fallback.showWelcome,
    notifyDetails: NOTIFY_DETAILS.includes(o['notifyDetails'] as NotifyDetails)
      ? (o['notifyDetails'] as NotifyDetails)
      : fallback.notifyDetails,
    codeThemeLight: CODE_THEMES.includes(o['codeThemeLight'] as CodeThemeId)
      ? (o['codeThemeLight'] as CodeThemeId)
      : fallback.codeThemeLight,
    codeThemeDark: CODE_THEMES.includes(o['codeThemeDark'] as CodeThemeId)
      ? (o['codeThemeDark'] as CodeThemeId)
      : fallback.codeThemeDark,
    codeLineNumbers: typeof o['codeLineNumbers'] === 'boolean' ? o['codeLineNumbers'] : fallback.codeLineNumbers,
    codeWordWrap: typeof o['codeWordWrap'] === 'boolean' ? o['codeWordWrap'] : fallback.codeWordWrap,
    codeFontSize,
  };
}

export const PREFERENCES_FILE = 'desktop-preferences.json';
