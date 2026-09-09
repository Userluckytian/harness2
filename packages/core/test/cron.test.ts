// 定时任务测试（阶段 7 Task 3）：
// 调度解析/存储上限/at-most-once（先推进 next_run 再执行、落后不补跑）/跨进程文件锁/
// 熔断（连续 3 失败 disable + incident）/history 落盘/WS 通知帧。
// 测试直接调用 scheduler.tick(now) 驱动（不依赖真实定时器），执行用 stub provider。
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeNextRun,
  CronError,
  CronJobStore,
  CronScheduler,
  CRON_MAX_JOBS,
  parseSchedule,
  type CronFinishedFrame,
} from '../src/cron/index.js';
import type { ChatProvider, ChatRequest, StreamChunk } from '../src/provider/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cron-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 恒成功 provider（固定文本回复，记录请求数） */
class StubOkProvider implements ChatProvider {
  name = 'stub-ok';
  calls = 0;
  constructor(private readonly text: string = 'cron ok') {}
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamChunk> {
    this.calls += 1;
    yield { type: 'text-delta', text: this.text };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

/** 恒失败 provider（streamChat 抛错 = 执行失败） */
class StubFailProvider implements ChatProvider {
  name = 'stub-fail';
  async *streamChat(): AsyncIterable<StreamChunk> {
    throw new Error('provider exploded');
  }
}

/** 可控 provider：执行挂起直到放行（验证「先推进 next_run 再执行」的顺序） */
class StubBlockingProvider implements ChatProvider {
  name = 'stub-blocking';
  calls = 0;
  private startedResolve: (() => void) | null = null;
  private releaseResolve: (() => void) | null = null;
  readonly startedPromise = new Promise<void>((r) => (this.startedResolve = r));
  private readonly gate = new Promise<void>((r) => (this.releaseResolve = r));
  release(): void {
    this.releaseResolve!();
  }
  async waitStarted(): Promise<void> {
    return this.startedPromise;
  }
  async *streamChat(): AsyncIterable<StreamChunk> {
    this.calls += 1;
    this.startedResolve!();
    await this.gate;
    yield { type: 'text-delta', text: 'released' };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

function tools(): ToolRegistry {
  return new ToolRegistry();
}

/** 直写 jobs.json（绕过 add() 的 1 分钟下限校验，制造任意 nextRun/schedule 测试场景） */
function writeJobsFile(root: string, jobs: unknown[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs }), 'utf8');
}

function makeJob(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'cron-test1',
    instruction: '执行巡检',
    schedule: '1m',
    nextRun: new Date(Date.now() - 60_000).toISOString(), // 默认已到期
    enabled: true,
    failCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('parseSchedule / computeNextRun（解析）', () => {
  it('interval：5m/2h/1d 解析为毫秒；小于 1 分钟拒绝', () => {
    expect(parseSchedule('5m')).toEqual({ kind: 'interval', intervalMs: 300_000 });
    expect(parseSchedule('2h')).toEqual({ kind: 'interval', intervalMs: 7_200_000 });
    expect(parseSchedule('1d')).toEqual({ kind: 'interval', intervalMs: 86_400_000 });
    expect(() => parseSchedule('30s')).toThrow(CronError);
    expect(() => parseSchedule('5x')).toThrow(CronError);
    expect(() => parseSchedule('every 5m')).toThrow(CronError);
  });

  it('daily：合法 HH:MM；越界拒绝', () => {
    expect(parseSchedule('daily 09:00')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(parseSchedule('daily 23:59')).toEqual({ kind: 'daily', hour: 23, minute: 59 });
    expect(() => parseSchedule('daily 24:00')).toThrow(CronError);
    expect(() => parseSchedule('daily 09:60')).toThrow(CronError);
  });

  it('computeNextRun：interval = from+周期；daily = 之后最近的本地 HH:MM', () => {
    const from = new Date('2026-09-06T08:00:00.000Z');
    expect(new Date(computeNextRun('5m', from)).getTime()).toBe(from.getTime() + 300_000);
    // 本地时区构造：2026-09-06 10:30 local → daily 09:00 应为次日；daily 11:00 应为当天
    const base = new Date();
    base.setHours(10, 30, 0, 0);
    const next900 = new Date(computeNextRun('daily 09:00', base));
    expect(next900.getDate()).toBe(base.getDate() + 1);
    expect(next900.getHours()).toBe(9);
    expect(next900.getMinutes()).toBe(0);
    const next1100 = new Date(computeNextRun('daily 11:00', base));
    expect(next1100.getDate()).toBe(base.getDate());
    expect(next1100.getHours()).toBe(11);
    // 恰好等于 HH:MM → 推进到明天（严格大于）
    const exact = new Date(computeNextRun('daily 10:30', base));
    expect(exact.getDate()).toBe(base.getDate() + 1);
  });
});

describe('CronJobStore（持久化）', () => {
  it('add/list/remove/update 往返；文件缺失读为空', () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    expect(store.list()).toEqual([]);
    const job = store.add('每天整理 issue 日志', 'daily 09:00');
    expect(job.enabled).toBe(true);
    expect(job.failCount).toBe(0);
    expect(job.nextRun).toBeTruthy();
    expect(store.list()).toHaveLength(1);
    expect(store.update(job.id, { failCount: 2 })).toMatchObject({ failCount: 2 });
    expect(store.get(job.id)?.failCount).toBe(2);
    expect(store.remove(job.id)).toBe(true);
    expect(store.remove(job.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('上限 50：第 51 个任务拒绝', () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    for (let i = 0; i < CRON_MAX_JOBS; i++) store.add(`任务 ${i}`, '1m');
    expect(() => store.add('超限', '1m')).toThrow(/上限 50/);
  });

  it('非法调度/空指令拒绝；损坏 jobs.json 读为空（不崩调度）', () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    expect(() => store.add('x', 'oops')).toThrow(CronError);
    expect(() => store.add('   ', '1m')).toThrow(CronError);
    writeFileSync(join(root, 'jobs.json'), '{broken json', 'utf8');
    expect(store.list()).toEqual([]);
  });
});

describe('at-most-once 调度', () => {
  it('先推进 next_run 再执行：执行挂起时 jobs.json 的 nextRun 已是未来', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob()]);
    const provider = new StubBlockingProvider();
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
    });
    const t0 = new Date();
    await scheduler.tick(t0); // 扫描推进 + 排队执行（挂起中）
    await provider.waitStarted();

    const job = new CronJobStore(root).get('cron-test1')!;
    expect(new Date(job.nextRun).getTime()).toBe(t0.getTime() + 60_000); // 已推进且为未来
    expect(job.nextRun).not.toBe((makeJob() as { nextRun: string }).nextRun);

    provider.release();
    await scheduler.stop(); // 等待在途执行收尾
    expect(new CronJobStore(root).get('cron-test1')!.failCount).toBe(0); // 成功归零
  });

  it('落后不补跑：nextRun 落后 10 个周期，一次 tick 只执行一次且推进到未来', async () => {
    const root = tmpDir();
    const t0 = Date.now();
    writeJobsFile(root, [makeJob({ nextRun: new Date(t0 - 10 * 60_000).toISOString() })]); // 落后 10 周期
    const provider = new StubOkProvider();
    const frames: CronFinishedFrame[] = [];
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
      onFinished: (f) => frames.push(f),
    });
    await scheduler.tick(new Date(t0));
    await scheduler.stop();

    expect(provider.calls).toBe(1); // 只补一次（错过的不展开）
    const job = new CronJobStore(root).get('cron-test1')!;
    expect(new Date(job.nextRun).getTime()).toBe(t0 + 60_000); // 推进到未来，不逐周期追赶
    expect(frames).toEqual([{ type: 'cron', op: 'finished', id: 'cron-test1', ok: true }]);
  });

  it('未到期不执行；disabled 不执行', async () => {
    const root = tmpDir();
    const t0 = Date.now();
    writeJobsFile(root, [
      makeJob({ id: 'cron-future', nextRun: new Date(t0 + 60_000).toISOString() }),
      makeJob({ id: 'cron-disabled', enabled: false }),
    ]);
    const provider = new StubOkProvider();
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
    });
    await scheduler.tick(new Date(t0));
    await scheduler.stop();
    expect(provider.calls).toBe(0);
  });

  it('损坏的 nextRun 视为到期并被修复为合法未来值', async () => {
    const root = tmpDir();
    const t0 = Date.now();
    writeJobsFile(root, [makeJob({ nextRun: 'not-a-date' })]);
    const provider = new StubOkProvider();
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
    });
    await scheduler.tick(new Date(t0));
    await scheduler.stop();
    expect(provider.calls).toBe(1);
    expect(new Date(new CronJobStore(root).get('cron-test1')!.nextRun).getTime()).toBe(t0 + 60_000);
  });
});

