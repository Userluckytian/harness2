// /fork /resume 真实会话补口（P1-② 覆盖矩阵补缺，加性文件不改既有用例）：
//   既有 session-commands.test.ts 用录制缝只验证「fork(at) 被调 / switchSession(id) 被调」；
//   本文件把缝接到真实内核（forkSession + SessionManager + tmp 目录，接线方式对齐 cli
//   chat-setup 的 runtime.fork），验证：
//   - /fork <seq>：真实分叉前缀投影 + 血缘 header + 原会话字节级零改动；
//   - /fork（无 seq）：全量分叉全部活动事件；
//   - /fork 0：逐字错误文案且真实会话库不新增会话（分叉未发生）；
//   - /resume：成功恢复后 current() 真变化（/sessions 的当前会话 * 标记随恢复移动）；
//     多 token 只取第一个 token 作为 id。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkSession } from '../../src/session/fork.js';
import { SessionManager } from '../../src/session/manager.js';
import { computeProjection, loadSession } from '../../src/session/reader.js';
import type { SessionWriter } from '../../src/session/writer.js';
import { SESSION_LOG_FILE } from '../../src/session/types.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 原始会话：header(1) u1(2) a1(3) u2(4) a2(5)，挂在 manager 的 cwd 组（writer 已关闭落盘） */
function seedOriginal(
  root: string,
  cwd: string,
): { manager: SessionManager; id: string; dir: string; writer: SessionWriter } {
  const manager = new SessionManager(root);
  const { id, dir, writer } = manager.create(cwd);
  writer.append('user/message', { text: 'u1', turnId: 't1' });
  writer.append('assistant/message', { text: 'a1', turnId: 't1' });
  writer.append('user/message', { text: 'u2', turnId: 't2' });
  writer.append('assistant/message', { text: 'a2', turnId: 't2' });
  writer.close();
  return { manager, id, dir, writer };
}

function logText(dir: string): string {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
}

