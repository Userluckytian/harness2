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

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}