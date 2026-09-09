// harness2 config check 测试：正常/异常路径、脱敏展示、exit code。
// 依赖根脚本 `pnpm -r build`：cli 与 core 的 dist 均已构建。
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

function makeEnv(): { home: string; root: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'h2-cfg-home-'));
  const root = mkdtempSync(join(tmpdir(), 'h2-cfg-root-'));
  return {
    home,
    root,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeGlobal(home: string, content: string): void {
  mkdirSync(join(home, '.harness2'), { recursive: true });
  writeFileSync(join(home, '.harness2', 'config.json'), content, 'utf8');
}
function writeProject(root: string, content: string): void {
  mkdirSync(join(root, '.harness2'), { recursive: true });
  writeFileSync(join(root, '.harness2', 'config.json'), content, 'utf8');
}
function writeAuth(home: string, content: string): void {
  mkdirSync(join(home, '.harness2'), { recursive: true });
  writeFileSync(join(home, '.harness2', 'auth.json'), content, 'utf8');
}

const GLOBAL_CONFIG = JSON.stringify({
  providers: {
    deepseek: {
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      envKey: 'DEEPSEEK_API_KEY',
      models: { 'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192 } },
    },
  },
  roles: {
    main: { channel: 'deepseek', model: 'deepseek-chat' },
    small: { channel: 'deepseek', model: 'deepseek-chat' },
  },
  approval: { mode: 'default', tools: { bash: 'ask' } },
});

function runCheck(home: string, root: string, env?: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync('node', [cliEntry, 'config', 'check', '--home', home, '--root', root], {
    encoding: 'utf8',
    env: env ?? process.env,
  });
}

describe('harness2 config check', () => {
  it('合法配置：exit 0，展示 providers/roles/approval，key 来源 auth.json，且永不打印明文 key', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(home, GLOBAL_CONFIG);
      writeAuth(home, JSON.stringify({ channels: { deepseek: { apiKey: 'test-key-visual-secret' } } }));
      const r = runCheck(home, root);
      expect(r.status).toBe(0);
      const out = r.stdout as string;
      expect(out).toContain('config OK');
      expect(out).toContain('deepseek  openai  https://api.deepseek.com/v1');
      expect(out).toContain('models: deepseek-chat');
      expect(out).toContain('main -> deepseek/deepseek-chat');
      expect(out).toContain('approval: mode=default, rules: bash=ask');
      expect(out).toContain('deepseek: auth.json');
      // 脱敏红线：明文 key 不得出现在输出
      expect(out).not.toContain('test-key-visual-secret');
    } finally {
      cleanup();
    }
  });

  it('key 来源 env:XXX（auth.json 未配置时）与 **missing**', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(home, GLOBAL_CONFIG);
      const withEnv = runCheck(home, root, { ...process.env, DEEPSEEK_API_KEY: 'env-key-fake' });
      expect(withEnv.status).toBe(0);
      expect(withEnv.stdout).toContain('deepseek: env:DEEPSEEK_API_KEY');
      expect(withEnv.stdout).not.toContain('env-key-fake');

      const missing = spawnSync('node', [cliEntry, 'config', 'check', '--home', home, '--root', root], {
        encoding: 'utf8',
        env: { ...process.env, DEEPSEEK_API_KEY: '' }, // 置空 = 未设置
      });
      expect(missing.status).toBe(0);
      expect(missing.stdout).toContain('deepseek: **missing**');
    } finally {
      cleanup();
    }
  });

  it('项目配置覆盖全局：合并结果正确展示', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(home, GLOBAL_CONFIG);
      writeProject(
        root,
        JSON.stringify({
          providers: { deepseek: { baseUrl: 'https://mirror.local/v1' } },
          approval: { mode: 'acceptEdits' },
        }),
      );
      const r = runCheck(home, root);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('https://mirror.local/v1');
      expect(r.stdout).toContain('approval: mode=acceptEdits, rules: bash=ask');
      expect(r.stdout).toContain('main -> deepseek/deepseek-chat');
    } finally {
      cleanup();
    }
  });

  it('非法配置（坏 protocol）：一行 error，exit 1，不打印报告', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(home, JSON.stringify({ providers: { x: { protocol: 'grpc', baseUrl: 'https://x' } }, roles: {} }));
      const r = runCheck(home, root);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^error: providers\.x\.protocol/);
      expect((r.stderr as string).split('\n').filter((l) => l.startsWith('error:'))).toHaveLength(1);
      expect(r.stdout).not.toContain('config OK');
    } finally {
      cleanup();
    }
  });

  it('无任何配置文件：exit 1 一行错误', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      const r = runCheck(home, root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('未找到任何配置文件');
      expect(r.stderr).not.toMatch(/\n\s+at /); // 无堆栈
    } finally {
      cleanup();
    }
  });

  it('未解析的 ${VAR}：告警展示且 exit 0', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(
        home,
        JSON.stringify({
          providers: { deepseek: { protocol: 'openai', baseUrl: '${MY_BASE}/v1' } },
          roles: { main: { channel: 'deepseek', model: 'm' } },
        }),
      );
      const r = runCheck(home, root);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('${MY_BASE}');
      expect(r.stdout).toContain('MY_BASE 未设置');
    } finally {
      cleanup();
    }
  });

  it('P2-6：baseUrl 含 ${VAR} 展开出的密钥形态值 → 输出已脱敏', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(
        home,
        JSON.stringify({
          providers: {
            deepseek: { protocol: 'openai', baseUrl: '${MY_BASE}/v1' },
          },
          roles: { main: { channel: 'deepseek', model: 'deepseek-chat' } },
        }),
      );
      const r = runCheck(home, root, { ...process.env, MY_BASE: 'https://sk-real-secret-9911.internal.example' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('deepseek  openai');
      expect(r.stdout).toContain('[REDACTED]');
      expect(r.stdout).not.toContain('sk-real-secret-9911');
    } finally {
      cleanup();
    }
  });

  it('auth.json 损坏：一行 error，exit 1', () => {
    const { home, root, cleanup } = makeEnv();
    try {
      writeGlobal(home, GLOBAL_CONFIG);
      writeAuth(home, '{broken json');
      const r = runCheck(home, root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('auth.json');
      expect(r.stderr).toMatch(/^error: auth\.json/m); // 单行 error（无堆栈）
      // P2-9：先校验后输出——不再先打 "config OK" 再 exit 1 的自相矛盾输出
      expect(r.stdout).not.toContain('config OK');
    } finally {
      cleanup();
    }
  });

  it('execFileSync 冒烟：--help 列出 config check', () => {
    const out = execFileSync('node', [cliEntry, 'config', '--help'], { encoding: 'utf8' });
    expect(out).toContain('check');
  });
});
