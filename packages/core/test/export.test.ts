// 轨迹导出/回放测试（阶段 10 Task 1）：导出只读红线、zip 冻结结构、幂等、
// 子代理递归、回放投影黄金断言、坏行容错、空包拒绝。
// 全程零 key——轨迹即测试夹具；zip 用 fflate 现场构造/改写。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { SessionManager } from '../src/session/manager.js';
import { SnapshotStore } from '../src/session/snapshots.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { exportSession, importReplay } from '../src/session/export.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-export-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写一个最小会话：一轮 user/assistant 消息 */
function makeSimpleSession(dir: string, sessionId: string, userText = 'hello'): void {
  const w = SessionWriter.create(dir, { sessionId, cwd: dir }, { fsync: false });
  w.append('user/message', { text: userText, turnId: 't1' });
  w.append('assistant/message', { text: `回复：${userText}`, model: 'mock', turnId: 't1' });
  w.close();
}

/** 目录状态快照（相对路径 → mtime+内容 base64），只读红线断言用 */
function snapshotDirState(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const childAbs = join(d, e.name);
      if (e.isDirectory()) walk(childAbs, childRel);
      else out.set(childRel, `${statSync(childAbs).mtimeMs}:${readFileSync(childAbs).toString('base64')}`);
    }
  };
  walk(dir, '');
  return out;
}

interface LibraryFixture {
  root: string;
  parentDir: string;
  childDir: string;
  grandchildDir: string;
  parentZip: () => string;
}

/** 建一个含「父 → 子 → 孙」三代会话的库：父子血缘 = header.parentSession */
function makeLibrary(): LibraryFixture {
  const root = tmpDir();
  const manager = new SessionManager(root);
  const parent = manager.create(join(root, 'proj-a'), { id: '20260906-010101-aaaaaa' });
  parent.writer.append('user/message', { text: '父任务开始', turnId: 't1' });
  parent.writer.append('assistant/message', { text: '派发子任务', model: 'mock', turnId: 't1' });
  parent.writer.append('user/message', { text: '被回退的 turn', turnId: 't2' });
  parent.writer.append('assistant/message', { text: '被回退的回复', model: 'mock', turnId: 't2' });
  parent.writer.append('rewind/marker', { rewindToSeq: 3, reason: 'undo turn 2' }); // 遮蔽 turn 2 两条消息（seq 4-5）
  parent.writer.close();

  const child = manager.create(join(root, 'proj-b'), {
    id: '20260906-010202-bbbbbb',
    parentSession: parent.id,
    isSeeded: true,
    subagent: true,
  });
  child.writer.append('user/message', { text: '子任务', turnId: 't1' });
  child.writer.append('assistant/message', { text: '子任务完成', model: 'mock', turnId: 't1' });
  child.writer.close();

  const grandchild = manager.create(join(root, 'proj-c'), {
    id: '20260906-010303-cccccc',
    parentSession: child.id,
    isSeeded: true,
    subagent: true,
  });
  grandchild.writer.append('user/message', { text: '孙任务', turnId: 't1' });
  grandchild.writer.close();

  const parentDir = parent.dir;
  const childDir = child.dir;
  const grandchildDir = grandchild.dir;
  const outDir = join(tmpDir(), 'out');
  mkdirSync(outDir, { recursive: true });
  return {
    root,
    parentDir,
    childDir,
    grandchildDir,
    parentZip: () => join(outDir, `${parent.id}.zip`),
  };
}

