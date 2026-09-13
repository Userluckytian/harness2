// /context /compact /tasks 命令测试：可选缝注入与缺省降级（逐字对齐现有壳文案）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContextUsage } from '../../src/agent/contextUsage.js';
import { parseCoreCommand, runCoreCommand } from '../../src/commands/index.js';
import type { CronJob } from '../../src/cron/jobs.js';
import { SessionManager } from '../../src/session/manager.js';
import type { SessionWriter } from '../../src/session/writer.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cmd-ctx-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 真实会话（1 条用户消息）作为缺省缝的占用来源 */
function seedSession(): { manager: SessionManager; id: string; writer: SessionWriter } {
  const manager = new SessionManager(tmpDir());
  const s = manager.create(tmpDir());
  s.writer.append('user/message', { text: '估算一下上下文占用' });
  return { manager, id: s.id, writer: s.writer };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron-test01',
    instruction: '每天上午汇总待办',
    schedule: 'daily 09:00',
    nextRun: '2026-09-14T01:00:00.000Z',
    enabled: true,
    failCount: 0,
    createdAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('/context', () => {
  it('注入缝：0.5 → 上下文占用: 50%；undefined → —（无活动会话）', async () => {
    const ctx = makeRecordingCtx({ contextUsage: () => 0.5 });
    await execCommand('/context', ctx);
    expect(ctx.lines).toEqual(['上下文占用: 50%']);

    const unknownCtx = makeRecordingCtx({ contextUsage: () => undefined });
    await execCommand('/context', unknownCtx);
    expect(unknownCtx.lines).toEqual(['上下文占用: —（无活动会话）']);
  });

  it('缺省缝（真实会话目录）→ 与 core getContextUsage 同源（0..100% 取整）', async () => {
    const { manager, id, writer } = seedSession();
    const ctx = makeRecordingCtx({ manager, current: () => ({ id, writer }) });
    await execCommand('/context', ctx);
    const usage = getContextUsage(writer.dir);
    expect(ctx.lines).toEqual([
      `上下文占用: ${usage === undefined ? '—（无活动会话）' : `${Math.round(usage * 100)}%`}`,
    ]);
  });

  it('缺省缝 + 无活动会话 → —（无活动会话）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/context', ctx);
    expect(ctx.lines).toEqual(['上下文占用: —（无活动会话）']);
  });
});

describe('/compact', () => {
  it('未注入缝 → 自动压缩提示（同步完成，对齐现有壳行为，不伪造执行）', () => {
    const ctx = makeRecordingCtx();
    const r = runCoreCommand(parseCoreCommand('/compact')!, ctx);
    expect(r).toBeUndefined(); // 同步语义（不返回 Promise）
    expect(ctx.lines).toEqual(['压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。']);
  });

  it('注入缝（异步 true）→ 已执行上下文压缩', async () => {
    const ctx = makeRecordingCtx({ compact: async () => true });
    const r = runCoreCommand(parseCoreCommand('/compact')!, ctx);
    if (!(r instanceof Promise)) throw new Error('注入 compact 缝后应返回 Promise');
    await r;
    expect(ctx.lines).toEqual(['已执行上下文压缩。']);
  });

  it('注入缝（同步 false）→ 未执行压缩说明', async () => {
    const ctx = makeRecordingCtx({ compact: () => false });
    const r = runCoreCommand(parseCoreCommand('/compact')!, ctx);
    if (!(r instanceof Promise)) throw new Error('注入 compact 缝后应返回 Promise');
    await r;
    expect(ctx.lines).toEqual(['未执行压缩：未达阈值或摘要生成失败（下一次 turn 开始时会自动重试）。']);
  });
});

describe('/tasks', () => {
  it('未注入缝 → `harness2 cron list` 引导文案（对齐现有壳行为）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/tasks', ctx);
    expect(ctx.lines).toEqual(['任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。']);
  });

  it('空任务表 → （无任务）', async () => {
    const ctx = makeRecordingCtx({ cronJobs: () => [] });
    await execCommand('/tasks', ctx);
    expect(ctx.lines).toEqual(['（无任务）']);
  });

  it('任务列表行：id + 调度 + 启用/停用 + 指令摘要（长指令截断）', async () => {
    const jobs = [
      makeJob(),
      makeJob({ id: 'cron-test02', instruction: '很长的指令'.repeat(30), schedule: '5m', enabled: false }),
    ];
    const ctx = makeRecordingCtx({ cronJobs: () => jobs });
    await execCommand('/tasks', ctx);
    expect(ctx.lines).toEqual([
      'cron-test01  daily 09:00  启用  每天上午汇总待办',
      `cron-test02  5m  停用  ${'很长的指令'.repeat(12)}…`, // 摘要 ≤60 字（5 字/组 × 12）
    ]);
  });
});
