// undo/redo 内核语义测试：投影截断 + 快照恢复联动 + n 级链 + dryRun 无副作用 + 边界。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWriter } from '../src/session/writer.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { SnapshotStore } from '../src/session/snapshots.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { redoLastUndo, UndoRedoError, undoLastTurn } from '../src/session/undo.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-undo-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 典型 turn：header(1) u(2) a(3) */
function makeTurnSession(dir: string, turns: Array<[string, string]>): SessionWriter {
  const w = SessionWriter.create(dir, { sessionId: 'undo-test' }, { fsync: false });
  for (const [u, a] of turns) {
    w.append('user/message', { text: u });
    w.append('assistant/message', { text: a });
  }
  return w;
}

function activeTexts(dir: string): string[] {
  return computeProjection(loadSession(dir)).messages.map((m) => `${m.role}:${m.text}`);
}

describe('undoLastTurn 投影截断', () => {
  it('单 turn：撤掉 user/message 及其后内容，marker reason=undo', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const r = undoLastTurn(w, { dryRun: false });
    w.close();

    expect(r).toMatchObject({ kind: 'undo', dryRun: false, rewindToSeq: 3, messages: 2 }); // u2(4)+a2(5) 被撤，保留到 a1(3)
    expect(r.markerSeq).toBe(6);
    expect(activeTexts(dir)).toEqual(['user:u1', 'assistant:a1']); // u2/a2 被遮蔽

    const marker = loadSession(dir).events.at(-1)!.event;
    expect(marker).toMatchObject({ type: 'rewind/marker', seq: 6, payload: { rewindToSeq: 3, reason: 'undo' } });
  });

  it('含 attempt/tool 事件的 turn 全部遮蔽（撤到该用户消息之前）', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'undo-test' }, { fsync: false });
    w.append('user/message', { text: 'u1' });
    w.append('assistant/message', { text: 'a1' });
    w.append('assistant/attempt', { error: 'boom' });
    w.append('tool/call', { callId: 'c1', tool: 'bash' });
    w.append('tool/result', { callId: 'c1', ok: true });
    const r = undoLastTurn(w);
    w.close();

    expect(r.rewindToSeq).toBe(1); // u1 在 seq 2 → 目标 1（header）
    const s = loadSession(dir);
    const p = computeProjection(s);
    expect(p.messages).toEqual([]);
    expect(p.activeCount).toBe(2); // header + undo marker
  });

  it('undo 到会话开头：目标 seq 1 合法（只留 header）', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    const r = undoLastTurn(w);
    w.close();
    expect(r.rewindToSeq).toBe(1);
    expect(activeTexts(dir)).toEqual([]);
  });

  it('边界：无活动 user/message → 明确错误', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'x' }, { fsync: false });
    expect(() => undoLastTurn(w)).toThrow(UndoRedoError);
    expect(() => undoLastTurn(w)).toThrow(/没有可撤回的用户消息/);
    w.close();
  });

  it('边界：用户消息在 seq 1（手造日志，无 header）→ 目标 0 越界报错', () => {
    const dir = tmpDir();
    // 手工构造绕过 writer.create 的 header（writer 校验侧不可能产生该日志）
    const lines = [
      JSON.stringify({ v: 1, seq: 1, ts: '2026-09-06T00:00:00.000Z', type: 'user/message', payload: { text: '只有一条' } }),
    ];
    writeFileSync(join(dir, SESSION_LOG_FILE), lines.join('\n') + '\n', 'utf8');
    const w = SessionWriter.open(dir, { fsync: false });
    expect(() => undoLastTurn(w)).toThrow(/目标 seq 0 越界/);
    w.close();
  });

  it('第二次 undo 撤更早的 turn（n 级链：连续 undo）', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    undoLastTurn(w);
    const r2 = undoLastTurn(w);
    w.close();
    expect(r2.rewindToSeq).toBe(1); // u1 在 seq 2 → 目标 1
    expect(activeTexts(dir)).toEqual([]);
  });

  it('undo 恢复后的新分支上再 undo：只影响新分支', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    undoLastTurn(w); // 撤掉 u1/a1
    w.append('user/message', { text: 'u1-alt' });
    w.append('assistant/message', { text: 'a1-alt' });
    const r = undoLastTurn(w);
    w.close();
    expect(r.rewindToSeq).toBe(4); // u1-alt 在 seq 5 → 目标 4（undo marker）
    expect(activeTexts(dir)).toEqual([]);
  });

  it('dryRun：不追加 marker、不写文件，返回与实际执行一致的预览', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const before = readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
    const r = undoLastTurn(w, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.messages).toBe(2);
    expect(r.markerSeq).toBe(6); // 拟追加位置
    expect(readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')).toBe(before); // 日志未动
    // 实际执行结果与预览一致
    const r2 = undoLastTurn(w);
    w.close();
    expect(r2.messages).toBe(2);
    expect(r2.rewindToSeq).toBe(r.rewindToSeq);
  });
});

