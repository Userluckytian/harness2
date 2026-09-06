// 定时任务持久化（阶段 7 Task 3，hermes 式）：jobs.json 单文件存储 + 原子写。
// 布局：~/.harness2/cron/jobs.json（任务）、~/.harness2/cron/history/<id>/<ts>/（执行轨迹与结果）、
//       ~/.harness2/cron/.tick.lock（跨进程 tick 文件锁）、~/.harness2/cron/incidents.jsonl（熔断标记）。
// 任务指令与结果属用户数据（不入 git）；上限 50 个任务。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 任务上限（防失控，hermes 同口径） */
export const CRON_MAX_JOBS = 50;

export interface CronJob {
  id: string;
  /** 发给模型的指令（cron 执行 = 以此为 user turn 起独立临时会话） */
  instruction: string;
  /** 调度表达式：interval（如 "5m"/"2h"/"1d"）或 "daily HH:MM"（本地时区） */
  schedule: string;
  /** 下次应执行时间（ISO8601 UTC） */
  nextRun: string;
  enabled: boolean;
  /** 连续失败计数（成功归零；≥3 熔断 enabled=false） */
  failCount: number;
  createdAt: string;
  lastRunAt?: string;
  lastError?: string;
}

export interface CronJobsFile {
  version: 1;
  jobs: CronJob[];
}

/** 调度错误（CLI 一行输出） */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export type ParsedSchedule = { kind: 'interval'; intervalMs: number } | { kind: 'daily'; hour: number; minute: number };

const INTERVAL_PATTERN = /^(\d+)([mhd])$/;
const DAILY_PATTERN = /^daily (\d{1,2}):(\d{2})$/;

/** 解析调度表达式：interval "5m"/"2h"/"1d"（最小 1 分钟）或 "daily HH:MM"；非法抛 CronError */
export function parseSchedule(spec: string): ParsedSchedule {
  const trimmed = spec.trim();
  const interval = INTERVAL_PATTERN.exec(trimmed);
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2];
    const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    const intervalMs = n * multiplier;
    if (intervalMs < 60_000) {
      throw new CronError(`调度间隔过小（最小 1 分钟）: ${spec}`);
    }
    return { kind: 'interval', intervalMs };
  }
  const daily = DAILY_PATTERN.exec(trimmed);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) throw new CronError(`daily 时间非法（HH:MM 00:00-23:59）: ${spec}`);
    return { kind: 'daily', hour, minute };
  }
  throw new CronError(`调度表达式非法（可用 "5m"/"2h"/"1d" 或 "daily HH:MM"）: ${spec}`);
}

/**
 * 计算 from 之后的下一次执行时间（ISO8601 UTC）：
 *   interval = from + intervalMs；daily = from 之后最近的本地 HH:MM（含 from 当天未到点）。
 * 落后的调度不做补跑展开（调用方在到点时一次性推进，见 scheduler 的 at-most-once 口径）。
 */
export function computeNextRun(schedule: string, from: Date = new Date()): string {
  const parsed = parseSchedule(schedule);
  if (parsed.kind === 'interval') {
    return new Date(from.getTime() + parsed.intervalMs).toISOString();
  }
  const next = new Date(from);
  next.setHours(parsed.hour, parsed.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export function defaultCronRoot(home?: string): string {
  return join(home ?? homedir(), '.harness2', 'cron');
}

/** 原子写（同目录临时文件 + rename） */
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不影响主错误
    }
    throw e;
  }
}

function isJobLike(v: unknown): v is CronJob {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Partial<CronJob>;
  return (
    typeof j.id === 'string' &&
    typeof j.instruction === 'string' &&
    typeof j.schedule === 'string' &&
    typeof j.nextRun === 'string' &&
    typeof j.enabled === 'boolean' &&
    typeof j.failCount === 'number'
  );
}

export class CronJobStore {
  readonly root: string;
  readonly jobsFile: string;

  constructor(root: string = defaultCronRoot()) {
    this.root = root;
    this.jobsFile = join(root, 'jobs.json');
  }

  /** 读取全部任务（文件缺失/损坏 → 空表；损坏不抛错以免调度器崩死） */
  list(): CronJob[] {
    if (!existsSync(this.jobsFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.jobsFile, 'utf8')) as Partial<CronJobsFile>;
      if (!Array.isArray(parsed.jobs)) return [];
      return parsed.jobs.filter(isJobLike);
    } catch {
      return [];
    }
  }

  get(id: string): CronJob | undefined {
    return this.list().find((j) => j.id === id);
  }

  /** 新增任务：调度先解析（非法即抛），上限 CRON_MAX_JOBS */
  add(instruction: string, schedule: string): CronJob {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) throw new CronError('instruction 必须是非空字符串');
    parseSchedule(schedule); // 合法性校验
    const jobs = this.list();
    if (jobs.length >= CRON_MAX_JOBS) {
      throw new CronError(`任务数已达上限 ${CRON_MAX_JOBS}，请先删除部分任务`);
    }
    const job: CronJob = {
      id: randomId(),
      instruction: trimmed,
      schedule: schedule.trim(),
      nextRun: computeNextRun(schedule),
      enabled: true,
      failCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.writeAll([...jobs, job]);
    return job;
  }

  remove(id: string): boolean {
    const jobs = this.list();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    this.writeAll(next);
    return true;
  }

  /** 局部更新（读-改-写全文件；单 serve 进程为写者，CLI 编辑属低频操作） */
  update(
    id: string,
    patch: Partial<Pick<CronJob, 'nextRun' | 'enabled' | 'failCount' | 'lastRunAt' | 'lastError'>>,
  ): CronJob | undefined {
    const jobs = this.list();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    const updated: CronJob = { ...jobs[idx]!, ...patch };
    jobs[idx] = updated;
    this.writeAll(jobs);
    return updated;
  }

  private writeAll(jobs: CronJob[]): void {
    mkdirSync(this.root, { recursive: true });
    writeJsonAtomic(this.jobsFile, { version: 1, jobs } satisfies CronJobsFile);
  }
}

/** 生成任务 id：cron- + 时间戳 + 4 位随机（可读、无路径原语） */
function randomId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `cron-${Date.now().toString(36)}${rand}`;
}

/** 追加一条熔断/异常 incident 记录（JSONL；失败静默——不阻塞调度） */
export function appendIncident(root: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, 'incidents.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
  } catch {
    // incidents 只增不阻塞
  }
}
