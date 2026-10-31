// 预定义工具共享助手：参数校验、输出截断、原子写。
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function expectObject(args: unknown, tool: string): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`${tool}: arguments must be an object`);
  }
  return args as Record<string, unknown>;
}

export function expectString(obj: Record<string, unknown>, key: string, tool: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new Error(`${tool}: missing required string argument "${key}"`);
  return v;
}

export function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 超长输出截断（追加截断标记，让模型知道内容不完整） */
export function truncateText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n...[truncated ${s.length - maxChars} chars]`;
}

/**
 * 路径边界校验：把模型可控路径解析为 cwd 内的绝对路径。
 * resolve(cwd, p) 后计算 relative(cwd, resolved)：
 *   - ''（恰好是 cwd 本身）→ 允许（glob/grep 默认搜索根就是 cwd）
 *   - 首段为 `..`（POSIX/Windows 分隔符均覆盖）→ 向上逃逸，拒绝
 *   - isAbsolute(rel)（Windows 跨盘符/UNC 时 relative 返回绝对路径）→ 拒绝
 * 越界时抛明确错误；调用方必须在执行任何 IO（readFileSync/fg/spawn/writeAtomic）之前调用，
 * 且不得对越界路径做任何文件操作。
 */
export function resolveWithinCwd(cwd: string, userPath: string, tool: string): string {
  const resolved = resolve(cwd, userPath);
  const rel = relative(cwd, resolved);
  const escaped = rel !== '' && (isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..');
  if (escaped) {
    throw new Error(`${tool}: path escapes workspace (cwd): ${userPath}`);
  }
  return resolved;
}

/**
 * 原子写：同目录临时文件 + rename（跨平台原子替换）。
 * 自动创建父目录；rename 失败时清理临时文件。
 */
export function writeAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件清理失败不影响主错误
    }
    throw e;
  }
}
