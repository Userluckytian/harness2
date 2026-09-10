// context-ref：`@file`/`@dir` 引用语法（两路径通用发送前预处理，纯函数便于单测）。
// 在 user message 最前拼接解析出的引用块；终端回显仍用原始输入文本。
// 约定：
//   - `@路径` token 用 /@([^\s"']+)/g 匹配；
//   - 路径先试相对 cwd，找不到再试相对项目 root；
//   - 文件 UTF-8 读取（单文件 64KB 截断保护 + 截断提示）；目录列出直接子项（不递归）；
//   - 失败/不存在跳过并在引用块末尾追加 `[@x 未找到，已忽略]`。
import { existsSync, openSync, readSync, readFileSync, readdirSync, statSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;

/** 匹配 `@路径` token（不含空白/引号；捕获完整路径） */
export const CONTEXT_REF_PATTERN = /@([^\s"']+)/g;

export interface ContextRefOptions {
  /** 发送时工作目录（token 优先相对此解析） */
  cwd: string;
  /** 项目 root（token 在此目录下再试一次） */
  root: string;
  /** 单文件读取上限字节（默认 64KiB） */
  maxFileBytes?: number;
}

export interface ContextRefResult {
  /** 解析出的引用块（拼到 user message 最前；无引用/无可读取项时为空串） */
  header: string;
  /** 是否存在引用 token（含未找到：仍算引用，追加忽略提示） */
  hasRefs: boolean;
}

function resolveRef(path: string, cwd: string, root: string): string | undefined {
  const candidates = [resolve(cwd, path), resolve(root, path)];
  // cwd 与 root 相同时避免重复判断
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return candidate;
  }
  return undefined;
}

function listedContents(dirPath: string): string {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    if (entries.length === 0) return '(空目录)';
    return entries.map((e) => `${e.isDirectory() ? e.name + '/' : e.name}`).join('\n');
  } catch {
    return '(无法读取目录)';
  }
}

/** 发送前展开 `@路径` 引用。返回引用 header（空串=无引用）与是否含引用 token。 */
export function expandContextRefs(input: string, opts: ContextRefOptions): ContextRefResult {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const seen = new Set<string>();
  const missing: string[] = [];
  const blocks: string[] = [];

  CONTEXT_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTEXT_REF_PATTERN.exec(input)) !== null) {
    const token = match[1] ?? '';
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);

    const resolved = resolveRef(token, opts.cwd, opts.root);
    if (resolved === undefined) {
      missing.push(`[@${token} 未找到，已忽略]`);
      continue;
    }
    // 相对路径展示用 token（原样），正文放解析结果
    try {
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        blocks.push(`[@${token} → ${resolved}/]（目录，直接子项）\n${listedContents(resolved)}`);
      } else {
        let content: string;
        let note = '';
        if (stat.size > maxFileBytes) {
          // 限长读取（open/read 前缀 N 字节，避免大文件整体进内存）
          const buf = Buffer.alloc(maxFileBytes);
          const fd = openSync(resolved, 'r');
          let n = 0;
          try {
            n = readSync(fd, buf, 0, maxFileBytes, 0);
          } finally {
            closeSync(fd);
          }
          content = buf.subarray(0, n).toString('utf8');
          note = `（已截断：单文件 > ${Math.round(maxFileBytes / 1024)}KB，仅前 64KB）`;
        } else {
          content = readFileSync(resolved, 'utf8');
        }
        blocks.push(`[@${token} → ${resolved}]${note}\n${content}`);
      }
    } catch {
      missing.push(`[@${token} 读取失败，已忽略]`);
    }
  }

  const hasRefs = seen.size > 0;
  if (!hasRefs) return { header: '', hasRefs: false };

  const parts = [...blocks, ...missing];
  return { header: parts.join('\n\n'), hasRefs: true };
}

export function hasContextRefs(input: string): boolean {
  CONTEXT_REF_PATTERN.lastIndex = 0;
  return CONTEXT_REF_PATTERN.test(input);
}
