// H-46 自然语言 cron 测试（阶段 7 P7-D）：
//   规则兜底（中英双写：每 N 分钟/小时/天、每天 HH:MM、工作日 HH:MM、每周X、中文数字/上午下午/半）、
//   模型 provider 注入（优先 / 非法输出回落 / 抛错回落）、模糊输入拒绝并提示、
//   回显确认两段式（未确认不落盘 / 拒绝不落盘）、weekly 规格推进、投递通道抽象与调度投递。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addCronJobFromNatural,
  addCronJobFromNaturalOrThrow,
  computeNextRun,
  confirmCronDraft,
  CronDeliveryDispatcher,
  CronError,
  CronJobStore,
  CronScheduler,
  CRON_NATURAL_HINT,
  describeSchedule,
  draftCronJob,
  interpretCronSchedule,
  parseCronTextByRules,
  parseSchedule,
  renderCronDraftEcho,
  type CronDeliverySink,
  type CronNaturalParseProvider,
  type CronFinishedFrame,
} from '../src/cron/index.js';
import type { ChatProvider, ChatRequest, StreamChunk } from '../src/provider/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cron-nl-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class StubOkProvider implements ChatProvider {
  name = 'stub-ok';
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', text: '完成巡检' };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}

function tools(): ToolRegistry {
  return new ToolRegistry();
}

function makeJob(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'cron-test1',
    instruction: '执行巡检',
    schedule: '1m',
    nextRun: new Date(Date.now() - 60_000).toISOString(),
    enabled: true,
    failCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeJobsFile(root: string, jobs: unknown[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs }), 'utf8');
}

// —— 用例 1：规则兜底覆盖的中英形态 ——

describe('H-46 规则兜底：中英自然语言 → 调度规格', () => {
  const now = new Date();
  const cases: Array<[string, string, string]> = [
    // [输入, 规格, 期望回显]
    ['每5分钟', '5m', '每 5 分钟'],
    ['每隔10分钟', '10m', '每 10 分钟'],
    ['每2小时', '2h', '每 2 小时'],
    ['每半小时', '30m', '每 30 分钟'],
    ['每天', '1d', '每 1 天'],
    ['每3天', '3d', '每 3 天'],
    ['every 5 minutes', '5m', '每 5 分钟'],
    ['every 2 hours', '2h', '每 2 小时'],
    ['half an hour', '30m', '每 30 分钟'],
    ['每天09:00', 'daily 9:00', '每天 09:00'],
    ['每天18:30', 'daily 18:30', '每天 18:30'],
    ['每天上午9点', 'daily 9:00', '每天 09:00'],
    ['每天下午6点', 'daily 18:00', '每天 18:00'],
    ['每天夜里十一点半', 'daily 23:30', '每天 23:30'],
    ['every day at 9am', 'daily 9:00', '每天 09:00'],
    ['daily at 9:30pm', 'daily 21:30', '每天 21:30'],
    ['每天中午12点', 'daily 12:00', '每天 12:00'],
    ['每个工作日上午9点', 'weekly 1,2,3,4,5 9:00', '每周一、二、三、四、五 09:00'],
    ['工作日 09:00', 'weekly 1,2,3,4,5 9:00', '每周一、二、三、四、五 09:00'],
    ['weekdays at 9am', 'weekly 1,2,3,4,5 9:00', '每周一、二、三、四、五 09:00'],
    ['每周一 09:00', 'weekly 1 9:00', '每周一 09:00'],
    ['每周一和周三 18:00', 'weekly 1,3 18:00', '每周一、三 18:00'],
    ['every monday and wednesday at 9am', 'weekly 1,3 9:00', '每周一、三 09:00'],
    ['周末 10:00', 'weekly 0,6 10:00', '每周日、六 10:00'],
    ['5m', '5m', '每 5 分钟'],
    ['daily 07:30', 'daily 7:30', '每天 07:30'],
    ['weekly 1,3 09:00', 'weekly 1,3 9:00', '每周一、三 09:00'],
  ];

  for (const [input, schedule, display] of cases) {
    it(`「${input}」→ ${schedule}（回显 ${display}）`, async () => {
      const result = await interpretCronSchedule(input, { now });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.schedule).toBe(schedule);
      expect(result.display).toBe(display);
      expect(result.source).toBe('rules');
      expect(new Date(result.nextRun).getTime()).toBeGreaterThan(now.getTime());
    });
  }

  it('模糊/不支持的输入明确拒绝并给可用形态提示', async () => {
    for (const input of ['随便什么时候都行', '偶尔提醒我一下', '每周一次', '有时候早上', 'every once in a while', '']) {
      const result = await interpretCronSchedule(input, { now });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.hint).toBe(CRON_NATURAL_HINT);
    }
  });

  it('「每隔N天」歧义明确拒绝（不猜）', () => {
    const r = parseCronTextByRules('每隔一天执行');
    expect(r.ok).toBe(false);
  });

  it('规则解析是纯函数：同一输入稳定同规格', () => {
    const a = parseCronTextByRules('每个工作日上午9点');
    const b = parseCronTextByRules('每个工作日上午9点');
    expect(a).toEqual(b);
  });
});

