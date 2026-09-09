// 定时任务调度器（阶段 7 Task 3，hermes 实证口径）：
//   - serve 内常驻 tick（setTimeout 链，默认 60s；测试可调小）；
//   - 跨进程 tick 文件锁（~/.harness2/cron/.tick.lock，O_EXCL 原子创建 + pid 存活检查 + 陈旧锁接管）；
//   - at-most-once：到点任务**先推进 next_run 落盘再执行**——crash 不重跑、落后不补跑
//     （错过的 occurrences 直接跳过，nextRun = 执行触发时刻 + 一个周期）；
//   - 执行 = 独立临时会话跑 runTurn（主 provider + 全量工具 + cwd=serve root），
//     产出写 ~/.harness2/cron/history/<id>/<ts>/（session.v1.jsonl + result.md）；
//   - 失败 failCount+1（成功归零），连续 ≥3 → enabled=false + incidents.jsonl 标记；
//   - 执行串行（进程内单队列，不与用户 turn 抢并发）；ask 审批无人工通道 → 按拒绝处理。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn } from '../agent/loop.js';
import type { TurnResult } from '../agent/types.js';
import type { ApprovalHandler } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChatProvider } from '../provider/types.js';
import { SessionWriter } from '../session/writer.js';
import { computeNextRun, CronJobStore, defaultCronRoot, appendIncident, type CronJob } from './jobs.js';

/** 默认 tick 周期（60s，hermes 同口径） */
export const CRON_TICK_INTERVAL_MS = 60_000;
/** 连续失败熔断阈值 */
export const CRON_FAIL_CIRCUIT = 3;

export interface CronFinishedFrame {
  type: 'cron';
  op: 'finished';
  id: string;
  ok: boolean;
  error?: string;
}

export interface CronSchedulerOptions {
  /** cron 数据根（缺省 defaultCronRoot(home)） */
  root?: string;
  home?: string;
  /** cron 执行的 cwd（= serve root） */
  cwd: string;
  provider: ChatProvider;
  /** 全量工具（按运行键绑定，serve 传 hub.toolsForSession） */
  toolsForSession: (sessionKey: string) => ToolRegistry;
  /** 策略决策缝（与 serve 同策略；ask 无人工通道 → 按拒绝处理） */
  decide?: ApprovalHandler['decide'];
  /** tick 周期 ms（缺省 60_000） */
  tickIntervalMs?: number;
  /** WS 通知缝（{type:'cron', op:'finished', id, ok}） */
  onFinished?: (frame: CronFinishedFrame) => void;
  /** 会话日志 fsync（测试可关） */
  fsync?: boolean;
  now?: () => Date;
}

export interface CronRunOutcome {
  ok: boolean;
  dir: string;
  stopReason?: TurnResult['stopReason'];
  error?: string;
}

