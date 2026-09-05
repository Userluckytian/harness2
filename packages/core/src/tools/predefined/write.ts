// write 工具：原子写文件（tmp+rename），自动建父目录。unsafe，lockKey=目标路径。
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { expectObject, expectString, writeAtomic } from './common.js';

export const writeTool: ToolDefinition = {
  name: 'write',
  description:
    'Write (create or overwrite) a UTF-8 text file atomically (tmp file + rename). ' +
    'Parent directories are created automatically. Unsafe: writes to the same path are serialized.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'File path (absolute, or relative to cwd)' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['file_path', 'content'],
  },
  lockKey: (rawArgs) => {
    // 以调用参数中的路径串作锁键（同一路径的并发写彼此串行）
    const rec = rawArgs as { file_path?: unknown };
    return typeof rec?.file_path === 'string' ? rec.file_path : '<unknown>';
  },
  execute: async (rawArgs, ctx) => {
    const args = expectObject(rawArgs, 'write');
    const filePath = resolve(ctx.cwd, expectString(args, 'file_path', 'write'));
    const content = expectString(args, 'content', 'write');
    writeAtomic(filePath, content);
    const rel = resolve(filePath) === resolve(ctx.cwd) ? filePath : filePath.slice(resolve(ctx.cwd).length + 1);
    return { output: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${rel}` };
  },
};
