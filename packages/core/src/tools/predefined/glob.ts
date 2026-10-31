// glob 工具：fast-glob 模式匹配（上限 1000 条，排序输出）。safe。
import fg from 'fast-glob';
import type { Dirent } from 'node:fs';
import type { ToolDefinition } from '../types.js';
import { expectObject, expectString, optionalString, resolveWithinCwd } from './common.js';
// 忽略语义与 grep 共用同一事实源（A22 抽取；取值零变化）
import { EXCLUDED_GLOBS } from './ignore.js';
// 目录条目缓存：与 grep JS 回退共用（按目录 mtimeMs 失效，见 dirCache.ts）
import { readDirCached } from './dirCache.js';

export const MAX_GLOB_ENTRIES = 1000;

/**
 * fast-glob fs 注入：回调风格 readdir（与 fs.readdir 同签名），命中目录缓存时
 * 跳过 readdirSync；未命中则 readdirSync 并写缓存。
 */
function cachedReaddir(
  filepath: string,
  options: { withFileTypes: true },
  callback: (error: NodeJS.ErrnoException | null, files: Dirent[]) => void,
): void;
function cachedReaddir(
  filepath: string,
  callback: (error: NodeJS.ErrnoException | null, files: string[]) => void,
): void;
function cachedReaddir(filepath: string, optionsOrCallback: unknown, callback?: unknown): void {
  const withFileTypes = (optionsOrCallback as { withFileTypes?: boolean } | undefined)?.withFileTypes === true;
  const cb = (callback ?? optionsOrCallback) as (
    error: NodeJS.ErrnoException | null,
    files?: string[] | Dirent[],
  ) => void;
  setImmediate(() => {
    try {
      const entries = readDirCached(filepath);
      cb(null, withFileTypes ? entries : entries.map((e) => e.name));
    } catch (e) {
      cb(e as NodeJS.ErrnoException);
    }
  });
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'List paths matching a glob pattern (e.g. "src/**/*.ts", "*" for top level) relative to `path` or cwd. ' +
    'Includes dotfiles (except node_modules/.git, which are always excluded); results are sorted; ' +
    'capped at 1000 entries. Safe for parallel execution.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (fast-glob syntax)' },
      path: { type: 'string', description: 'Base directory (default: cwd)' },
    },
    required: ['pattern'],
  },
  concurrencySafe: true,
  execute: async (rawArgs, ctx) => {
    const args = expectObject(rawArgs, 'glob');
    const pattern = expectString(args, 'pattern', 'glob');
    const baseArg = optionalString(args, 'path');
    const searchDir = baseArg !== undefined ? resolveWithinCwd(ctx.cwd, baseArg, 'glob') : ctx.cwd;

    let entries: string[];
    try {
      entries = await fg(pattern, {
        cwd: searchDir,
        dot: true,
        suppressErrors: true,
        ignore: [...EXCLUDED_GLOBS],
        fs: { readdir: cachedReaddir }, // 目录级缓存注入：命中跳过 fast-glob 全树 readdir（#5476）
      });
    } catch (e) {
      return { error: `glob failed: ${(e as Error).message}` };
    }
    entries.sort();
    if (entries.length === 0) return { output: '(no matches)' };
    const truncated = entries.length > MAX_GLOB_ENTRIES;
    const shown = truncated ? entries.slice(0, MAX_GLOB_ENTRIES) : entries;
    const note = truncated ? `\n... [truncated at ${MAX_GLOB_ENTRIES} entries, ${entries.length} total]` : '';
    return { output: shown.join('\n') + note };
  },
};
