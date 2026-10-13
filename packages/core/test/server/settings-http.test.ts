// Z9-6a serve 设置数据端点测试：
//   - GET /api/settings/config 脱敏读（种子 config 密钥字段不出现在响应；与 GET /api/config 同源）；
//   - PUT/POST /api/settings/config 白名单深合并写回全局 config.json（合法生效并落盘；非法/密钥字段拒绝且文件不变）；
//   - GET /api/settings/auth 掩码视图（不含明文）；A2 起 PUT/POST 放开写 auth.json gateways 段（响应掩码、无明文）；
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
      // Z9-6c：完整段（断言 GET /api/settings/config 如实回读，而非 schema 缺省）
      browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: ['plugin-x'] },
      mcpServers: { echo: { command: 'node', args: ['echo.mjs'] } },
      subagent: { maxDepth: 2, maxTurns: 40 },
      hooks: { enabled: true, timeoutMs: 3000, entries: [{ event: 'turnEnd', command: 'echo done' }] },
      gateways: { qq: { enabled: true, appId: 'qq-app-id', dmPolicy: 'open' } },
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

describe('Z9-6c GET /api/settings/config（完整脱敏视图，与桌面 settings:getConfig 同形）', () => {
  it('200 返回完整 config 段（memory/browser/plugins/mcpServers/subagent/hooks/gateways 为真实读取值）', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/settings/config');
    expect(r.status).toBe(200);
    // 既有段
    expect(r.json.providers.ds.protocol).toBe('openai');
    expect(r.json.providers.ds.baseUrl).toBe('https://api.test/v1');
    expect(r.json.roles.main).toEqual({ channel: 'ds', model: 'm-1' });
    expect(r.json.approval.mode).toBe('default');
    // Z9-6c：此前缺的段现在是真实读取值（非 schema 缺省）
    expect(r.json.memory).toEqual({ mode: 'off', nudgeInterval: 10 });
    expect(r.json.browser).toEqual({ enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 });
    expect(r.json.plugins).toEqual({ enabled: true, allow: ['plugin-x'] });
    expect(r.json.mcpServers).toEqual({ echo: { command: 'node', args: ['echo.mjs'] } });
    expect(r.json.subagent).toEqual({ maxDepth: 2, maxTurns: 40 });
    expect(r.json.hooks.entries[0]).toMatchObject({ event: 'turnEnd', command: 'echo done' });
    expect(r.json.hooks.enabled).toBe(true);
    expect(r.json.gateways.qq).toMatchObject({ enabled: true, appId: 'qq-app-id', dmPolicy: 'open' });
    expect(r.json.sources).toEqual({ global: true, project: false });
    // 配置里误写的密钥值被 schema 丢弃（告警），绝不回显；auth.json 明文密钥也绝不出现
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
    expect(r.text).not.toContain(CONFIG_PLANTED_SECRET);
    expect(r.text).not.toContain('app-secret-plain');
  });

  it('既有 GET /api/config 保持原样（脱敏报告语义，不被本次改动影响）', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.report.providers[0].channel).toBe('ds');
    expect(r.json.report.providers[0].keySource).toBe('auth.json');
    // 报告语义 ≠ 完整视图语义：报告无 memory/mcpServers 等段
    expect(r.json.memory).toBeUndefined();
    expect(r.json.mcpServers).toBeUndefined();
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
  });

  it('方法不符 → 405（列出可用方法）', async () => {
    const { handle } = await start();
    const r = await api(handle, 'DELETE', '/api/settings/config');
    expect(r.status).toBe(405);
    expect(r.json.error).toContain('/api/settings/config');
  });
});

