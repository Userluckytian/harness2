import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE, parseEventLine, type SessionEventType } from '../src/session/types.js';
import { computeProjection, exportAllEvents, loadSession } from '../src/session/reader.js';
import { renderTrajectory } from '../src/trajectory/view.js';

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

  it('P1-3 回归：payload 形状非法 → loadSession 告警并跳过，renderTrajectory 不抛 TypeError', () => {
    // 审查实测输入：payload 缺 text 字段（{"typoField":1}）
    const badLine = JSON.stringify({
      v: 1, seq: 10, ts: '2026-09-06T00:00:00.000Z', type: 'user/message', payload: { typoField: 1 },
    }) + '\n';
    expect(parseEventLine(badLine)).toBeNull();

    const dir = tmpDir();
    const w = writeDemoSession(dir);
    w.close();
    appendFileSync(join(dir, SESSION_LOG_FILE), badLine, 'utf8');

    const s = loadSession(dir);
    expect(s.events).toHaveLength(9); // 非法行被跳过
    expect(s.warnings).toHaveLength(1); // 走告警通道
    expect(s.warnings[0]).toMatch(/invalid line 10/);
    expect(() => renderTrajectory(s)).not.toThrow();
    expect(renderTrajectory(s).join('\n')).toContain('1 warning(s)');
  });

  it('P2-1 读侧容错：日志中已存在的越界 rewind/marker 给 warning，渲染不崩溃', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir); // seq 1..9
    w.close();
    // 绕过 writer 直接追加越界 marker（模拟旧版本/外部写入的日志）
    const bogus = JSON.stringify({
      v: 1, seq: 10, ts: '2026-09-06T00:00:00.000Z', type: 'rewind/marker', payload: { rewindToSeq: 0 },
    }) + '\n';
    appendFileSync(join(dir, SESSION_LOG_FILE), bogus, 'utf8');

    const s = loadSession(dir);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/rewind\/marker at seq 10: rewindToSeq 0 out of range \(1\.\.10\)/);
    expect(() => renderTrajectory(s)).not.toThrow();
    // 单调并集语义仍然生效：rewindToSeq 0 遮蔽其前全部非标记事件（含 header）
    const p = computeProjection(s);
    expect(p.messages).toHaveLength(0);
    expect(p.shadowedCount).toBe(9);
    expect(p.rewindCount).toBe(1);
  });
});

describe('parseEventLine payload 校验（P1-3）', () => {
  const base = { v: 1, ts: '2026-09-06T00:00:00.000Z' };
  const line = (type: SessionEventType, payload: unknown): string =>
    JSON.stringify({ ...base, seq: 1, type, payload });

  // 每种事件类型的最低 payload 要求：合法最小 payload 通过，缺字段/类型不符返回 null
  const cases: Array<{ type: SessionEventType; good: Record<string, unknown>; bad: Record<string, unknown> }> = [
    { type: 'session/header', good: { sessionId: 's' }, bad: {} },
    { type: 'user/message', good: { text: 'x' }, bad: { text: 42 } },
    { type: 'assistant/message', good: { text: 'x' }, bad: { typoField: 1 } },
    { type: 'assistant/attempt', good: { error: 'e' }, bad: { error: null } },
    { type: 'step/start', good: { stepId: 'st' }, bad: {} },
    { type: 'step/end', good: { stepId: 'st' }, bad: { stepId: 7 } },
    { type: 'tool/call', good: { callId: 'c', tool: 'bash' }, bad: { callId: 'c' } },
    { type: 'tool/result', good: { callId: 'c', ok: true }, bad: { callId: 'c', ok: 'yes' } },
    { type: 'memory/snapshot', good: { content: '记忆内容' }, bad: { content: '' } },
    { type: 'rewind/marker', good: { rewindToSeq: 3 }, bad: { rewindToSeq: 1.5 } },
  ];

  for (const { type, good, bad } of cases) {
    it(`${type}：缺字段/类型不符 → null，合法最小 payload 通过`, () => {
      expect(parseEventLine(line(type, good))).not.toBeNull();
      expect(parseEventLine(line(type, bad))).toBeNull();
    });
  }

  it('payload 为非对象（标量/数组/null）→ null', () => {
    for (const payload of [42, 'x', [], null, false]) {
      expect(parseEventLine(line('user/message', payload))).toBeNull();
    }
  });
});

