// Z9-6a serve 设置数据端点测试：
//   - GET /api/settings/config 脱敏读（种子 config 密钥字段不出现在响应；与 GET /api/config 同源）；
//   - PUT/POST /api/settings/config 白名单深合并写回全局 config.json（合法生效并落盘；非法/密钥字段拒绝且文件不变）；
//   - GET /api/settings/auth 掩码视图（不含明文）；写 auth → 405（网页端不开放凭据写）；
//   - GET /api/settings/doctor / skills / crash-reports 结构断言（真实调用 core runDoctor/SkillStore/crash 目录）；
//   - 鉴权：严格模式无 token → 401（沿既有门禁）。
// 全部本地临时目录 + startServe（127.0.0.1 随机端口），无网络。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeHandle } from '../../src/server/http.js';
import { MockProvider } from '../../src/provider/mock.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 种子明文密钥（断言绝不回显的哨兵值） */
const AUTH_PLAINTEXT = 'sk-plain-secret-987654';
/** 种在 config 里（非法字段，schema 会告警丢弃）的密钥值——也绝不应回显 */
const CONFIG_PLANTED_SECRET = 'sk-planted-config-secret-abc';

/** 在 home 下写全局 config.json + auth.json（合法最小配置 + 明文密钥哨兵） */
function seedHome(home: string): void {
  const cfgDir = join(home, '.harness2');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        ds: {
          protocol: 'openai',
          baseUrl: 'https://api.test/v1',
          envKey: 'DS_KEY',
          models: { 'm-1': { contextWindow: 128000, maxOutputTokens: 4096 } },
          // 迁移哨兵：config 不该持有密钥值；schema 应告警并丢弃
          apiKey: CONFIG_PLANTED_SECRET,
        },
      },
      roles: { main: { channel: 'ds', model: 'm-1' } },
      approval: { mode: 'default', tools: { write: 'ask' } },
      memory: { mode: 'off', nudgeInterval: 10 },
    }),
    'utf8',
  );
  writeFileSync(
    join(cfgDir, 'auth.json'),
    JSON.stringify({
      channels: { ds: { apiKey: AUTH_PLAINTEXT } },
      gateways: { qq: { appId: 'app-id-plain', appSecret: 'app-secret-plain' } },
    }),
    'utf8',
  );
}

/** 在 home 下建一个崩溃报告文件（core 自有目录 ~/.harness2/crash） */
function seedCrashReport(home: string): void {
  const dir = join(home, '.harness2', 'crash');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2020-01-01T00-00-00-000Z.log'), 'version: 1.0.0\n', 'utf8');
}

/** 在 root 下建一个项目级技能（文件夹型） */
function seedProjectSkill(root: string): void {
  const dir = join(root, '.harness2', 'skills', 'my-test-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    ['---', 'name: my-test-skill', 'description: 测试用技能（Z9-6a）', '---', '', '正文内容。', ''].join('\n'),
    'utf8',
  );
}

async function start(
  opts: { requireToken?: boolean; seed?: (home: string) => void } = {},
): Promise<{ handle: ServeHandle; home: string; root: string }> {
  const home = tmpDir('h2-set-home-');
  const root = tmpDir('h2-set-root-');
  seedHome(home);
  opts.seed?.(home);
  const handle = await startServe({
    port: 0,
    home,
    root,
    provider: new MockProvider([{ text: '回复。' }]),
    token: 'settings-http-token-0123456789',
    requireToken: opts.requireToken ?? false,
  });
  handles.push(handle);
  return { handle, home, root };
}

interface ApiResult {
  status: number;
  json: any;
  text: string;
}

async function api(handle: ServeHandle, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null, text };
}

describe('Z9-6a GET /api/settings/config（脱敏读，复用 buildConfigPayload）', () => {
  it('200 返回脱敏报告；种子明文密钥绝不出现；与 GET /api/config 同源一致', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/settings/config');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.report.providers[0].channel).toBe('ds');
    // 密钥只以来源标签出现
    expect(r.json.report.providers[0].keySource).toBe('auth.json');
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
    expect(r.text).not.toContain(CONFIG_PLANTED_SECRET);
    expect(r.text).not.toContain('app-secret-plain');
    // 单一读取语义：与既有 /api/config 逐字一致
    const base = await api(handle, 'GET', '/api/config');
    expect(base.status).toBe(200);
    expect(r.json).toEqual(base.json);
  });

  it('方法不符 → 405（列出可用方法）', async () => {
    const { handle } = await start();
    const r = await api(handle, 'DELETE', '/api/settings/config');
    expect(r.status).toBe(405);
    expect(r.json.error).toContain('/api/settings/config');
  });
});

