// A1-1 验收测试：Windows shell 探测（config.bash.shell > Git Bash > cmd 回退）。
// 零外部依赖：探测用注入的 env/exists；真机用例仅在 Windows 上跑（CI Linux 自动跳过）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBashShell } from '../src/tools/shell.js';
import { bashTool } from '../src/tools/predefined/bash.js';
import type { ToolOutput } from '../src/tools/types.js';

const IS_WINDOWS = process.platform === 'win32';
const never = (): boolean => false;

/** 直接调用 bash 工具（测试注入 bashShell，等价 config.bash.shell） */
async function runBash(command: string, bashShell?: string): Promise<ToolOutput> {
  return bashTool.execute(
    { command },
    {
      signal: new AbortController().signal,
      cwd: process.cwd(),
      ...(bashShell !== undefined ? { bashShell } : {}),
    },
  );
}

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-winbash-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('A1-1 shell 探测顺序', () => {
  it('POSIX 平台：/bin/sh（Node shell:true），不受 Windows 探测影响', () => {
    const spec = resolveBashShell({ platform: 'linux', configured: 'D:\\Git\\bin\\bash.exe', exists: never });
    expect(spec.kind).toBe('posix');
    expect(spec.executable).toBe('/bin/sh');
    expect(spec.useNodeShell).toBe(true);
  });

  it('config.bash.shell 优先级最高（即使 Git Bash 存在也用配置值）', () => {
    const spec = resolveBashShell({
      platform: 'win32',
      configured: 'C:\\MyShell\\bash.exe',
      env: { GIT_BASH: 'C:\\Program Files\\Git' },
      exists: () => true,
    });
    expect(spec.kind).toBe('configured');
    expect(spec.executable).toBe('C:\\MyShell\\bash.exe');
    expect(spec.useNodeShell).toBe(false);
    expect(spec.argsPrefix).toEqual(['-c']);
    expect(spec.display).toContain('config.bash.shell');
  });

  it('config.bash.shell 指向 cmd.exe 时按 cmd 口径解释', () => {
    const spec = resolveBashShell({ platform: 'win32', configured: 'C:\\Windows\\System32\\cmd.exe', exists: never });
    expect(spec.kind).toBe('configured');
    expect(spec.useNodeShell).toBe(true);
  });

  it('未配置：GIT_BASH 环境变量（安装根目录）优先于常见路径', () => {
    const gitBash = 'D:\\Tools\\Git\\bin\\bash.exe';
    const spec = resolveBashShell({
      platform: 'win32',
      env: { GIT_BASH: 'D:\\Tools\\Git', ProgramFiles: 'C:\\Program Files' },
      exists: (p) => p === gitBash || p === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    expect(spec.kind).toBe('git-bash');
    expect(spec.executable).toBe(gitBash);
    expect(spec.display).toContain('GIT_BASH');
  });

  it('未配置且无 GIT_BASH：命中常见安装路径 Program Files\\Git\\bin\\bash.exe', () => {
    const spec = resolveBashShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    expect(spec.kind).toBe('git-bash');
    expect(spec.executable).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('Git 装在非 C 盘：PATH 里的 Git 目录（含 git 字样）也能命中', () => {
    const gitBash = 'D:\\Program Files\\Git\\usr\\bin\\bash.exe';
    const spec = resolveBashShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows;D:\\Program Files\\Git\\usr\\bin' },
      exists: (p) => p === gitBash,
    });
    expect(spec.kind).toBe('git-bash');
    expect(spec.executable).toBe(gitBash);
  });

  it('都没有：回退 cmd.exe（ComSpec 优先），display 说明回退原因', () => {
    const spec = resolveBashShell({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      exists: never,
    });
    expect(spec.kind).toBe('cmd');
    expect(spec.executable).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spec.useNodeShell).toBe(true);
    expect(spec.display).toContain('回退');
  });
});

describe.skipIf(!IS_WINDOWS)('Windows 真机：bash 工具走 Git Bash / cmd 回退', () => {
  it('Git Bash：ls / pwd / head 经真实 shell 成功执行', async () => {
    const file = join(tmpDir(), 'sample.txt');
    writeFileSync(file, 'first line\nsecond line\n', 'utf8');
    const base = process.cwd();

    const ls = await runBash('ls package.json');
    expect(ls.error).toBeUndefined();
    expect(ls.output).toContain('package.json');

    const pwd = await runBash('pwd');
    expect(pwd.error).toBeUndefined();
    // Git Bash 的 pwd 形如 /d/AI_Projects/harness2/packages/core；只断言成功且非空
    expect((pwd.output ?? '').trim().length).toBeGreaterThan(0);

    const head = await runBash(`head -n 1 "${file.replace(/\\/g, '/')}"`);
    expect(head.error).toBeUndefined();
    expect(head.output).toContain('first line');

    expect(base.length).toBeGreaterThan(0);
  }, 30_000);

  it('配置的 shell 路径不存在：spawn 失败错误里带实际使用的 shell，便于自纠', async () => {
    const r = await runBash('echo hi', 'C:\\NoSuchShell\\bash.exe');
    expect(r.error).toBeDefined();
    expect(r.error).toContain('shell: C:\\NoSuchShell\\bash.exe');
  }, 30_000);
});