describe('跨进程 tick 文件锁', () => {
  it('锁被存活进程持有：tick 跳过（不执行不推进）；陈旧锁接管', async () => {
    const root = tmpDir();
    const t0 = Date.now();
    writeJobsFile(root, [makeJob()]);
    const provider = new StubOkProvider();
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
    });

    // 存活进程（本进程）持锁 → 跳过
    writeFileSync(join(root, '.tick.lock'), JSON.stringify({ pid: process.pid, ts: 'x' }), 'utf8');
    await scheduler.tick(new Date(t0));
    expect(provider.calls).toBe(0);
    expect(new CronJobStore(root).get('cron-test1')!.failCount).toBe(0);
    // nextRun 未被推进（仍是过去）
    expect(new Date(new CronJobStore(root).get('cron-test1')!.nextRun).getTime()).toBeLessThan(t0);
    unlinkSync(join(root, '.tick.lock'));

    // 陈旧锁（pid 不存在）→ 接管并正常执行
    writeFileSync(join(root, '.tick.lock'), JSON.stringify({ pid: 999999999, ts: 'x' }), 'utf8');
    await scheduler.tick(new Date(t0));
    await scheduler.stop();
    expect(provider.calls).toBe(1);
    expect(existsSync(join(root, '.tick.lock'))).toBe(false); // 释放
  });

  it('两进程争锁（O_EXCL，审查 P2-1）：存活持有者的锁不被覆盖，第二个 tick 拿不到锁退出；死 pid 接管成功', async () => {
    const root = tmpDir();
    const t0 = Date.now();
    writeJobsFile(root, [makeJob()]);
    const provider = new StubOkProvider();
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
    });
    const lockPath = join(root, '.tick.lock');

    // 模拟另一进程以 O_EXCL 原子创建占住锁（活 pid = 本进程）
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: 'held-by-other' }));
    closeSync(fd);

    // 第二进程的 tick：拿不到锁 → 本次跳过（不执行、不推进、不覆盖锁内容）
    await scheduler.tick(new Date(t0));
    expect(provider.calls).toBe(0);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid, ts: 'held-by-other' });
    expect(new Date(new CronJobStore(root).get('cron-test1')!.nextRun).getTime()).toBeLessThan(t0);

    // 持有者死亡（死 pid）→ unlink 后原子重试接管成功并正常执行
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, ts: 'dead-holder' }), 'utf8');
    await scheduler.tick(new Date(t0));
    await scheduler.stop();
    expect(provider.calls).toBe(1);
    expect(existsSync(lockPath)).toBe(false); // 释放
  });
});

