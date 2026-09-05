// read 工具：按行读取文本文件（cat -n 风格行号；上限 2000 行）。safe。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { expectObject, expectString, optionalNumber } from './common.js';

export const MAX_READ_LINES = 2000;

export const readTool: ToolDefinition = {
  name: 'read',
  description:
    'Read a UTF-8 text file. Lines are numbered `cat -n` style. ' +
    'Optional 1-based `offset` (start line) and `limit` (max lines, hard cap 2000). ' +
    'Safe for parallel execution.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'File path (absolute, or relative to cwd)' },
      offset: { type: 'number', description: '1-based start line (default 1)' },
      limit: { type: 'number', description: 'Max lines to return (default/cap 2000)' },
    },
    required: ['file_path'],
  },
  concurrencySafe: true,
  execute: async (rawArgs, ctx) => {
    const args = expectObject(rawArgs, 'read');
    const filePath = resolve(ctx.cwd, expectString(args, 'file_path', 'read'));
    const offset = Math.max(1, Math.floor(optionalNumber(args, 'offset') ?? 1));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(optionalNumber(args, 'limit') ?? MAX_READ_LINES)));

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (e) {
      return { error: `read failed: ${(e as Error).message}` };
    }

    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop(); // 结尾换行不产生幽灵空行
    const startIdx = offset - 1;
    const slice = lines.slice(startIdx, startIdx + limit);
    if (slice.length === 0) {
      return { error: `offset ${offset} is beyond end of file (${lines.length} lines)` };
    }
    const body = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n');
    const shownEnd = offset + slice.length - 1;
    const note =
      shownEnd < lines.length ? `\n... [showing lines ${offset}-${shownEnd} of ${lines.length}]` : '';
    return { output: body + note };
  },
};
