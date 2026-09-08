// write 工具：原子写文件（tmp+rename），自动建父目录。unsafe（独占执行，天然串行）。
import { relative, resolve } from 'node:path';
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
  // lockKey 不声明：unsafe 调用本就独占执行（串行），按路径加锁是无效实现（P2-7）；
  // lockKey 字段为 Ph3 并发模型预留（见 tools/types.ts）。
  // cancelGuaranteed：writeAtomic 同步原子完成——要么未启动（取消门拒绝），要么已写完整，无半截。
  cancelGuaranteed: true,
  execute: async (rawArgs, ctx) => {
    const args = expectObject(rawArgs, 'write');
    const filePath = resolve(ctx.cwd, expectString(args, 'file_path', 'write'));
    const content = expectString(args, 'content', 'write');
    writeAtomic(filePath, content);
    // cwd 内显示相对路径；越界（..开头）或空时回退绝对路径（P2-4：slice 截位在盘符根等场景错位）
    const rel = relative(ctx.cwd, filePath);
    const display = rel !== '' && !rel.startsWith('..') ? rel : filePath;
    return { output: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${display}` };
  },
};