describe('redoLastUndo（marker 链复活）', () => {
  it('undo → redo：被遮蔽的消息恢复活动，marker reason=redo', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const u = undoLastTurn(w);
    const r = redoLastUndo(w);
    w.close();

    expect(r).toMatchObject({ kind: 'redo', rewindToSeq: u.markerSeq - 1, messages: 2 });
    expect(activeTexts(dir)).toEqual(['user:u1', 'assistant:a1', 'user:u2', 'assistant:a2']);
    const marker = loadSession(dir).events.at(-1)!.event;
    expect(marker).toMatchObject({ type: 'rewind/marker', seq: 7, payload: { rewindToSeq: 5, reason: 'redo' } });
  });

  it('redo 无 undo（无 marker / 最后 marker 是 redo）→ 明确错误', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    expect(() => redoLastUndo(w)).toThrow(/没有 rewind\/marker/);

    undoLastTurn(w);
    redoLastUndo(w);
    expect(() => redoLastUndo(w)).toThrow(/没有尚未重做的 undo 标记/); // 已 redo，无可再 redo
    w.close();
  });

  it('n 级链往返：undo→undo→undo→redo→redo→redo 完整恢复', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
      ['u3', 'a3'],
    ]);
    const texts = ['user:u1', 'assistant:a1', 'user:u2', 'assistant:a2', 'user:u3', 'assistant:a3'];

    undoLastTurn(w);
    undoLastTurn(w);
    undoLastTurn(w);
    expect(activeTexts(dir)).toEqual([]); // 三个 turn 全部撤掉
    redoLastUndo(w);
    expect(activeTexts(dir)).toEqual(texts.slice(0, 2)); // LIFO：先恢复最早的 turn
    redoLastUndo(w);
    expect(activeTexts(dir)).toEqual(texts.slice(0, 4));
    redoLastUndo(w);
    expect(activeTexts(dir)).toEqual(texts); // 全部恢复
    w.close();
  });

  it('undo→redo→undo→redo 链稳定；redo 后再 undo 回到撤后状态', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const texts = ['user:u1', 'assistant:a1', 'user:u2', 'assistant:a2'];
    undoLastTurn(w);
    redoLastUndo(w);
    undoLastTurn(w);
    expect(activeTexts(dir)).toEqual(texts.slice(0, 2));
    redoLastUndo(w);
    expect(activeTexts(dir)).toEqual(texts);
    w.close();
  });

  it('undo 后追加新 turn 再 redo：redo 恢复的是「undo 前的状态」，新 turn 被遮蔽（语义如实声明）', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    undoLastTurn(w); // u1/a1 被遮蔽
    w.append('user/message', { text: 'undo 之后的消息' });
    w.append('assistant/message', { text: 'undo 之后的回复' });
    const r = redoLastUndo(w);
    w.close();

    expect(r.messages).toBe(2); // 恢复 u1/a1
    expect(activeTexts(dir)).toEqual(['user:u1', 'assistant:a1']); // 新 turn 被遮蔽
  });

  it('dryRun 的 redo 同样无副作用', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    undoLastTurn(w);
    const before = readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
    const r = redoLastUndo(w, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')).toBe(before);
    expect(activeTexts(dir)).toEqual([]); // 仍处于撤后状态
    w.close();
  });
});

describe('undo/redo 与快照联动', () => {
  it('undo 恢复文件 before；dryRun 只列出计划不写盘', () => {
    const dir = tmpDir(); // 会话目录
    const work = tmpDir(); // 工作目录
    const file = join(work, 'a.txt');
    writeFileSync(file, 'v1', 'utf8');

    const w = SessionWriter.create(dir, { sessionId: 'snap' }, { fsync: false });
    w.append('user/message', { text: '写文件' });
    const snapshots = new SnapshotStore(dir);
    // 模拟 loop 钩子：tool/call 在 seq 3，write 执行前后捕获
    snapshots.capture({ seq: 3, file, before: 'v1' });
    snapshots.commitAfter({ seq: 3, after: 'v2' });
    writeFileSync(file, 'v2', 'utf8');
    w.append('assistant/message', { text: '已写入' });

    const preview = undoLastTurn(w, { snapshots, dryRun: true });
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]).toMatchObject({ file, target: 'v1', current: 'v2', externallyModified: false, restored: false });
    expect(readFileSync(file, 'utf8')).toBe('v2'); // dryRun 未动

    const r = undoLastTurn(w, { snapshots });
    w.close();
    expect(r.files[0]!.restored).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('v1');
  });

  it('undo 删除被创建的文件；redo 恢复 after 内容', () => {
    const dir = tmpDir();
    const work = tmpDir();
    const file = join(work, 'created.txt');
    writeFileSync(file, 'content', 'utf8');

    const w = SessionWriter.create(dir, { sessionId: 'snap2' }, { fsync: false });
    w.append('user/message', { text: '创建文件' });
    const snapshots = new SnapshotStore(dir);
    snapshots.capture({ seq: 3, file, before: null });
    snapshots.commitAfter({ seq: 3, after: 'content' });

    const u = undoLastTurn(w, { snapshots });
    expect(u.files[0]).toMatchObject({ target: null, restored: true });
    expect(existsSync(file)).toBe(false);

    const r = redoLastUndo(w, { snapshots });
    w.close();
    expect(r.files[0]).toMatchObject({ target: 'content', restored: true });
    expect(readFileSync(file, 'utf8')).toBe('content');
  });

  it('未提供 snapshots 时只做投影截断（files 为空）', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [['u1', 'a1']]);
    const r = undoLastTurn(w);
    w.close();
    expect(r.files).toEqual([]);
    expect(activeTexts(dir)).toEqual([]);
  });
});

describe('Model-visible ⟺ logged 与 undo/redo', () => {
  it('undo 后日志重建的消息序列不含被撤 turn；redo 后完整恢复（上下文重建一致性）', () => {
    const dir = tmpDir();
    const w = makeTurnSession(dir, [
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    undoLastTurn(w);
    let msgs = computeProjection(loadSession(dir)).messages.map((m) => m.text);
    expect(msgs).toEqual(['u1', 'a1']);
    redoLastUndo(w);
    msgs = computeProjection(loadSession(dir)).messages.map((m) => m.text);
    expect(msgs).toEqual(['u1', 'a1', 'u2', 'a2']);
    // append-only：全部事件仍在日志中
    expect(loadSession(dir).events.length).toBe(7); // header+4 消息 + undo marker + redo marker
    w.close();
  });
});
