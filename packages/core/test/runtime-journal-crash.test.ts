// 版本化 runtime journal（S3a）崩溃/恢复/对账测试。
// 真实磁盘临时目录（os.tmpdir + randomUUID），不触用户数据。
// 覆盖：单写者、append-only、JSONL 行格式、EOF 半行截断恢复、readWatermark、
// judgeSubmission（not_started/started/unknown，unknown 不得被当 rejected/not_started）、
// task/transition 非法迁移写入口拒绝、queue/call 原语查询。
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  InvalidJournalAppendError,
  RUNTIME_JOURNAL_FILE,
  RuntimeJournal,
  RuntimeJournalLockedError,
  judgeSubmission,
  parseEntry,
  queryJournalById,
  readWatermark,
} from '../src/interaction/runtime-journal.js';
import type { RuntimeJournalEntry } from '../src/interaction/runtime-journal.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), `h2-rj-${randomUUID()}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readRaw(dir: string): string {
  return readFileSync(join(dir, RUNTIME_JOURNAL_FILE), 'utf8');
}

/** 构造一条手工 JSONL 行（用于模拟崩溃时的半行/损坏输入） */
function rawLine(input: {
  seq: number;
  kind: string;
  clientMessageId?: string;
  sessionId?: string;
}): string {
  return JSON.stringify({
    v: 1,
    seq: input.seq,
    ts: new Date().toISOString(),
    kind: input.kind,
    clientMessageId: input.clientMessageId,
    sessionId: input.sessionId,
    payload: { intent: 'queue' },
  });
}

describe('单写者守卫与追加', () => {
  it('create+append：seq 单调、JSONL 行格式（v/kind/稳定id/ISO ts）、末尾换行、行行可解析', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    const e1 = w.append({ kind: 'queue/accepted', clientMessageId: 'cm1', sessionId: 's1', intent: 'queue', queueSeq: 0 });
    const e2 = w.append({ kind: 'call/started', callId: 'c1', taskId: 't1', clientMessageId: 'cm1', tool: 'bash' });
    w.append({ kind: 'call/outcome', callId: 'c1', taskId: 't1', ok: true });
    w.close();

    expect(readRaw(dir).endsWith('\n')).toBe(true);
    const lines = readRaw(dir).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const [i, line] of lines.entries()) {
      const e = parseEntry(line);
      expect(e, `line ${i + 1} should parse`).not.toBeNull();
      expect(e?.v).toBe(1);
      expect(e?.seq).toBe(i + 1);
      expect(Number.isNaN(new Date(e?.ts as string).getTime())).toBe(false);
    }
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  it('同进程二次 create/open 抛 RuntimeJournalLockedError；close 释放；陈旧 pid 锁接管', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'seed', sessionId: 's1', intent: 'queue' });
    expect(() => RuntimeJournal.open(dir)).toThrow(RuntimeJournalLockedError);
    expect(() => RuntimeJournal.create(dir, { fsync: false })).toThrow(RuntimeJournalLockedError);
    w.close();

    // 陈旧锁（持锁进程已死）→ 接管
    writeFileSync(
      join(dir, 'runtime.v1.lock'),
      JSON.stringify({ pid: 2147483647, ts: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );
    const w2 = RuntimeJournal.open(dir, { fsync: false });
    expect(w2.lastSeq).toBeGreaterThan(0);
    w2.close();
  });

  it('open 续写 seq 连续；close 后 append 抛错', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.close();

    const w2 = RuntimeJournal.open(dir, { fsync: false });
    expect(w2.lastSeq).toBe(1);
    const e = w2.append({ kind: 'queue/removed', clientMessageId: 'a', reason: 'user-cancel' });
    expect(e.seq).toBe(2);
    w2.close();
    expect(() => w2.append({ kind: 'queue/removed', clientMessageId: 'a' })).toThrow(/closed/);
  });

  it('append-only：重新 open 只续写，不改写既存行字节', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.append({ kind: 'queue/accepted', clientMessageId: 'b', sessionId: 's1', intent: 'queue' });
    w.close();
    const before = readRaw(dir);

    const w2 = RuntimeJournal.open(dir, { fsync: false });
    w2.append({ kind: 'queue/removed', clientMessageId: 'a' });
    w2.close();
    const after = readRaw(dir);

    expect(after.startsWith(before)).toBe(true);
    // 只追加一行完整行，既存行字节不变
    const linesBefore = before.trimEnd().split('\n').length;
    const linesAfter = after.trimEnd().split('\n');
    expect(linesAfter).toHaveLength(linesBefore + 1);
    const entries = RuntimeJournal.readEntries(dir).entries;
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('readWatermark 恢复水位', () => {
  it('clean 完整文件：complete=true、lastSeq/lineCount 正确', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.append({ kind: 'queue/accepted', clientMessageId: 'b', sessionId: 's1', intent: 'queue' });
    w.close();

    const wm = readWatermark(dir);
    expect(wm.lastSeq).toBe(2);
    expect(wm.lineCount).toBe(2);
    expect(wm.complete).toBe(true);
    expect(wm.truncated).toBe(false);
    expect(wm.reason).toBe('clean');
    expect(wm.tornBytes).toBe(0);
  });

  it('EOF 半行（即使 JSON 完整但无换行）不算 durable：truncated=true、丢弃并标记', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.close();

    // 崩溃模拟：完整 JSON 但无换行（writeSync 在写入 \n 前被中断）
    const half = rawLine({ seq: 2, kind: 'queue/accepted', clientMessageId: 'b', sessionId: 's1' });
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), half, 'utf8');

    const wm = readWatermark(dir);
    expect(wm.truncated).toBe(true);
    expect(wm.reason).toBe('eof-partial');
    expect(wm.complete).toBe(false);
    expect(wm.lastSeq).toBe(1);
    expect(wm.lineCount).toBe(1);
    expect(wm.tornBytes).toBe(Buffer.byteLength(half, 'utf8'));
  });

  it('open 崩溃恢复：截断半行后从最后完整 seq 续写，recoveredBytes 正确', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.close();

    const partial = '{"v":1,"seq":2,"ts":"2026-09-08T00:00:00.000Z","kind":"call/';
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), partial, 'utf8');

    const w2 = RuntimeJournal.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBe(Buffer.byteLength(partial, 'utf8'));
    expect(w2.lastSeq).toBe(1);
    const e = w2.append({ kind: 'queue/removed', clientMessageId: 'a' });
    expect(e.seq).toBe(2);
    w2.close();
    expect(readRaw(dir).endsWith('\n')).toBe(true);
    for (const l of readRaw(dir).trimEnd().split('\n')) expect(parseEntry(l)).not.toBeNull();
  });

  it('中部完整行损坏（非 JSON）→ reason=corrupt-line，该行及之后全部不可信', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.close();
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), 'THIS_IS_NOT_JSON\n', 'utf8');
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), rawLine({ seq: 3, kind: 'queue/accepted', clientMessageId: 'c', sessionId: 's1' }) + '\n', 'utf8');

    const wm = readWatermark(dir);
    expect(wm.reason).toBe('corrupt-line');
    expect(wm.truncated).toBe(true);
    expect(wm.lastSeq).toBe(1);
  });
});

