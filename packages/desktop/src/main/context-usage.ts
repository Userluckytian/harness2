// B4 上下文占用水条数据源：优先调 @harness2/core 的只读 getContextUsage(sessionId)
// （由终端轨道 T6 独家新增，桌面只调用同一导出，不在 desktop 另算一套）。
// 当前 core 尚未落地该导出 → 提供「本地只读换算兜底」让 IPC 通路与 UI 先行可用；
// core 的 getContextUsage 一旦出现（import 动态探测），即切换为唯一实现。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContextUsageShape } from '../shared/protocol.js';

/** 估算 token：字符数 / 4（与 core agent/compaction 的近似口径一致，纯只读换算） */
const CHARS_PER_TOKEN = 4;

/** 会话目录布局：<root>/<encoded-cwd>/<sessionId>/session.v1.jsonl（与 session/manager 一致） */
const SESSIONS_DIR_NAME = 'sessions';
const SESSION_LOG_FILE = 'session.v1.jsonl';

function sessionLogPath(sessionId: string, home?: string): string | null {
  const sessionsRoot = join(home ?? homedir(), '.harness2', SESSIONS_DIR_NAME);
  if (!existsSync(sessionsRoot)) return null;
  const entries = readdirRecursive(sessionsRoot);
  for (const dir of entries) {
    const p = join(dir, sessionId, SESSION_LOG_FILE);
    if (existsSync(p)) return p;
  }
  return null;
}

function readdirRecursive(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(p);
  }
  return out;
}

/** 会话日志字节 → 活动文本 token 估算（只读；不含快照/其他文件） */
function estimateTokens(logPath: string): number {
  try {
    const bytes = readFileSync(logPath, 'utf8');
    // 只统计可见活动事件里的文本字段，粗估：整个文件字符 / 每 token 字符数
    return Math.floor(bytes.length / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

export interface ContextUsageResult {
  usage: number | null;
  label: string;
}

/**
 * 读取会话上下文占用：优先 core getContextUsage（终端轨道 T6 提供）；
 * 未落地时用本地只读换算兜底（估算值与终端 /context 口径同为"字符/4"级近似，
 * 非精确一致——merge 时以 core 导出为准）。
 */
export function getContextUsageFallback(sessionId: string, opts: { home?: string } = {}): ContextUsageShape {
  const logPath = sessionLogPath(sessionId, opts.home);
  if (logPath === null) return { usage: null, label: '—' };
  const tokens = estimateTokens(logPath);
  // 缺省上下文预算：200K token（UI 占位；core getContextUsage 落地后以模型 contextWindow 为准）
  const window = 200_000;
  const usage = Math.min(1, tokens / window);
  return { usage, label: `${Math.round(usage * 100)}%` };
}

export type { ContextUsageShape };