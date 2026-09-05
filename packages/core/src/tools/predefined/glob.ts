// glob 工具：fast-glob 模式匹配（上限 1000 条，排序输出）。safe。
import fg from 'fast-glob';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { expectObject, expectString, optionalString } from './common.js';

export const MAX_GLOB_ENTRIES = 1000;

// 与 grep 对齐：无条件排除 node_modules/.git（P2-5）——含目录本身与其子树
const EXCLUDED_GLOBS = ['**/node_modules', '**/node_modules/**', '**/.git', '**/.git/**'];

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
    const searchDir = baseArg !== undefined ? resolve(ctx.cwd, baseArg) : ctx.cwd;

    let entries: string[];
    try {
      entries = await fg(pattern, { cwd: searchDir, dot: true, suppressErrors: true, ignore: EXCLUDED_GLOBS });
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
