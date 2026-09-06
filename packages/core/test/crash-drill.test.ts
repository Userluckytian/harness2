// 崩溃恢复演练（阶段 11 Task 4，crash-drill）：
//   演练① writer append 中途截断（半行 JSON + 断电式进程结束语义）→ open 恢复 →
//          既有事件无损、重开追加正常；
//   演练③ 合成日志（与 Task 1 基线共用生成器）经历截断恢复后 export → importReplay
//          往返，坏行 0。
//   （演练② serve 子进程强杀恢复在 packages/cli/test/crash-drill.test.ts——CLI serve
//    层面真实 spawn 演练；桌面 serve-manager 退避重启已有单测，声明复用。）
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWriter } from '../src/session/writer.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { writeSyntheticSession } from '../src/session/bench.js';
import { exportSession, importReplay } from '../src/session/export.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-crill-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 半行 JSON（断电式截断：合法事件的前缀，无换行） */
function halfLine(): string {
  const event = { v: 1, seq: 999, ts: new Date().toISOString(), type: 'user/message', payload: { text: '半截' } };
  return JSON.stringify(event).slice(0, Math.floor(JSON.stringify(event).length / 2));
}

describe('演练①：writer 中途截断 → recoverTruncatedTail → 重开追加', () => {
  it('半行 JSON + 无尾换行全部判为未提交丢弃：既有事件无损，重开追加续 seq', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: '20260907-000000-0c0ffee' }, { fsync: false });
    w.append('user/message', { text: '第一问' });
    w.append('assistant/message', { text: '第一答', model: 'mock' });
    w.append('user/message', { text: '第二问' });
    w.close();

    // 断电式写入：半行 JSON（无换行）——两类撕裂形态之一
    appendFileSync(join(dir, SESSION_LOG_FILE), halfLine(), 'utf8');

    // 崩溃后重开：恢复撕裂区
    const reopened = SessionWriter.open(dir, { fsync: false });
    expect(reopened.recoveredBytes).toBeGreaterThan(0);
    expect(reopened.lastSeq).toBe(4); // header + 3 事件，seq 续接
    // 既有事件无损
    const session = loadSession(dir);
    expect(session.events).toHaveLength(4);
    expect(session.warnings).toEqual([]);
    const projection = computeProjection(session);
    expect(projection.messages.map((m) => m.text)).toEqual(['第一问', '第一答', '第二问']);
    // 重开追加正常（恢复后写入即续接，日志保持合法）
    reopened.append('assistant/message', { text: '第二答', model: 'mock' });
    reopened.close();
    const after = loadSession(dir);
    expect(after.events).toHaveLength(5);
    expect(after.warnings).toEqual([]);
    expect(readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')).not.toContain('半截');
  });

  it('坏行落在日志中部（已换行但非法）→ 该行起全部截断丢弃，恢复后坏行不再出现', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: '20260907-000000-0dead11' }, { fsync: false });
    w.append('user/message', { text: '问' });
    w.close();
    appendFileSync(join(dir, SESSION_LOG_FILE), 'garbage-torn-line\n', 'utf8');
    appendFileSync(join(dir, SESSION_LOG_FILE), '{"v":1,"seq":3', 'utf8'); // 坏行之后的半行
    const reopened = SessionWriter.open(dir, { fsync: false });
    expect(reopened.recoveredBytes).toBeGreaterThan('garbage-torn-line\n'.length);
    reopened.append('assistant/message', { text: '答', model: 'mock' });
    reopened.close();
    const session = loadSession(dir);
    expect(session.events.map((e) => e.event.type)).toEqual(['session/header', 'user/message', 'assistant/message']);
    expect(session.warnings).toEqual([]);
  });
});

describe('演练③：截断恢复后的轨迹资产往返（export → importReplay）', () => {
  it('合成日志（1000 事件，含 rewind）+ 截断恢复 → 导出回放坏行 0、事件计数正确', () => {
    const root = tmpDir();
    const { dir } = writeSyntheticSession(join(root, 'sessions'), { events: 1000, seed: 20260907 });
    const before = loadSession(dir).events.length;
    // 模拟崩溃：追加撕裂区后恢复
    appendFileSync(join(dir, SESSION_LOG_FILE), halfLine(), 'utf8');
    const reopened = SessionWriter.open(dir, { fsync: false });
    expect(reopened.recoveredBytes).toBeGreaterThan(0);
    reopened.append('user/message', { text: '恢复后的新消息' });
    reopened.close();
    // 导出（含主会话）→ 回放：往返坏行 0，投影消息计数与日志一致
    const zip = exportSession(dir, join(root, 'drill.zip'));
    expect(existsSync(zip.outFile)).toBe(true);
    const report = importReplay(zip.outFile);
    expect(report.sessions).toHaveLength(1);
    const s = report.sessions[0]!;
    expect(s.badLines).toBe(0);
    expect(s.warnings).toEqual([]);
    expect(s.events).toBe(before + 1); // 撕裂区丢弃不计 + 恢复后追加 1 条
    expect(s.messageCount).toBe(
      computeProjection(loadSession(dir)).messages.length,
    );
  });
});
