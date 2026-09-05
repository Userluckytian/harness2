// 单写者会话写入器：目录锁 + 追加写 + 可选 fsync。
// 崩溃一致性策略（对照 grok persistence）：追加前不截断文件；
// 残行（崩溃导致的半行 JSON）由 open() 恢复 —— 截断到最后一个完整合法事件行边界。
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_LOCK_FILE,
  SESSION_LOG_FILE,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
  type SessionHeaderPayload,
  isSessionEventType,
  parseEventLine,
} from './types.js';

export interface SessionWriterOptions {
  /** 每次追加后 fsync（默认 true；测试可关） */
  fsync?: boolean;
}

export class SessionLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly holderPid: number | null,
  ) {
    super(`session directory is locked by pid ${holderPid ?? 'unknown'}: ${dir}`);
    this.name = 'SessionLockedError';
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程存在但无权限发信号 → 视为存活
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockContent {
  pid: number;
  ts: string;
}

export class SessionWriter {
  private fd = -1;
  private nextSeq = 1;
  private recoveredBytesValue = 0;
  private readonly doFsync: boolean;
  private closed = false;

  private constructor(
    readonly dir: string,
    options: SessionWriterOptions,
  ) {
    this.doFsync = options.fsync ?? true;
  }

  /** 新建会话目录并写入 header 事件（seq=1）。目录已有日志时抛错。 */
  static create(dir: string, header: SessionHeaderPayload, options: SessionWriterOptions = {}): SessionWriter {
    if (existsSync(join(dir, SESSION_LOG_FILE))) {
      throw new Error(`session log already exists: ${join(dir, SESSION_LOG_FILE)}; use open()`);
    }
    mkdirSync(dir, { recursive: true });
    const writer = new SessionWriter(dir, options);
    writer.acquireLock();
    writer.fd = openSync(join(dir, SESSION_LOG_FILE), 'a');
    writer.append('session/header', {
      ...header,
      createdAt: header.createdAt ?? new Date().toISOString(),
    });
    return writer;
  }

  /** 打开既有会话继续追加；自动恢复崩溃残行（见 recoveredBytes）。 */
  static open(dir: string, options: SessionWriterOptions = {}): SessionWriter {
    const logPath = join(dir, SESSION_LOG_FILE);
    if (!existsSync(logPath)) {
      throw new Error(`session log not found: ${logPath}; use create()`);
    }
    const writer = new SessionWriter(dir, options);
    writer.acquireLock();
    writer.recoveredBytesValue = writer.recoverTruncatedTail(logPath);
    const { count, lastSeq } = writer.scanLog(logPath);
    if (lastSeq !== count) {
      throw new Error(`log seq inconsistency in ${logPath}: ${count} lines but last seq is ${lastSeq}`);
    }
    writer.fd = openSync(logPath, 'a');
    writer.nextSeq = lastSeq + 1;
    return writer;
  }

  /** open() 时从崩溃残行恢复所丢弃的字节数（0 表示无需恢复） */
  get recoveredBytes(): number {
    return this.recoveredBytesValue;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  append<T extends SessionEventType>(type: T, payload: SessionEventMap[T]): SessionEvent<T> {
    if (this.closed) throw new Error('writer is closed');
    if (!isSessionEventType(type)) throw new Error(`unknown event type: ${type}`);
    const event: SessionEvent<T> = {
      v: 1,
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      type,
      payload,
    };
    writeSync(this.fd, JSON.stringify(event) + '\n');
    if (this.doFsync) fsyncSync(this.fd);
    this.nextSeq += 1;
    return event;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    unlinkSync(join(this.dir, SESSION_LOCK_FILE));
  }

  private acquireLock(): void {
    const lockPath = join(this.dir, SESSION_LOCK_FILE);
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(lockPath)) {
      let pid: number | undefined;
      try {
        pid = (JSON.parse(readFileSync(lockPath, 'utf8')) as LockContent).pid;
      } catch {
        pid = undefined;
      }
      if (typeof pid === 'number' && isPidAlive(pid)) {
        throw new SessionLockedError(this.dir, pid);
      }
      // 陈旧锁（持锁进程已死）：接管
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() } satisfies LockContent), 'utf8');
  }

  /** 检测并截断文件尾部的崩溃残行。返回丢弃的字节数（0 表示无需恢复）。 */
  private recoverTruncatedTail(logPath: string): number {
    const before = statSync(logPath).size;
    if (before === 0) return 0;
    const lines = readFileSync(logPath).toString('utf8').split('\n');
    let goodBytes = 0;
    for (const line of lines) {
      if (line.length === 0 || parseEventLine(line) === null) break;
      // +1 为行尾换行；Buffer.byteLength 保证多字节字符下的字节精确
      goodBytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    if (goodBytes === before) return 0;
    truncateSync(logPath, goodBytes);
    return before - goodBytes;
  }

  private scanLog(logPath: string): { count: number; lastSeq: number } {
    const lines = readFileSync(logPath).toString('utf8').split('\n');
    let count = 0;
    let lastSeq = 0;
    for (const line of lines) {
      if (line.length === 0) continue;
      const e = parseEventLine(line);
      if (e === null) throw new Error(`corrupt event line in ${logPath}: ${line.slice(0, 80)}`);
      count += 1;
      lastSeq = e.seq;
    }
    return { count, lastSeq };
  }
}
