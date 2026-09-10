// 版本化 runtime journal（S3a）：每 session `runtime.v1.jsonl` 的操作状态账本。
// 只记录操作状态（accepted queue、去重、task lifecycle、call started/outcome、恢复水位），
// 不存第二套对话正文（对话正文仍是 session.log 投影）。
// 与 session.log 跨文件无原子事务 → 提供稳定 ID 可恢复对账（judgeSubmission）：
// 先 durable accepted 后 ack；崩溃后扫描已有事件判断未启动/已启动/unknown，不能盲目再追加或执行。
// 单写者：同进程并发写经 in-process 注册表守卫，跨进程经 pid 锁文件 + 陈旧锁接管。
//
// 禁止 import session/*（避免循环依赖）：只依赖 interaction/types.ts 与 node:fs/path。
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
import { join, resolve } from 'node:path';
import { TASK_STATES, TASK_TERMINAL_STATES, canTaskTransition, isNonNegativeInteger, isSubmitIntent } from './types.js';
import type { CallId, ClientMessageId, RequestId, SessionId, SubmitIntent, TaskId, TaskState } from './types.js';

export const RUNTIME_JOURNAL_FILE = 'runtime.v1.jsonl';
export const RUNTIME_JOURNAL_LOCK_FILE = 'runtime.v1.lock';
export const RUNTIME_JOURNAL_VERSION = 1;

// —— 行类型（JSONL 每行 = 一条账本事件；字段现在就定，对齐 S0 TaskContract/CallId 语义） ——

export interface RuntimeJournalEntryBase {
  v: 1;
  /** 单调 seq（1 起始，无 header） */
  seq: number;
  /** ISO8601 写入时间 */
  ts: string;
}

export interface QueueAcceptedEntry extends RuntimeJournalEntryBase {
  kind: 'queue/accepted';
  /** 幂等键 = 提交时的 clientMessageId（S3b 去重/receipt 复用） */
  clientMessageId: ClientMessageId;
  sessionId: SessionId;
  payload: { intent: SubmitIntent; queueSeq?: number };
}

export interface QueueDuplicateEntry extends RuntimeJournalEntryBase {
  kind: 'queue/duplicate';
  clientMessageId: ClientMessageId;
  /** 已 durable 的首次 accept seq（同 id 再提交 → 返回既有 receipt） */
  payload: { originalSeq: number };
}

export interface QueueRemovedEntry extends RuntimeJournalEntryBase {
  kind: 'queue/removed';
  clientMessageId: ClientMessageId;
  payload?: { reason?: string };
}

export interface TaskTransitionEntry extends RuntimeJournalEntryBase {
  kind: 'task/transition';
  taskId: TaskId;
  parentTaskId?: TaskId;
  /** 溯源到提交（可选；judge 判 outcome 依赖该字段） */
  clientMessageId?: ClientMessageId;
  /**
   * FixC E1：本账本行写入时该会话 session.log 的 lastSeq 水位（加性；旧账本可缺省）。
   * 供 plan-state 目标锚定：目标 = session.log 内 seq <= 水位的最后活动 user/message
   * （同一时间线单调、不依赖跨文件时钟）。
   */
  sessionLogSeq?: number;
  payload: { from: TaskState; to: TaskState; background?: boolean };
}

export interface CallStartedEntry extends RuntimeJournalEntryBase {
  kind: 'call/started';
  callId: CallId;
  taskId?: TaskId;
  clientMessageId?: ClientMessageId;
  payload: { tool?: string; requestId?: RequestId };
}

export interface CallOutcomeEntry extends RuntimeJournalEntryBase {
  kind: 'call/outcome';
  callId: CallId;
  taskId?: TaskId;
  payload: { ok: boolean; error?: string };
}

export type RuntimeJournalEntry =
  | QueueAcceptedEntry
  | QueueDuplicateEntry
  | QueueRemovedEntry
  | TaskTransitionEntry
  | CallStartedEntry
  | CallOutcomeEntry;

export type RuntimeJournalKind = RuntimeJournalEntry['kind'];

