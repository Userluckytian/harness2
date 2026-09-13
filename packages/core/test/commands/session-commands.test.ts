// 会话命令测试：/resume 参数校验、/sessions 列表与搜索、/fork 分叉缝（真实 SessionManager + tmp 根）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCommand, makeRecordingCtx } from './helpers.js';
import { SESSION_LOG_FILE } from '../../src/session/types.js';
import { SessionManager } from '../../src/session/manager.js';
import type { SessionWriter } from '../../src/session/writer.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cmd-sessions-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 在 tmp 根建两个会话：older（先建，mtime 拨旧 1 分钟）与 newer（后建，作当前会话） */
function seedSessions(cwd: string): {
  manager: SessionManager;
  olderId: string;
  newerId: string;
  newerWriter: SessionWriter;
} {
  const manager = new SessionManager(tmpDir());
  const older = manager.create(cwd);
  older.writer.append('user/message', { text: '帮我查一下 flaky 测试的原因' });
  older.writer.close();
  // mtime 确定性：older 拨旧 1 分钟（同秒创建时 mtime 倒序排序不稳定）
  const stale = new Date(Date.now() - 60_000);
  utimesSync(join(older.dir, SESSION_LOG_FILE), stale, stale);
  const newer = manager.create(cwd);
  newer.writer.append('user/message', { text: '继续修复 undo 边界' });
  return { manager, olderId: older.id, newerId: newer.id, newerWriter: newer.writer };
}

describe('/resume', () => {
  it('缺 id → 逐字错误文案（不切换会话）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/resume', ctx);
    expect(ctx.lines).toEqual(['error: 用法 /resume <id>（/sessions 查看 id）']);
    expect(ctx.switched).toEqual([]);
  });

  it('带 id → switchSession(id)', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/resume 20260913-101010-abcdef', ctx);
    expect(ctx.lines).toEqual([]);
    expect(ctx.switched).toEqual(['20260913-101010-abcdef']);
  });
});

describe('/sessions', () => {
  it('无会话 → （无会话）', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/sessions', ctx);
    expect(ctx.lines).toEqual(['（无会话）']);
  });

  it('列表：id + 时间 + 条数 + 当前会话 * 标记 + 首条用户消息（mtime 倒序）', async () => {
    const cwd = tmpDir();
    const { manager, newerId, newerWriter } = seedSessions(cwd);
    const ctx = makeRecordingCtx({ manager, cwd, current: () => ({ id: newerId, writer: newerWriter }) });
    await execCommand('/sessions', ctx);
    expect(ctx.lines.length).toBe(2);
    for (const line of ctx.lines) {
      expect(line).toMatch(/^20\d{6}-\d{6}-[0-9a-f]{6,} {2}\d{2}-\d{2} \d{2}:\d{2} {2}1 条( \*)? {2}/);
    }
    // 当前会话带 * 标记；另一条不带
    const currentLine = ctx.lines.find((l) => l.includes(newerId));
    expect(currentLine).toContain('1 条 *  继续修复 undo 边界');
    expect(ctx.lines.find((l) => l !== currentLine)).toContain('1 条  帮我查一下 flaky 测试的原因');
    // mtime 倒序：当前会话（newer）在前
    expect(ctx.lines[0]).toContain(newerId);
  });

  it('关键字搜索：命中行 + 缩进命中片段；无匹配 → 逐字文案', async () => {
    const cwd = tmpDir();
    const { manager, olderId } = seedSessions(cwd);
    const ctx = makeRecordingCtx({ manager, cwd });

    await execCommand('/sessions flaky', ctx);
    expect(ctx.lines.length).toBe(2);
    expect(ctx.lines[0]).toContain(olderId);
    expect(ctx.lines[0]).toContain('帮我查一下 flaky 测试的原因');
    expect(ctx.lines[1]).toMatch(/^ {4}命中 \[user@\d+\]: 帮我查一下 flaky 测试的原因$/);

    ctx.lines.length = 0;
    await execCommand('/sessions 不存在的关键字xyz', ctx);
    expect(ctx.lines).toEqual(['（无匹配会话：不存在的关键字xyz）']);
  });
});

describe('/fork', () => {
  it('未注入 fork 缝 → 逐字错误文案', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/fork', ctx);
    expect(ctx.lines).toEqual(['error: 当前会话不支持分叉']);
  });

  it('不带序号 → fork()；带合法序号 → fork(at)', async () => {
    const ctx = makeRecordingCtx({ fork: (at) => ctx.forkCalls.push(at) });
    await execCommand('/fork', ctx);
    expect(ctx.forkCalls).toEqual([undefined]);
    await execCommand('/fork 3', ctx);
    expect(ctx.forkCalls).toEqual([undefined, 3]);
  });

  it('非法序号 → 逐字错误文案（0 / 负数 / 非整数 / 非数字）', async () => {
    for (const token of ['0', '-2', '1.5', 'abc']) {
      const ctx = makeRecordingCtx({ fork: (at) => ctx.forkCalls.push(at) });
      await execCommand(`/fork ${token}`, ctx);
      expect(ctx.lines).toEqual([`error: 无效的事件序号 "${token}"（应为 >= 1 的整数，或省略分叉全部活动事件）`]);
      expect(ctx.forkCalls).toEqual([]);
    }
  });
});
