// 会话展示态覆层持久化（主进程）：~/.harness2/desktop-metadata.json 读写。
// 与 desktop-layout.json 同目录、同「校验 + 损坏回退」模式（公共逻辑见 json-file.ts，不复制两套）。
// **覆层语义红线**：只读写本文件；绝不触碰会话目录里的事件溯源日志（session.v1.jsonl/rewind_points.jsonl）。
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultMetadata,
  METADATA_FILE,
  normalizeMetadata,
  type SessionMetadataMap,
} from '../shared/metadata.js';
import { readJsonWithDefault, writeJsonNormalized } from './json-file.js';

export function metadataFilePath(home: string): string {
  return join(home, '.harness2', METADATA_FILE);
}

export function readMetadata(home: string): SessionMetadataMap {
  return readJsonWithDefault(metadataFilePath(home), normalizeMetadata, defaultMetadata);
}

/**
 * 合并写回：读当前磁盘覆层 → 合并 patch（单条字段级覆盖）→ normalize 后写盘 → 返回整体。
 * 写前 normalize 同时是防脏入口（IPC 侧非法结构不会落盘）。
 */
export function writeMetadataPatch(
  home: string,
  id: string,
  patch: { title?: string; archived?: boolean; deleted?: boolean },
): SessionMetadataMap {
  const current = readMetadata(home); // 已 normalize
  const next: SessionMetadataMap = { ...current };
  const entry: SessionMetadataMap[string] = { ...(current[id] ?? {}) };
  if ('title' in patch) {
    // 空字符串/非字符串经 normalizeMetadata 统一丢弃（不存在删除 title 的显式语义）
    if (typeof patch.title === 'string' && patch.title.trim().length > 0) entry.title = patch.title.trim();
    else delete entry.title;
  }
  if ('archived' in patch) {
    entry.archived = patch.archived === true;
  }
  if ('deleted' in patch) {
    entry.deleted = patch.deleted === true;
  }
  if (Object.keys(entry).length === 0) delete next[id];
  else next[id] = entry;
  return writeJsonNormalized(metadataFilePath(home), next, normalizeMetadata);
}

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}