/** append 入参：v/seq/ts 由写入器补，调用方只给 kind + 内容 */
export type JournalAppendInput =
  | {
      kind: 'queue/accepted';
      clientMessageId: ClientMessageId;
      sessionId: SessionId;
      intent: SubmitIntent;
      queueSeq?: number;
    }
  | { kind: 'queue/duplicate'; clientMessageId: ClientMessageId; originalSeq: number }
  | { kind: 'queue/removed'; clientMessageId: ClientMessageId; reason?: string }
  | {
      kind: 'task/transition';
      taskId: TaskId;
      parentTaskId?: TaskId;
      clientMessageId?: ClientMessageId;
      sessionLogSeq?: number;
      from: TaskState;
      to: TaskState;
      background?: boolean;
    }
  | {
      kind: 'call/started';
      callId: CallId;
      taskId?: TaskId;
      clientMessageId?: ClientMessageId;
      tool?: string;
      requestId?: RequestId;
    }
  | { kind: 'call/outcome'; callId: CallId; taskId?: TaskId; ok: boolean; error?: string };

// —— 恢复水位 ——

export type JournalWatermarkReason = 'clean' | 'eof-partial' | 'corrupt-line';

export interface JournalWatermark {
  /** 最后一条完整落盘行的 seq（0 = 空 journal）；崩溃后只信任该水位之前的行 */
  lastSeq: number;
  /** durable 完整行数量 */
  lineCount: number;
  /** 是否干净读到 EOF（无丢弃） */
  complete: boolean;
  /** 是否存在丢弃（半行 / 损坏区） */
  truncated: boolean;
  reason: JournalWatermarkReason;
  /** 丢弃字节数（半行或损坏区起点至 EOF） */
  tornBytes: number;
  /** 可信前缀字节数（open() 恢复截断到该偏移） */
  durableBytes: number;
}

// —— 对账 ——

export type SubmissionStatus = 'not_started' | 'started' | 'unknown';

export interface SubmissionJudgement {
  status: SubmissionStatus;
  /** status=started 时细分：in-flight=已 durable accepted 无 outcome；completed=存在 outcome */
  phase?: 'in-flight' | 'completed';
  /** durable accepted 行的 seq */
  acceptedSeq?: number;
  /** 本次扫描是否丢弃过尾部（半行/损坏区） */
  truncated: boolean;
}

// —— 错误 ——

export class RuntimeJournalLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly holderPid: number | null,
  ) {
    super(`runtime journal is locked by pid ${holderPid ?? 'unknown'}: ${dir}`);
    this.name = 'RuntimeJournalLockedError';
  }
}

export class InvalidJournalAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJournalAppendError';
  }
}

// —— 基础工具 ——

