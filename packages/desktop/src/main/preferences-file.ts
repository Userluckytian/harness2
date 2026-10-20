// 桌面偏好持久化（主进程）：~/.harness2/desktop-preferences.json 读写。
// 与 desktop-layout.json 同目录、同「校验 + 损坏回退」模式（公共逻辑见 json-file.ts，不复制两套）。
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultPreferences,
  normalizePreferences,
  PREFERENCES_FILE,
  type DesktopPreferences,
} from '../shared/preferences.js';
import { readJsonWithDefault, writeJsonNormalized } from './json-file.js';

export function preferencesFilePath(home: string): string {
  return join(home, '.harness2', PREFERENCES_FILE);
}

export function readPreferences(home: string): DesktopPreferences {
  return readJsonWithDefault(preferencesFilePath(home), normalizePreferences, defaultPreferences);
}

export function writePreferences(home: string, preferences: unknown): DesktopPreferences {
  return writeJsonNormalized(preferencesFilePath(home), preferences, normalizePreferences);
}

/**
 * Z-47：单字段合并写 closeToTray（读-改-写，不整体覆盖其余偏好）。
 * 渲染端设置页整表写回（settings:setPreferences）与主进程侧写共用同一 normalize 校验口，
 * 二者互不踩踏；缺省 = 平台默认（win 开 / linux 关），显式写入后固化。
 */
export function setCloseToTray(home: string, enabled: boolean): DesktopPreferences {
  const current = readPreferences(home);
  return writePreferences(home, { ...current, closeToTray: enabled });
}

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}