describe('熔断与历史', () => {
  it('连续 3 次失败 → enabled=false + incidents.jsonl；成功归零不熔断', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob()]);
    const provider = new StubFailProvider();
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
    });
    const store = new CronJobStore(root);
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      // 每次把 nextRun 拉回到期（模拟周期到点）
      store.update('cron-test1', { nextRun: new Date(base + i * 1000 - 60_000).toISOString() });
      await scheduler.tick(new Date(base + i * 1000));
      await scheduler.stop();
    }
    const job = store.get('cron-test1')!;
    expect(job.failCount).toBe(3);
    expect(job.enabled).toBe(false);
    expect(job.lastError).toContain('provider exploded');
    const incidents = readFileSync(join(root, 'incidents.jsonl'), 'utf8').trim().split('\n');
    expect(incidents).toHaveLength(1);
    expect(JSON.parse(incidents[0]!)).toMatchObject({ kind: 'circuit_break', jobId: 'cron-test1' });

    // 熔断后到点不再执行
    store.update('cron-test1', { nextRun: new Date(base).toISOString(), enabled: false });
    const okP = new StubOkProvider();
    const scheduler2 = new CronScheduler({
      root,
      cwd: root,
      provider: okP,
      toolsForSession: () => tools(),
      fsync: false,
    });
    await scheduler2.tick(new Date(base + 60_000));
    await scheduler2.stop();
    expect(okP.calls).toBe(0);
  });

  it('history 落盘：result.md + session.v1.jsonl；失败执行也留痕', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob()]);
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider: new StubOkProvider('巡检完成，一切正常'),
      toolsForSession: () => tools(),
      fsync: false,
    });
    await scheduler.tick(new Date());
    await scheduler.stop();
    const runDirs = readdirSync(join(root, 'history', 'cron-test1'));
    expect(runDirs).toHaveLength(1);
    const resultMd = readFileSync(join(root, 'history', 'cron-test1', runDirs[0]!, 'result.md'), 'utf8');
    expect(resultMd).toContain('stopReason: end_turn');
    expect(resultMd).toContain('巡检完成，一切正常');
    expect(existsSync(join(root, 'history', 'cron-test1', runDirs[0]!, 'session.v1.jsonl'))).toBe(true);

    // 失败执行：result.md 带 error
    writeJobsFile(root, [makeJob({ id: 'cron-failrun' })]);
    const failing = new CronScheduler({
      root,
      cwd: root,
      provider: new StubFailProvider(),
      toolsForSession: () => tools(),
      fsync: false,
    });
    await failing.tick(new Date());
    await failing.stop();
    const failRun = readdirSync(join(root, 'history', 'cron-failrun'))[0]!;
    const failMd = readFileSync(join(root, 'history', 'cron-failrun', failRun, 'result.md'), 'utf8');
    expect(failMd).toContain('provider exploded');
  });

  it('runOnce（CLI cron run 口径）：立即执行一次，不动 nextRun/熔断计数', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob()]);
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider: new StubOkProvider(),
      toolsForSession: () => tools(),
      fsync: false,
    });
    const outcome = await scheduler.runOnce('cron-test1');
    expect(outcome?.ok).toBe(true);
    expect(outcome?.stopReason).toBe('end_turn');
    const job = new CronJobStore(root).get('cron-test1')!;
    expect(job.failCount).toBe(0);
    expect(new Date(job.nextRun).getTime()).toBeLessThan(Date.now()); // 未推进
    expect(await scheduler.runOnce('cron-missing')).toBeNull();
    await scheduler.stop();
  });

  it('start() 常驻 tick：到期任务在窗口内被执行一次，stop() 收口', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob()]);
    const provider = new StubOkProvider();
    const frames: CronFinishedFrame[] = [];
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider,
      toolsForSession: () => tools(),
      fsync: false,
      tickIntervalMs: 25,
      onFinished: (f) => frames.push(f),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    await scheduler.stop();
    expect(provider.calls).toBe(1); // 60s 周期 + 已推进 → 窗口内只执行一次
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'cron', op: 'finished', id: 'cron-test1', ok: true });
  });
});

