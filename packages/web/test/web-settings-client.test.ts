// Z9-6b：serve 客户端**设置端点**契约测试。
//
// 用假 fetch（记录 method/path/body/token）证明：
//   * 每个设置成员打到**正确的**端点与方法（不发明路径）；
//   * config 读载荷（core buildConfigReport 脱敏报告）被适配成共享设置页的 SettingsConfigShape；
//   * 写 config 走 PUT 且体为 patch；HTTP 失败（400/401/405/500）一律回 {ok:false,error}（分区如实报错）。
import { describe, expect, it } from 'vitest';
import { createServeClient, mapServeConfigPayload, type WebSocketLike } from '../src/serve-client.js';

const TOKEN = 'tok-settings-xyz';

interface Recorded {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}

/** 不连接的假 socket（本测试只走 HTTP 面；不触发重连定时器） */
function fakeSocket(): WebSocketLike {
  return {
    readyState: 0,
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

function clientWith(handler: (rec: Recorded) => { status: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = init?.headers as Headers | undefined;
    const rec: Recorded = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(headers?.get('x-harness2-token') !== null && headers?.get('x-harness2-token') !== undefined
        ? { token: headers.get('x-harness2-token') as string }
        : {}),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(rec);
    const { status, body } = handler(rec);
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createServeClient({
    origin: 'http://127.0.0.1:9',
    token: TOKEN,
    socketFactory: fakeSocket,
    fetchImpl,
  });
  return { client, calls };
}

// serve 读载荷（Z9-6c：完整 config 视图，与桌面 settings:getConfig 同形 —— 覆盖所有真实配置段）
const CONFIG_PAYLOAD = {
  errors: [],
  warnings: ['未知字段 x（已忽略）'],
  sources: { global: true, project: false },
  providers: {
    ds: {
      protocol: 'openai',
      baseUrl: 'https://api.test/v1',
      envKey: 'DS_KEY',
      models: {
        'm-1': { contextWindow: 128000, maxOutputTokens: 4096 },
        'm-2': { reasoning: { values: ['low', 'high'], default: 'low' } },
      },
    },
  },
  roles: { main: { channel: 'ds', model: 'm-1', effort: 'high' } },
  approval: { mode: 'bypass', tools: { write: 'ask' } },
  memory: { mode: 'ask', nudgeInterval: 30 },
  browser: { enabled: false, idleDestroyMs: 120_000, maxConcurrent: 4 },
  plugins: { enabled: true, allow: ['plugin-x'] },
  mcpServers: { echo: { command: 'node', args: ['echo.mjs'] } },
  subagent: { maxDepth: 2, maxTurns: 40 },
  hooks: {
    enabled: true,
    timeoutMs: 3000,
    maxOutputBytes: 1024,
    entries: [{ event: 'turnEnd', command: 'echo done' }],
  },
  gateways: { qq: { enabled: true, appId: 'qq-app-id' } },
};

describe('Z9-6c GET /api/settings/config → SettingsConfigShape 适配（完整段）', () => {
  it('打 GET 端点（带 token）；完整 config 段如实映射（不再回退 schema 缺省）', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, body: CONFIG_PAYLOAD }));
    const cfg = await client.getSettingsConfig();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/settings/config', token: TOKEN });

    expect(cfg.providers['ds']).toMatchObject({ protocol: 'openai', baseUrl: 'https://api.test/v1', envKey: 'DS_KEY' });
    expect(Object.keys(cfg.providers['ds']!.models!)).toEqual(['m-1', 'm-2']);
    expect(cfg.providers['ds']!.models!['m-1']).toEqual({ contextWindow: 128000, maxOutputTokens: 4096 });
    // Z10-2b：模型 reasoning 档位声明与 roles.effort 如实保留（web 思考档位的数据面）
    expect(cfg.providers['ds']!.models!['m-2']).toEqual({ reasoning: { values: ['low', 'high'], default: 'low' } });
    expect(cfg.roles['main']).toEqual({ channel: 'ds', model: 'm-1', effort: 'high' });
    expect(cfg.approval).toEqual({ mode: 'bypass', tools: { write: 'ask' } });
    // Z9-6c：此前缺的段现在是真实读取值（非缺省占位）
    expect(cfg.memory).toEqual({ mode: 'ask', nudgeInterval: 30 });
    expect(cfg.browser).toEqual({ enabled: false, idleDestroyMs: 120_000, maxConcurrent: 4 });
    expect(cfg.plugins).toEqual({ enabled: true, allow: ['plugin-x'] });
    expect(cfg.mcpServers).toEqual({ echo: { command: 'node', args: ['echo.mjs'] } });
    expect(cfg.subagent).toEqual({ maxDepth: 2, maxTurns: 40 });
    expect(cfg.hooks).toEqual({
      enabled: true,
      timeoutMs: 3000,
      maxOutputBytes: 1024,
      entries: [{ event: 'turnEnd', command: 'echo done' }],
    });
    expect(cfg.gateways).toEqual({ qq: { enabled: true, appId: 'qq-app-id' } });
    expect(cfg.sources).toEqual({ global: true, project: false });
    expect(cfg.warnings).toEqual(['未知字段 x（已忽略）']);
    expect(cfg.errors).toEqual([]);
  });

  it('读失败（500/401）→ 如实抛出可读错误（不返回假空配置）', async () => {
    for (const status of [500, 401] as const) {
      const { client } = clientWith(() => ({ status, body: { error: `HTTP 就绪失败 ${status}` } }));
      await expect(client.getSettingsConfig()).rejects.toThrow(new RegExp(`HTTP 就绪失败 ${status}`));
    }
  });

  it('plain 函数：无任何段 → 空 providers/roles + 各段 schema 缺省 + errors 如实', () => {
    const cfg = mapServeConfigPayload({ errors: ['config 解析失败'], warnings: [] });
    expect(cfg.providers).toEqual({});
    expect(cfg.roles).toEqual({});
    expect(cfg.approval).toEqual({ mode: 'default' });
    expect(cfg.memory).toEqual({ mode: 'off', nudgeInterval: 10 });
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.gateways).toBeUndefined();
    expect(cfg.hooks).toBeUndefined();
    expect(cfg.errors).toEqual(['config 解析失败']);
  });

  it('plain 函数：载荷无 gateways/hooks 段 → 不臆造该键', () => {
    const cfg = mapServeConfigPayload({ providers: {}, roles: {}, approval: { mode: 'default' } });
    expect(cfg.gateways).toBeUndefined();
    expect(cfg.hooks).toBeUndefined();
  });
});