// —— 用例 2：weekly 规格推进 ——

describe('H-46 weekly 规格：parseSchedule / computeNextRun', () => {
  it('weekly 解析：星期列表去重排序；越界/空列表/时间越界拒绝', () => {
    expect(parseSchedule('weekly 1,3 09:00')).toEqual({ kind: 'weekly', days: [1, 3], hour: 9, minute: 0 });
    expect(parseSchedule('weekly 3,1,3 09:00')).toEqual({ kind: 'weekly', days: [1, 3], hour: 9, minute: 0 });
    expect(() => parseSchedule('weekly 7 09:00')).toThrow(CronError);
    expect(() => parseSchedule('weekly 1 24:00')).toThrow(CronError);
  });

  it('computeNextRun：落在允许的星期与本地 HH:MM，且严格大于 from', () => {
    const from = new Date();
    from.setHours(10, 30, 0, 0);
    const next = new Date(computeNextRun('weekly 1,2,3,4,5 09:00', from));
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect([1, 2, 3, 4, 5]).toContain(next.getDay());
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('weekly 当天未到点 → 当天；已过点 → 下一个允许日', () => {
    const from = new Date();
    // 构造一个允许的星期（下周一），分别测「当天未到点 / 已过点」
    const monday = new Date(from);
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
    monday.setHours(8, 0, 0, 0);
    const sameDay = new Date(computeNextRun('weekly 1 09:00', monday));
    expect(sameDay.getDay()).toBe(1);
    expect(sameDay.getHours()).toBe(9);
    const later = new Date(monday);
    later.setHours(10, 0, 0, 0);
    const nextWeek = new Date(computeNextRun('weekly 1 09:00', later));
    expect(nextWeek.getTime() - later.getTime()).toBeGreaterThan(6 * 24 * 3600 * 1000 - 24 * 3600 * 1000);
    expect(nextWeek.getDay()).toBe(1);
  });

  it('describeSchedule 对三种规格都给可读中文', () => {
    expect(describeSchedule('2h')).toBe('每 2 小时');
    expect(describeSchedule('daily 09:00')).toBe('每天 09:00');
    expect(describeSchedule('weekly 1,5 18:30')).toBe('每周一、五 18:30');
  });
});

// —— 用例 3：模型 provider 注入 ——

describe('H-46 provider 注入（有模型用模型 / 非法输出回落规则）', () => {
  const now = new Date();

  it('provider 命中 → source=provider，规格取模型输出', async () => {
    const provider: CronNaturalParseProvider = {
      name: 'stub-model',
      parse: () => ({ schedule: 'daily 07:30', confidence: 'high' }),
    };
    const result = await interpretCronSchedule('早班提醒', { now, provider });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule).toBe('daily 07:30');
    expect(result.source).toBe('provider');
    expect(result.providerName).toBe('stub-model');
  });

  it('provider 返回非法规格 → 丢弃并回落规则兜底（source=rules）', async () => {
    const provider: CronNaturalParseProvider = { name: 'bad-model', parse: () => ({ schedule: 'not a schedule' }) };
    const result = await interpretCronSchedule('每5分钟', { now, provider });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule).toBe('5m');
    expect(result.source).toBe('rules');
  });

  it('provider 抛错 → 回落规则兜底，不外抛', async () => {
    const provider: CronNaturalParseProvider = {
      name: 'boom',
      parse: () => {
        throw new Error('model down');
      },
    };
    const result = await interpretCronSchedule('每天 18:30', { now, provider });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule).toBe('daily 18:30');
    expect(result.source).toBe('rules');
  });

  it('provider 返回空 → 回落规则', async () => {
    const provider: CronNaturalParseProvider = { name: 'empty', parse: () => null };
    const result = await interpretCronSchedule('工作日 9:00', { now, provider });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule).toBe('weekly 1,2,3,4,5 9:00');
  });
});

// —— 用例 4：回显确认两段式（拒绝静默落盘） ——

