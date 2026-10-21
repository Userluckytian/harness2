// 会话目录侧车 meta（pinned/archived/unread/unreadAt）读写。
// 事实源：~/.harness2/sessions/<encoded-cwd>/<sessionId>/session-meta.json
// 原子写（temp + rename）；损坏 JSON 视为空并容错。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionMeta {
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  unreadAt?: number;
}

export interface NormalizedSessionMeta {
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  unreadAt?: number;
}

const META_FILE = 'session-meta.json';

export function sessionMetaPath(dir: string): string {
  return join(dir, META_FILE);
}

export function readSessionMeta(dir: string): NormalizedSessionMeta {
  const p = sessionMetaPath(dir);
  if (!existsSync(p)) {
    return { pinned: false, archived: false, unread: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    // 损坏 JSON → 视为空
    return { pinned: false, archived: false, unread: false };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { pinned: false, archived: false, unread: false };
  }
  const r = raw as Record<string, unknown>;
  const unreadAt = typeof r.unreadAt === 'number' && Number.isFinite(r.unreadAt) ? r.unreadAt : undefined;
  return {
    pinned: r.pinned === true,
    archived: r.archived === true,
    unread: r.unread === true,
    ...(unreadAt !== undefined ? { unreadAt } : {}),
  };
}

export function writeSessionMeta(dir: string, patch: SessionMeta = {}): NormalizedSessionMeta {
  const current = readSessionMeta(dir);
  const pinned = patch.pinned !== undefined ? patch.pinned === true : current.pinned;
  const archived = patch.archived !== undefined ? patch.archived === true : current.archived;
  const unread = patch.unread !== undefined ? patch.unread === true : current.unread;

  let unreadAt: number | undefined;
  if (patch.unread === true) {
    unreadAt = typeof patch.unreadAt === 'number' ? patch.unreadAt : Date.now();
  } else if (patch.unread === false) {
    unreadAt = undefined;
  } else if (patch.unreadAt !== undefined) {
    unreadAt = patch.unreadAt;
  } else {
    unreadAt = current.unreadAt;
  }

  const next: NormalizedSessionMeta = {
    pinned,
    archived,
    unread,
    ...(unreadAt !== undefined ? { unreadAt } : {}),
  };

  const tmp = join(dir, `${META_FILE}.tmp`);
  const payloadObj: Record<string, unknown> = {};
  if (next.pinned) payloadObj.pinned = true;
  if (next.archived) payloadObj.archived = true;
  if (next.unread) payloadObj.unread = true;
  if (next.unreadAt !== undefined) payloadObj.unreadAt = next.unreadAt;
  writeFileSync(tmp, JSON.stringify(payloadObj, null, 2), 'utf8');
  renameSync(tmp, sessionMetaPath(dir));
  return next;
}
