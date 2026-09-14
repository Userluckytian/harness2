// H-13 会话可移植（导入/迁移）测试：导出→导入往返一致 / 幂等（重复导入零写盘）/
// 冲突与覆盖 / dry-run / zip slip 防御 / 未知条目与坏行容错 / 版本迁移链与新代际拒绝 /
// 解压体积闸门（与 importReplay 同口径）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { SessionManager, encodeCwd } from '../src/session/manager.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { loadSession } from '../src/session/reader.js';
import { REWIND_POINTS_FILE } from '../src/session/snapshots.js';
import { exportSession, ReplayTooLargeError } from '../src/session/export.js';
import {
  SESSION_MIGRATIONS,
  detectLogVersion,
  importSession,
  migrateLogLines,
  planMigrationChain,
  type SessionMigration,
} from '../src/session/portability.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-port-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CWD = '/proj/portability';
/** 目标库分组目录（header.cwd 真值 = create 时的 resolve(CWD)，须与导入侧同口径） */
const GROUP_DIR = encodeCwd(resolve(CWD));

/** 建「父 + 子代理」两会话库并返回父会话目录 */
function makeLibrary(root: string): { parentDir: string; childDir: string; parentId: string; childId: string } {
  const mgr = new SessionManager(root);
  const parentId = '20260914-222222-aa0001';
  const childId = '20260914-222222-aa0002';
  const parent = mgr.create(CWD, { id: parentId, fsync: false });
  parent.writer.append('user/message', { text: 'portable parent quantum', turnId: 't1' });
  parent.writer.append('assistant/message', { text: 'parent reply', turnId: 't1' });
  parent.writer.close();
  const child = mgr.create(CWD, { id: childId, fsync: false, parentSession: parentId, subagent: true });
  child.writer.append('user/message', { text: 'child task' });
  child.writer.append('assistant/message', { text: 'child done' });
  child.writer.close();
  // 辅助文件（随包走）：rewind_points.jsonl
  writeFileSync(
    join(parent.dir, REWIND_POINTS_FILE),
    `${JSON.stringify({ v: 1, seq: 3, file: '/proj/a.ts', before: 'old', after: 'new' })}\n`,
    'utf8',
  );
  return { parentDir: parent.dir, childDir: child.dir, parentId, childId };
}

/** 递归收集目录内文件（相对路径 → 字节） */
function collectFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs, childRel);
      else out.set(childRel, readFileSync(abs));
    }
  };
  walk(dir, '');
  return out;
}

describe('H-13 导出 → 导入往返', () => {
  it('主会话与子会话（含辅助文件）逐字节还原，且再导出字节幂等', () => {
    const sourceRoot = tmpDir();
    const { parentDir, parentId, childId } = makeLibrary(sourceRoot);
    const zipA = join(tmpDir(), 'a.zip');
    exportSession(parentDir, zipA);
    const targetRoot = tmpDir();
    const report = importSession(zipA, { targetRoot });
    expect(report.sessions.map((s) => s.status)).toEqual(['imported', 'imported']);
    const importedParent = join(targetRoot, GROUP_DIR, parentId);
    const importedChild = join(targetRoot, GROUP_DIR, childId);
    // 文件集合与字节一一还原（含 rewind_points.jsonl）
    const expected = collectFiles(parentDir);
    const actual = collectFiles(importedParent);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [rel, bytes] of expected) expect(actual.get(rel)!.equals(bytes)).toBe(true);
    expect(readFileSync(join(importedParent, REWIND_POINTS_FILE), 'utf8')).toContain('/proj/a.ts');
    // 血缘保留 → 再导出得到的 zip 与首次导出逐字节一致（固定 mtime 口径未变）
    const zipB = join(tmpDir(), 'b.zip');
    exportSession(importedParent, zipB);
    expect(readFileSync(zipB).equals(readFileSync(zipA))).toBe(true);
    // 子会话血缘字段
    expect(loadSession(importedChild).header?.parentSession).toBe(parentId);
  });

  it('包内事件可读且投影一致（导入即事实源，非回放态）', () => {
    const sourceRoot = tmpDir();
    const { parentDir, parentId } = makeLibrary(sourceRoot);
    const zip = join(tmpDir(), 'c.zip');
    exportSession(parentDir, zip);
    const targetRoot = tmpDir();
    importSession(zip, { targetRoot });
    const imported = loadSession(join(targetRoot, GROUP_DIR, parentId));
    expect(imported.warnings).toEqual([]);
    expect(imported.events).toHaveLength(3); // header + user + assistant
  });
});