describe('Z9-6a PUT/POST /api/settings/config（白名单深合并写回）', () => {
  it('合法 patch 生效并落盘；响应回读与 GET 同源', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'config.json');
    const before = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

    const r = await api(handle, 'PUT', '/api/settings/config', { approval: { mode: 'bypass' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.config.report.approval.mode).toBe('bypass');

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    expect(after.approval.mode).toBe('bypass');
    // 既有字段深合并保留（providers/roles 未被 patch 覆盖）
    expect(after.providers.ds.baseUrl).toBe(before.providers.ds.baseUrl);
    expect(after.roles.main.model).toBe('m-1');
  });

  it('POST 亦被接受（等价写）', async () => {
    const { handle, home } = await start();
    const r = await api(handle, 'POST', '/api/settings/config', { memory: { nudgeInterval: 25 } });
    expect(r.status).toBe(200);
    const after = JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8')) as Record<string, any>;
    expect(after.memory.nudgeInterval).toBe(25);
    // 未 patch 的 memory.mode 保持种子值
    expect(after.memory.mode).toBe('off');
  });

  it('白名单外顶层字段 → 400，文件不变', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'config.json');
    const before = readFileSync(path, 'utf8');
    const r = await api(handle, 'PUT', '/api/settings/config', { notAllowed: true });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('notAllowed');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('含密钥字段（递归）→ 400，文件不变，且错误不回显值', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'config.json');
    const before = readFileSync(path, 'utf8');
    const r = await api(handle, 'PUT', '/api/settings/config', {
      providers: { ds: { apiKey: 'sk-this-must-not-be-echoed-123456' } },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('密钥');
    expect(r.text).not.toContain('sk-this-must-not-be-echoed-123456');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('非对象 patch（数组）→ 400', async () => {
    const { handle } = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it('全局 config.json 损坏（JSONC 半截）→ 400 拒绝写入，不静默覆盖', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'config.json');
    writeFileSync(path, '{ "providers": { ', 'utf8');
    const r = await api(handle, 'PUT', '/api/settings/config', { approval: { mode: 'bypass' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('无法解析');
    expect(readFileSync(path, 'utf8')).toBe('{ "providers": { ');
  });
});

describe('Z9-6a GET /api/settings/auth（掩码视图；写不开放）', () => {
  it('200 返回 channel/gateway 掩码状态，绝不含明文', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/settings/auth');
    expect(r.status).toBe(200);
    expect(r.json.channels).toContainEqual({ channel: 'ds', masked: true });
    expect(r.json.gateways).toContainEqual({ channel: 'qq', maskedAppId: true, maskedAppSecret: true });
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
    expect(r.text).not.toContain('app-secret-plain');
    expect(r.text).not.toContain('app-id-plain');
  });

  it('写凭据（PUT/POST）→ 405 并说明网页端不开放', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'auth.json');
    const before = readFileSync(path, 'utf8');
    for (const method of ['PUT', 'POST']) {
      const r = await api(handle, method, '/api/settings/auth', { gateways: { qq: { appSecret: 'x' } } });
      expect(r.status).toBe(405);
      expect(r.json.error).toContain('auth.json');
      expect(r.text).not.toContain(AUTH_PLAINTEXT);
    }
    expect(readFileSync(path, 'utf8')).toBe(before); // 凭据文件未被触碰
  });
});

describe('Z9-6a 诊断 / 技能 / 崩溃报告', () => {
  it('GET /api/settings/doctor 复用 runDoctor：含六项以上检查与 exitCode', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/settings/doctor');
    expect(r.status).toBe(200);
    expect([0, 1]).toContain(r.json.exitCode);
    const ids = r.json.checks.map((c: { id: string }) => c.id);
    for (const id of ['node', 'config', 'home', 'bash', 'mcp', 'sessions', 'skills']) {
      expect(ids).toContain(id);
    }
    expect(r.json.checks.length).toBeGreaterThanOrEqual(6);
  });

  it('GET /api/settings/skills 复用 SkillStore 两级扫描：命中项目技能', async () => {
    const { handle, root } = await start();
    seedProjectSkill(root);
    const r = await api(handle, 'GET', '/api/settings/skills');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.skills)).toBe(true);
    expect(Array.isArray(r.json.warnings)).toBe(true);
    expect(r.json.roots.project).toBe(join(root, '.harness2', 'skills'));
    const mine = r.json.skills.find((s: { name: string }) => s.name === 'my-test-skill');
    expect(mine).toBeDefined();
    expect(mine.source).toBe('project');
    expect(mine.description).toContain('测试用技能');
  });

  it('GET /api/settings/crash-reports 读 core 崩溃目录：命中文件；其余方法 405', async () => {
    const { handle } = await start({ seed: (home) => seedCrashReport(home) });
    const r = await api(handle, 'GET', '/api/settings/crash-reports');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    const hit = r.json.find((e: { fileName: string }) => e.fileName === '2020-01-01T00-00-00-000Z.log');
    expect(hit).toBeDefined();
    expect(typeof hit.mtime).toBe('string');
    expect(hit.size).toBeGreaterThan(0);

    expect((await api(handle, 'PUT', '/api/settings/crash-reports')).status).toBe(405);
  });
});

describe('Z9-6a 鉴权（沿既有门禁）', () => {
  it('严格模式无 token → 401；带 token → 200', async () => {
    const { handle } = await start({ requireToken: true });
    const url = `http://127.0.0.1:${handle.port}/api/settings/config`;
    const noToken = await fetch(url);
    expect(noToken.status).toBe(401);
    const withToken = await fetch(url, { headers: { 'x-harness2-token': handle.token } });
    expect(withToken.status).toBe(200);
    expect(handle.security.noTokenRejected).toBe(1);
  });
});
