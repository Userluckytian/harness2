// 会话草稿持久化（主进程，D1）：~/.harness2/desktop-drafts.json 读写。
// 读容错：缺失/损坏/形状非法 → 空映射；写前 normalize（防 IPC 侧注入非法结构落盘）。
// 与布局/偏好同策略：磁盘为唯一事实源，渲染端只经 IPC 读写（零 Node）。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeDrafts, type DraftsMap } from '../shared/drafts.js';
import { readJsonWithDefault, writeJsonNormalized } from './json-file.js';

export const DRAFTS_FILE = 'desktop-drafts.json';

export function draftsFilePath(home: string): string {
  return join(home, '.harness2', DRAFTS_FILE);
}

export function readDrafts(home: string): DraftsMap {
  return readJsonWithDefault(draftsFilePath(home), normalizeDrafts, () => ({}));
}

export function writeDrafts(home: string, raw: unknown): DraftsMap {
  return writeJsonNormalized(draftsFilePath(home), raw, normalizeDrafts);
}

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}
