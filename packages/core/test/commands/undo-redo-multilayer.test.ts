// /undo /redo 多层与边界补口（P1-② 覆盖矩阵补缺，加性文件不改既有用例）：
//   既有 undo-redo-commands.test.ts 盖了单层 /undo、/undo 2（两层）、单层 dry-run 预览、
//   无活动会话/无可撤/无 marker 的 UndoRedoError 透传；本文件补：
//   - /undo 3（n=3）三层连撤的逐层输出；
//   - /undo 100：上界 100 合法接受（parse 层只证明 '100' 能解析，这里证明经命令真实执行），
//     层数超过可撤层数时以内核错误行收尾（不抛出、不产生多余输出）；
//   - 连续 /redo 逐层恢复（先恢复最早一层）+ 投影回到全部消息；
//   - redo 栈耗尽（全部已重做）→ '没有可重做的撤销（没有尚未重做的 undo 标记）' 逐字透传。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjection, loadSession } from '../../src/session/reader.js';
import { SessionWriter } from '../../src/session/writer.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cmd-undo-multi-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** n 个 turn 的典型会话（header(1) + 每 turn 2 事件） */
function makeTurnSession(dir: string, turns: Array<[string, string]>): SessionWriter {
  const w = SessionWriter.create(dir, { sessionId: 'undo-multi-test' }, { fsync: false });
  for (const [u, a] of turns) {
    w.append('user/message', { text: u });
    w.append('assistant/message', { text: a });
  }
  return w;
}

const NO_FILES_LINE = '  - 文件快照：无（本 turn 未通过 write/edit 改动文件，或未启用快照）';

describe('/undo 多层', () => {
  it('/undo 3（n=3）→ 三层连撤，逐层 rewind 到 seq 5/3/1', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
      ['u3', 'a3'],
    ]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });

    await execCommand('/undo 3', ctx);

    expect(ctx.lines).toEqual([
      '已撤回 2 条消息（rewind 到 seq 5）',
      NO_FILES_LINE,
      '已撤回 2 条消息（rewind 到 seq 3）',
      NO_FILES_LINE,
      '已撤回 2 条消息（rewind 到 seq 1）',
      NO_FILES_LINE,
    ]);
  });

  it('/undo 100：上界 100 合法接受；层数超过可撤层数时以内核错误行收尾（不抛出）', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });

    await execCommand('/undo 100', ctx);

    expect(ctx.lines).toEqual([
      '已撤回 2 条消息（rewind 到 seq 3）',
      NO_FILES_LINE,
      '已撤回 2 条消息（rewind 到 seq 1）',
      NO_FILES_LINE,
      'error: 没有可撤回的用户消息',
    ]);
  });
});

describe('/redo 多层', () => {
  it('undo 2 层后连续 /redo 两次：逐层恢复（先恢复最早一层），投影回到全部 4 条消息', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
    await execCommand('/undo 2', ctx);
    expect(ctx.lines).toHaveLength(4); // 两层撤回各 2 行

    ctx.lines.length = 0;
    await execCommand('/redo', ctx);
    expect(ctx.lines).toEqual(['已重做 2 条消息（rewind 到 seq 6）', NO_FILES_LINE]);
    expect(computeProjection(loadSession(w.dir)).messages.map((m) => m.text)).toEqual(['u1', 'a1']);

    ctx.lines.length = 0;
    await execCommand('/redo', ctx);
    expect(ctx.lines).toEqual(['已重做 2 条消息（rewind 到 seq 5）', NO_FILES_LINE]);
    expect(computeProjection(loadSession(w.dir)).messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('全部重做完再 /redo → error: 没有可重做的撤销（没有尚未重做的 undo 标记）', async () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    const ctx = makeRecordingCtx({ current: () => ({ id: 's1', writer: w }) });
    await execCommand('/undo', ctx);
    await execCommand('/redo', ctx);
    expect(ctx.lines).toHaveLength(4);

    ctx.lines.length = 0;
    await execCommand('/redo', ctx);
    expect(ctx.lines).toEqual(['error: 没有可重做的撤销（没有尚未重做的 undo 标记）']);
  });
});