describe('/fork 真实分叉（缝接 core forkSession，对齐 cli chat-setup 接线）', () => {
  it('/fork 3：真实分叉前缀投影（u1,a1），血缘入 header，原会话字节级零改动', async () => {
    const root = tmpDir('h2-cmd-fork-root-');
    const cwd = tmpDir('h2-cmd-fork-cwd-');
    const orig = seedOriginal(root, cwd);
    const before = logText(orig.dir);

    let currentId: string | null = orig.id;
    const ctx = makeRecordingCtx({
      manager: orig.manager,
      cwd,
      fork: (at) => {
        ctx.forkCalls.push(at);
        const r = forkSession(orig.manager, currentId!, at !== undefined ? { atSeq: at } : {});
        currentId = r.id; // 对齐 cli：分叉成功后切换到新会话
      },
    });

    await execCommand('/fork 3', ctx);

    // core 命令本身不输出（分叉结果呈现归壳）；序号逐字传缝
    expect(ctx.lines).toEqual([]);
    expect(ctx.forkCalls).toEqual([3]);
    expect(currentId).not.toBe(orig.id);

    // 新会话：落在同一 cwd 组、血缘 header、投影 = seq<=3 的前缀（u1,a1）
    expect(orig.manager.list(cwd).some((s) => s.id === currentId)).toBe(true);
    const forked = loadSession(orig.manager.locate(currentId!));
    expect(forked.header).toMatchObject({ parentSession: orig.id, isSeeded: true });
    expect(computeProjection(forked).messages.map((m) => m.text)).toEqual(['u1', 'a1']);

    // 原会话零改动（字节级）
    expect(logText(orig.dir)).toBe(before);
  });

  it('/fork（无 seq）：全量分叉全部活动事件（4 条消息），原会话字节级零改动', async () => {
    const root = tmpDir('h2-cmd-fork-root-');
    const cwd = tmpDir('h2-cmd-fork-cwd-');
    const orig = seedOriginal(root, cwd);
    const before = logText(orig.dir);

    let currentId: string | null = orig.id;
    const ctx = makeRecordingCtx({
      manager: orig.manager,
      cwd,
      fork: (at) => {
        ctx.forkCalls.push(at);
        const r = forkSession(orig.manager, currentId!, at !== undefined ? { atSeq: at } : {});
        currentId = r.id;
      },
    });

    await execCommand('/fork', ctx);

    expect(ctx.forkCalls).toEqual([undefined]);
    const forked = loadSession(orig.manager.locate(currentId!));
    expect(computeProjection(forked).messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(logText(orig.dir)).toBe(before);
  });

  it('/fork 0：逐字错误文案，真实会话库不新增会话、当前会话不变（分叉未发生）', async () => {
    const root = tmpDir('h2-cmd-fork-root-');
    const cwd = tmpDir('h2-cmd-fork-cwd-');
    const orig = seedOriginal(root, cwd);

    let currentId: string | null = orig.id;
    const ctx = makeRecordingCtx({
      manager: orig.manager,
      cwd,
      fork: (at) => {
        ctx.forkCalls.push(at);
        const r = forkSession(orig.manager, currentId!, at !== undefined ? { atSeq: at } : {});
        currentId = r.id;
      },
    });

    await execCommand('/fork 0', ctx);

    expect(ctx.lines).toEqual(['error: 无效的事件序号 "0"（应为 >= 1 的整数，或省略分叉全部活动事件）']);
    expect(ctx.forkCalls).toEqual([]);
    expect(orig.manager.list(cwd)).toHaveLength(1); // 只有原会话
    expect(currentId).toBe(orig.id);
  });
});

describe('/resume 真实会话恢复', () => {
  /** 两个真实会话：older（先建，已关闭）与 newer（后建，初始当前会话） */
  function seedTwo(
    root: string,
    cwd: string,
  ): {
    manager: SessionManager;
    olderId: string;
    newerId: string;
    writers: Map<string, SessionWriter>;
  } {
    const manager = new SessionManager(root);
    const older = manager.create(cwd);
    older.writer.append('user/message', { text: '早期的会话' });
    older.writer.close();
    const newer = manager.create(cwd);
    newer.writer.append('user/message', { text: '当前会话' });
    return {
      manager,
      olderId: older.id,
      newerId: newer.id,
      writers: new Map<string, SessionWriter>([
        [older.id, older.writer],
        [newer.id, newer.writer],
      ]),
    };
  }

  it('成功恢复 → current() 变化；/sessions 把恢复的会话标记为当前（*）', async () => {
    const root = tmpDir('h2-cmd-resume-root-');
    const cwd = tmpDir('h2-cmd-resume-cwd-');
    const { manager, olderId, newerId, writers } = seedTwo(root, cwd);

    let currentId: string | null = newerId;
    const ctx = makeRecordingCtx({
      manager,
      cwd,
      current: () => (currentId === null ? null : { id: currentId, writer: writers.get(currentId)! }),
      switchSession: (id) => {
        ctx.switched.push(id);
        currentId = id; // 状态化缝：模拟壳真实切换
      },
    });

    await execCommand(`/resume ${olderId}`, ctx);
    expect(ctx.switched).toEqual([olderId]);
    expect(ctx.current()?.id).toBe(olderId); // current() 变化

    // /sessions 的当前会话 * 标记随恢复移动到被恢复的会话
    await execCommand('/sessions', ctx);
    const olderLine = ctx.lines.find((l) => l.includes(olderId));
    const newerLine = ctx.lines.find((l) => l.includes(newerId));
    expect(olderLine).toBeDefined();
    expect(newerLine).toBeDefined();
    expect(olderLine).toContain(' *');
    expect(newerLine).not.toContain(' *');
  });

  it('/resume <id> 带多余 token → 只取第一个 token 作为 id（current() 切到该会话）', async () => {
    const root = tmpDir('h2-cmd-resume-root-');
    const cwd = tmpDir('h2-cmd-resume-cwd-');
    const { manager, olderId, newerId, writers } = seedTwo(root, cwd);

    let currentId: string | null = newerId;
    const ctx = makeRecordingCtx({
      manager,
      cwd,
      current: () => (currentId === null ? null : { id: currentId, writer: writers.get(currentId)! }),
      switchSession: (id) => {
        ctx.switched.push(id);
        currentId = id;
      },
    });

    await execCommand(`/resume ${olderId} 忽略的尾巴`, ctx);
    expect(ctx.switched).toEqual([olderId]);
    expect(ctx.current()?.id).toBe(olderId);
    expect(ctx.lines).toEqual([]);
  });
});