function journalPath(dir: string): string {
  return join(resolve(dir), RUNTIME_JOURNAL_FILE);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// —— 解析（读回；与写入互为校验） ——

/** 单行 JSONL → 账本事件；解析/形状/必填字段不合法返回 null */
export function parseEntry(line: string): RuntimeJournalEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['v'] !== 1) return null;
  if (typeof raw['seq'] !== 'number' || !Number.isInteger(raw['seq']) || raw['seq'] < 1) return null;
  if (typeof raw['ts'] !== 'string' || Number.isNaN(Date.parse(raw['ts']))) return null;
  const kind = raw['kind'];
  if (
    typeof kind !== 'string' ||
    (kind !== 'queue/accepted' &&
      kind !== 'queue/duplicate' &&
      kind !== 'queue/removed' &&
      kind !== 'task/transition' &&
      kind !== 'call/started' &&
      kind !== 'call/outcome')
  ) {
    return null;
  }
  const payload = raw['payload'];
  if (payload !== undefined && !isRecord(payload)) return null;

  const base = { v: 1 as const, seq: raw['seq'] as number, ts: raw['ts'] as string, kind: kind as RuntimeJournalKind };

  switch (kind) {
    case 'queue/accepted': {
      if (!isNonEmptyString(raw['clientMessageId']) || !isNonEmptyString(raw['sessionId'])) return null;
      const p = payload as Record<string, unknown> | undefined;
      if (!p || !isSubmitIntent(p['intent'])) return null;
      if (p['queueSeq'] !== undefined && !isNonNegativeInteger(p['queueSeq'])) return null;
      const entry: QueueAcceptedEntry = {
        ...base,
        kind: 'queue/accepted',
        clientMessageId: raw['clientMessageId'],
        sessionId: raw['sessionId'],
        payload: { intent: p['intent'], queueSeq: isNonNegativeInteger(p['queueSeq']) ? p['queueSeq'] : undefined },
      };
      return entry;
    }
    case 'queue/duplicate': {
      if (!isNonEmptyString(raw['clientMessageId'])) return null;
      const p = payload as Record<string, unknown> | undefined;
      if (!p || typeof p['originalSeq'] !== 'number' || !Number.isInteger(p['originalSeq']) || p['originalSeq'] < 1)
        return null;
      const entry: QueueDuplicateEntry = {
        ...base,
        kind: 'queue/duplicate',
        clientMessageId: raw['clientMessageId'],
        payload: { originalSeq: p['originalSeq'] },
      };
      return entry;
    }
    case 'queue/removed': {
      if (!isNonEmptyString(raw['clientMessageId'])) return null;
      const p = payload as Record<string, unknown> | undefined;
      if (p && p['reason'] !== undefined && typeof p['reason'] !== 'string') return null;
      const entry: QueueRemovedEntry = {
        ...base,
        kind: 'queue/removed',
        clientMessageId: raw['clientMessageId'],
        payload: p && p['reason'] !== undefined ? { reason: p['reason'] as string } : undefined,
      };
      return entry;
    }
    case 'task/transition': {
      if (!isNonEmptyString(raw['taskId'])) return null;
      if (raw['parentTaskId'] !== undefined && !isNonEmptyString(raw['parentTaskId'])) return null;
      if (raw['clientMessageId'] !== undefined && !isNonEmptyString(raw['clientMessageId'])) return null;
      if (raw['sessionLogSeq'] !== undefined && !isNonNegativeInteger(raw['sessionLogSeq'])) return null;
      const p = payload as Record<string, unknown> | undefined;
      if (!p || !isTaskState(p['from']) || !isTaskState(p['to'])) return null;
      const entry: TaskTransitionEntry = {
        ...base,
        kind: 'task/transition',
        taskId: raw['taskId'],
        parentTaskId: isNonEmptyString(raw['parentTaskId']) ? raw['parentTaskId'] : undefined,
        clientMessageId: isNonEmptyString(raw['clientMessageId']) ? raw['clientMessageId'] : undefined,
        sessionLogSeq: isNonNegativeInteger(raw['sessionLogSeq']) ? raw['sessionLogSeq'] : undefined,
        payload: {
          from: p['from'],
          to: p['to'],
          background: p['background'] === undefined ? undefined : Boolean(p['background']),
        },
      };
      return entry;
    }
    case 'call/started': {
      if (!isNonEmptyString(raw['callId'])) return null;
      if (raw['taskId'] !== undefined && !isNonEmptyString(raw['taskId'])) return null;
      if (raw['clientMessageId'] !== undefined && !isNonEmptyString(raw['clientMessageId'])) return null;
      const p = payload as Record<string, unknown> | undefined;
      if (p && p['tool'] !== undefined && typeof p['tool'] !== 'string') return null;
      if (p && p['requestId'] !== undefined && typeof p['requestId'] !== 'string') return null;
      const entry: CallStartedEntry = {
        ...base,
        kind: 'call/started',
        callId: raw['callId'],
        taskId: isNonEmptyString(raw['taskId']) ? raw['taskId'] : undefined,
        clientMessageId: isNonEmptyString(raw['clientMessageId']) ? raw['clientMessageId'] : undefined,
        payload: {
          tool: p && p['tool'] !== undefined ? (p['tool'] as string) : undefined,
          requestId: p && p['requestId'] !== undefined ? (p['requestId'] as string) : undefined,
        },
      };
      return entry;
    }
    case 'call/outcome': {
      if (!isNonEmptyString(raw['callId'])) return null;
      if (raw['taskId'] !== undefined && !isNonEmptyString(raw['taskId'])) return null;
      const p = payload as Record<string, unknown> | undefined;
      if (!p || typeof p['ok'] !== 'boolean') return null;
      if (p['error'] !== undefined && typeof p['error'] !== 'string') return null;
      const entry: CallOutcomeEntry = {
        ...base,
        kind: 'call/outcome',
        callId: raw['callId'],
        taskId: isNonEmptyString(raw['taskId']) ? raw['taskId'] : undefined,
        payload: { ok: p['ok'], error: p['error'] === undefined ? undefined : (p['error'] as string) },
      };
      return entry;
    }
    default:
      return null;
  }
}

