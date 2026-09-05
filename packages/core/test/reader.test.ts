import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { computeProjection, exportAllEvents, loadSession } from '../src/session/reader.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-reader-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 组一个典型对话：header(1) u(2) a(3) u(4) a(5) tool(6) result(7) u(8) a(9) */
function writeDemoSession(dir: string, fsync = false): SessionWriter {
  const w = SessionWriter.create(dir, { sessionId: 'demo' }, { fsync });
  w.append('user/message', { text: 'u1', turnId: 't1' });
  w.append('assistant/message', { text: 'a1', turnId: 't1', usage: { inputTokens: 10, outputTokens: 4 } });
  w.append('user/message', { text: 'u2', turnId: 't2' });
  w.append('assistant/message', { text: 'a2', turnId: 't2' });
  w.append('tool/call', { callId: 'c1', tool: 'bash', args: { cmd: 'ls' }, turnId: 't2' });
  w.append('tool/result', { callId: 'c1', ok: true, output: 'f1' });
  w.append('user/message', { text: 'u3', turnId: 't3' });
  w.append('assistant/message', { text: 'a3', turnId: 't3' });
  return w;
}

describe('loadSession', () => {
  it('读取全部事件并还原 header；非法行跳过且告警', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir);
    w.close();
    appendFileSync(join(dir, SESSION_LOG_FILE), '{"broken":true}\n', 'utf8');

    const s = loadSession(dir);
    expect(s.events).toHaveLength(9);
    expect(s.header?.sessionId).toBe('demo');
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/invalid line 10/);
  });

  it('目录不存在时抛错', () => {
    expect(() => loadSession(join(tmpDir(), 'nope'))).toThrow(/not found/);
  });
});

describe('computeProjection', () => {
  it('无 rewind 时全部事件活动，消息按序重建', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir);
    w.close();
    const p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:u1',
      'assistant:a1',
      'user:u2',
      'assistant:a2',
      'user:u3',
      'assistant:a3',
    ]);
    expect(p.activeCount).toBe(9);
    expect(p.shadowedCount).toBe(0);
    expect(p.rewindCount).toBe(0);
    expect(p.lastSeq).toBe(9);
  });

  it('rewind/marker 收缩投影，影子事件保留可导出', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir);
    // 回退到 seq=3（即回到 assistant:a1 之后）：u2 及其之后全部遮蔽
    w.append('rewind/marker', { rewindToSeq: 3, reason: 'undo u2' });
    w.close();

    const s = loadSession(dir);
    const p = computeProjection(s);
    expect(p.messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:u1', 'assistant:a1']);
    expect(p.rewindCount).toBe(1);
    expect(p.shadowedCount).toBe(6); // seq 4..9（marker 自身不遮蔽自身）
    expect(p.activeCount).toBe(4); // header + u1 + a1 + marker
    // 全量导出仍包含全部 10 个事件（append-only 红线）
    expect(exportAllEvents(s).split('\n')).toHaveLength(10);
  });

  it('标记之后的新分支保持活动；二次 rewind 只影响当前活动时间线', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir);
    w.append('rewind/marker', { rewindToSeq: 3 });
    w.append('user/message', { text: 'u2-alt', turnId: 't2a' });
    w.append('assistant/message', { text: 'a2-alt', turnId: 't2a' });
    w.close();

    let p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2-alt', 'a2-alt']);
    expect(p.lastSeq).toBe(12);

    // 继续：在 alt 分支上回退到 seq=5（u1 之后）→ alt 两条与原 seq5..9 全部遮蔽
    const w2 = SessionWriter.open(dir, { fsync: false });
    w2.append('rewind/marker', { rewindToSeq: 5, reason: 'undo alt' });
    w2.close();
    p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1']);
    expect(p.rewindCount).toBe(2);
    expect(exportAllEvents(loadSession(dir)).split('\n')).toHaveLength(13);
  });

  it('Model-visible ⟺ logged：从日志重建的消息序列与写入时一致（回放基线）', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir);
    w.close();
    const written = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'];
    const s = loadSession(dir);
    const rebuilt = computeProjection(s).messages.map((m) => m.text);
    expect(rebuilt).toEqual(written);
    // 事件日志里不存在任何写入器之外的消息来源
    const loggedTexts = s.events
      .filter((x) => x.event.type === 'user/message' || x.event.type === 'assistant/message')
      .map((x) => (x.event.payload as { text: string }).text);
    expect(loggedTexts).toEqual(written);
  });
});
