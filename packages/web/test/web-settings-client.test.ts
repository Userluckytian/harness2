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

const CONFIG_PAYLOAD = {
  ok: true,
  errors: [],
  warnings: ['未知字段 x（已忽略）'],
  sources: { global: true, project: false },
  report: {
    providers: [
      {
        channel: 'ds',
        protocol: 'openai',
        baseUrl: 'https://api.test/v1',
        envKey: 'DS_KEY',
        models: ['m-1', 'm-2'],
        keySource: 'auth.json',
      },
    ],
    roles: [{ role: 'main', channel: 'ds', model: 'm-1' }],
    approval: { mode: 'bypass', tools: { write: 'ask' } },
  },
};

describe('Z9-6b GET /api/settings/config → SettingsConfigShape 适配', () => {
  it('打 GET 端点（带 token），脱敏报告映射为 providers/roles/approval + 来源/告警', async () => {
    const { client, calls } = clientWith(() => ({ status: 200, body: CONFIG_PAYLOAD }));
    const cfg = await client.getSettingsConfig();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/settings/config', token: TOKEN });

    expect(cfg.providers['ds']).toMatchObject({ protocol: 'openai', baseUrl: 'https://api.test/v1', envKey: 'DS_KEY' });
    expect(Object.keys(cfg.providers['ds']!.models!)).toEqual(['m-1', 'm-2']); // 只给 id，不臆造容量
    expect(cfg.roles['main']).toEqual({ channel: 'ds', model: 'm-1' });
    expect(cfg.approval).toEqual({ mode: 'bypass', tools: { write: 'ask' } });
    expect(cfg.sources).toEqual({ global: true, project: false });
    expect(cfg.warnings).toEqual(['未知字段 x（已忽略）']);
    expect(cfg.errors).toEqual([]);
    // serve 读载荷不含 gateways 段 → 适配结果不臆造该键
    expect(cfg.gateways).toBeUndefined();
  });

  it('读失败（500/401）→ 如实抛出可读错误（不返回假空配置）', async () => {
    for (const status of [500, 401] as const) {
      const { client } = clientWith(() => ({ status, body: { error: `HTTP 就绪失败 ${status}` } }));
      await expect(client.getSettingsConfig()).rejects.toThrow(new RegExp(`HTTP 就绪失败 ${status}`));
    }
  });

  it('plain 函数：ok=false（无 report）→ 空 providers/roles + approval 缺省 + errors 如实', () => {
    const cfg = mapServeConfigPayload({ ok: false, errors: ['config 解析失败'], warnings: [] });
    expect(cfg.providers).toEqual({});
    expect(cfg.roles).toEqual({});
    expect(cfg.approval).toEqual({ mode: 'default' });
    expect(cfg.errors).toEqual(['config 解析失败']);
  });
});

describe('Z9-6b PUT /api/settings/config → 写白名单 patch', () => {
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
