// B4 上下文占用水条数据源：调 @harness2/core 的只读 getContextUsage（单一实现）。
// 终端 StatusBar、legacy /context、桌面 B4 水条三处共用同一数据源——这里只负责
// 「sessionId → 会话目录」定位（目录查找，非 token 估算），token 占用估算一律交给
// core 的 getContextUsage(dir)，禁止在 desktop 另算一套（此前本地 char/4 + 200K 兜底已移除）。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getContextUsage } from './core.js';
import type { ContextUsageShape } from '../shared/protocol.js';

/** 会话目录布局：<root>/<encoded-cwd>/<sessionId>/（会话目录本身，含 session.v1.jsonl） */
const SESSIONS_DIR_NAME = 'sessions';

/** 找出 sessionId 对应的会话目录（<...>/session.v1.jsonl 的父目录）。找不到返回 null。 */
function sessionDir(sessionId: string, home?: string): string | null {
  const sessionsRoot = join(home ?? homedir(), '.harness2', SESSIONS_DIR_NAME);
  if (!existsSync(sessionsRoot)) return null;
  for (const cwdDir of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, cwdDir);
    if (!statSync(dir).isDirectory()) continue;
    const candidate = join(dir, sessionId);
    const log = join(candidate, 'session.v1.jsonl');
    if (existsSync(log)) return candidate;
  }
  return null;
}

/**
 * 读会话上下文占用：定位会话目录 → 调 core getContextUsage(dir)。
 * core 返回 undefined（目录缺失/日志损坏/容量无效）→ 显示「—」而非 0%。
 */
export function getContextUsageForSession(sessionId: string, opts: { home?: string } = {}): ContextUsageShape {
  const dir = sessionDir(sessionId, opts.home);
  if (dir === null) return { usage: null, label: '—' };
  const ratio = getContextUsage(dir); // core 只读，同步，0..1 | undefined
  if (ratio === undefined) return { usage: null, label: '—' };
  return { usage: ratio, label: `${Math.round(ratio * 100)}%` };
}

export type { ContextUsageShape };
