import { afterEach, expect, it, describe } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionLockedError, SessionWriter } from '../src/session/writer.js';
import { SESSION_LOCK_FILE, SESSION_LOG_FILE, parseEventLine } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-session-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readLines(dir: string): string[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** 取一个确定已退出的进程 pid，用于构造陈旧锁 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (typeof r.pid !== 'number') throw new Error('spawn failed');
  return r.pid;
}

describe('SessionWriter', () => {
  it('create 写 header，追加事件 seq 单调、行行合法、文件以换行结尾', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.append('user/message', { text: '你好' });
    w.append('assistant/message', { text: '回复', usage: { inputTokens: 10, outputTokens: 5 } });
    w.append('step/start', { stepId: 'st1', turnId: 't1' });
    w.append('tool/call', { callId: 'c1', tool: 'bash', args: { cmd: 'ls' } });
    w.append('tool/result', { callId: 'c1', ok: true, output: 'ok' });
    w.append('step/end', { stepId: 'st1', turnId: 't1', durationMs: 12 });
    w.close();

    const lines = readLines(dir);
    expect(lines).toHaveLength(7);
    const events = lines.map((l) => parseEventLine(l));
    for (const [i, e] of events.entries()) {
      expect(e, `line ${i} should parse`).not.toBeNull();
      expect(e?.seq).toBe(i + 1);
      expect(() => new Date(e?.ts as string).toISOString()).not.toThrow();
    }
    expect(events[0]?.type).toBe('session/header');
    expect(events[1]?.type).toBe('user/message');
    expect(events[6]?.type).toBe('step/end');
    expect(readFileSync(join(dir, SESSION_LOG_FILE)).at(-1)).toBe(0x0a);
  });

  it('目录锁：第二个写者被拒；close 后锁释放；陈旧锁（死 pid）被接管', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    expect(() => SessionWriter.open(dir)).toThrow(SessionLockedError);
    w.close();
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);

    writeFileSync(join(dir, SESSION_LOCK_FILE), JSON.stringify({ pid: deadPid(), ts: '2020-01-01T00:00:00.000Z' }));
    const w2 = SessionWriter.open(dir);
    expect(w2.lastSeq).toBeGreaterThan(0);
    w2.close();
  });

  it('open 续写 seq 连续；close 后再 append 抛错', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: 'a' });
    w.append('assistant/message', { text: 'b' });
    w.close();

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.lastSeq).toBe(3);
    const ev = w2.append('user/message', { text: 'c' });
    expect(ev.seq).toBe(4);
    w2.close();
    expect(() => w2.append('user/message', { text: 'x' })).toThrow(/closed/);
  });

  it('崩溃残行：open 恢复（截断半行）并从最后合法 seq 续写', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: 'a' });
    w.append('assistant/message', { text: 'b' });
    w.close();

    // 模拟崩溃：追加半行 JSON（无换行、不完整）
    const logPath = join(dir, SESSION_LOG_FILE);
    const partial = '{"v":1,"seq":4,"ts":"2026-09-06T00:00:00.000Z","type":"user/mess';
    appendFileSync(logPath, partial, 'utf8');

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBe(Buffer.byteLength(partial, 'utf8'));
    expect(w2.lastSeq).toBe(3);
    const ev = w2.append('user/message', { text: 'after-crash' });
    expect(ev.seq).toBe(4);
    w2.close();

    const lines = readLines(dir);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(parseEventLine(l)).not.toBeNull();
  });

  it('P1-1 回归：日志中部空行不触发截断，已提交内容全部保留', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: 'a' });
    w.append('assistant/message', { text: 'b' });
    w.append('user/message', { text: 'c' });
    w.append('assistant/message', { text: 'd' });
    w.close();

    const logPath = join(dir, SESSION_LOG_FILE);
    const originalLines = readLines(dir); // 5 行（header + 4 事件）
    // 在第 2 行后注入 1 个空行
    const raw = readFileSync(logPath, 'utf8');
    const parts = raw.split('\n');
    const injected = [...parts.slice(0, 2), '', ...parts.slice(2)].join('\n');
    writeFileSync(logPath, injected, 'utf8');

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBe(0); // 空行保留，无需恢复
    expect(w2.lastSeq).toBe(5);
    const ev = w2.append('user/message', { text: 'after' });
    expect(ev.seq).toBe(6);
    w2.close();

    const after = readFileSync(logPath, 'utf8');
    expect(after).toContain('\n\n'); // 空行未被删除
    // 原有 5 行逐字节保留，新事件可解析
    for (const l of originalLines) expect(after).toContain(l);
    const lines = readLines(dir);
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(parseEventLine(l)).not.toBeNull();
  });

  it('P1-1 回归：无换行的完整 JSON 尾行视为未提交丢弃，续写 seq 正确且无 NUL 补字节', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: 'a' });
    w.close();

    const logPath = join(dir, SESSION_LOG_FILE);
    // 模拟崩溃：事件字节已落盘但换行（提交标记）未落盘
    const uncommitted = JSON.stringify({
      v: 1, seq: 3, ts: '2026-09-06T00:00:00.000Z', type: 'user/message', payload: { text: 'orphan' },
    });
    appendFileSync(logPath, uncommitted, 'utf8');

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBe(Buffer.byteLength(uncommitted, 'utf8'));
    expect(w2.lastSeq).toBe(2);
    const ev = w2.append('user/message', { text: 'next' });
    expect(ev.seq).toBe(3);
    w2.close();

    const rawBytes = readFileSync(logPath);
    expect(rawBytes.includes(0)).toBe(false); // 无 NUL 补字节
    expect(readFileSync(logPath, 'utf8')).not.toContain('orphan');
    const lines = readLines(dir);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(parseEventLine(l)).not.toBeNull();
  });

  it('P1-2 回归：open() 取锁后失败（seq 不一致触发 scanLog 抛错）锁文件已释放', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: 'a' });
    w.close();

    // 追加一行格式合法但 seq 与行数不一致的事件（恢复扫描不会截掉它，
    // 从而让 open() 在取锁之后的 scanLog 校验中抛错）
    const bogus = JSON.stringify({
      v: 1, seq: 9, ts: '2026-09-06T00:00:00.000Z', type: 'user/message', payload: { text: 'x' },
    });
    appendFileSync(join(dir, SESSION_LOG_FILE), bogus + '\n', 'utf8');

    expect(() => SessionWriter.open(dir, { fsync: false })).toThrow(/seq inconsistency/);
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);
    // 锁已释放：后续 open 不被死锁阻塞（仍因同样的日志问题抛错）
    expect(() => SessionWriter.open(dir, { fsync: false })).toThrow(/seq inconsistency/);
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it('P1-1 回归：多字节 UTF-8 撕裂尾行按字节精确丢弃', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: '你好' });
    w.close();

    const logPath = join(dir, SESSION_LOG_FILE);
    const committedBytes = readFileSync(logPath); // 以 \n 结尾的已提交前缀
    const full = JSON.stringify({
      v: 1, seq: 3, ts: '2026-09-06T00:00:00.000Z', type: 'user/message', payload: { text: '崩溃前的中文' },
    }) + '\n';
    const fullBytes = Buffer.from(full, 'utf8');
    // 行尾 7 字节 =「文」(E6 96 87) + '"' + '}' + '}' + '\n'；去掉 5 字节会切进「文」中间
    expect([...fullBytes.subarray(-7)]).toEqual([0xe6, 0x96, 0x87, 0x22, 0x7d, 0x7d, 0x0a]);
    const partial = fullBytes.subarray(0, fullBytes.length - 5);
    appendFileSync(logPath, partial); // 按字节写入撕裂残行（含半截多字节字符）

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBe(partial.length); // 字节精确
    expect(w2.lastSeq).toBe(2);
    const ev = w2.append('user/message', { text: 'after' });
    expect(ev.seq).toBe(3);
    w2.close();

    const rawBytes = readFileSync(logPath);
    expect(rawBytes.subarray(0, committedBytes.length)).toEqual(committedBytes); // 已提交前缀原样保留
    expect(rawBytes.includes(0)).toBe(false);
    expect(rawBytes.at(-1)).toBe(0x0a);
    expect(readLines(dir)).toHaveLength(3);
    for (const l of readLines(dir)) expect(parseEventLine(l)).not.toBeNull();
  });

  it('已有日志的目录不能 create；未知事件类型被拒', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.close();
    expect(() => SessionWriter.create(dir, { sessionId: 's2' })).toThrow(/already exists/);

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(() => w2.append('bogus/type' as 'user/message', {} as never)).toThrow(/unknown event type/);
    w2.close();
  });

  it('P2-1 回归：rewind/marker 的 rewindToSeq 越界在写入口被拒绝', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.append('user/message', { text: 'a' }); // lastSeq=2（含 header）
    expect(() => w.append('rewind/marker', { rewindToSeq: 0 })).toThrow(/out of range/);
    expect(() => w.append('rewind/marker', { rewindToSeq: -1 })).toThrow(/out of range/);
    expect(() => w.append('rewind/marker', { rewindToSeq: 3 })).toThrow(/out of range/); // 超过 lastSeq=2
    expect(() => w.append('rewind/marker', { rewindToSeq: 1.5 })).toThrow(/out of range/);
    // 边界内合法：1 与 lastSeq 均可
    expect(w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo all' }).seq).toBe(3);
    w.close();

    // 被拒绝的调用没有留下任何半行/垃圾事件
    const lines = readLines(dir);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(parseEventLine(l)).not.toBeNull();
  });

  it('P2-3：fsync 默认开启路径冒烟——默认参数 create/append/close 后日志完整', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'fsync-default' }); // 不传 options：fsync 默认 true
    w.append('user/message', { text: 'fsync 默认路径' });
    w.append('assistant/message', { text: 'ok' });
    w.close();

    const lines = readLines(dir);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(parseEventLine(l)).not.toBeNull();
    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.lastSeq).toBe(3);
    w2.close();
  });
});