// —— 扫描（只读；不改文件） ——

interface ScanResult {
  entries: RuntimeJournalEntry[];
  watermark: JournalWatermark;
}

function emptyWatermark(): JournalWatermark {
  return {
    lastSeq: 0,
    lineCount: 0,
    complete: true,
    truncated: false,
    reason: 'clean',
    tornBytes: 0,
    durableBytes: 0,
  };
}

function scanBuffer(buf: Buffer): ScanResult {
  const len = buf.length;
  if (len === 0) return { entries: [], watermark: emptyWatermark() };

  const entries: RuntimeJournalEntry[] = [];
  let pos = 0;
  let durableBytes = 0;
  let expectedSeq = 1;
  let reason: JournalWatermarkReason = 'clean';
  let tornBytes = 0;

  while (pos < len) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) {
      // 半行：未以 \n 终止的尾行 → 未提交，丢弃（即使 JSON 完整）
      reason = 'eof-partial';
      tornBytes = len - pos;
      break;
    }
    if (nl > pos) {
      // 非空行：必须是合法 entry 且 seq 连续，否则该行及之后全部视为损坏区
      const entry = parseEntry(buf.subarray(pos, nl).toString('utf8'));
      if (entry === null || entry.seq !== expectedSeq) {
        reason = 'corrupt-line';
        tornBytes = len - pos;
        break;
      }
      entries.push(entry);
      expectedSeq = entry.seq + 1;
    }
    // 空行（nl === pos）保留跳过（同 session writer 语义）
    durableBytes = nl + 1;
    pos = nl + 1;
  }

  const lastSeq = entries.length > 0 ? (entries.at(-1) as RuntimeJournalEntry).seq : 0;
  const watermark: JournalWatermark = {
    lastSeq,
    lineCount: entries.length,
    complete: reason === 'clean',
    truncated: reason !== 'clean',
    reason,
    tornBytes,
    durableBytes,
  };
  return { entries, watermark };
}

function scanJournal(path: string): ScanResult {
  if (!existsSync(path)) return { entries: [], watermark: emptyWatermark() };
  return scanBuffer(readFileSync(path));
}

// —— 只读独立原语（恢复时无写者、不取锁；跨进程可用） ——

/** 读恢复水位：仅信任完整落盘行；EOF 半行丢弃并标记 truncated */
export function readWatermark(dir: string): JournalWatermark {
  return scanJournal(journalPath(dir)).watermark;
}

/** 读全部 durable 事件（半行截断不计入） */
export function readEntries(dir: string): ScanResult {
  return scanJournal(journalPath(dir));
}

/** 按 id 扫描/查询：kind 决定主键（queue*→clientMessageId / task→taskId / call→callId） */
export function queryJournalById(dir: string, kind: RuntimeJournalKind, id: string): RuntimeJournalEntry[] {
  return scanJournal(journalPath(dir)).entries.filter((e) => {
    switch (kind) {
      case 'queue/accepted':
        return e.kind === 'queue/accepted' && e.clientMessageId === id;
      case 'queue/duplicate':
        return e.kind === 'queue/duplicate' && e.clientMessageId === id;
      case 'queue/removed':
        return e.kind === 'queue/removed' && e.clientMessageId === id;
      case 'task/transition':
        return e.kind === 'task/transition' && e.taskId === id;
      case 'call/started':
        return e.kind === 'call/started' && e.callId === id;
      case 'call/outcome':
        return e.kind === 'call/outcome' && e.callId === id;
      default:
        return false;
    }
  });
}

