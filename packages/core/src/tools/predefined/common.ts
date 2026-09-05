// 预定义工具共享助手：参数校验、输出截断、原子写。
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
