// H-44 / H-66～H-68 审计账本（阶段 7）：所有审批 / 澄清 / 特权决策落**追加写** JSONL。
//
// 与 session.v1.jsonl 的关系：**完全独立文件**（`flows.v1.jsonl`，路径由调用方给定），
// 不改动 session 日志的 append-only 语义，也不与 runtime journal 的 kind 集冲突。
//
// 机密红线（纵深防御）：
//   1) 事件类型里根本没有机密值字段（password/value 等由类型层排除）；
//   2) 写入前 stripForbiddenFields 递归删除 password/value/token/… 键；
//   3) 所有字符串出口过 redactSecrets；
//   4) 写入器不接收 FlowResponse（机密载体）——只接收已归一的 FlowAuditEvent。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from '../config/redact.js';
import type { FlowId, FlowKind, FlowSessionId } from './types.js';

export const FLOW_AUDIT_FILE = 'flows.v1.jsonl';
export const FLOW_AUDIT_VERSION = 1;

export interface FlowAuditEntryBase {
  v: 1;
  /** 单调 seq（1 起始；仅同一文件内有效） */
  seq: number;
  /** ISO8601 写入时间 */
  ts: string;
}

export interface FlowRequestAudit extends FlowAuditEntryBase {
  kind: 'flow/request';
  flowId: FlowId;
  flowKind: FlowKind;
  sessionId?: FlowSessionId;
  /** 请求摘要（已脱敏；不含机密值） */
  summary: string;
  /** 同一请求被重复登记（待处理去重）→ true */
  deduped?: boolean;
}

export interface FlowPresentedAudit extends FlowAuditEntryBase {
  kind: 'flow/presented';
  flowId: FlowId;
  flowKind: FlowKind;
  title: string;
}

export interface FlowResponseAudit extends FlowAuditEntryBase {
  kind: 'flow/response';
  flowId: FlowId;
  flowKind: FlowKind;
  /** 归一后的决策名（approval: allow_once/…；clarify: answered/cancelled；sudo: submitted/…；secret: stored/skipped/denied） */
  decision: string;
  reason?: string;
  /** 可公开细节（storedAs 引用 / grantId / 选中项数等；绝不含机密值） */
  detail?: Record<string, string | number | boolean>;
}

export interface FlowGrantAudit extends FlowAuditEntryBase {
  kind: 'flow/grant';
  flowId: FlowId;
  grantId: string;
  scope: 'once' | 'session' | 'always';
  pattern?: string;
}

export interface FlowConsumeAudit extends FlowAuditEntryBase {
  kind: 'flow/consume';
  grantId: string;
  flowId?: FlowId;
  ok: boolean;
  reason?: string;
}

export interface FlowExpiredAudit extends FlowAuditEntryBase {
  kind: 'flow/expired';
  flowId: FlowId;
  flowKind: FlowKind;
}

export interface FlowCancelledAudit extends FlowAuditEntryBase {
  kind: 'flow/cancelled';
  flowId: FlowId;
  flowKind: FlowKind;
}

export type FlowAuditEvent =
  | Omit<FlowRequestAudit, 'v' | 'seq' | 'ts'>
  | Omit<FlowPresentedAudit, 'v' | 'seq' | 'ts'>
  | Omit<FlowResponseAudit, 'v' | 'seq' | 'ts'>
  | Omit<FlowGrantAudit, 'v' | 'seq' | 'ts'>
  | Omit<FlowConsumeAudit, 'v' | 'seq' | 'ts'>
  | Omit<FlowExpiredAudit, 'v' | 'seq' | 'ts'>
  | Omit<FlowCancelledAudit, 'v' | 'seq' | 'ts'>;

export type FlowAuditEntry =
  | FlowRequestAudit
  | FlowPresentedAudit
  | FlowResponseAudit
  | FlowGrantAudit
  | FlowConsumeAudit
  | FlowExpiredAudit
  | FlowCancelledAudit;

export type FlowAuditKind = FlowAuditEntry['kind'];

/** 禁止出现在审计里的键名（机密载体；纵深防御，类型层已排除） */
export const FORBIDDEN_AUDIT_KEYS: ReadonlySet<string> = new Set([
  'password',
  'value',
  'secret',
  'secretvalue',
  'token',
  'credential',
  'apikey',
  'api_key',
  'authorization',
]);