describe('judgeSubmission 对账', () => {
  it('从未写入 → not_started（空 journal / 缺失 journal）', () => {
    const dir = tmpDir();
    expect(judgeSubmission(dir, 'ghost')).toEqual({ status: 'not_started', truncated: false });

    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.close();
    expect(judgeSubmission(dir, 'ghost')).toEqual({ status: 'not_started', truncated: false });
  });

  it('[核心] durable accepted 后（无 outcome）：started/in-flight，不得按 not_started 再执行', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm1', sessionId: 's1', intent: 'queue', queueSeq: 0 });
    w.close(); // durable：已落盘

    const j = judgeSubmission(dir, 'cm1');
    expect(j.status).toBe('started');
    expect(j.phase).toBe('in-flight');
    expect(j.acceptedSeq).toBe(1);
    expect(j.truncated).toBe(false);
    expect(j.status).not.toBe('not_started');
  });

  it('[崩溃窗口] 有 durable accept 无 ack：独立只读 judgeSubmission 判 started，恢复不得盲目再执行', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm-boom', sessionId: 's1', intent: 'queue' });
    // 不 close：模拟 ack 发出前进程崩溃；跨进程恢复用独立只读查询（无锁）
    const j = judgeSubmission(dir, 'cm-boom');
    expect(j.status).toBe('started');
    expect(j.acceptedSeq).toBe(1);
    expect(j.status).not.toBe('not_started');
    w.close(); // 清理锁
  });

  it('accepted + 后续 outcome（task 终态带 clientMessageId 溯源）→ started/completed', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    const accepted = w.append({ kind: 'queue/accepted', clientMessageId: 'cm1', sessionId: 's1', intent: 'queue' });
    w.append({ kind: 'task/transition', taskId: 't1', clientMessageId: 'cm1', from: 'registered', to: 'queued' });
    w.append({ kind: 'task/transition', taskId: 't1', clientMessageId: 'cm1', from: 'queued', to: 'starting' });
    w.append({ kind: 'task/transition', taskId: 't1', clientMessageId: 'cm1', from: 'running', to: 'completed' });
    w.close();

    const j = judgeSubmission(dir, 'cm1');
    expect(j.status).toBe('started');
    expect(j.phase).toBe('completed');
    expect(j.acceptedSeq).toBe(accepted.seq);
  });

  it('[半行截断 A] accepted 行本身是半行（无换行）→ 从未 durable → not_started，且 truncated 标记', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'other', sessionId: 's1', intent: 'queue' });
    w.close();
    // 崩溃模拟：accepted 的 JSON 完整但缺末尾换行（writeSync 半途中断）
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), rawLine({ seq: 2, kind: 'queue/accepted', clientMessageId: 'cm-torn', sessionId: 's1' }), 'utf8');

    const j = judgeSubmission(dir, 'cm-torn');
    expect(j.status).toBe('not_started');
    expect(j.truncated).toBe(true);
  });

  it('[半行截断 B] accepted 已 durable + 其后半行 → 仍 started；半行丢弃不误伤 accepted', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm1', sessionId: 's1', intent: 'queue' });
    w.close();
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), '{"v":1,"seq":2,"ts":"2026-09-08T00:00:00.000Z","kind":"call/', 'utf8');

    const j = judgeSubmission(dir, 'cm1');
    expect(j.status).toBe('started');
    expect(j.acceptedSeq).toBe(1);
    expect(j.truncated).toBe(true);
  });

  it('[损坏保护] 中部损坏行 → 未确认 id 判 unknown（≠ not_started ≠ rejected）；已 durable accepted 的 id 仍 started', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cmA', sessionId: 's1', intent: 'queue' });
    w.close();
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), 'NOT_JSON\n', 'utf8');

    const jA = judgeSubmission(dir, 'cmA');
    expect(jA.status).toBe('started');
    expect(jA.truncated).toBe(true);

    const jUn = judgeSubmission(dir, 'cmNever');
    expect(jUn.status).toBe('unknown');
    expect(jUn.status).not.toBe('not_started');
    expect(jUn.status).not.toBe('accepted');
    expect(jUn.truncated).toBe(true);
  });
});

