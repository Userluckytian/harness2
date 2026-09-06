// 会话管理器：全局集中存储布局（grok 式按 cwd 编码归组）。
// 布局：<root>/<encoded-cwd>/<sessionId>/session.v1.jsonl，root 默认 ~/.harness2/sessions/。
// cwd 编码规则（encodeCwd，纯字符串逐字符映射，不做路径解析，任何平台结果一致）：
//   - 保留可读性：字母/数字/`.`/`_`/`-` 原样保留；
//   - 盘符冒号 `:` 丢弃；路径分隔符 `\` 与 `/` 替换为 `--`（组件间双横线），
//     其余不安全字符（空格/Unicode 等）逐字符替换为 `-`；
//     例：`D:\a\b` → `D--a--b`、`/home/u` → `--home--u`、`C:\` → `C--`；
//   - 编码不保证双射（如 `a:b` 与 `ab` 同码）；cwd 真值以 session/header.cwd 为准；
//   - 编码结果超过 120 字符时截断并追加 sha1 前 8 位防碰撞（写入与查找用同一函数，结果确定）。
// 列表/搜索为只读（loadSession 不截断日志）；resume 打开 writer，沿用其崩溃残行恢复语义。
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeProjection, loadSession, type ProjectionMessage } from './reader.js';
import { SESSION_LOG_FILE, type SessionHeaderPayload } from './types.js';
import { SessionWriter } from './writer.js';

/** ~/.harness2 下的会话存储目录名 */
export const SESSIONS_DIR_NAME = 'sessions';

/** 会话摘要展示宽度（首条用户消息/命中片段 ≤60 字） */
export const SUMMARY_TEXT_MAX = 60;

export function defaultSessionsRoot(home?: string): string {
  return join(home ?? homedir(), '.harness2', SESSIONS_DIR_NAME);
}

/** cwd → 组目录名（规则见文件头注释；纯字符串映射，任何平台结果一致） */
export function encodeCwd(cwd: string): string {
  let name = '';
  for (const ch of cwd) {
    if (/[A-Za-z0-9._-]/.test(ch)) name += ch;
    else if (ch === ':') name += ''; // 盘符冒号丢弃
    else if (ch === '\\' || ch === '/') name += '--'; // 路径分隔符 → 双横线
    else name += '-'; // 其余不安全字符
  }
  if (name.length > 120) {
    name = `${name.slice(0, 112)}-${createHash('sha1').update(cwd).digest('hex').slice(0, 8)}`;
  }
  return name;
}

/** 截断摘要文本（≤60 字，超长加省略号） */
function summarize(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= SUMMARY_TEXT_MAX ? t : `${t.slice(0, SUMMARY_TEXT_MAX)}…`;
}

/** 会话摘要（列表/搜索共用的基础形态） */
export interface SessionSummary {
  id: string;
  dir: string;
  /** header.cwd 真值（旧日志可缺省） */
  cwd?: string;
  /** 主日志文件修改时间（ms） */
  mtimeMs: number;
  /** 首条活动用户消息摘要（≤60 字；无则空串） */
  firstUserText: string;
  /** 活动消息数（user+assistant 投影） */
  messageCount: number;
  /** 日志最后一个事件的 seq */
  lastSeq: number;
}

export interface SessionSearchHit extends SessionSummary {
  /** 命中的消息片段（≤60 字，最多 3 条） */
  hits: Array<{ role: ProjectionMessage['role']; seq: number; snippet: string }>;
}

export interface SessionCreateResult {
  id: string;
  dir: string;
  writer: SessionWriter;
}

export interface SessionResumeResult {
  id: string;
  dir: string;
  writer: SessionWriter;
  header: SessionHeaderPayload | null;
  /** open() 恢复的崩溃残行字节数（0 = 无） */
  recoveredBytes: number;
}

function summarizeSession(id: string, dir: string): SessionSummary {
  const logPath = join(dir, SESSION_LOG_FILE);
  const session = loadSession(dir); // 只读；非法行跳过并进 warnings（此处忽略告警）
  const messages = computeProjection(session).messages;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(logPath).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    id,
    dir,
    ...(session.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    mtimeMs,
    firstUserText: firstUser ? summarize(firstUser.text) : '',
    messageCount: messages.length,
    lastSeq: session.events.at(-1)?.event.seq ?? 0,
  };
}

export class SessionManager {
  constructor(readonly root: string = defaultSessionsRoot()) {}

  private groupDir(cwd: string): string {
    return join(this.root, encodeCwd(resolve(cwd)));
  }

  /** 生成会话 id：UTC 时间戳前缀（可读）+ 随机后缀；全库查重防碰撞 */
  private generateId(): string {
    const d = new Date();
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    for (let i = 0; i < 5; i++) {
      const id = `${stamp}-${randomBytes(3).toString('hex')}`;
      if (this.findAllGroupsWithId(id).length === 0) return id;
    }
    throw new Error('failed to generate a unique session id');
  }

