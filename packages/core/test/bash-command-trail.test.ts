// Z6-A17 会话快照完整性测试：
// ① bash 副作用清单（真实日志提取，不重放）——collectBashCommands 区间/活动性/ok 关联；
//    undo/redo 结果对象携带受影响区间的清单（红线⑩：只报真实记录）。
// ② checkpoint 语义（A17-2）：每次「回到历史点」都落 rewind/marker——undo/redo 各落一枚
//    （测试钉住）。审计口径（2026-10-11 grep writer 调用点）：
//    - undoLastTurn / redoLastUndo：marker ✓（本文件钉住；serve hub undo/redo 与 chat
//      /undo、/redo 全部直调这两个内核函数，无旁路）；
//    - fork：按设计不落 marker（fork.ts 文件头：新会话 undo 从零开始，原会话不回退）；
//    - /resume（switchSession）：打开另一会话的当前 tip，不发生投影回退——不属
//      「回到历史点」，不落 marker（语义如此，非缺口）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectBashCommands } from '../src/session/bashCommands.js';
import { redoLastUndo, undoLastTurn } from '../src/session/undo.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-bash-trail-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWriter(id: string): SessionWriter {
  return SessionWriter.create(tmpDir(), { sessionId: id }, { fsync: false });
}

function loadEvents(dir: string): AnySessionEvent[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}

function markers(dir: string): Array<{ seq: number; reason?: string; rewindToSeq: number }> {
  return loadEvents(dir)
    .filter((e) => e.type === 'rewind/marker')
    .map((e) => ({
      seq: e.seq,
      reason: (e.payload as { reason?: string }).reason,
      rewindToSeq: (e.payload as { rewindToSeq: number }).rewindToSeq,
    }));
}

describe('A17-1 collectBashCommands（bash 清单提取）', () => {
  it('只取 tool=bash 的活动调用；write/read 不入清单；ok 按 callId 关联 tool/result', () => {
    const writer = makeWriter('extract');
    writer.append('user/message', { text: 'u1', turnId: 't1' });
    writer.append('tool/call', { callId: 'c1', tool: 'bash', args: { command: 'git init' }, turnId: 't1' });
    writer.append('tool/result', { callId: 'c1', tool: 'bash', ok: true, output: 'ok', turnId: 't1' });
    writer.append('tool/call', { callId: 'c2', tool: 'write', args: { file_path: 'a.txt' }, turnId: 't1' });
    writer.append('tool/result', { callId: 'c2', tool: 'write', ok: true, turnId: 't1' });
    writer.append('tool/call', { callId: 'c3', tool: 'bash', args: { command: 'rm missing.tmp' }, turnId: 't1' });
    writer.append('tool/result', { callId: 'c3', tool: 'bash', ok: false, error: 'boom', turnId: 't1' });
    writer.append('tool/call', { callId: 'c4', tool: 'bash', args: { command: 'sleep 100' }, turnId: 't1' });
    writer.append('tool/call', { callId: 'c5', tool: 'read', args: { file_path: 'a.txt' }, turnId: 't1' });
    writer.append('tool/call', { callId: 'c6', tool: 'bash', args: {}, turnId: 't1' }); // 无命令 → 不臆造
    writer.close();

    const records = collectBashCommands(loadSession(writer.dir));
    // seq：header=1，u1=2，c1=3 …（bash 记录 = c1@3、c3@7、c4@9）
    expect(records).toEqual([
      { seq: 3, command: 'git init', ok: true, turnId: 't1' },
      { seq: 7, command: 'rm missing.tmp', ok: false, turnId: 't1' },
      { seq: 9, command: 'sleep 100', turnId: 't1' }, // 结果未落 → ok 缺省（如实）
    ]);
  });

  it('区间过滤：afterSeq / upToSeq', () => {
    const writer = makeWriter('range');
    writer.append('user/message', { text: 'u1' });
    const s1 = writer.append('tool/call', { callId: 'c1', tool: 'bash', args: { command: 'one' } }).seq;
    const s2 = writer.append('tool/call', { callId: 'c2', tool: 'bash', args: { command: 'two' } }).seq;
    const s3 = writer.append('tool/call', { callId: 'c3', tool: 'bash', args: { command: 'three' } }).seq;
    writer.close();
    const session = loadSession(writer.dir);
    expect(collectBashCommands(session).map((r) => r.command)).toEqual(['one', 'two', 'three']);
    expect(collectBashCommands(session, { afterSeq: s2 }).map((r) => r.command)).toEqual(['three']);
    expect(collectBashCommands(session, { afterSeq: s1, upToSeq: s3 - 1 }).map((r) => r.command)).toEqual(['two']);
  });

  it('活动性：被 rewind 遮蔽的 bash 调用不进清单', () => {
    const writer = makeWriter('shadowed');
    writer.append('user/message', { text: 'u1' });
    writer.append('tool/call', { callId: 'c1', tool: 'bash', args: { command: 'before' } });
    writer.append('user/message', { text: 'u2' });
    writer.append('tool/call', { callId: 'c2', tool: 'bash', args: { command: 'discarded' } });
    undoLastTurn(writer); // 撤 u2 turn → 'discarded' 被遮蔽
    writer.close();
    expect(collectBashCommands(loadSession(writer.dir)).map((r) => r.command)).toEqual(['before']);
  });
});