describe('exportSession', () => {
  it('基础导出：zip 含 session.v1.jsonl，返回 sessionId 与条目数', () => {
    const dir = join(tmpDir(), 'sess');
    makeSimpleSession(dir, '20260906-020202-dddddd');
    const outFile = join(tmpDir(), 'out.zip');
    const r = exportSession(dir, outFile);
    expect(r.sessionId).toBe('20260906-020202-dddddd');
    expect(r.outFile).toBe(outFile);
    expect(r.entryCount).toBe(1);
    expect(r.subagentIds).toEqual([]);
    const files = unzipSync(new Uint8Array(readFileSync(outFile)));
    expect(Object.keys(files)).toEqual([SESSION_LOG_FILE]);
  });

  it('rewind_points.jsonl 存在时入包；lock 等未知文件永不入包', () => {
    const dir = join(tmpDir(), 'sess');
    makeSimpleSession(dir, '20260906-020303-eeeeee');
    const snapshots = new SnapshotStore(dir);
    snapshots.capture({ seq: 2, file: join(dir, 'tracked.txt'), before: null });
    snapshots.commitAfter({ seq: 2, after: 'content' });
    writeFileSync(join(dir, 'lock'), '{"pid":1}'); // 模拟目录锁（进程状态）
    const outFile = join(tmpDir(), 'out.zip');
    const r = exportSession(dir, outFile);
    expect(r.entryCount).toBe(2);
    const keys = Object.keys(unzipSync(new Uint8Array(readFileSync(outFile))));
    expect(keys).toContain('session.v1.jsonl');
    expect(keys).toContain('rewind_points.jsonl');
    expect(keys).not.toContain('lock');
  });

  it('条目按相对路径排序（审查 P2-1 防回归）：snapshots/ 多文件与子目录跨创建顺序稳定，导出仍字节幂等', () => {
    const dir = join(tmpDir(), 'sess');
    makeSimpleSession(dir, '20260906-020404-ffffff');
    // 故意按非字典序创建 snapshots/ 下的文件（readdir 顺序跨平台不保证）
    const snapDir = join(dir, 'snapshots');
    mkdirSync(join(snapDir, 'sub'), { recursive: true });
    writeFileSync(join(snapDir, 'b.txt'), 'b');
    writeFileSync(join(snapDir, 'a.txt'), 'a');
    writeFileSync(join(snapDir, 'sub', 'c.txt'), 'c');
    const out1 = join(tmpDir(), 's1.zip');
    const out2 = join(tmpDir(), 's2.zip');
    exportSession(dir, out1);
    exportSession(dir, out2);
    const keys = Object.keys(unzipSync(new Uint8Array(readFileSync(out1))));
    expect(keys).toEqual(['session.v1.jsonl', 'snapshots/a.txt', 'snapshots/b.txt', 'snapshots/sub/c.txt']);
    expect(readFileSync(out1).equals(readFileSync(out2))).toBe(true);
  });

  it('子代理会话递归打包进 subagents/<id>/；孙会话（parentSession=子 id）不入包', () => {
    const lib = makeLibrary();
    const outFile = lib.parentZip();
    const r = exportSession(lib.parentDir, outFile);
    expect(r.subagentIds).toEqual(['20260906-010202-bbbbbb']);
    const keys = Object.keys(unzipSync(new Uint8Array(readFileSync(outFile))));
    expect(keys).toContain('session.v1.jsonl');
    expect(keys).toContain(`subagents/20260906-010202-bbbbbb/${SESSION_LOG_FILE}`);
    expect(keys.some((k) => k.includes('cccccc'))).toBe(false); // 孙会话不在冻结结构内
  });

  it('幂等：同目录同内容两次导出 → zip 字节相同', () => {
    const lib = makeLibrary();
    const out1 = join(tmpDir(), 'a.zip');
    const out2 = join(tmpDir(), 'b.zip');
    exportSession(lib.parentDir, out1);
    exportSession(lib.parentDir, out2);
    expect(readFileSync(out1).equals(readFileSync(out2))).toBe(true);
  });

  it('只读红线：导出前后主/子会话目录逐字节一致（含 mtime）', () => {
    const lib = makeLibrary();
    const beforeParent = snapshotDirState(lib.parentDir);
    const beforeChild = snapshotDirState(lib.childDir);
    const beforeGrandchild = snapshotDirState(lib.grandchildDir);
    exportSession(lib.parentDir, lib.parentZip());
    expect(snapshotDirState(lib.parentDir)).toEqual(beforeParent);
    expect(snapshotDirState(lib.childDir)).toEqual(beforeChild);
    expect(snapshotDirState(lib.grandchildDir)).toEqual(beforeGrandchild);
  });

  it('非会话目录（无 session.v1.jsonl）拒绝导出', () => {
    const empty = tmpDir();
    expect(() => exportSession(empty, join(tmpDir(), 'x.zip'))).toThrow(/session log not found/);
  });
});