describe('serve 集成（startServe 内置调度器 + WS 通知帧）', () => {
  it('cron 完成帧广播到 WS 连接（无需订阅）；handle.close 停止调度器', async () => {
    const { startServe } = await import('../src/server/http.js');
    const { defaultCronRoot } = await import('../src/cron/jobs.js');
    const home = tmpDir();
    const root = tmpDir();
    writeJobsFile(defaultCronRoot(home), [makeJob({ instruction: '巡检一次' })]);
    const handle = await startServe({
      port: 0,
      home,
      root,
      provider: new StubOkProvider('cron via serve'),
      hooks: undefined,
    });
    const frames: Array<Record<string, unknown>> = [];
    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve());
      client.addEventListener('error', () => reject(new Error('ws 连接失败')));
    });
    client.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>));

    await handle.cron.tick(new Date()); // 手动驱动一轮扫描（绕过 60s tick）
    await new Promise((r) => setTimeout(r, 150)); // 等待执行收尾 + 帧送达
    const cronFrame = frames.find((f) => f['type'] === 'cron');
    expect(cronFrame).toMatchObject({ type: 'cron', op: 'finished', id: 'cron-test1', ok: true });

    expect(handle.cron.running).toBe(true);
    await handle.close();
    expect(handle.cron.running).toBe(false);
    client.close();
  }, 15_000);
});
