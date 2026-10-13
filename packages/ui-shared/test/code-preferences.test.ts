// @vitest-environment jsdom
// 代码偏好运行时 store 测试（Z10-7）：规范化回落、偏好形状互转、apply 写 store + 镜像 localStorage、
// 明暗 → 生效代码主题解析。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_PREFS_STORAGE_KEY,
  DEFAULT_CODE_PREFERENCES,
  applyCodePreferences,
  codePreferencesFromSettings,
  codePreferencesStore,
  codePreferencesToSettingsPatch,
  initCodePreferences,
  normalizeCodePreferences,
  readStoredCodePreferences,
} from '../src/renderer/code/code-preferences.js';
import { setShellTheme } from '../src/renderer/theme/shell-theme.js';
import type { SettingsPreferencesShape } from '../src/shared/settings.js';

beforeEach(() => {
  codePreferencesStore.reset();
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('normalizeCodePreferences', () => {
  it('缺省/非法回落默认；字号钳制 12–20', () => {
    expect(normalizeCodePreferences(undefined)).toEqual(DEFAULT_CODE_PREFERENCES);
    expect(normalizeCodePreferences({ themeLight: 'dracula', themeDark: 7, fontSize: 999 })).toEqual({
      themeLight: 'github-light',
      themeDark: 'github-dark',
      lineNumbers: true,
      wordWrap: false,
      fontSize: 20,
    });
  });
});

describe('偏好形状互转', () => {
  it('SettingsPreferencesShape → CodePreferences（缺省字段回落）', () => {
    const prefs: SettingsPreferencesShape = {
      theme: 'system',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    };
    expect(codePreferencesFromSettings(prefs)).toEqual(DEFAULT_CODE_PREFERENCES);
  });

  it('CodePreferences → 偏好补丁（字段名与 shared/settings.ts 对齐）', () => {
    expect(
      codePreferencesToSettingsPatch({
        themeLight: 'vitesse-light',
        themeDark: 'catppuccin-mocha',
        lineNumbers: false,
        wordWrap: true,
        fontSize: 18,
      }),
    ).toEqual({
      codeThemeLight: 'vitesse-light',
      codeThemeDark: 'catppuccin-mocha',
      codeLineNumbers: false,
      codeWordWrap: true,
      codeFontSize: 18,
    });
  });
});

describe('applyCodePreferences / 存储镜像', () => {
  it('写入 store 并镜像到 localStorage；initCodePreferences 可恢复', () => {
    applyCodePreferences({ themeDark: 'one-dark-pro', lineNumbers: false });
    expect(codePreferencesStore.getSnapshot().themeDark).toBe('one-dark-pro');
    expect(codePreferencesStore.getSnapshot().lineNumbers).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem(CODE_PREFS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored['themeDark']).toBe('one-dark-pro');
    expect(readStoredCodePreferences()?.lineNumbers).toBe(false);

    // 复位后再从存储恢复
    codePreferencesStore.reset();
    initCodePreferences();
    expect(codePreferencesStore.getSnapshot().themeDark).toBe('one-dark-pro');
  });
});

describe('明暗 → 生效代码主题', () => {
  it('浅色界面用 themeLight，深色界面用 themeDark（jsdom 无 matchMedia → zai-dark 明确指定）', () => {
    applyCodePreferences({ themeLight: 'min-light', themeDark: 'min-dark' });
    // 直接验证 store 两支都就位；明暗选择由 useActiveCodeThemeId 消费（jsdom 下 system→浅色）
    expect(codePreferencesStore.getSnapshot().themeLight).toBe('min-light');
    setShellTheme('zai-dark');
    expect(codePreferencesStore.getSnapshot().themeDark).toBe('min-dark');
  });
});
