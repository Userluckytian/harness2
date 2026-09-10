// harness2 memory 命令测试（阶段 6）：show / clear / pending / approve / reject。
// 依赖根脚本 `pnpm -r build`：cli 与 core 的 dist 均已构建。记忆内容全在临时 home（不入 git）。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

interface Env {
  home: string;
  memoriesDir: string;
  pendingDir: string;
  cleanup: () => void;
}

function makeEnv(): Env {
  const home = mkdtempSync(join(tmpdir(), 'h2-mem-home-'));
  const memoriesDir = join(home, '.harness2', 'memories');
  const pendingDir = join(memoriesDir, 'pending');
  mkdirSync(memoriesDir, { recursive: true });
  return {
    home,
    memoriesDir,
    pendingDir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function runMemory(home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [cliEntry, 'memory', ...args, '--home', home], { encoding: 'utf8' });
}

describe('harness2 memory show', () => {
  it('展示两个文件的条目与用量；空 store 正常展示', () => {
    const env = makeEnv();
    try {
      writeFileSync(join(env.memoriesDir, 'MEMORY.md'), '项目使用 pnpm monorepo', 'utf8');
      writeFileSync(join(env.memoriesDir, 'USER.md'), '用户偏好深色主题\n§\n用户在东八区', 'utf8');
      const r = runMemory(env.home, ['show']);
      expect(r.status).toBe(0);
      const out = r.stdout as string;
      expect(out).toContain('MEMORY.md（1 条，18/2200 字符，剩余 2182）');
      expect(out).toContain('[1] 项目使用 pnpm monorepo');
      expect(out).toContain('USER.md（2 条，');
      expect(out).toContain('用户偏好深色主题');
      expect(out).toContain('用户在东八区');

      // 空 store
      const empty = makeEnv();
      try {
        const r2 = runMemory(empty.home, ['show']);
        expect(r2.status).toBe(0);
        expect(r2.stdout as string).toContain('MEMORY.md（0 条，0/2200');
      } finally {
        empty.cleanup();
      }
    } finally {
      env.cleanup();
    }
  });

  it('漂移文件：show 给出告警', () => {
    const env = makeEnv();
    try {
      writeFileSync(join(env.memoriesDir, 'MEMORY.md'), '条目一\n§\n条目二\n§', 'utf8');
      const r = runMemory(env.home, ['show']);
      expect(r.status).toBe(0);
      expect(r.stdout as string).toContain('结构漂移');
    } finally {
      env.cleanup();
    }
  });
});

describe('harness2 memory clear', () => {
  it('--target user 只清 USER.md；--target all 清两个文件', () => {
    const env = makeEnv();
    try {
      writeFileSync(join(env.memoriesDir, 'MEMORY.md'), '项目笔记', 'utf8');
      writeFileSync(join(env.memoriesDir, 'USER.md'), '画像条目', 'utf8');
      const r = runMemory(env.home, ['clear', '--target', 'user']);
      expect(r.status).toBe(0);
      expect(readFileSync(join(env.memoriesDir, 'USER.md'), 'utf8')).toBe('');
      expect(readFileSync(join(env.memoriesDir, 'MEMORY.md'), 'utf8')).toBe('项目笔记');

      const r2 = runMemory(env.home, ['clear']);
      expect(r2.status).toBe(0);
      expect(readFileSync(join(env.memoriesDir, 'MEMORY.md'), 'utf8')).toBe('');
    } finally {
      env.cleanup();
    }
  });

  it('非法 --target 报错 exit 1', () => {
    const env = makeEnv();
    try {
      const r = runMemory(env.home, ['clear', '--target', 'chat']);
      expect(r.status).toBe(1);
      expect(r.stderr as string).toContain('--target');
    } finally {
      env.cleanup();
    }
  });
});

describe('harness2 memory pending / approve / reject', () => {
  function stageFile(env: Env, id: string): void {
    mkdirSync(env.pendingDir, { recursive: true });
    writeFileSync(
      join(env.pendingDir, `${id}.json`),
      JSON.stringify({
        id,
        createdAt: '2026-09-06T12:00:00.000Z',
        sessionId: 'sess-demo',
        ops: [{ operation: 'add', target: 'user', text: '审批后写入的偏好' }],
      }),
      'utf8',
    );
  }

  it('pending 列出暂存项；approve 重放落盘并删除暂存', () => {
    const env = makeEnv();
    try {
      stageFile(env, '1788660000000-ab01');
      const r = runMemory(env.home, ['pending']);
      expect(r.status).toBe(0);
      const out = r.stdout as string;
      expect(out).toContain('1788660000000-ab01');
      expect(out).toContain('sess-demo');
      expect(out).toContain('add user: 审批后写入的偏好');

      const r2 = runMemory(env.home, ['approve', '1788660000000-ab01']);
      expect(r2.status).toBe(0);
      expect(readFileSync(join(env.memoriesDir, 'USER.md'), 'utf8')).toBe('审批后写入的偏好');
      expect(existsSync(join(env.pendingDir, '1788660000000-ab01.json'))).toBe(false);
      expect(runMemory(env.home, ['pending']).stdout as string).toContain('（无待审批项）');
    } finally {
      env.cleanup();
    }
  });

  it('reject 丢弃暂存；approve 未知 id exit 1', () => {
    const env = makeEnv();
    try {
      stageFile(env, '1788660000000-cd02');
      const r = runMemory(env.home, ['reject', '1788660000000-cd02']);
      expect(r.status).toBe(0);
      expect(existsSync(join(env.pendingDir, '1788660000000-cd02.json'))).toBe(false);
      expect(readdirSync(env.pendingDir)).toHaveLength(0);

      const r2 = runMemory(env.home, ['approve', 'nope']);
      expect(r2.status).toBe(1);
      expect(r2.stderr as string).toContain('nope');
    } finally {
      env.cleanup();
    }
  });

  it('pending --clear 清空全部暂存并输出清除条数（审查 P2-3）', () => {
    const env = makeEnv();
    try {
      stageFile(env, '1788660000000-ee03');
      stageFile(env, '1788660000000-ff04');
      const r = runMemory(env.home, ['pending', '--clear']);
      expect(r.status).toBe(0);
      expect(r.stdout as string).toContain('已清除 2 条待审批项');
      expect(readdirSync(env.pendingDir)).toHaveLength(0);

      // 空目录再 clear：输出 0 条，exit 0
      const r2 = runMemory(env.home, ['pending', '--clear']);
      expect(r2.status).toBe(0);
      expect(r2.stdout as string).toContain('已清除 0 条待审批项');
    } finally {
      env.cleanup();
    }
  });
});