describe('Z9-6c PUT /api/settings/config → 写白名单 patch', () => {
  it('成功：PUT + 体为 patch；返回 ok + 适配后的最新 config', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: { ok: true, warnings: [], config: CONFIG_PAYLOAD },
    }));
    const patch = { approval: { mode: 'bypass' } };
    const res = await client.updateSettingsConfig(patch);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/settings/config', body: patch });
    expect(res.ok).toBe(true);
    expect(res.config?.approval.mode).toBe('bypass');
    expect(res.warnings).toEqual([]);
  });

  // Z9-6c：新放开分区（memory）的写路径——method/path/body 逐一断言
  it('新放开分区写路径：memory patch 打 PUT /api/settings/config，体为 patch', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: { ok: true, warnings: [], config: CONFIG_PAYLOAD },
    }));
    const patch = { memory: { mode: 'ask', nudgeInterval: 45 } };
    const res = await client.updateSettingsConfig(patch);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/settings/config', token: TOKEN, body: patch });
    expect(res.ok).toBe(true);
    expect(res.config?.memory).toEqual({ mode: 'ask', nudgeInterval: 30 });
  });

  it('失败（400 白名单/500/405）→ {ok:false, error: 可读}，绝不假装成功', async () => {
    const cases: Array<[number, string]> = [
      [400, '不允许的配置字段 notAllowed'],
      [500, '内部错误'],
      [405, '方法 PUT 不被支持'],
    ];
    for (const [status, msg] of cases) {
      const { client } = clientWith(() => ({ status, body: { error: msg } }));
      const res = await client.updateSettingsConfig({ approval: { mode: 'default' } });
      expect(res.ok).toBe(false);
      expect(res.error).toContain(msg);
      expect(res.config).toBeUndefined();
    }
  });
});

describe('Z9-6b auth / doctor / skills / crash-reports 端点', () => {
  it('各打对应 GET 端点并原样映射返回', async () => {
    const auth = { channels: [{ channel: 'ds', masked: true }], gateways: [] };
    const doctor = { checks: [{ id: 'node', status: 'ok', summary: 'OK' }], exitCode: 0 };
    const skills = { skills: [], warnings: [], roots: { project: '/p', global: '/g' } };
    const crashes = [{ fileName: 'a.log', mtime: '2020-01-01T00:00:00.000Z', size: 3 }];
    const bodies: Record<string, unknown> = {
      '/api/settings/auth': auth,
      '/api/settings/doctor': doctor,
      '/api/settings/skills': skills,
      '/api/settings/crash-reports': crashes,
    };
    const { client, calls } = clientWith((rec) => ({ status: 200, body: bodies[rec.path] }));

    expect(await client.getSettingsAuthMasked()).toEqual(auth);
    expect(await client.getSettingsDoctor()).toEqual(doctor);
    expect(await client.getSettingsSkills()).toEqual(skills);
    expect(await client.getSettingsCrashReports()).toEqual(crashes);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/settings/auth',
      '/api/settings/doctor',
      '/api/settings/skills',
      '/api/settings/crash-reports',
    ]);
  });
});

