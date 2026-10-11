// 轨迹视图的展示格式化（纯函数；全部对「未知」显式留空或如实写「未记录」，不写 0 冒充）。
import type { TrajectoryUsage } from './types.js';

/** 缺省占位（UI 统一的「没有数据」文案，便于断言） */
export const MISSING_VALUE = '未记录';

/** 耗时：null → ''（调用方决定是否显示占位）；<1s 用 ms，否则用 s */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * 时钟（UTC HH:MM:SS.mmm）。刻意用 UTC 而非本地时区：本仓测试与 CI 跨时区，
 * 本地格式化会让同一份日志在不同机器上产生不同字符串（不可断言）。
 */
export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(11, 23);
}

/** token 用量：缺失字段如实写「未记录」，不补 0 */
export function formatUsage(usage: TrajectoryUsage | undefined): string {
  if (usage === undefined) return MISSING_VALUE;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return MISSING_VALUE;
  const parts: string[] = [];
  parts.push(`输入 ${usage.inputTokens !== undefined ? String(usage.inputTokens) : MISSING_VALUE}`);
  parts.push(`输出 ${usage.outputTokens !== undefined ? String(usage.outputTokens) : MISSING_VALUE}`);
  return parts.join(' / ');
}
/** 绝对值 → 序列化预览（不可序列化如实说明，不抛错） */
export function previewValue(value: unknown, maxLength = 400): string {
  if (value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return '<不可序列化>';
    }
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** 文本截断（正文预览；省略号显式，避免误以为内容就到这里） */
export function truncate(text: string, maxLength = 400): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