describe('任务/调用原语与查询', () => {
  it('task/transition 非法迁移在写入口即拒（复用 canTaskTransition）', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    expect(() =>
      w.append({ kind: 'task/transition', taskId: 't1', from: 'running', to: 'running' }),
    ).toThrow(InvalidJournalAppendError);
    expect(() =>
      w.append({ kind: 'task/transition', taskId: 't1', from: 'completed', to: 'registered' }),
    ).toThrow(InvalidJournalAppendError);
    w.close();
  });

  it('queue 原语：duplicate/removed 只追加可见，judge 维持 started（去重不产生第二 accept）', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm1', sessionId: 's1', intent: 'queue' });
    const dup = w.append({ kind: 'queue/duplicate', clientMessageId: 'cm1', originalSeq: 1 });
    const rem = w.append({ kind: 'queue/removed', clientMessageId: 'cm1', reason: 'user-cancel' });
    w.close();

    expect(dup.seq).toBe(2);
    expect(rem.seq).toBe(3);
    expect(queryJournalById(dir, 'queue/duplicate', 'cm1')).toHaveLength(1);
    expect(queryJournalById(dir, 'queue/removed', 'cm1')).toHaveLength(1);
    expect(judgeSubmission(dir, 'cm1').status).toBe('started');
  });

  it('call/started 与 call/outcome 按 callId（S0 CallId 语义）查询', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'call/started', callId: 'c1', taskId: 't1', tool: 'bash' });
    w.append({ kind: 'call/outcome', callId: 'c1', taskId: 't1', ok: true, error: undefined });
    w.append({ kind: 'call/started', callId: 'c2', taskId: 't1', tool: 'read' });
    w.close();

    const started = queryJournalById(dir, 'call/started', 'c1');
    const outcome = queryJournalById(dir, 'call/outcome', 'c1');
    expect(started).toHaveLength(1);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]?.kind).toBe('call/outcome');
    expect((outcome[0] as RuntimeJournalEntry & { payload: { ok: boolean } }).payload.ok).toBe(true);
    expect(queryJournalById(dir, 'call/started', 'c2')).toHaveLength(1);
  });

  it('readEntries：只含 durable 完整行（半行截断不计入）', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'a', sessionId: 's1', intent: 'queue' });
    w.close();
    appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), '{"v":1,"seq":2,"partial', 'utf8');

    const { entries, watermark } = RuntimeJournal.readEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(1);
    expect(watermark.truncated).toBe(true);
  });
});