function hasTerminalOutcome(entries: RuntimeJournalEntry[], acceptedSeq: number, clientMessageId: string): boolean {
  return entries.some(
    (e) =>
      e.seq > acceptedSeq &&
      e.kind === 'task/transition' &&
      e.clientMessageId === clientMessageId &&
      TASK_TERMINAL_STATES.has(e.payload.to),
  );
}

/**
 * 对账：某 clientMessageId/submit 是「未启动 / 已启动 / 未知」。
 * - 从未写入（无 queue/accepted）→ not_started；
 * - durable accepted 且无后续 outcome → started(in-flight)；
 * - durable accepted + 后续 outcome → started(completed)；
 * - 中部损坏（corrupt-line）：可信前缀内已 accepted → started（保守 in-flight）；
 *   否则 → unknown（≠ rejected/not_started，不得盲目再追加或执行）。
 * - unknown 关键约束：调用方不得把 unknown 当 rejected/not_started 处理。
 */
export function judgeSubmission(dir: string, clientMessageId: ClientMessageId): SubmissionJudgement {
  if (!isNonEmptyString(clientMessageId))
    throw new InvalidJournalAppendError('judgeSubmission: clientMessageId must be a non-empty string');
  const { entries, watermark } = scanJournal(journalPath(dir));
  const accepted = entries.filter((e) => e.kind === 'queue/accepted' && e.clientMessageId === clientMessageId);

  if (watermark.reason === 'corrupt-line') {
    // 损坏区之后不可信：已 durable accepted 在可信前缀 → started；否则无法确认 → unknown
    if (accepted.length > 0) {
      const acceptedSeq = (accepted[0] as QueueAcceptedEntry).seq;
      return {
        status: 'started',
        phase: hasTerminalOutcome(entries, acceptedSeq, clientMessageId) ? 'completed' : 'in-flight',
        acceptedSeq,
        truncated: true,
      };
    }
    return { status: 'unknown', truncated: true };
  }

  if (accepted.length === 0) return { status: 'not_started', truncated: watermark.truncated };

  const acceptedSeq = (accepted[0] as QueueAcceptedEntry).seq;
  return {
    status: 'started',
    phase: hasTerminalOutcome(entries, acceptedSeq, clientMessageId) ? 'completed' : 'in-flight',
    acceptedSeq,
    truncated: watermark.truncated,
  };
}

// —— 单写者写入器 ——

/** 同进程已持锁的 journal 目录（in-process 单写守卫；跨进程靠 pid 锁文件） */
const activeWriters = new Set<string>();

export interface RuntimeJournalOptions {
  /** 每次追加后 fsync（默认 true；测试可关） */
  fsync?: boolean;
}

export class RuntimeJournal {
  private readonly dir: string;
  private readonly path: string;
  private readonly lockPath: string;
  private readonly doFsync: boolean;
  private fd = -1;
  private nextSeq = 1;
  private recoveredBytesValue = 0;
  private closed = false;

  private constructor(dir: string, options: RuntimeJournalOptions) {
    this.dir = resolve(dir);
    this.path = join(this.dir, RUNTIME_JOURNAL_FILE);
    this.lockPath = join(this.dir, RUNTIME_JOURNAL_LOCK_FILE);
    this.doFsync = options.fsync ?? true;
  }

  /** 新建 journal 并持锁。已存在 → 抛错（用 open()）。单写者守卫优先于存在性检查。 */
  static create(dir: string, options: RuntimeJournalOptions = {}): RuntimeJournal {
    const j = new RuntimeJournal(dir, options);
    mkdirSync(j.dir, { recursive: true });
    j.acquireLock();
    try {
      if (existsSync(j.path)) {
        throw new Error(`runtime journal already exists: ${j.path}; use open()`);
      }
      j.fd = openSync(j.path, 'a');
      return j;
    } catch (e) {
      j.releaseOnFailure();
      throw e;
    }
  }