describe('importReplay', () => {
  it('投影黄金断言：导入后的父/子会话摘要与原库投影一致（含 rewind 遮蔽）', () => {
    const lib = makeLibrary();
    const outFile = lib.parentZip();
    exportSession(lib.parentDir, outFile);
    const report = importReplay(outFile);

    // 根会话在前、子会话随后
    expect(report.sessions.map((s) => s.id)).toEqual(['20260906-010101-aaaaaa', '20260906-010202-bbbbbb']);
    expect(report.sessions[0]!.source).toBe(SESSION_LOG_FILE);
    expect(report.sessions[1]!.source).toBe(`subagents/20260906-010202-bbbbbb/${SESSION_LOG_FILE}`);

    // 黄金断言：与原库 computeProjection 逐字段一致
    const parentProj = computeProjection(loadSession(lib.parentDir));
    const childProj = computeProjection(loadSession(lib.childDir));
    expect(report.sessions[0]).toMatchObject({
      events: parentProj.activeCount + parentProj.shadowedCount,
      badLines: 0,
      warnings: [],
      messageCount: parentProj.messages.length,
      lastSeq: parentProj.lastSeq,
    });
    expect(parentProj.shadowedCount).toBe(2); // rewind 语义随导出保留（影子事件全量入包）
    expect(report.sessions[0]!.messageCount).toBe(2); // 被回退 turn 不在活动投影
    expect(report.sessions[1]).toMatchObject({
      events: childProj.activeCount + childProj.shadowedCount,
      badLines: 0,
      messageCount: childProj.messages.length,
      lastSeq: childProj.lastSeq,
    });
  });

  it('坏行容错：坏行计数与明细告警，其余事件照常投影', () => {
    const lib = makeLibrary();
    const outFile = lib.parentZip();
    exportSession(lib.parentDir, outFile);
    // 改写 zip：往根日志追加一行坏内容
    const files = unzipSync(new Uint8Array(readFileSync(outFile)));
    const text = new TextDecoder().decode(files[SESSION_LOG_FILE]!);
    files[SESSION_LOG_FILE] = new TextEncoder().encode(`${text}not-json-at-all\n`);
    const tampered = join(tmpDir(), 'tampered.zip');
    writeFileSync(tampered, zipSync(files, { mtime: new Date(Date.UTC(2000, 0, 1)) }));

    const report = importReplay(tampered);
    const root = report.sessions[0]!;
    expect(root.badLines).toBe(1);
    expect(root.warnings[0]).toMatch(/^skipped invalid line \d+: not-json-at-all/);
    expect(root.messageCount).toBe(2); // 既有活动投影不受影响
    expect(report.sessions[1]!.badLines).toBe(0); // 子会话不受根日志坏行影响
  });

  it('空包（无任何 session.v1.jsonl）拒绝回放', () => {
    const emptyZip = join(tmpDir(), 'empty.zip');
    writeFileSync(emptyZip, zipSync({}, { mtime: new Date(Date.UTC(2000, 0, 1)) }));
    expect(() => importReplay(emptyZip)).toThrow(/没有会话日志/);
  });

  it('越界 rewind/marker 告警与 loadSession 同款（审查 P2-3 防回归）：纯内存补齐，不计入 badLines', () => {
    // 手工构造越界 marker 的会话（rewindToSeq=99 超过 lastSeq=3；parseEventLine 放行、读侧告警）
    const ts = new Date().toISOString();
    const lines = [
      JSON.stringify({ v: 1, seq: 1, ts, type: 'session/header', payload: { sessionId: 'replay-oob' } }),
      JSON.stringify({ v: 1, seq: 2, ts, type: 'user/message', payload: { text: 'hi' } }),
      JSON.stringify({ v: 1, seq: 3, ts, type: 'rewind/marker', payload: { rewindToSeq: 99, reason: 'undo' } }),
    ];
    const oobZip = join(tmpDir(), 'oob.zip');
    writeFileSync(
      oobZip,
      zipSync(
        { 'session.v1.jsonl': new TextEncoder().encode(`${lines.join('\n')}\n`) },
        { mtime: new Date(Date.UTC(2000, 0, 1)) },
      ),
    );
    const report = importReplay(oobZip);
    const root = report.sessions[0]!;
    expect(root.badLines).toBe(0); // 事件本身合法（parseEventLine 放行），越界属告警非坏行
    expect(root.warnings).toEqual(['rewind/marker at seq 3: rewindToSeq 99 out of range (1..3)']);
    expect(root.lastSeq).toBe(3);
  });

  it('zip 文件缺失：一行可读错误（不打印堆栈路径之外的内容）', () => {
    const missing = join(tmpDir(), 'missing.zip');
    expect(() => importReplay(missing)).toThrow(/ENOENT/);
  });
});

describe('fixture 目录导出（demo-session 黄金轨迹）', () => {
  it('导出 fixtures/demo-session → 回放摘要与已知投影一致', () => {
    const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo-session');
    const outFile = join(tmpDir(), 'demo.zip');
    exportSession(fixtureDir, outFile);
    const report = importReplay(outFile);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      id: 'demo-session',
      events: 12,
      badLines: 0,
      messageCount: 4,
      lastSeq: 12,
    });
  });
});
