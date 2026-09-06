// harness2 skill list CLI 集成测试（阶段 10 Task 2）：两级扫描展示、同名覆盖告警、空列表提示。
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 依赖根脚本 `pnpm -r build && pnpm -r test`：core 与 cli 的 dist 均已构建
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpDir(prefix = 'h2-cli-skill-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSkill(dir: string, fileName: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`, 'utf8');
}

describe('harness2 skill list', () => {
  it('列出项目级 + 全局 skills（[project]/[global] 来源标注）', () => {
    const root = tmpDir();
    const home = tmpDir();
    writeSkill(join(root, '.harness2', 'skills'), 'deploy.md', 'deploy', '部署话术');
    writeSkill(join(home, '.harness2', 'skills'), 'commit.md', 'commit', '提交话术');
    const out = execFileSync('node', [cliEntry, 'skill', 'list', '--root', root, '--home', home], {
      encoding: 'utf8',
    });
    expect(out).toContain('commit  [global]  提交话术');
    expect(out).toContain('deploy  [project]  部署话术');
  });

  it('同名覆盖：只展示项目版，覆盖告警走 stderr', () => {
    const root = tmpDir();
    const home = tmpDir();
    writeSkill(join(root, '.harness2', 'skills'), 'dup.md', 'dup', '项目版');
    writeSkill(join(home, '.harness2', 'skills'), 'dup.md', 'dup', '全局版');
    const r = spawnSync('node', [cliEntry, 'skill', 'list', '--root', root, '--home', home], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dup  [project]  项目版');
    expect(r.stdout).not.toContain('全局版'); // 覆盖后只展示项目版
    expect(r.stderr).toContain('覆盖全局同名');
  });

  it('无 skills：空列表提示', () => {
    const out = execFileSync('node', [cliEntry, 'skill', 'list', '--root', tmpDir(), '--home', tmpDir()], {
      encoding: 'utf8',
    });
    expect(out).toContain('（无 skill');
  });
});
