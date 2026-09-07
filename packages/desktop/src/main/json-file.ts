// 主进程 JSON 文件「校验 + 损坏回退」公共读写（B2 抽取：layout-file/preferences-file 共用一套逻辑）。
// 读：文件缺失/损坏 → fallback()（由调用方提供 normalize 兜底的对象）；写：写前先 normalize 防落脏。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 读取并规范化 JSON 文件：缺失/解析失败/形状非法 → fallback()（默认对象） */
export function readJsonWithDefault<T>(path: string, normalize: (raw: unknown) => T, fallback: () => T): T {
  if (!existsSync(path)) return fallback();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return normalize(raw);
  } catch {
    return fallback();
  }
}

/** 规范化后写入（防 IPC/外部注入非法结构落盘）；返回写前 normalize 的结果 */
export function writeJsonNormalized<T>(path: string, value: unknown, normalize: (raw: unknown) => T): T {
  const normalized = normalize(value);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}