describe('memory/snapshot 事件（阶段 6）', () => {
  it('writer append + loadSession 往返：content 原样保留，普通活动事件参与投影', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'mem' }, { fsync: false });
    const content = '长期记忆快照内容\n多行也行';
    w.append('memory/snapshot', { content });
    w.append('user/message', { text: 'u1' });
    w.close();

    const s = loadSession(dir);
    const snap = s.events.find((x) => x.event.type === 'memory/snapshot')?.event;
    expect(snap && snap.type === 'memory/snapshot' ? snap.payload : null).toEqual({ content });
    // 普通活动事件：计入 activeCount，不出现在消息投影，渲染不特殊处理
    const p = computeProjection(s);
    expect(p.activeCount).toBe(3); // header + snapshot + user
    expect(p.messages.map((m) => m.text)).toEqual(['u1']);
    const lines = renderTrajectory(s);
    expect(lines.join('\n')).toContain('unknown event: memory/snapshot');
  });

  it('空 content：解析层拒绝（非法行）；writer 写入口同步拦截，日志不出现读不回的行', () => {
    const badLine = JSON.stringify({
      v: 1, seq: 2, ts: '2026-09-06T00:00:00.000Z', type: 'memory/snapshot', payload: { content: '' },
    });
    expect(parseEventLine(badLine)).toBeNull();

    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'mem-guard' }, { fsync: false });
    expect(() => w.append('memory/snapshot', { content: '' })).toThrow(/non-empty/);
    expect(() => w.append('memory/snapshot', { content: 42 as unknown as string })).toThrow(/non-empty/);
    w.close();
    expect(loadSession(dir).warnings).toHaveLength(0);
  });

  it('旧日志兼容：不含 memory/snapshot 的日志照常解析（事件类型清单加性扩展）', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir);
    w.close();
    const s = loadSession(dir);
    expect(s.warnings).toHaveLength(0);
    expect(s.events.some((x) => x.event.type === 'memory/snapshot')).toBe(false);
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

  it('redo 链中立化：reason=redo 的标记复活其前 undo 标记遮蔽的事件', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir); // seq 1..9
    w.append('rewind/marker', { rewindToSeq: 5, reason: 'undo' }); // seq 10：遮蔽 6..9（a2 在 seq5，保持活动）
    let p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2', 'a2']);

    // redo 标记：rewindToSeq = undo 标记前一事件（seq 9）→ 中立化 undo 标记，6..9 复活
    w.append('rewind/marker', { rewindToSeq: 9, reason: 'redo' }); // seq 11
    p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(p.shadowedCount).toBe(0);
    w.close();
  });

  it('redo 只中立化范围内的标记：更早的 undo 遮蔽保持不变', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'chain' }, { fsync: false });
    w.append('user/message', { text: 'u1' }); // 2
    w.append('assistant/message', { text: 'a1' }); // 3
    w.append('user/message', { text: 'u2' }); // 4
    w.append('assistant/message', { text: 'a2' }); // 5
    w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' }); // 6：遮蔽 2..5
    w.append('user/message', { text: 'u1-alt' }); // 7
    w.append('assistant/message', { text: 'a1-alt' }); // 8
    w.append('rewind/marker', { rewindToSeq: 6, reason: 'undo' }); // 9：遮蔽 7..8
    let p = computeProjection(loadSession(dir));
    expect(p.messages).toEqual([]);

    // redo 精确中立化 rewindToSeq+1（=seq 9 的 marker9）；marker6（seq 6）不受影响
    w.append('rewind/marker', { rewindToSeq: 8, reason: 'redo' }); // 10
    p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1-alt', 'a1-alt']); // 2..5 仍被 marker6 遮蔽
    w.close();
  });

  it('非 redo 标记语义不变：无 reason / undo 前缀均不触发中立化', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 'legacy' }, { fsync: false });
    w.append('user/message', { text: 'u1' }); // 2
    w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' }); // 3：遮蔽 2
    w.append('user/message', { text: 'u2' }); // 4
    w.append('rewind/marker', { rewindToSeq: 3 }); // 5：无 reason，遮蔽 4；不复活 2
    const p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual([]);
    w.close();
  });

  it('redo 标记的 rewindToSeq+1 处不是标记时优雅 no-op：无中立化发生，undo 遮蔽保持', () => {
    const dir = tmpDir();
    const w = writeDemoSession(dir); // seq 1..9（6=tool/call 7=tool/result 8=u3 9=a3）
    w.append('rewind/marker', { rewindToSeq: 5, reason: 'undo' }); // seq 10：遮蔽 6..9
    let p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2', 'a2']);

    // redo 定位落空：rewindToSeq+1 = seq 8（u3，非 rewind/marker）→ 不中立化任何标记
    w.append('rewind/marker', { rewindToSeq: 7, reason: 'redo' }); // seq 11
    p = computeProjection(loadSession(dir));
    // undo 标记（seq 10）的遮蔽保持——u3/a3 等不复活；redo 标记自身按普通 rewind
    // 语义遮蔽 seq > 7 的非标记事件（本已被 undo 遮蔽），投影不变、不抛错
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(p.shadowedCount).toBe(4);
    expect(p.rewindCount).toBe(2);
    w.close();
  });
});