describe('H-13 幂等、冲突与 dry-run', () => {
  it('重复导入：内容一致 → unchanged，不写盘（mtime 不变）', () => {
    const sourceRoot = tmpDir();
    const { parentDir, parentId } = makeLibrary(sourceRoot);
    const zip = join(tmpDir(), 'd.zip');
    exportSession(parentDir, zip);
    const targetRoot = tmpDir();
    const first = importSession(zip, { targetRoot });
    expect(first.sessions[0]!.status).toBe('imported');
    const logPath = join(targetRoot, GROUP_DIR, parentId, SESSION_LOG_FILE);
    const mtime = statSync(logPath).mtimeMs;
    const second = importSession(zip, { targetRoot });
    expect(second.sessions[0]!.status).toBe('unchanged');
    expect(statSync(logPath).mtimeMs).toBe(mtime);
  });

  it('目标内容不同且 overwrite:false → skipped-existing（原样保留）；overwrite:true → 覆盖', () => {
    const sourceRoot = tmpDir();
    const { parentDir, parentId } = makeLibrary(sourceRoot);
    const zip = join(tmpDir(), 'e.zip');
    exportSession(parentDir, zip);
    const targetRoot = tmpDir();
    importSession(zip, { targetRoot });
    const logPath = join(targetRoot, GROUP_DIR, parentId, SESSION_LOG_FILE);
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}\n`, 'utf8'); // 制造差异
    const skip = importSession(zip, { targetRoot });
    expect(skip.sessions[0]!.status).toBe('skipped-existing');
    expect(skip.sessions[0]!.warnings.join()).toContain('未覆盖');
    expect(readFileSync(logPath, 'utf8').endsWith('\n\n')).toBe(true); // 未被改回
    const overwritten = importSession(zip, { targetRoot, overwrite: true });
    expect(overwritten.sessions[0]!.status).toBe('overwritten');
    expect(readFileSync(logPath).equals(readFileSync(join(parentDir, SESSION_LOG_FILE)))).toBe(true);
  });

  it('dry-run：只报告不落盘（目标目录不存在）', () => {
    const sourceRoot = tmpDir();
    const { parentDir, parentId } = makeLibrary(sourceRoot);
    const zip = join(tmpDir(), 'f.zip');
    exportSession(parentDir, zip);
    const targetRoot = tmpDir();
    const report = importSession(zip, { targetRoot, dryRun: true });
    expect(report.sessions.every((s) => s.status === 'planned')).toBe(true);
    expect(report.sessions[0]!.dir).toContain(parentId);
    expect(existsSync(join(targetRoot, GROUP_DIR))).toBe(false);
  });

  it('无 cwd 真值且未给 opts.cwd → 该会话跳过并登记（不抛错、不影响其它会话）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'g.zip');
    const log = `${JSON.stringify({ v: 1, seq: 1, ts: '2026-09-14T00:00:00.000Z', type: 'session/header', payload: { sessionId: '20260914-222222-bb0001' } })}\n`;
    writeFileSync(zip, zipSync({ [SESSION_LOG_FILE]: new TextEncoder().encode(log) }));
    const report = importSession(zip, { targetRoot });
    expect(report.sessions[0]!.status).toBe('skipped-existing');
    expect(report.sessions[0]!.warnings.join()).toContain('无 cwd 真值');
  });
});

describe('H-13 安全与容错', () => {
  it('zip slip（../ 越界路径）→ 拒绝导入（安全闸门不静默）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'h.zip');
    writeFileSync(
      zip,
      zipSync({
        '../evil.jsonl': new TextEncoder().encode('{}\n'),
        [SESSION_LOG_FILE]: new TextEncoder().encode('{}\n'),
      }),
    );
    expect(() => importSession(zip, { targetRoot })).toThrow(/越界路径段/);
  });

  it('反斜杠/绝对路径条目 → 拒绝', () => {
    const targetRoot = tmpDir();
    const zipBackslash = join(tmpDir(), 'i.zip');
    writeFileSync(zipBackslash, zipSync({ 'snapshots\\x.txt': new Uint8Array([1]) }));
    expect(() => importSession(zipBackslash, { targetRoot })).toThrow(/反斜杠|绝对路径/);
    const zipAbs = join(tmpDir(), 'j.zip');
    writeFileSync(zipAbs, zipSync({ '/etc/passwd': new Uint8Array([1]) }));
    expect(() => importSession(zipAbs, { targetRoot })).toThrow(/绝对路径/);
  });

  // —— P1-1（H-13 修复）：会话 id 目录穿越 ——
  // 落点 = targetRoot/encodeCwd(resolve(cwd))/id，其中 id 来自**包内 header.sessionId**（不可信）。
  // 修复前 `sessionId='../../escaped-id'` 可直接把日志写到 targetRoot 之外。
  it('恶意 header.sessionId（目录穿越）→ 拒绝导入且零写入（格式闸门 + 落点前缀校验双防御）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'evil-id.zip');
    const log = `${JSON.stringify({
      v: 1,
      seq: 1,
      ts: '2026-09-14T00:00:00.000Z',
      type: 'session/header',
      payload: { sessionId: '../../escaped-id', cwd: CWD },
    })}\n`;
    writeFileSync(zip, zipSync({ [SESSION_LOG_FILE]: new TextEncoder().encode(log) }));
    // 变异取证（实测）：把第一层格式闸门改成 `if (false)` 后本用例即红——错误文案变为
    // 「会话落点越界（必须落在 <targetRoot> 内），拒绝导入: <parent>\escaped-id」，
    // 证明第二层前缀校验独立生效、且本断言非空转（两层都不在时才会真的写出 targetRoot 之外）。
    expect(() => importSession(zip, { targetRoot })).toThrow(/会话 id 非法/);
    // 零写入：越界落点不存在，目标库内也没有任何会话目录
    expect(existsSync(resolve(targetRoot, '..', 'escaped-id'))).toBe(false);
    expect(existsSync(join(targetRoot, '..', 'escaped-id'))).toBe(false);
    expect(readdirSync(targetRoot)).toEqual([]);
  });

  it('子会话日志 header.sessionId 越界同样被拒（packed.id 合法但 header 覆盖）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'evil-child-id.zip');
    const rootId = '20260914-222222-aa0001';
    const valid = '20260914-222222-aa0002';
    const header = (sessionId: string): string =>
      `${JSON.stringify({
        v: 1,
        seq: 1,
        ts: '2026-09-14T00:00:00.000Z',
        type: 'session/header',
        payload: { sessionId, cwd: CWD },
      })}\n`;
    writeFileSync(
      zip,
      zipSync({
        [SESSION_LOG_FILE]: new TextEncoder().encode(
          header(rootId) +
            `${JSON.stringify({ v: 1, seq: 2, ts: '2026-09-14T00:00:01.000Z', type: 'user/message', payload: { text: 'hi' } })}\n`,
        ),
        [`subagents/${valid}/${SESSION_LOG_FILE}`]: new TextEncoder().encode(header('../../escaped-child')),
      }),
    );
    expect(() => importSession(zip, { targetRoot })).toThrow(/会话 id 非法/);
    expect(existsSync(resolve(targetRoot, '..', 'escaped-child'))).toBe(false);
  });

  it('合法 id 仍可导入（修复不误伤正常包）', () => {
    const sourceRoot = tmpDir();
    const { parentDir, parentId } = makeLibrary(sourceRoot);
    const zip = join(tmpDir(), 'ok-id.zip');
    exportSession(parentDir, zip);
    const targetRoot = tmpDir();
    const report = importSession(zip, { targetRoot });
    expect(report.sessions[0]!.status).toBe('imported');
    expect(existsSync(join(targetRoot, GROUP_DIR, parentId, SESSION_LOG_FILE))).toBe(true);
  });

  it('未知根级条目 → warning 跳过（前向兼容，不阻塞导入）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'k.zip');
    const log =
      [
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: '2026-09-14T00:00:00.000Z',
          type: 'session/header',
          payload: { sessionId: '20260914-222222-cc0001', cwd: CWD },
        }),
        JSON.stringify({ v: 1, seq: 2, ts: '2026-09-14T00:00:01.000Z', type: 'user/message', payload: { text: 'hi' } }),
      ].join('\n') + '\n';
    writeFileSync(
      zip,
      zipSync({ [SESSION_LOG_FILE]: new TextEncoder().encode(log), 'future.json': new TextEncoder().encode('{}') }),
    );
    const report = importSession(zip, { targetRoot });
    expect(report.warnings.join()).toContain('未知条目');
    expect(report.sessions[0]!.status).toBe('imported');
    expect(existsSync(join(targetRoot, GROUP_DIR, '20260914-222222-cc0001', 'future.json'))).toBe(false);
  });

  it('坏行容错：计数 + 告警，合法事件仍可读（事实源字节原样落盘）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'l.zip');
    const log =
      [
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: '2026-09-14T00:00:00.000Z',
          type: 'session/header',
          payload: { sessionId: '20260914-222222-dd0001', cwd: CWD },
        }),
        'not-json-at-all',
        JSON.stringify({
          v: 1,
          seq: 2,
          ts: '2026-09-14T00:00:01.000Z',
          type: 'user/message',
          payload: { text: 'kept' },
        }),
      ].join('\n') + '\n';
    writeFileSync(zip, zipSync({ [SESSION_LOG_FILE]: new TextEncoder().encode(log) }));
    const report = importSession(zip, { targetRoot });
    expect(report.sessions[0]!.badLines).toBe(1);
    expect(report.sessions[0]!.events).toBe(2);
    expect(report.sessions[0]!.warnings.join()).toContain('非法事件');
    const imported = loadSession(join(targetRoot, GROUP_DIR, '20260914-222222-dd0001'));
    expect(imported.warnings).toHaveLength(1);
    expect(readFileSync(join(targetRoot, GROUP_DIR, '20260914-222222-dd0001', SESSION_LOG_FILE), 'utf8')).toBe(log);
  });

  it('空包/非 harness2 导出 → 抛错', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'm.zip');
    writeFileSync(zip, zipSync({ 'readme.txt': new TextEncoder().encode('nope') }));
    expect(() => importSession(zip, { targetRoot })).toThrow(/没有会话日志/);
  });

  it('解压体积闸门：超过 maxDecompressedBytes → ReplayTooLargeError（与 importReplay 同口径）', () => {
    const sourceRoot = tmpDir();
    const { parentDir } = makeLibrary(sourceRoot);
    const zip = join(tmpDir(), 'n.zip');
    exportSession(parentDir, zip);
    const targetRoot = tmpDir();
    expect(() => importSession(zip, { targetRoot, maxDecompressedBytes: 1 })).toThrow(ReplayTooLargeError);
    try {
      importSession(zip, { targetRoot, maxDecompressedBytes: 1 });
    } catch (e) {
      expect((e as Error).message).toContain('超过上限');
    }
  });
});

describe('H-13 版本迁移', () => {
  it('缺省迁移表为空（当前仅 v1）；迁移链规划正确', () => {
    expect(SESSION_MIGRATIONS).toEqual([]);
    expect(planMigrationChain(1, 1)).toEqual([]);
    expect(planMigrationChain(0, 1)).toBeNull();
  });

  it('新于本内核的代际 → 拒绝导入（提示升级）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'o.zip');
    writeFileSync(
      zip,
      zipSync({
        [SESSION_LOG_FILE]: new TextEncoder().encode(
          `${JSON.stringify({ v: 2, seq: 1, ts: '2026-09-14T00:00:00.000Z', type: 'session/header', payload: { sessionId: '20260914-222222-ee0001', cwd: CWD } })}\n`,
        ),
      }),
    );
    expect(() => importSession(zip, { targetRoot })).toThrow(/新于本内核/);
  });

  it('旧代际 + 注入迁移链 → 迁移后落盘为当前代际（可被 loadSession 读取）', () => {
    const targetRoot = tmpDir();
    const zip = join(tmpDir(), 'p.zip');
    // 虚构的 v0：信封 v=0（当前解析器拒绝），迁移把 v 改成 1
    const legacy =
      [
        JSON.stringify({
          v: 0,
          seq: 1,
          ts: '2026-09-14T00:00:00.000Z',
          type: 'session/header',
          payload: { sessionId: '20260914-222222-ff0001', cwd: CWD },
        }),
        JSON.stringify({
          v: 0,
          seq: 2,
          ts: '2026-09-14T00:00:01.000Z',
          type: 'user/message',
          payload: { text: 'legacy message' },
        }),
      ].join('\n') + '\n';
    writeFileSync(zip, zipSync({ [SESSION_LOG_FILE]: new TextEncoder().encode(legacy) }));
    const migration: SessionMigration = {
      from: 0,
      to: 1,
      description: 'v0 → v1：补齐信封代际',
      migrate: (lines) =>
        lines.map((l) => {
          if (l.length === 0) return l;
          const obj = JSON.parse(l) as Record<string, unknown>;
          obj['v'] = 1;
          return JSON.stringify(obj);
        }),
    };
    expect(detectLogVersion(legacy.split('\n'))).toBe(0);
    expect(() => importSession(zip, { targetRoot })).toThrow(/缺少 v0 → v1 的迁移链/);
    const report = importSession(zip, { targetRoot, migrations: [migration] });
    expect(report.sessions[0]!.migrated).toEqual({ from: 0, to: 1, steps: ['v0 → v1：补齐信封代际'] });
    expect(report.sessions[0]!.badLines).toBe(0);
    const dir = join(targetRoot, GROUP_DIR, '20260914-222222-ff0001');
    const imported = loadSession(dir);
    expect(imported.events).toHaveLength(2);
    expect(imported.warnings).toEqual([]);
    // 迁移幂等：再导入一次 → unchanged（已是 v1，无需重写）
    const again = importSession(zip, { targetRoot, migrations: [migration] });
    expect(again.sessions[0]!.status).toBe('unchanged');
  });

  it('migrateLogLines 对同代际/空日志原样返回', () => {
    const lines = ['{"v":1,"seq":1,"ts":"t","type":"session/header","payload":{"sessionId":"s"}}'];
    expect(migrateLogLines(lines)).toMatchObject({ lines, from: 1, to: 1, steps: [] });
    expect(migrateLogLines([''])).toMatchObject({ lines: [''], from: 1, to: 1 });
  });
});
