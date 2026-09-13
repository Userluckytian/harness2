// /undo /redo 命令测试：dry-run 预览、快照联动输出、层数校验、错误文案逐字（复用 core undo 内核）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../src/session/snapshots.js';
import { SessionWriter } from '../../src/session/writer.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cmd-undo-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 典型两 turn 会话：header(1) u1(2) a1(3) u2(4) a2(5) */
function makeTurnSession(dir: string, turns: Array<[string, string]>): SessionWriter {
  const w = SessionWriter.create(dir, { sessionId: 'undo-cmd-test' }, { fsync: false });
  for (const [u, a] of turns) {
    w.append('user/message', { text: u });
    w.append('assistant/message', { text: a });
  }
  return w;
}

describe('/undo', () => {
  it('dry-run：预览行 + 文件快照无（不动日志）', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
    const seqBefore = w.lastSeq;

    await execCommand('/undo --dry-run', ctx);

    expect(ctx.lines).toEqual([
      '预览（未执行）：将撤回 2 条消息，rewind 到 seq 3',
      '  - 文件快照：无（本 turn 未通过 write/edit 改动文件，或未启用快照）',
    ]);
    expect(w.lastSeq).toBe(seqBefore); // dry-run 不落盘
  });

  it('实际撤回 + 快照联动：创建的文件被删除（输出与 cli printFiles 同格式）', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    w.append('tool/call', { callId: 'c1', tool: 'write' });
    const toolCallSeq = w.lastSeq;
    w.append('tool/result', { callId: 'c1', ok: true });

    const created = join(dir, 'created.txt');
    writeFileSync(created, 'hello 快照', 'utf8');
    const snapshots = new SnapshotStore(dir);
    snapshots.capture({ seq: toolCallSeq, file: created, before: null });
    snapshots.commitAfter({ seq: toolCallSeq, after: 'hello 快照' });

    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }), snapshots: () => snapshots });
    await execCommand('/undo', ctx);

    expect(ctx.lines).toEqual(['已撤回 2 条消息（rewind 到 seq 1）', `  - ${created} → 删除创建的文件（已执行）`]);
    expect(existsSync(created)).toBe(false); // 文件真的被删了
  });

  it('层数非法 → error: 无效的撤回层数（1..100 逐字文案）', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    for (const token of ['0', '101', 'abc']) {
      const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
      await execCommand(`/undo ${token}`, ctx);
      expect(ctx.lines).toEqual([`error: 无效的撤回层数 "${token}"（应为 1..100 整数）`]);
    }
  });

  it('无活动会话 → error: 无活动会话', async () => {
    const ctx = makeRecordingCtx(); // current() = null
    await execCommand('/undo', ctx);
    expect(ctx.lines).toEqual(['error: 无活动会话']);
  });

  it('无可撤（无活动 user/message）→ 内核错误逐字透出', async () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'empty' }, { fsync: false });
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
    await execCommand('/undo', ctx);
    expect(ctx.lines).toEqual(['error: 没有可撤回的用户消息']);
  });

  it('/undo 2 连撤两层 → 两行撤回输出', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
    await execCommand('/undo 2', ctx);
    expect(ctx.lines).toEqual([
      '已撤回 2 条消息（rewind 到 seq 3）',
      '  - 文件快照：无（本 turn 未通过 write/edit 改动文件，或未启用快照）',
      '已撤回 2 条消息（rewind 到 seq 1）',
      '  - 文件快照：无（本 turn 未通过 write/edit 改动文件，或未启用快照）',
    ]);
  });
});

describe('/redo', () => {
  it('撤销后重做：恢复输出 + 文件恢复', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    w.append('tool/call', { callId: 'c1', tool: 'write' });
    const toolCallSeq = w.lastSeq;
    w.append('tool/result', { callId: 'c1', ok: true });

    const created = join(dir, 'created.txt');
    writeFileSync(created, 'hello 快照', 'utf8');
    const snapshots = new SnapshotStore(dir);
    snapshots.capture({ seq: toolCallSeq, file: created, before: null });
    snapshots.commitAfter({ seq: toolCallSeq, after: 'hello 快照' });

    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }), snapshots: () => snapshots });
    await execCommand('/undo', ctx);
    expect(existsSync(created)).toBe(false);

    ctx.lines.length = 0;
    await execCommand('/redo', ctx);
    expect(ctx.lines).toEqual([
      '已重做 2 条消息（rewind 到 seq 5）',
      `  - ${created} → 恢复内容 "hello 快照"（已执行）`,
    ]);
    expect(existsSync(created)).toBe(true);
  });

  it('无撤销标记 → error: 没有可重做的撤销（日志中没有 rewind/marker）', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
    await execCommand('/redo', ctx);
    expect(ctx.lines).toEqual(['error: 没有可重做的撤销（日志中没有 rewind/marker）']);
  });

  it('无活动会话 → error: 无活动会话', async () => {
    const ctx = makeRecordingCtx();
    await execCommand('/redo', ctx);
    expect(ctx.lines).toEqual(['error: 无活动会话']);
  });
});