  /** 在全部组中查找包含指定 id 的会话目录（存在性检查） */
  private findAllGroupsWithId(id: string): string[] {
    return this.listGroupDirs()
      .map((group) => join(group, id))
      .filter((dir) => existsSync(join(dir, SESSION_LOG_FILE)));
  }

  private listGroupDirs(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(this.root, e.name));
  }

  /**
   * 新建会话：root/组目录缺失时自动创建（含 ~/.harness2 链）；
   * header 写入 sessionId 与 cwd 真值；fork 血缘字段（阶段 5 预留）由 forkSession 传入。
   */
  create(
    cwd: string,
    opts: {
      id?: string;
      fsync?: boolean;
      /** fork 血缘：派生自哪个会话 */
      parentSession?: string;
      isSeeded?: boolean;
    } = {},
  ): SessionCreateResult {
    const id = opts.id ?? this.generateId();
    const dir = join(this.groupDir(cwd), id);
    const writer = SessionWriter.create(
      dir,
      {
        sessionId: id,
        cwd: resolve(cwd),
        ...(opts.parentSession !== undefined ? { parentSession: opts.parentSession } : {}),
        ...(opts.isSeeded !== undefined ? { isSeeded: opts.isSeeded } : {}),
      },
      { fsync: opts.fsync ?? true },
    );
    return { id, dir, writer };
  }

  /**
   * 列出会话摘要（mtime 倒序）。cwd 提供时只列该 cwd 组；否则全库。
   * 搜索用子串匹配的轻量实现（SQLite/FTS 明确不做，见阶段计划）。
   */
  list(cwd?: string): SessionSummary[] {
    const groups = cwd === undefined ? this.listGroupDirs() : [this.groupDir(cwd)];
    const summaries: SessionSummary[] = [];
    for (const group of groups) {
      if (!existsSync(group)) continue;
      for (const entry of readdirSync(group, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(group, entry.name);
        if (!existsSync(join(dir, SESSION_LOG_FILE))) continue;
        try {
          summaries.push(summarizeSession(entry.name, dir));
        } catch {
          // 损坏会话不阻塞列表
        }
      }
    }
    return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * 会话搜索：活动 user/assistant 消息文本的子串命中（大小写不敏感）。
   * cwd 提供时只搜该 cwd 组。返回带命中片段的会话列表（mtime 倒序）。
   */
  search(cwd: string | undefined, text: string): SessionSearchHit[] {
    const needle = text.toLowerCase();
    if (needle.length === 0) return [];
    return this.list(cwd)
      .map((s): SessionSearchHit | null => {
        const session = loadSession(s.dir);
        const messages = computeProjection(session).messages;
        const hits: SessionSearchHit['hits'] = [];
        for (const m of messages) {
          const idx = m.text.toLowerCase().indexOf(needle);
          if (idx === -1) continue;
          const start = Math.max(0, Math.min(idx - 16, m.text.length - SUMMARY_TEXT_MAX));
          hits.push({ role: m.role, seq: m.seq, snippet: summarize(m.text.slice(start)) });
          if (hits.length >= 3) break;
        }
        return hits.length > 0 ? { ...s, hits } : null;
      })
      .filter((x): x is SessionSearchHit => x !== null);
  }

  /**
   * 只读定位会话目录（阶段 5）：cwd 提供时直查组目录，否则全库查找；命中多组取 mtime 最新。
   * 不打开 writer、不取目录锁——服务层读事件日志（GET /events）用，可与持锁写者并存。
   * 找不到抛 `session not found: <id>`（与 resume一致）。
   */
  locate(id: string, opts: { cwd?: string } = {}): string {
    let dir: string | undefined;
    if (opts.cwd !== undefined) {
      const candidate = join(this.groupDir(opts.cwd), id);
      if (existsSync(join(candidate, SESSION_LOG_FILE))) dir = candidate;
    } else {
      const candidates = this.findAllGroupsWithId(id).filter((d) => {
        try {
          return statSync(join(d, SESSION_LOG_FILE)).mtimeMs > 0;
        } catch {
          return false;
        }
      });
      if (candidates.length > 1) {
        candidates.sort(
          (a, b) => statSync(join(b, SESSION_LOG_FILE)).mtimeMs - statSync(join(a, SESSION_LOG_FILE)).mtimeMs,
        );
      }
      dir = candidates[0];
    }
    if (dir === undefined) {
      throw new Error(`session not found: ${id}`);
    }
    return dir;
  }

  /**
   * 恢复会话：locate 定位后打开 writer（崩溃残行恢复语义沿用 SessionWriter.open）。
   */
  resume(id: string, opts: { cwd?: string; fsync?: boolean } = {}): SessionResumeResult {
    const dir = this.locate(id, { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
    const header = loadSession(dir).header;
    const writer = SessionWriter.open(dir, { fsync: opts.fsync ?? true });
    return { id, dir, writer, header, recoveredBytes: writer.recoveredBytes };
  }
}
