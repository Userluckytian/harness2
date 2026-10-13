// 代码查看器偏好运行时（Z10-7）：代码主题（浅/深）、行号、自动换行、代码字号。
//
// 为什么要一个**运行时 store**（而不是把偏好留在设置页 state 里）：代码查看器在**右栏**，
// 与设置覆层是两个互不相邻的 surface —— 设置里改的代码主题/行号/换行/字号必须被查看器与
// 预览卡**即时消费**，否则就是「死设置」。做法与 shell-theme / ui-font-size 同源：
//   * 内存单例 store（`createShellStore`）+ `useSyncExternalStore` 订阅；
//   * 持久化走各壳的偏好通道（桌面 settings:* IPC → desktop-preferences.json；web 浏览器存储），
//     这里额外镜像一份到 localStorage 作为**同步兜底**（D-14 例外 #1/#2 同族：boot 时同步可读），
//     key = harness2-code-prefs（JSON）。
//
// 边界：纯渲染端；不 import shiki（异步/体积不外泄）；不 import 任何壳的全局对象。
import type { CodeThemeId, SettingsPreferencesShape } from '../../shared/settings.js';
import { createShellStore, useShellStore, type ShellStore } from '../shell-store.js';
import { resolvedTheme } from '../theme/theme.js';
import { useShellTheme } from '../theme/shell-theme.js';
import {
  clampCodeFontSize,
  CODE_FONT_SIZE_DEFAULT,
  DEFAULT_CODE_THEME_DARK,
  DEFAULT_CODE_THEME_LIGHT,
  isCodeThemeId,
} from './code-theme.js';

/** 本地存储镜像 key（boot 时同步读取，做持久化的兜底通道） */
export const CODE_PREFS_STORAGE_KEY = 'harness2-code-prefs';

/** 代码查看器偏好（运行时的规范形状；字段名与 desktop-preferences.json 同口径） */
export interface CodePreferences {
  /** 浅色代码主题（浅色预览卡 + 浅色界面下的查看器） */
  readonly themeLight: CodeThemeId;
  /** 深色代码主题（深色预览卡 + 深色界面下的查看器） */
  readonly themeDark: CodeThemeId;
  /** 显示行号 */
  readonly lineNumbers: boolean;
  /** 长行自动换行 */
  readonly wordWrap: boolean;
  /** 代码字号（12–20） */
  readonly fontSize: number;
}

export const DEFAULT_CODE_PREFERENCES: CodePreferences = Object.freeze({
  themeLight: DEFAULT_CODE_THEME_LIGHT,
  themeDark: DEFAULT_CODE_THEME_DARK,
  lineNumbers: true,
  wordWrap: false,
  fontSize: CODE_FONT_SIZE_DEFAULT,
});

/** 校验任意来源的代码偏好（缺省/非法字段回落默认；与桌面 normalizePreferences 同口径） */
export function normalizeCodePreferences(raw: unknown): CodePreferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_CODE_PREFERENCES;
  const o = raw as Record<string, unknown>;
  return {
    themeLight: isCodeThemeId(o['themeLight']) ? o['themeLight'] : DEFAULT_CODE_PREFERENCES.themeLight,
    themeDark: isCodeThemeId(o['themeDark']) ? o['themeDark'] : DEFAULT_CODE_PREFERENCES.themeDark,
    lineNumbers: typeof o['lineNumbers'] === 'boolean' ? o['lineNumbers'] : DEFAULT_CODE_PREFERENCES.lineNumbers,
    wordWrap: typeof o['wordWrap'] === 'boolean' ? o['wordWrap'] : DEFAULT_CODE_PREFERENCES.wordWrap,
    fontSize:
      typeof o['fontSize'] === 'number' && Number.isFinite(o['fontSize'])
        ? clampCodeFontSize(o['fontSize'])
        : DEFAULT_CODE_PREFERENCES.fontSize,
  };
}

/** 跨壳偏好形状（SettingsPreferencesShape 的可选 code* 字段）→ 运行时规范形状 */
export function codePreferencesFromSettings(prefs: SettingsPreferencesShape): CodePreferences {
  return normalizeCodePreferences({
    themeLight: prefs.codeThemeLight,
    themeDark: prefs.codeThemeDark,
    lineNumbers: prefs.codeLineNumbers,
    wordWrap: prefs.codeWordWrap,
    fontSize: prefs.codeFontSize,
  });
}

/** 运行时形状 → 跨壳偏好补丁（写回偏好通道；字段名与 shared/settings.ts 对齐） */
export function codePreferencesToSettingsPatch(prefs: CodePreferences): Partial<SettingsPreferencesShape> {
  return {
    codeThemeLight: prefs.themeLight,
    codeThemeDark: prefs.themeDark,
    codeLineNumbers: prefs.lineNumbers,
    codeWordWrap: prefs.wordWrap,
    codeFontSize: prefs.fontSize,
  };
}

/** 内存单例（右栏查看器 / 设置页预览卡共用同一条订阅面） */
export const codePreferencesStore: ShellStore<CodePreferences> =
  createShellStore<CodePreferences>(DEFAULT_CODE_PREFERENCES);

/** 读存储镜像（无存储 / 非法 → null；调用方回落默认，不造值） */
export function readStoredCodePreferences(storage?: Pick<Storage, 'getItem'>): CodePreferences | null {
  try {
    const raw = (storage ?? window.localStorage)?.getItem(CODE_PREFS_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return normalizeCodePreferences(parsed);
  } catch {
    return null; // 存储不可用（隐私模式）或 JSON 损坏：回落默认，不阻断
  }
}

/** 应用代码偏好：写 store（即时被查看器/预览卡消费）+ 镜像到 localStorage（持久化兜底） */
export function applyCodePreferences(patch: Partial<CodePreferences>): CodePreferences {
  const next = normalizeCodePreferences({ ...codePreferencesStore.getSnapshot(), ...patch });
  codePreferencesStore.patch(next);
  try {
    window.localStorage?.setItem(CODE_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储不可用：本次会话仍即时生效，持久化退化，不阻断
  }
  return next;
}

/** 从 localStorage 镜像恢复（壳 boot 调用；无存储值时不动 store，保留默认） */
export function initCodePreferences(): void {
  const stored = readStoredCodePreferences();
  if (stored !== null) codePreferencesStore.patch(stored);
}

/**
 * 直接用给定偏好灌入 store（**不镜像 localStorage**）。
 * 桌面 boot 用：桌面的持久化真源是 desktop-preferences.json（settings:* IPC），
 * 不该在 boot 时往 localStorage 写第二个 key（会污染「几何不落盘」等断言）。
 */
export function hydrateCodePreferences(prefs: CodePreferences): void {
  codePreferencesStore.patch(normalizeCodePreferences(prefs));
}

/** 订阅代码偏好（查看器 / 预览卡 / 设置卡共用） */
export function useCodePreferences(): CodePreferences {
  return useShellStore(codePreferencesStore);
}

/**
 * 当前界面主题下**实际生效**的代码主题 id（浅色界面 → themeLight，深色 → themeDark）。
 * 代码查看器与「当前生效」预览徽标共用此口径，避免两处各判一次明暗。
 */
export function useActiveCodeThemeId(): CodeThemeId {
  const prefs = useCodePreferences();
  const theme = useShellTheme();
  return resolvedTheme(theme) === 'zai-dark' ? prefs.themeDark : prefs.themeLight;
}
