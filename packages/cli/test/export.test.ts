// harness2 export/replay CLI 集成测试（阶段 10 Task 1）：
// 默认输出路径、-o 指定输出、replay 摘要与坏行报告、空包 exit 1、只读（目录无新文件）。
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { SessionManager } from '@harness2/core';

// 依赖根脚本 `pnpm -r build && pnpm -r test`：core 与 cli 的 dist 均已构建
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpDir(prefix = 'h2-cli-export-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  parentDir: string;
  childId: string;
}

/** 库内建父 + subagent 子会话（血缘 = header.parentSession） */
function makeLibrary(): Fixture {
  const root = tmpDir();
  const manager = new SessionManager(root);
  const parent = manager.create(join(root, 'proj'), { id: '20260906-030301-pppppp' });
  parent.writer.append('user/message', { text: '父任务', turnId: 't1' });
  parent.writer.append('assistant/message', { text: '完成', model: 'mock', turnId: 't1' });
  parent.writer.close();
  const child = manager.create(join(root, 'proj'), {
    id: '20260906-030302-cccccc',
    parentSession: parent.id,
    isSeeded: true,
    subagent: true,
  });
  child.writer.append('user/message', { text: '子任务', turnId: 't1' });
  child.writer.close();
  return { root, parentDir: parent.dir, childId: child.id };
}

/** 读出 zip 产物、往根日志追加一行坏内容、重新打包（固定 mtime） */
function zipWithBadLine(zipFile: string): Buffer {
  const files = unzipSync(new Uint8Array(readFileSync(zipFile)));
  const logKey = Object.keys(files).find((k) => k === 'session.v1.jsonl')!;
  const text = new TextDecoder().decode(files[logKey]!);
  files[logKey] = new TextEncoder().encode(`${text}broken-line\n`);
  return Buffer.from(zipSync(files, { mtime: new Date(Date.UTC(2000, 0, 1)) }));
}

describe('harness2 export', () => {
  it('默认输出到 cwd/<sessionId>.zip；含子代理会话；会话目录无新增文件（只读）', () => {
    const lib = makeLibrary();
    const outDir = tmpDir();
    const before = readdirSync(lib.parentDir).sort();
    const out = execFileSync('node', [cliEntry, 'export', lib.parentDir], {
      encoding: 'utf8',
      cwd: outDir,
    });
    expect(out).toContain('20260906-030301-pppppp');
    expect(existsSync(join(outDir, '20260906-030301-pppppp.zip'))).toBe(true);
    expect(readdirSync(lib.parentDir).sort()).toEqual(before); // 只读红线
    const replay = execFileSync('node', [cliEntry, 'replay', join(outDir, '20260906-030301-pppppp.zip')], {
      encoding: 'utf8',
    });
    expect(replay).toContain('主会话 20260906-030301-pppppp  events=3  messages=2  lastSeq=3  badLines=0');
    expect(replay).toContain(`子会话 ${lib.childId}  events=2  messages=1  lastSeq=2  badLines=0`);
  });

  it('-o 指定输出路径；会话目录不存在时一行友好错误（exit 1）', () => {
    const lib = makeLibrary();
    const outFile = join(tmpDir(), 'custom.zip');
    const out = execFileSync('node', [cliEntry, 'export', lib.parentDir, '-o', outFile], {
      encoding: 'utf8',
    });
    expect(out).toContain(`→ ${outFile}`);
    expect(existsSync(outFile)).toBe(true);

    const r = spawnSync('node', [cliEntry, 'export', join(tmpDir(), 'nope')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: .+not found/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('harness2 replay', () => {
  it('坏行如实报告（badLines=1 + warning 明细），其余会话照常投影', () => {
    const lib = makeLibrary();
    const outFile = join(tmpDir(), 'lib.zip');
    execFileSync('node', [cliEntry, 'export', lib.parentDir, '-o', outFile], { encoding: 'utf8' });
    const tampered = join(tmpDir(), 'tampered.zip');
    writeFileSync(tampered, zipWithBadLine(outFile));
    const out = execFileSync('node', [cliEntry, 'replay', tampered], { encoding: 'utf8' });
    expect(out).toMatch(/主会话 .+ badLines=1/);
    expect(out).toContain('warning: skipped invalid line');
  });

  it('空包 / 非 harness2 zip：一行友好错误（exit 1）', () => {
    const emptyZip = join(tmpDir(), 'empty.zip');
    writeFileSync(emptyZip, Buffer.from(zipSync({}, { mtime: new Date(Date.UTC(2000, 0, 1)) })));
    const r = spawnSync('node', [cliEntry, 'replay', emptyZip], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: .+没有会话日志/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('zip 文件缺失：一行友好错误（exit 1）', () => {
    const r = spawnSync('node', [cliEntry, 'replay', join(tmpDir(), 'missing.zip')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: ENOENT/);
  });
});