describe('Z10-2b GET/PUT /api/settings/config：roles.effort 与模型 reasoning 档位（web 思考档位数据面）', () => {
  /** 覆盖全局 config.json：模型声明 reasoning 档位 + roles.main.effort（并保留密钥哨兵字段） */
  function seedReasoningHome(home: string): void {
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
            models: {
              'm-1': { contextWindow: 128000, reasoning: { values: ['low', 'medium', 'high'], default: 'medium' } },
              'm-2': { maxOutputTokens: 4096 },
            },
            apiKey: CONFIG_PLANTED_SECRET,
          },
        },
        roles: { main: { channel: 'ds', model: 'm-1', effort: 'high' } },
      }),
      'utf8',
    );
  }

  it('GET 返回 effort 与 reasoning（与桌面 SettingsRoleShape/SettingsProviderShape 同形）；密钥不外泄', async () => {
    const { handle } = await start({ seed: seedReasoningHome });
    const r = await api(handle, 'GET', '/api/settings/config');
    expect(r.status).toBe(200);
    expect(r.json.roles.main).toEqual({ channel: 'ds', model: 'm-1', effort: 'high' });
    expect(r.json.providers.ds.models['m-1']).toEqual({
      contextWindow: 128000,
      reasoning: { values: ['low', 'medium', 'high'], default: 'medium' },
    });
    // 未声明 reasoning 的模型不出现该字段（如实，不臆造）
    expect(r.json.providers.ds.models['m-2']).toEqual({ maxOutputTokens: 4096 });
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
    expect(r.text).not.toContain(CONFIG_PLANTED_SECRET);
  });

  it('PUT roles.main.effort 走白名单深合并并落盘，响应回带新视图（写路径无需另改白名单）', async () => {
    const { handle, home } = await start({ seed: seedReasoningHome });
    const r = await api(handle, 'PUT', '/api/settings/config', {
      roles: { main: { channel: 'ds', model: 'm-1', effort: 'low' } },
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.config.roles.main.effort).toBe('low');
    const onDisk = JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8')) as {
      roles: { main: { effort: string } };
      providers: { ds: { models: Record<string, { reasoning: { values: string[] } }> } };
    };
    expect(onDisk.roles.main.effort).toBe('low');
    // 模型 reasoning 声明未被 effort 写入覆盖（深合并）
    expect(onDisk.providers.ds.models['m-1']!.reasoning.values).toEqual(['low', 'medium', 'high']);
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
    // Z9-6c：写后回读 = 完整 config 视图（approval 在顶层，非 report 内）
    expect(r.json.config.approval.mode).toBe('bypass');
    expect(r.json.config.memory).toEqual({ mode: 'off', nudgeInterval: 10 });

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

describe('GET /api/settings/auth（掩码视图）+ A2 PUT/POST 放开写网关凭据', () => {
  it('GET 200 返回 channel/gateway 掩码状态，绝不含明文', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/settings/auth');
    expect(r.status).toBe(200);
    expect(r.json.channels).toContainEqual({ channel: 'ds', masked: true });
    expect(r.json.gateways).toContainEqual({ channel: 'qq', maskedAppId: true, maskedAppSecret: true });
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
    expect(r.text).not.toContain('app-secret-plain');
    expect(r.text).not.toContain('app-id-plain');
  });

  it('A2 PUT 写网关凭据：200 落盘、响应只含掩码、回显无明文；空白字段保留原值', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'auth.json');
    const NEW_SECRET = 'gateway-new-secret-777';
    for (const method of ['PUT', 'POST'] as const) {
      const r = await api(handle, method, '/api/settings/auth', {
        gateways: { qq: { appSecret: NEW_SECRET } },
      });
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      // 响应只回掩码级信息，绝不回显明文（新旧都不出现）
      expect(r.json.auth.channels).toContainEqual({ channel: 'ds', masked: true });
      expect(r.json.auth.gateways).toContainEqual({ channel: 'qq', maskedAppId: true, maskedAppSecret: true });
      expect(r.text).not.toContain(NEW_SECRET);
      expect(r.text).not.toContain(AUTH_PLAINTEXT);
      expect(r.text).not.toContain('app-secret-plain');
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      expect(onDisk.gateways.qq.appSecret).toBe(NEW_SECRET);
      expect(onDisk.gateways.qq.appId).toBe('app-id-plain'); // 空白字段 = 保留原值
      expect(onDisk.channels.ds.apiKey).toBe(AUTH_PLAINTEXT); // channels 段不受影响
    }
  });

  it('A2 非法 patch（gateways 非对象）→ 400 可读错误，文件不被触碰', async () => {
    const { handle, home } = await start();
    const path = join(home, '.harness2', 'auth.json');
    const before = readFileSync(path, 'utf8');
    const r = await api(handle, 'PUT', '/api/settings/auth', { gateways: 'nope' });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('gateways');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('A2 null 值移除渠道；其余方法仍 405', async () => {
    const { handle, home } = await start();
    const r = await api(handle, 'POST', '/api/settings/auth', { gateways: { qq: null } });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(join(home, '.harness2', 'auth.json'), 'utf8')).gateways).toBeUndefined();
    expect((await api(handle, 'PATCH', '/api/settings/auth')).status).toBe(405);
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
