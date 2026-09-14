// harness2 tools CLI 集成测试（P7-C H-31）：list/show/select 真机（core runToolsCommand 薄接线）。
// 依赖根脚本 `pnpm -r build`（dist/index.js）。
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpDir(prefix = 'h2-cli-tools-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写入最小可加载项目 config.json（tools select 的落盘目标必须存在） */
function writeConfig(root: string): string {
  const dir = join(root, '.harness2');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        providers: {
          openai: { protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', envKey: 'H2_TOOLS_KEY', models: { m: {} } },
        },
        roles: { main: { channel: 'openai', model: 'm' } },
      },
      null,
      2,
    ),
    'utf8',
  );
  return path;
}

function run(args: string[], root: string, home = root): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [cliEntry, 'tools', ...args, '--root', root, '--home', home], {
    encoding: 'utf8',
    env: { ...process.env, H2_TOOLS_KEY: 'k' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('harness2 tools', () => {
  it('list：工具清单 + 工具集清单（真实盘点）', () => {
    const root = tmpDir();
    const r = run(['list'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('工具 6 个');
    expect(r.stdout).toContain('bash');
    expect(r.stdout).toContain('工具集 5 个');
  });

  it('show <tool> / show <toolset>：单工具详情与工具集成员', () => {
    const root = tmpDir();
    const tool = run(['show', 'read'], root);
    expect(tool.status).toBe(0);
    expect(tool.stdout).toContain('工具 read');
    expect(tool.stdout).toContain('分类: 文件');

    const set = run(['show', 'coding'], root);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('工具集 coding');
    expect(set.stdout).toContain('当前命中');
  });

  it('select --dry-run：只打印片段不落盘', () => {
    const root = tmpDir();
    const path = writeConfig(root);
    const before = readFileSync(path, 'utf8');
    const r = run(['select', 'coding', '--dry-run'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('未落盘');
    expect(readFileSync(path, 'utf8')).toBe(before); // 逐字节未改
  });

  it('select <toolset>：写入 config.json 的 tools.toolset，list 反映选择', () => {
    const root = tmpDir();
    const path = writeConfig(root);
    const r = run(['select', 'read-only'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已写入');
    expect(readFileSync(path, 'utf8')).toContain('"toolset": "read-only"');

    const after = run(['list'], root);
    expect(after.stdout).toContain('工具集 read-only');
    expect(after.stdout).toContain('write [off]'); // read-only 不含 write
  });

  it('未知子命令/未知工具集 → 退出码 1', () => {
    const root = tmpDir();
    expect(run(['bogus'], root).status).toBe(1);
    writeConfig(root);
    expect(run(['select', 'nope'], root).status).toBe(1);
  });
});