export class CronScheduler {
  private readonly store: CronJobStore;
  private readonly root: string;
  private readonly tickIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  /** 执行串行链（全局并发 1：调度执行不与用户 turn 抢资源） */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: CronSchedulerOptions) {
    this.root = options.root ?? defaultCronRoot(options.home);
    this.store = new CronJobStore(this.root);
    this.tickIntervalMs = options.tickIntervalMs ?? CRON_TICK_INTERVAL_MS;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    const loop = (): void => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.tick()
          .catch(() => {})
          .finally(loop);
      }, this.tickIntervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  /** 停止：不再 tick；等待在途执行收尾 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.chain;
  }

  /** 单次扫描（测试可直接调用）：持文件锁 → 到点任务先推进 next_run → 排队执行 */
  async tick(now: Date = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let release: (() => void) | undefined;
      try {
        release = this.acquireTickLock();
      } catch {
        return; // 他进程正在 tick：本次跳过（跨进程单 tick）；ticking 标志必须复位
      }
      try {
        const due = this.store
          .list()
          .filter((j) => j.enabled && isDue(j.nextRun, now));
        for (const job of due) {
          // —— at-most-once 关键序：先推进 next_run 并落盘，再排队执行 ——
          const advanced = computeNextRun(job.schedule, now);
          this.store.update(job.id, { nextRun: advanced });
          this.enqueueRun(job, now);
        }
      } finally {
        release?.();
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 立即执行一次（CLI cron run；不动 nextRun/failCount——手工触发不进熔断计数） */
  async runOnce(id: string): Promise<CronRunOutcome | null> {
    const job = this.store.get(id);
    if (job === undefined) return null;
    return this.execute(job);
  }

  private enqueueRun(job: CronJob, now: Date): void {
    const run = this.chain.then(() => this.executeAndRecord(job, now)).catch(() => {});
    this.chain = run;
  }

  /** 执行 + 熔断记账（调度路径）；异常收口不外抛 */
  private async executeAndRecord(job: CronJob, now: Date): Promise<void> {
    const outcome = await this.execute(job);
    if (outcome.ok) {
      this.store.update(job.id, { failCount: 0, lastRunAt: now.toISOString(), lastError: undefined });
      this.options.onFinished?.({ type: 'cron', op: 'finished', id: job.id, ok: true });
      return;
    }
    const current = this.store.get(job.id);
    const failCount = (current?.failCount ?? job.failCount) + 1;
    const error = outcome.error ?? `stopReason=${outcome.stopReason ?? 'unknown'}`;
    if (failCount >= CRON_FAIL_CIRCUIT) {
      this.store.update(job.id, {
        failCount,
        enabled: false,
        lastRunAt: now.toISOString(),
        lastError: error,
      });
      appendIncident(this.root, { kind: 'circuit_break', jobId: job.id, failCount, error });
    } else {
      this.store.update(job.id, { failCount, lastRunAt: now.toISOString(), lastError: error });
    }
    this.options.onFinished?.({ type: 'cron', op: 'finished', id: job.id, ok: false, error });
  }

  /** 单次执行：独立临时会话（history/<id>/<ts>/）跑 runTurn，产出 result.md */
  private async execute(job: CronJob): Promise<CronRunOutcome> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(this.root, 'history', job.id, `${ts}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(dir, { recursive: true });
    const writer = SessionWriter.create(
      dir,
      { sessionId: `cron-${job.id}-${ts}`, cwd: this.options.cwd },
      { fsync: this.options.fsync ?? true },
    );
    try {
      const tools = this.options.toolsForSession(`cron-${job.id}`);
      const decide = this.options.decide;
      const result = await runTurn(writer, {
        provider: this.options.provider,
        tools,
        cwd: this.options.cwd,
        userText: job.instruction,
        // ask 审批无人工确认通道 → onAsk 缺省按拒绝处理（执行器语义）
        ...(decide !== undefined ? { approval: { decide } } : {}),
      });
      const ok = result.stopReason === 'end_turn';
      const resultMd = [
        `# cron run ${job.id}`,
        `- ts: ${ts}`,
        `- stopReason: ${result.stopReason}`,
        `- toolCalls: ${result.toolCalls}`,
        `- durationMs: ${result.durationMs}`,
        ...(result.error !== undefined ? [`- error: ${result.error}`] : []),
        ...(result.warning !== undefined ? [`- warning: ${result.warning}`] : []),
        '',
        result.finalText ?? '（无最终文本）',
        '',
      ].join('\n');
      writeFileSync(join(dir, 'result.md'), resultMd, 'utf8');
      return {
        ok,
        dir,
        stopReason: result.stopReason,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      try {
        writeFileSync(join(dir, 'result.md'), `# cron run ${job.id}\n- error: ${msg}\n`, 'utf8');
      } catch {
        // 连 result.md 都写不了时如实吞掉（历史缺失即证据）
      }
      return { ok: false, dir, error: msg };
    } finally {
      writer.close();
    }
  }

  // —— tick 文件锁（跨进程单 tick；复用会话锁思路：pid 存活检查 + 陈旧锁接管） ——

  private lockPath(): string {
    return join(this.root, '.tick.lock');
  }

  /**
   * 获取 tick 锁（P2-1 阶段 7 审查）：openSync 'wx'（O_EXCL）原子创建——不存在
   * exists→check→write 的检查窗口，双进程争锁只有一个创建成功；被存活进程持有 →
   * 抛错（本次 tick 跳过）；陈旧锁（持有者 pid 死亡/锁损坏）unlink 后原子重试一次，
   * 仍失败 = 竞争对手刚接管。返回 release。
   */
  private acquireTickLock(): () => void {
    mkdirSync(this.root, { recursive: true });
    const path = this.lockPath();
    const tryCreate = (): number => openSync(path, 'wx');
    let fd: number;
    try {
      fd = tryCreate();
    } catch {
      // 锁已存在：检查持有者是否存活
      let pid: number | undefined;
      try {
        pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }).pid;
      } catch {
        pid = undefined; // 损坏锁 = 陈旧锁
      }
      if (typeof pid === 'number' && isPidAlive(pid)) {
        throw new Error(`tick lock held by pid ${pid}`);
      }
      // 陈旧锁接管：先 unlink 再原子重试一次（仍失败 = 对手刚接管，本轮放弃）
      try {
        unlinkSync(path);
      } catch {
        // 锁已消失（对手接管后释放等）：直接重试
      }
      try {
        fd = tryCreate();
      } catch {
        throw new Error('tick lock contention: stale takeover lost');
      }
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return () => {
      try {
        // 只删除自己持有的锁（期间被接管则不误删）
        const current = existsSync(path)
          ? (JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }).pid
          : undefined;
        if (current === process.pid) unlinkSync(path);
      } catch {
        // 锁文件已消失/损坏：无需清理
      }
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function isDue(nextRun: string, now: Date): boolean {
  const t = Date.parse(nextRun);
  if (Number.isNaN(t)) return true; // 损坏的 nextRun 视为到期（tick 会重算修复）
  return t <= now.getTime();
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
