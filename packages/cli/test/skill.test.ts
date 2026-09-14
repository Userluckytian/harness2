// harness2 skill list CLI 集成测试（阶段 10 Task 2）：两级扫描展示、同名覆盖告警、空列表提示。
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** 隔离 homedir()：技能兜底目录 ~/.agents/skills 固定挂用户主目录（与 --home 解耦），
 *  测试须把子进程的 USERPROFILE/HOME 一并指向临时目录，否则真机技能会污染断言。 */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, USERPROFILE: home, HOME: home };
}

describe('harness2 skill list', () => {
  it('列出项目级 + 全局 skills（[project]/[global] 来源标注）', () => {
    const root = tmpDir();
    const home = tmpDir();
    writeSkill(join(root, '.harness2', 'skills'), 'deploy.md', 'deploy', '部署话术');
    writeSkill(join(home, '.harness2', 'skills'), 'commit.md', 'commit', '提交话术');
    const out = execFileSync('node', [cliEntry, 'skill', 'list', '--root', root, '--home', home], {
      encoding: 'utf8',
      env: isolatedEnv(home),
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
      env: isolatedEnv(home),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dup  [project]  项目版');
    expect(r.stdout).not.toContain('全局版'); // 覆盖后只展示项目版
    expect(r.stderr).toContain('覆盖全局同名');
  });

  it('无 skills：空列表提示', () => {
    const home = tmpDir();
    const out = execFileSync('node', [cliEntry, 'skill', 'list', '--root', tmpDir(), '--home', home], {
      encoding: 'utf8',
      env: isolatedEnv(home),
    });
    expect(out).toContain('（无 skill');
  });
});

// P7-A H-22：经验造技能审批入口（propose / pending / approve / reject）全链真机。
describe('harness2 skill propose/approve/reject（P7 审批入口）', () => {
  function run(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('node', [cliEntry, ...args], { encoding: 'utf8', env: isolatedEnv(home) });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('propose → pending 可见 → approve 落盘 SKILL.md；reject 不落盘', () => {
    const root = tmpDir();
    const home = tmpDir();
    const skillFile = join(root, '.harness2', 'skills', 'deploy-notes', 'SKILL.md');

    // propose（只暂存）
    const proposed = run(
      [
        'skill',
        'propose',
        '--root',
        root,
        '--name',
        'deploy-notes',
        '--description',
        '部署笔记',
        '--body',
        '# 部署\n\n步骤……\n',
      ],
      home,
    );
    expect(proposed.status).toBe(0);
    expect(proposed.stdout).toContain('已提交待审批提案');
    expect(existsSync(skillFile)).toBe(false); // 未 approve 前不落盘

    // pending 列表可见
    const pending = run(['skill', 'pending', '--root', root], home);
    expect(pending.status).toBe(0);
    expect(pending.stdout).toContain('deploy-notes');
    const id = /(\d+-[0-9a-f]+)/.exec(pending.stdout)?.[1];
    expect(id, `pending 未列出提案 id:\n${pending.stdout}`).toBeTruthy();

    // approve → 原子落盘
    const approved = run(['skill', 'approve', id!, '--root', root], home);
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain('已写入');
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf8')).toContain('部署笔记');

    // 落盘后即可被技能扫描发现（[Skills 可用] 的 CLI 侧来源，与 skill_author 提案形成闭环）
    const listed = run(['skill', 'list', '--root', root], home);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('deploy-notes');
    expect(listed.stdout).toContain('部署笔记');

    // 已审批 → pending 清空
    expect(run(['skill', 'pending', '--root', root], home).stdout).toContain('（无待审批技能提案）');
  });

  it('reject → 暂存丢弃、不落盘；未知 id 报错退出码 1', () => {
    const root = tmpDir();
    const home = tmpDir();
    const skillFile = join(root, '.harness2', 'skills', 'tmp-skill', 'SKILL.md');
    const proposed = run(
      ['skill', 'propose', '--root', root, '--name', 'tmp-skill', '--description', '临时', '--body', '# 临时\n'],
      home,
    );
    expect(proposed.status).toBe(0);
    const id = /(\d+-[0-9a-f]+)/.exec(run(['skill', 'pending', '--root', root], home).stdout)?.[1]!;

    const rejected = run(['skill', 'reject', id, '--root', root], home);
    expect(rejected.status).toBe(0);
    expect(rejected.stdout).toContain('已丢弃');
    expect(existsSync(skillFile)).toBe(false);
    expect(run(['skill', 'pending', '--root', root], home).stdout).toContain('（无待审批技能提案）');

    const missing = run(['skill', 'reject', 'no-such-id', '--root', root], home);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('未找到待审批提案');
  });

  it('propose 缺正文 → 用法错误退出码 1（不生成暂存）', () => {
    const root = tmpDir();
    const home = tmpDir();
    const r = run(['skill', 'propose', '--root', root, '--name', 'x', '--description', 'd'], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('缺少正文');
  });
});
