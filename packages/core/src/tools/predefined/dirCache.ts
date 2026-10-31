// 目录条目缓存（#5476 性能修复）：按目录 mtimeMs 缓存 readdirSync(dir, { withFileTypes: true })
// 的 Dirent[] 结果，供 grep JS 回退（scanTextFiles）与 glob（fast-glob fs 注入）共用，
// 消除重复调用时的整树重遍历。
// 失效语义：目录 mtimeMs 在其条目（增/删/改名）变化时更新；文件内容变化不更新目录
// mtime，而内容读取保持惰性（每次调用实时 stat/readFileSync），不影响 grep/glob 结果
// 正确性。已知限制：mtime 粒度较粗的文件系统上，同一 mtimeMs 窗口内的连续目录变更
// 可能被缓存遮蔽（与 store.ts statsCache 同类取舍）；缓存为进程内内存态，不跨进程。
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { resolve } from 'node:path';

/** 缓存上限（目录数）；超出整体清空，简单且正确 */
const MAX_CACHE_ENTRIES = 2048;

interface DirCacheEntry {
  mtimeMs: number;
  entries: Dirent[];
}

const cache = new Map<string, DirCacheEntry>();

/**
 * 取目录条目列表（含失效检查）：先 stat 目录并与缓存 mtimeMs 比对，命中直接返回
 * 缓存条目（同一数组引用，调用方仅迭代不得修改）；未命中则 readdirSync 并写入缓存
 * 后返回。目录不存在/无权限等错误照常抛出，由调用方决定跳过（grep walk）或上报
 * （glob readdir 回调）。
 */
export function readDirCached(dir: string): Dirent[] {
  const key = resolve(dir);
  const mtimeMs = statSync(key).mtimeMs; // 抛错即目录不可读，交调用方处理
  const hit = cache.get(key);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.entries;
  const entries = readdirSync(key, { withFileTypes: true });
  cache.set(key, { mtimeMs, entries });
  if (cache.size > MAX_CACHE_ENTRIES) cache.clear();
  return entries;
}

/** 清空缓存（测试/显式失效用） */
export function clearDirCache(): void {
  cache.clear();
}