/**
 * 审计接收缝（FlowAuditLog / 测试内存句柄 / 宿主自定义落点）。
 * `record` 收**事件**（不含 v/seq/ts），由 sink 自己分配 seq 与时间戳——保证落盘行永远可解析。
 */
export interface FlowAuditSink {
  record(event: FlowAuditEvent): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 递归删除禁止键 + 所有字符串过 redactSecrets（审计出口最后闸门） */
export function redactFlowAudit<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactFlowAudit(v)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_AUDIT_KEYS.has(k.toLowerCase())) continue;
      out[k] = redactFlowAudit(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** 是否含禁止键（递归；测试断言「审计里绝不出现机密字段」用） */
export function containsForbiddenAuditKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => containsForbiddenAuditKeys(v));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([k, v]) => FORBIDDEN_AUDIT_KEYS.has(k.toLowerCase()) || containsForbiddenAuditKeys(v),
    );
  }
  return false;
}

/** 解析一行审计 JSONL；非法返回 null（与 session writer 的宽容读口径一致） */
export function parseFlowAuditEntry(line: string): FlowAuditEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw['v'] !== FLOW_AUDIT_VERSION) return null;
  if (typeof raw['seq'] !== 'number' || !Number.isInteger(raw['seq']) || raw['seq'] < 1) return null;
  if (typeof raw['ts'] !== 'string' || Number.isNaN(Date.parse(raw['ts']))) return null;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !kind.startsWith('flow/')) return null;
  return raw as unknown as FlowAuditEntry;
}

export interface FlowAuditLogOptions {
  /** 每次追加后 fsync（默认 true；测试可关） */
  fsync?: boolean;
  /** 时间源（测试注入） */
  now?: () => Date;
}

/**
 * 追加写审计账本（单文件 JSONL）。append-only：只追加，绝不改写历史行。
 * 写失败**不抛**（审计是旁路，不得让审批链路因磁盘问题崩掉）——由返回 false 告知调用方。
 */
export class FlowAuditLog implements FlowAuditSink {
  private seq = 0;

  private constructor(
    private readonly filePath: string,
    private readonly options: FlowAuditLogOptions,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.seq = this.scanLastSeq();
  }

  /** 打开（已有文件则续写 seq；不存在则新建） */
  static open(filePath: string, options: FlowAuditLogOptions = {}): FlowAuditLog {
    return new FlowAuditLog(filePath, options);
  }

  get path(): string {
    return this.filePath;
  }

  /** 追加一条审计事件；返回落盘行（含 v/seq/ts），写失败返回 null */
  append(event: FlowAuditEvent): FlowAuditEntry | null {
    const ts = (this.options.now?.() ?? new Date()).toISOString();
    const entry = redactFlowAudit({
      v: FLOW_AUDIT_VERSION,
      seq: this.seq + 1,
      ts,
      ...(event as Record<string, unknown>),
    }) as unknown as FlowAuditEntry;
    try {
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      return null;
    }
    this.seq += 1;
    return entry;
  }

  /** record 缝：内部走 append（自带 seq/ts/脱敏）；写失败静默（审计是旁路） */
  record(event: FlowAuditEvent): void {
    this.append(event);
  }

  /** 读回全部可解析行（只读） */
  readEntries(): FlowAuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    const out: FlowAuditEntry[] = [];
    for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const entry = parseFlowAuditEntry(line);
      if (entry !== null) out.push(entry);
    }
    return out;
  }

  private scanLastSeq(): number {
    const entries = this.readEntries();
    const last = entries.at(-1);
    return last !== undefined ? last.seq : 0;
  }
}

/** 内存审计句柄：测试与「无落盘需求」的宿主用 */
export class MemoryFlowAuditSink implements FlowAuditSink {
  readonly entries: FlowAuditEntry[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(event: FlowAuditEvent): void {
    this.append(event);
  }

  /** 便捷追加（与 FlowAuditLog.append 同形） */
  append(event: FlowAuditEvent): FlowAuditEntry {
    this.seq += 1;
    const entry = redactFlowAudit({
      v: FLOW_AUDIT_VERSION,
      seq: this.seq,
      ts: this.now().toISOString(),
      ...(event as Record<string, unknown>),
    }) as unknown as FlowAuditEntry;
    this.entries.push(entry);
    return entry;
  }

  ofKind(kind: FlowAuditKind): FlowAuditEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }
}
