// CLI doctor 命令集成测试（阶段 11 Task 4）：spawn dist/index.js doctor，
// 分节输出 + exit 语义（WARN 不红 / FAIL 红）。依赖根脚本 `pnpm -r build`。
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpHome(prefix = 'h2-cli-doctor-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface DoctorRun {
  code: number | null;
  stdout: string;
}

function runDoctor(args: string[], home: string): Promise<DoctorRun> {
  return new Promise((resolve) => {
    const proc = spawn('node', [cliEntry, 'doctor', '--home', home, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

describe('harness2 doctor 命令', () => {
  it('全新 home：分节输出 OK/WARN，exit 0（WARN 不红）', async () => {
    const home = tmpHome();
    const r = await runDoctor([], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('harness2 doctor');
    expect(r.stdout).toContain('[OK]  node');
    expect(r.stdout).toContain('[WARN] config'); // 未配置 = 全新环境提示
    expect(r.stdout).toContain('[OK]  sessions');
    expect(r.stdout).toContain('exit 0');
  });

  it('config 解析失败：[FAIL] 行与 exit 1', async () => {
    const home = tmpHome();
    const dir = join(home, '.harness2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ broken !!!', 'utf8');
    const r = await runDoctor([], home);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('[FAIL] config');
    expect(r.stdout).toContain('FAIL → exit 1');
  });
});
