// 单写者会话写入器：目录锁 + 追加写 + 可选 fsync。
// 崩溃一致性策略（对照 grok persistence）：追加前不截断文件；
// open() 时按字节偏移扫描恢复：换行即提交标记 —— 已提交内容（合法事件行与空行）全部保留；
// 「非空且解析失败」的行及其后内容、以及末尾未以 \n 终止的尾行（无论 JSON 是否完整）
// 视为未提交的撕裂区，截断丢弃。
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  type RewindMarkerPayload,
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
    try {
      writer.fd = openSync(join(dir, SESSION_LOG_FILE), 'a');
      writer.append('session/header', {
        ...header,
        createdAt: header.createdAt ?? new Date().toISOString(),
      });
      return writer;
    } catch (e) {
      writer.releaseOnFailure();
      throw e;
    }
  }

  /** 打开既有会话继续追加；自动恢复崩溃残行（见 recoveredBytes）。 */
  static open(dir: string, options: SessionWriterOptions = {}): SessionWriter {
    const logPath = join(dir, SESSION_LOG_FILE);
    if (!existsSync(logPath)) {
      throw new Error(`session log not found: ${logPath}; use create()`);
    }
    const writer = new SessionWriter(dir, options);
    writer.acquireLock();
    try {
      writer.recoveredBytesValue = writer.recoverTruncatedTail(logPath);
      const { count, lastSeq } = writer.scanLog(logPath);
      if (lastSeq !== count) {
        throw new Error(`log seq inconsistency in ${logPath}: ${count} lines but last seq is ${lastSeq}`);
      }
      writer.fd = openSync(logPath, 'a');
      writer.nextSeq = lastSeq + 1;
      return writer;
    } catch (e) {
      writer.releaseOnFailure();
      throw e;
    }
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
    if (type === 'rewind/marker') {
      // P2-1：rewindToSeq 必须指向本日志中已存在的事件（1..lastSeq），越界在写入口即拒绝
      const n = (payload as RewindMarkerPayload).rewindToSeq;
      if (!Number.isInteger(n) || n < 1 || n > this.lastSeq) {
        throw new Error(`invalid rewind/marker: rewindToSeq ${n} out of range (1..${this.lastSeq})`);
      }
    }
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

  /** create()/open() 取锁后失败时的善后：释放已打开的 fd 并移除锁文件（由调用方 rethrow）。 */
  private releaseOnFailure(): void {
    this.closed = true;
    if (this.fd >= 0) {
      try {
        closeSync(this.fd);
      } catch {
        // fd 已失效则忽略，确保锁文件仍被清理
      }
      this.fd = -1;
    }
    try {
      unlinkSync(join(this.dir, SESSION_LOCK_FILE));
    } catch {
      // 锁文件不存在则无需清理
    }
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

  /**
   * 检测并截断文件尾部的崩溃撕裂区。返回丢弃的字节数（0 表示无需恢复）。
   * 按字节偏移逐行扫描（多字节 UTF-8 安全）：换行即提交标记 ——
   *   - 合法事件行与空行：已提交，保留并继续扫描；
   *   - 非空且 parseEventLine 失败的行：撕裂区起点，该行及其后全部丢弃；
   *   - 末尾未以 \n 终止的尾行：无论 JSON 是否完整，一律视为未提交丢弃。
   * goodBytes 始终不超过文件大小（结构上保证 truncate 不会把文件变长）。
   */
  private recoverTruncatedTail(logPath: string): number {
    const buf = readFileSync(logPath);
    const before = buf.length;
    if (before === 0) return 0;
    let goodBytes = 0;
    let pos = 0;
    while (pos < before) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break; // 尾行无换行 → 未提交，从该行起全部丢弃
      if (nl > pos && parseEventLine(buf.subarray(pos, nl).toString('utf8')) === null) {
        break; // 非空且非法 → 撕裂区起点
      }
      // 空行（nl === pos，保留）或合法事件行（已提交）
      goodBytes = nl + 1;
      pos = nl + 1;
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
