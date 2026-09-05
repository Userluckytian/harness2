// edit 工具：唯一子串替换（old_text 必须恰好出现 1 次）。unsafe（独占执行，天然串行）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { expectObject, expectString, writeAtomic } from './common.js';

export const editTool: ToolDefinition = {
  name: 'edit',
  description:
    'Replace `old_text` with `new_text` in a file. ' +
    'Fails unless old_text occurs EXACTLY once (uniqueness guard). Unsafe: serialized per target path.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'File path (absolute, or relative to cwd)' },
      old_text: { type: 'string', description: 'Exact substring to replace (must be unique in the file)' },
      new_text: { type: 'string', description: 'Replacement text' },
    },
    required: ['file_path', 'old_text', 'new_text'],
  },
  // lockKey 不声明：unsafe 调用本就独占执行（串行），按路径加锁是无效实现（P2-7）；
  // lockKey 字段为 Ph3 并发模型预留（见 tools/types.ts）。
  execute: async (rawArgs, ctx) => {
    const args = expectObject(rawArgs, 'edit');
    const filePath = resolve(ctx.cwd, expectString(args, 'file_path', 'edit'));
    const oldText = expectString(args, 'old_text', 'edit');
    const newText = expectString(args, 'new_text', 'edit');
    if (oldText.length === 0) return { error: 'edit: old_text must be non-empty' };

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (e) {
      return { error: `read failed: ${(e as Error).message}` };
    }

    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) return { error: 'old_text not found in file' };
    if (occurrences > 1) {
      return { error: `old_text matches ${occurrences} times; expected exactly 1 (make it more specific)` };
    }
    // 函数形式替换：字符串形式的 new_text 会被解释 `$&`/`` $` ``/`$'`/`$$` 等替换模式，
    // 导致静默损坏文件（P1-2）；函数形式按字面写入。
    writeAtomic(filePath, content.replace(oldText, () => newText));
    return { output: `replaced 1 occurrence in ${filePath}` };
  },
};