describe('A17-1 undo/redo 结果携带 bash 清单', () => {
  /** u1, a1, u2, bash, r, a2 —— undo 撤掉 u2 turn（含 bash 副作用） */
  function buildWithBashInSecondTurn(): SessionWriter {
    const writer = makeWriter('carry');
    writer.append('user/message', { text: 'u1' });
    writer.append('assistant/message', { text: 'a1' });
    writer.append('user/message', { text: 'u2' });
    writer.append('tool/call', { callId: 'c1', tool: 'bash', args: { command: 'git push --force' } });
    writer.append('tool/result', { callId: 'c1', tool: 'bash', ok: true, output: 'pushed' });
    writer.append('assistant/message', { text: 'a2' });
    return writer;
  }

  it('undo：bashCommands = 被撤区间的真实 bash 调用（dryRun 同样携带）', () => {
    const writer = buildWithBashInSecondTurn();
    const preview = undoLastTurn(writer, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.bashCommands).toEqual([{ seq: 5, command: 'git push --force', ok: true }]);

    const applied = undoLastTurn(writer);
    expect(applied.kind).toBe('undo');
    expect(applied.bashCommands).toEqual([{ seq: 5, command: 'git push --force', ok: true }]);
    // 文件快照账不含 bash 副作用：files 只反映 write/edit（此处无）
    expect(applied.files).toEqual([]);
    writer.close();
  });

  it('redo：bashCommands = 复活区间的真实 bash 调用', () => {
    const writer = buildWithBashInSecondTurn();
    const u = undoLastTurn(writer);
    const r = redoLastUndo(writer);
    expect(r.kind).toBe('redo');
    expect(r.rewindToSeq).toBe(u.markerSeq - 1);
    expect(r.bashCommands).toEqual([{ seq: 5, command: 'git push --force', ok: true }]);
    writer.close();
  });

  it('无可撤/无 bash 调用时如实为空数组（不臆造）', () => {
    const writer = makeWriter('empty');
    writer.append('user/message', { text: 'u1' });
    writer.append('assistant/message', { text: 'a1' });
    const r = undoLastTurn(writer);
    expect(r.bashCommands).toEqual([]);
    writer.close();
  });
});

describe('A17-2 checkpoint 语义：每次回到历史点都有 rewind/marker', () => {
  it('undo 落一枚 marker（reason=undo）；redo 再落一枚（reason=redo）——每次回退恰好一枚', () => {
    const writer = makeWriter('markers');
    for (const t of ['t1', 't2', 't3']) {
      writer.append('user/message', { text: t });
      writer.append('assistant/message', { text: `回复:${t}` });
    }
    expect(markers(writer.dir)).toEqual([]); // 未回退：无 marker

    const u1 = undoLastTurn(writer);
    let ms = markers(writer.dir);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ seq: u1.markerSeq, reason: 'undo', rewindToSeq: u1.rewindToSeq });

    const u2 = undoLastTurn(writer);
    ms = markers(writer.dir);
    expect(ms).toHaveLength(2);
    expect(ms[1]).toMatchObject({ seq: u2.markerSeq, reason: 'undo' });

    const r = redoLastUndo(writer);
    ms = markers(writer.dir);
    expect(ms).toHaveLength(3);
    expect(ms[2]).toMatchObject({ seq: r.markerSeq, reason: 'redo', rewindToSeq: r.rewindToSeq });

    // 投影一致性（redo 链中立化）：undo×2 + redo×1 后活动消息 = 4 条（t1 对 + t2 对）
    computeProjection(loadSession(writer.dir));
    writer.close();
  });

  it('多级 undo/redo 链：每层回退各自落 marker（n 层 = n 枚 undo marker）', () => {
    const writer = makeWriter('chain');
    for (let i = 1; i <= 4; i++) {
      writer.append('user/message', { text: `t${i}` });
      writer.append('assistant/message', { text: `r${i}` });
    }
    const undos = [undoLastTurn(writer), undoLastTurn(writer), undoLastTurn(writer)];
    expect(markers(writer.dir)).toHaveLength(3);
    const r1 = redoLastUndo(writer);
    const r2 = redoLastUndo(writer);
    const ms = markers(writer.dir);
    expect(ms).toHaveLength(5);
    expect(ms.slice(3).map((m) => m.reason)).toEqual(['redo', 'redo']);
    expect(r1.rewindToSeq).toBe(undos[2]!.markerSeq - 1);
    expect(r2.rewindToSeq).toBe(undos[1]!.markerSeq - 1);
    writer.close();
  });
});