describe('A2 模型通道面 + auth 写（method/path/body 逐一对齐 serve 路由）', () => {
  it('settingsGetModels → GET /api/settings/models（文档原样映射）', async () => {
    const doc = {
      revision: '0123456789abcdef',
      providers: [],
      declarationAckVersion: 0,
      sources: { global: false, project: false },
      warnings: [],
      errors: [],
    };
    const { client, calls } = clientWith(() => ({ status: 200, body: doc }));
    expect(await client.settingsGetModels()).toEqual(doc);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/settings/models', token: TOKEN });
  });

  it('settingsUpdateModels → PUT /api/settings/models，体含 revision/provider/originalId/mainModel', async () => {
    const result = { ok: true, document: { revision: 'ffffffffffffffff' } };
    const { client, calls } = clientWith(() => ({ status: 200, body: result }));
    const provider = { id: 'new-oai', displayName: '新网关', protocol: 'openai' as const, baseUrl: 'u', models: [] };
    const res = await client.settingsUpdateModels({
      revision: '0123456789abcdef',
      provider,
      originalId: 'old',
      mainModel: 'm-1',
    });
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/api/settings/models',
      body: { revision: '0123456789abcdef', provider, originalId: 'old', mainModel: 'm-1' },
    });
    expect(res).toEqual(result);
  });

  it('settingsDeleteProvider → DELETE /api/settings/models，体含 route/confirmRoute', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, body: { ok: true } }));
    await client.settingsDeleteProvider('temp', 'temp');
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      path: '/api/settings/models',
      body: { route: 'temp', confirmRoute: 'temp' },
    });
  });

  it('settingsWriteChannelKey → PUT /api/settings/models/credential；请求带 key，响应无明文', async () => {
    const PLAINTEXT = 'sk-client-channel-secret-246810';
    const { client, calls } = clientWith(() => ({ status: 200, body: { ok: true, reference: 'CH1_API_KEY' } }));
    const res = await client.settingsWriteChannelKey('ch1', PLAINTEXT);
    // 请求体必须携带密钥（写 auth.json 的唯一入口）
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/settings/models/credential' });
    expect(calls[0]?.body).toEqual({ route: 'ch1', key: PLAINTEXT });
    // 响应只回具名引用：回显里没有明文 key
    expect(res).toEqual({ ok: true, reference: 'CH1_API_KEY' });
    expect(JSON.stringify(res)).not.toContain(PLAINTEXT);
  });

  it('settingsGetCredentialStatus → POST /api/settings/models/credential-status，体含 routes', async () => {
    const statuses = { ds: { state: 'confirmed', source: 'auth.json', reference: 'DS_KEY' } };
    const { client, calls } = clientWith(() => ({ status: 200, body: statuses }));
    expect(await client.settingsGetCredentialStatus(['ds'])).toEqual(statuses);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/settings/models/credential-status',
      body: { routes: ['ds'] },
    });
  });

  it('settingsAckModelsDeclaration → POST /api/settings/models/ack-declaration，体含 version', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, body: { ok: true, declarationAckVersion: 1 } }));
    expect(await client.settingsAckModelsDeclaration(1)).toEqual({ ok: true, declarationAckVersion: 1 });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/settings/models/ack-declaration',
      body: { version: 1 },
    });
  });

  it('settingsDiscoverModels → POST /api/settings/models/discover，体含 route/baseUrl/protocol', async () => {
    const models = { ok: true, models: [{ id: 'm-1', displayName: 'M1' }] };
    const { client, calls } = clientWith(() => ({ status: 200, body: models }));
    const res = await client.settingsDiscoverModels({
      route: 'ds',
      baseUrl: 'https://api.test/v1',
      protocol: 'openai',
    });
    expect(res).toEqual(models);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/settings/models/discover',
      body: { route: 'ds', baseUrl: 'https://api.test/v1', protocol: 'openai' },
    });
  });

  it('模型写失败（409 冲突 / 400 校验）→ 原样回结果对象（含 code/field），不抛错不假装成功', async () => {
    const conflict = { ok: false, code: 'settings/conflict', error: 'revision 不一致' };
    const { client } = clientWith(() => ({ status: 409, body: conflict }));
    expect(await client.settingsUpdateModels({ revision: 'r', provider: {} as never })).toEqual(conflict);

    const invalid = { ok: false, code: 'validation', field: 'key', error: '密钥非法' };
    const c2 = clientWith(() => ({ status: 400, body: invalid }));
    expect(await c2.client.settingsWriteChannelKey('ch1', 'sk-a b')).toEqual(invalid);
  });

  it('updateSettingsAuth → PUT /api/settings/auth，体为 patch；成功 ok、400 回可读错误', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: { ok: true, auth: { channels: [], gateways: [] } },
    }));
    const patch = { gateways: { qq: { appSecret: 's' } } };
    expect(await client.updateSettingsAuth(patch)).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/settings/auth', body: patch });

    const bad = clientWith(() => ({ status: 400, body: { ok: false, error: 'gateways 必须是对象' } }));
    const res = await bad.client.updateSettingsAuth({ gateways: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('gateways');
  });
});