describe('H-46 回显确认：未确认不落盘 / 确认才落盘 / 拒绝不落盘', () => {
  it('confirmed 缺省 → 只回显 draft，store 零写入', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const result = await addCronJobFromNatural(store, {
      instruction: '汇总今日 CI 状态',
      text: '每个工作日上午9点',
    });
    expect(result.needsConfirmation).toBe(true);
    expect(result.job).toBeUndefined();
    expect(result.draft?.schedule).toBe('weekly 1,2,3,4,5 9:00');
    expect(result.echo).toContain('每周一、二、三、四、五 09:00');
    expect(result.echo).toContain('确认后才会落盘');
    expect(store.list()).toEqual([]);
  });

  it('confirmed=true → 落盘且回显文案含规格与首次执行', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const result = await addCronJobFromNatural(store, {
      instruction: '每晚汇报',
      text: '每天18:30',
      confirmed: true,
    });
    expect(result.needsConfirmation).toBe(false);
    const job = result.job!;
    expect(job.schedule).toBe('daily 18:30');
    expect(store.list().map((j) => j.id)).toEqual([job.id]);
    const echo = renderCronDraftEcho(result.draft!);
    expect(echo).toContain('daily 18:30');
    expect(echo).toContain(job.instruction);
  });

  it('解析失败 → 不落盘且回传失败详情（fuzzy 拒绝）', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const result = await addCronJobFromNatural(store, { instruction: 'x', text: '看情况提醒我' });
    expect(result.draft).toBeNull();
    expect(result.failure?.ok).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('instruction 为空 → 拒绝且不落盘', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const result = await addCronJobFromNatural(store, { instruction: '   ', text: '每天 09:00', confirmed: true });
    expect(result.failure?.ok).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('confirmCronDraft 二次校验：被篡改的规格落盘即抛（fail-closed）', () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    expect(() =>
      confirmCronDraft(store, {
        instruction: 'x',
        text: 'x',
        schedule: 'bogus',
        display: 'x',
        source: 'rules',
        previewNextRun: new Date().toISOString(),
      }),
    ).toThrow(CronError);
  });

  it('addCronJobFromNaturalOrThrow：成功返回 job，失败抛可读错误', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const job = await addCronJobFromNaturalOrThrow(store, { instruction: 'y', text: '每2小时' });
    expect(job.schedule).toBe('2h');
    await expect(addCronJobFromNaturalOrThrow(store, { instruction: 'y', text: '随缘' })).rejects.toThrow(CronError);
  });

  it('draftCronJob 不改盘（纯 draft）', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const drafted = await draftCronJob({ instruction: 'z', text: '每天 08:00' });
    expect(drafted.ok).toBe(true);
    expect(store.list()).toEqual([]);
  });
});

// —— 用例 5：投递通道抽象 ——

describe('H-46 投递通道抽象（不实现平台，只留通道缝）', () => {
  it('未注册通道 → 显式失败（不静默丢弃）', async () => {
    const dispatcher = new CronDeliveryDispatcher();
    const result = await dispatcher.deliver(
      { channel: 'telegram' },
      {
        jobId: 'j1',
        instruction: 'i',
        ok: true,
        ts: new Date().toISOString(),
        resultPath: '/tmp/x',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('telegram');
  });

  it('注册通道 → 收到脱敏信封；密钥形态文本被 [REDACTED]', async () => {
    const received: unknown[] = [];
    const sink: CronDeliverySink = {
      channel: 'web',
      deliver: (envelope) => {
        received.push(envelope);
        return { ok: true };
      },
    };
    const dispatcher = new CronDeliveryDispatcher([sink]);
    const result = await dispatcher.deliver(
      { channel: 'web', address: 'room-1' },
      {
        jobId: 'j1',
        instruction: 'apiKey = sk-abcdef123456',
        ok: true,
        ts: new Date().toISOString(),
        resultPath: '/tmp/x',
        text: 'token=secretvalue12345 完成',
      },
    );
    expect(result.ok).toBe(true);
    const envelope = received[0] as { instruction: string; text?: string };
    expect(envelope.instruction).not.toContain('sk-abcdef123456');
    expect(envelope.text).not.toContain('secretvalue12345');
  });

  it('通道抛错 → 归一为失败结果，不外抛', async () => {
    const sink: CronDeliverySink = {
      channel: 'boom',
      deliver: () => {
        throw new Error('platform exploded');
      },
    };
    const dispatcher = new CronDeliveryDispatcher([sink]);
    const result = await dispatcher.deliver(
      { channel: 'boom' },
      { jobId: 'j1', instruction: 'i', ok: false, ts: new Date().toISOString(), resultPath: '/tmp/x' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('platform exploded');
  });

  it('调度投递：到点任务执行后投递结果并回报帧；投递失败不影响熔断计数', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob({ deliver: { channel: 'cli' } })]);
    const envelopes: Array<{ ok: boolean }> = [];
    const dispatcher = new CronDeliveryDispatcher([
      {
        channel: 'cli',
        deliver: (envelope) => {
          envelopes.push({ ok: envelope.ok });
          return { ok: false, error: 'no tty' };
        },
      },
    ]);
    const frames: CronFinishedFrame[] = [];
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider: new StubOkProvider(),
      toolsForSession: () => tools(),
      fsync: false,
      delivery: dispatcher,
      onFinished: (f) => frames.push(f),
    });
    await scheduler.tick(new Date());
    await scheduler.stop();
    expect(envelopes).toEqual([{ ok: true }]);
    expect(frames[0]?.deliver).toEqual({ channel: 'cli', ok: false, error: 'no tty' });
    // 投递失败不记入熔断
    expect(new CronJobStore(root).get('cron-test1')!.failCount).toBe(0);
    // 投递失败落 incident
    const incidents = readFileSync(join(root, 'incidents.jsonl'), 'utf8');
    expect(incidents).toContain('delivery_failed');
  });

  it('未配置投递目标 → 帧不带 deliver 字段（既有形状不变）', async () => {
    const root = tmpDir();
    writeJobsFile(root, [makeJob()]);
    const frames: CronFinishedFrame[] = [];
    const scheduler = new CronScheduler({
      root,
      cwd: root,
      provider: new StubOkProvider(),
      toolsForSession: () => tools(),
      fsync: false,
      onFinished: (f) => frames.push(f),
    });
    await scheduler.tick(new Date());
    await scheduler.stop();
    expect(frames).toEqual([{ type: 'cron', op: 'finished', id: 'cron-test1', ok: true }]);
  });

  it('非法投递目标：add 拒绝；jobs.json 里的坏 deliver 读取时被剔除（任务仍可用）', () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    expect(() => store.add('x', '5m', { deliver: { channel: '  ' } })).toThrow(CronError);
    writeJobsFile(root, [makeJob({ deliver: { channel: '' } })]);
    const job = store.get('cron-test1')!;
    expect(job.deliver).toBeUndefined();
  });
});