  /** 打开既有 journal 续写；自动恢复崩溃撕裂区（半行截断/损坏区截断），recoveredBytes 记录丢弃字节数。 */
  static open(dir: string, options: RuntimeJournalOptions = {}): RuntimeJournal {
    const j = new RuntimeJournal(dir, options);
    if (!existsSync(j.path)) {
      throw new Error(`runtime journal not found: ${j.path}; use create()`);
    }
    j.acquireLock();
    try {
      j.recover();
      j.fd = openSync(j.path, 'a');
      return j;
    } catch (e) {
      j.releaseOnFailure();
      throw e;
    }
  }

  /** 只读扫描（无锁；恢复期跨进程核对用） */
  static readEntries(dir: string): ScanResult {
    return scanJournal(journalPath(dir));
  }

  /** open() 时丢弃的撕裂区字节数（0=无需恢复） */
  get recoveredBytes(): number {
    return this.recoveredBytesValue;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** append-only 追加一条账本事件；返回落盘行（含 v/seq/ts）。持锁排他写，无并发窗口。 */
  append(input: JournalAppendInput): RuntimeJournalEntry {
    if (this.closed) throw new Error('runtime journal is closed');
    const entry = buildAppendEntry(input, this.nextSeq);
    writeSync(this.fd, JSON.stringify(entry) + '\n');
    if (this.doFsync) fsyncSync(this.fd);
    this.nextSeq += 1;
    return entry;
  }

  readEntries(): ScanResult {
    return scanJournal(this.path);
  }

  readWatermark(): JournalWatermark {
    return scanJournal(this.path).watermark;
  }

  judgeSubmission(clientMessageId: ClientMessageId): SubmissionJudgement {
    return judgeSubmission(this.dir, clientMessageId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    this.fd = -1;
    this.removeLock();
    activeWriters.delete(this.dir);
  }

  private acquireLock(): void {
    if (activeWriters.has(this.dir)) {
      throw new RuntimeJournalLockedError(this.dir, process.pid);
    }
    if (existsSync(this.lockPath)) {
      let holderPid: number | null = null;
      try {
        const parsed = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: unknown };
        holderPid = typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch {
        holderPid = null;
      }
      if (holderPid !== null && isPidAlive(holderPid)) {
        throw new RuntimeJournalLockedError(this.dir, holderPid);
      }
      // 陈旧锁（持锁进程已死）：接管
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
    activeWriters.add(this.dir);
  }

  private recover(): void {
    const { watermark } = scanJournal(this.path);
    if (watermark.truncated && watermark.tornBytes > 0) {
      truncateSync(this.path, watermark.durableBytes);
    }
    this.recoveredBytesValue = watermark.tornBytes > 0 ? watermark.tornBytes : 0;
    this.nextSeq = watermark.lastSeq + 1;
  }

  private removeLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // 锁文件已不存在则忽略
    }
  }

  private releaseOnFailure(): void {
    this.closed = true;
    if (this.fd >= 0) {
      try {
        closeSync(this.fd);
      } catch {
        // fd 已失效则忽略
      }
      this.fd = -1;
    }
    this.removeLock();
    activeWriters.delete(this.dir);
  }
}

// —— 写入口校验与组装 ——

function buildAppendEntry(input: JournalAppendInput, seq: number): RuntimeJournalEntry {
  const ts = new Date().toISOString();
  const base = { v: 1 as const, seq, ts };
  switch (input.kind) {
    case 'queue/accepted': {
      if (!isNonEmptyString(input.clientMessageId))
        throw new InvalidJournalAppendError('queue/accepted: clientMessageId must be a non-empty string');
      if (!isNonEmptyString(input.sessionId))
        throw new InvalidJournalAppendError('queue/accepted: sessionId must be a non-empty string');
      if (!isSubmitIntent(input.intent))
        throw new InvalidJournalAppendError(`queue/accepted: invalid intent ${String(input.intent)}`);
      if (input.queueSeq !== undefined && !isNonNegativeInteger(input.queueSeq)) {
        throw new InvalidJournalAppendError(
          `queue/accepted: queueSeq must be a non-negative integer, got ${String(input.queueSeq)}`,
        );
      }
      const entry: QueueAcceptedEntry = {
        ...base,
        kind: 'queue/accepted',
        clientMessageId: input.clientMessageId,
        sessionId: input.sessionId,
        payload:
          input.queueSeq === undefined ? { intent: input.intent } : { intent: input.intent, queueSeq: input.queueSeq },
      };
      return entry;
    }
    case 'queue/duplicate': {
      if (!isNonEmptyString(input.clientMessageId))
        throw new InvalidJournalAppendError('queue/duplicate: clientMessageId must be a non-empty string');
      if (!Number.isInteger(input.originalSeq) || input.originalSeq < 1) {
        throw new InvalidJournalAppendError(
          `queue/duplicate: originalSeq must be a positive integer, got ${String(input.originalSeq)}`,
        );
      }
      const entry: QueueDuplicateEntry = {
        ...base,
        kind: 'queue/duplicate',
        clientMessageId: input.clientMessageId,
        payload: { originalSeq: input.originalSeq },
      };
      return entry;
    }
    case 'queue/removed': {
      if (!isNonEmptyString(input.clientMessageId))
        throw new InvalidJournalAppendError('queue/removed: clientMessageId must be a non-empty string');
      const entry: QueueRemovedEntry = {
        ...base,
        kind: 'queue/removed',
        clientMessageId: input.clientMessageId,
        payload: input.reason === undefined ? undefined : { reason: input.reason },
      };
      return entry;
    }
    case 'task/transition': {
      if (!isNonEmptyString(input.taskId))
        throw new InvalidJournalAppendError('task/transition: taskId must be a non-empty string');
      if (!canTaskTransition(input.from, input.to)) {
        throw new InvalidJournalAppendError(`task/transition: illegal transition ${input.from} → ${input.to}`);
      }
      if (input.sessionLogSeq !== undefined && !isNonNegativeInteger(input.sessionLogSeq)) {
        throw new InvalidJournalAppendError(
          `task/transition: sessionLogSeq must be a non-negative integer, got ${String(input.sessionLogSeq)}`,
        );
      }
      const entry: TaskTransitionEntry = {
        ...base,
        kind: 'task/transition',
        taskId: input.taskId,
        parentTaskId: input.parentTaskId === undefined ? undefined : input.parentTaskId,
        clientMessageId: input.clientMessageId === undefined ? undefined : input.clientMessageId,
        sessionLogSeq: input.sessionLogSeq === undefined ? undefined : input.sessionLogSeq,
        payload: {
          from: input.from,
          to: input.to,
          background: input.background === undefined ? undefined : input.background,
        },
      };
      return entry;
    }
    case 'call/started': {
      if (!isNonEmptyString(input.callId))
        throw new InvalidJournalAppendError('call/started: callId must be a non-empty string');
      const entry: CallStartedEntry = {
        ...base,
        kind: 'call/started',
        callId: input.callId,
        taskId: input.taskId === undefined ? undefined : input.taskId,
        clientMessageId: input.clientMessageId === undefined ? undefined : input.clientMessageId,
        payload: {
          tool: input.tool === undefined ? undefined : input.tool,
          requestId: input.requestId === undefined ? undefined : input.requestId,
        },
      };
      return entry;
    }
    case 'call/outcome': {
      if (!isNonEmptyString(input.callId))
        throw new InvalidJournalAppendError('call/outcome: callId must be a non-empty string');
      if (typeof input.ok !== 'boolean') throw new InvalidJournalAppendError('call/outcome: ok must be a boolean');
      const entry: CallOutcomeEntry = {
        ...base,
        kind: 'call/outcome',
        callId: input.callId,
        taskId: input.taskId === undefined ? undefined : input.taskId,
        payload: {
          ok: input.ok,
          error: input.error === undefined ? undefined : input.error,
        },
      };
      return entry;
    }
    default: {
      const _never: never = input;
      throw new InvalidJournalAppendError(`unknown journal kind: ${String(_never)}`);
    }
  }
}
