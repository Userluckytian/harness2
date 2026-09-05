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

  it('已有日志的目录不能 create；未知事件类型被拒', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    w.close();
    expect(() => SessionWriter.create(dir, { sessionId: 's2' })).toThrow(/already exists/);

    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(() => w2.append('bogus/type' as 'user/message', {} as never)).toThrow(/unknown event type/);
    w2.close();
  });
});