// —— 用例 6：创建/列出/删除/启停全链路（core API 面） ——

describe('H-46 全链路 core API：创建/列出/删除/启停', () => {
  it('自然语言创建 → 列出 → 停用/启用 → 删除', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const job = await addCronJobFromNaturalOrThrow(store, { instruction: '晨会摘要', text: '每个工作日上午9点' });
    expect(store.list().map((j) => j.id)).toEqual([job.id]);
    const disabled = store.setEnabled(job.id, false)!;
    expect(disabled.enabled).toBe(false);
    expect(store.get(job.id)!.enabled).toBe(false);
    expect(store.setEnabled(job.id, true)!.enabled).toBe(true);
    expect(store.setEnabled('nope', true)).toBeUndefined();
    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  // 补强（覆盖矩阵）：把「自然语言创建」与「启停」接到真实调度器上——
  // 证明 enable/disable 不只改一个字段，而是真的决定到点任务是否执行。
  it('自然语言创建 → 停用后到期不执行 → 启用后到期执行一次（启停与调度联动）', async () => {
    const root = tmpDir();
    const store = new CronJobStore(root);
    const job = await addCronJobFromNaturalOrThrow(store, { instruction: '巡检', text: '每5分钟' });
    const past = () => new Date(Date.now() - 60_000).toISOString();
    const makeScheduler = (frames: CronFinishedFrame[]): CronScheduler =>
      new CronScheduler({
        root,
        cwd: root,
        provider: new StubOkProvider(),
        toolsForSession: () => tools(),
        fsync: false,
        onFinished: (f) => frames.push(f),
      });

    // 停用：即便已到期也不执行，且 nextRun 不被推进
    store.setEnabled(job.id, false);
    store.update(job.id, { nextRun: past() });
    const nextRunWhileDisabled = store.get(job.id)!.nextRun;
    const disabledFrames: CronFinishedFrame[] = [];
    const s1 = makeScheduler(disabledFrames);
    await s1.tick(new Date());
    await s1.stop();
    expect(disabledFrames).toHaveLength(0);
    expect(store.get(job.id)!.enabled).toBe(false);
    expect(store.get(job.id)!.nextRun).toBe(nextRunWhileDisabled); // 未执行不推进

    // 启用：到期即执行一次，随后 nextRun 推进到未来（at-most-once）
    store.setEnabled(job.id, true);
    store.update(job.id, { nextRun: past() });
    const frames: CronFinishedFrame[] = [];
    const s2 = makeScheduler(frames);
    await s2.tick(new Date());
    await s2.stop();
    expect(frames.map((f) => f.id)).toEqual([job.id]);
    expect(frames[0]?.ok).toBe(true);
    expect(new Date(store.get(job.id)!.nextRun).getTime()).toBeGreaterThan(Date.now());
  });
});
