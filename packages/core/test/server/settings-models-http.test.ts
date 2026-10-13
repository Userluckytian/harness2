// A1：serve 模型配置路由测试（GET/PUT/DELETE /api/settings/models · PUT credential · POST discover）。
// 全部本地临时目录 + startServe（127.0.0.1 随机端口）；discover 走本地 stub HTTP 服务（无外部网络）。
// 密钥红线断言：任何响应体都不含明文密钥；凭据只落 auth.json。
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeHandle } from '../../src/server/http.js';
import { MockProvider } from '../../src/provider/mock.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
const stubServers: Server[] = [];

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const s of stubServers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AUTH_PLAINTEXT = 'sk-models-route-secret-987654';
const NEW_KEY = 'sk-new-channel-secret-123456';

function seedHome(home: string): void {
  const cfgDir = join(home, '.harness2');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: { ds: { protocol: 'openai', baseUrl: 'https://api.test/v1', envKey: 'DS_KEY' } },
      roles: { main: { channel: 'ds', model: 'm-1' } },
    }),
    'utf8',
  );
  writeFileSync(join(cfgDir, 'auth.json'), JSON.stringify({ channels: { ds: { apiKey: AUTH_PLAINTEXT } } }), 'utf8');
}

async function start(): Promise<{ handle: ServeHandle; home: string; root: string }> {
  const home = tmpDir('h2-mdl-home-');
  const root = tmpDir('h2-mdl-root-');
  seedHome(home);
  const handle = await startServe({
    port: 0,
    home,
    root,
    provider: new MockProvider([{ text: '回复。' }]),
    token: 'models-http-token-0123456789',
    requireToken: false,
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

/** 本地 stub：任何路径都回 openai 兼容模型列表 */
async function startStubServer(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stub-model-1', display_name: 'Stub One' }, { id: 'stub-model-2' }] }));
  });
  stubServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as { port: number }).port;
}

describe('A1 GET /api/settings/models（分层视图；密钥回状态不回显）', () => {
  it('200 返回与桌面 readModelsDocument 同形的文档；credential 只回状态；无明文', async () => {
    const { handle } = await start();
    const r = await api(handle, 'GET', '/api/settings/models');
    expect(r.status).toBe(200);
    expect(r.json.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(r.json.sources).toEqual({ global: true, project: false });
    const ds = r.json.providers.find((p: { id: string }) => p.id === 'ds');
    expect(ds.layers).toEqual(['user']);
    expect(ds.deletable).toBe(true);
    expect(ds.credential).toEqual({ state: 'confirmed', source: 'auth.json', reference: 'DS_KEY' });
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
  });

  it('方法不符 → 405；严格模式无 token → 401', async () => {
    const { handle } = await start();
    expect((await api(handle, 'PATCH', '/api/settings/models')).status).toBe(405);
    const strict = await startServe({
      port: 0,
      home: tmpDir('h2-mdl-h2-'),
      root: tmpDir('h2-mdl-r2-'),
      provider: new MockProvider([{ text: 'x' }]),
      token: 'strict-models-token',
      requireToken: true,
    });
    handles.push(strict);
    const noToken = await fetch(`http://127.0.0.1:${strict.port}/api/settings/models`);
    expect(noToken.status).toBe(401);
  });
});

describe('A1 PUT / DELETE /api/settings/models（写后回读；密钥不回显）', () => {
  it('PUT 新增 provider：落盘 config（只有 envKey 名），回读含新行；无明文', async () => {
    const { handle, home } = await start();
    const doc = (await api(handle, 'GET', '/api/settings/models')).json;
    const r = await api(handle, 'PUT', '/api/settings/models', {
      revision: doc.revision,
      provider: {
        id: 'new-oai',
        displayName: '新网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:40080/v1',
        models: [{ id: 'big-pickle', contextWindow: 200000 }],
      },
      mainModel: 'big-pickle',
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.document.providers.find((p: { id: string }) => p.id === 'new-oai').apiKeyRef).toBe('NEW_OAI_API_KEY');
    const cfgText = readFileSync(join(home, '.harness2', 'config.json'), 'utf8');
    expect(cfgText).toContain('"envKey": "NEW_OAI_API_KEY"');
    expect(cfgText).not.toContain('apiKey');
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
  });

  it('PUT 旧 revision → 409 settings/conflict，不落盘', async () => {
    const { handle, home } = await start();
    const stale = (await api(handle, 'GET', '/api/settings/models')).json.revision;
    await api(handle, 'PUT', '/api/settings/models', {
      revision: stale,
      provider: { id: 'x', displayName: 'X', protocol: 'openai', baseUrl: 'https://x.test/v1', models: [] },
    });
    const r = await api(handle, 'PUT', '/api/settings/models', {
      revision: stale,
      provider: { id: 'y', displayName: 'Y', protocol: 'openai', baseUrl: 'https://y.test/v1', models: [] },
    });
    expect(r.status).toBe(409);
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe('settings/conflict');
    expect(readFileSync(join(home, '.harness2', 'config.json'), 'utf8')).not.toContain('"y"');
  });

  it('DELETE 确认名不一致 → 400 validation；一致 → 200 且行消失', async () => {
    const { handle } = await start();
    const doc = (await api(handle, 'GET', '/api/settings/models')).json;
    await api(handle, 'PUT', '/api/settings/models', {
      revision: doc.revision,
      provider: { id: 'temp', displayName: 'T', protocol: 'openai', baseUrl: 'https://t.test/v1', models: [] },
    });
    const bad = await api(handle, 'DELETE', '/api/settings/models', { route: 'temp', confirmRoute: 'other' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('validation');
    const ok = await api(handle, 'DELETE', '/api/settings/models', { route: 'temp', confirmRoute: 'temp' });
    expect(ok.status).toBe(200);
    expect(ok.json.document.providers.find((p: { id: string }) => p.id === 'temp')).toBeUndefined();
  });
});

describe('A1 PUT /api/settings/models/credential（只写；响应/不写日志）', () => {
  it('写渠道密钥：只回具名引用；auth.json 落明文，响应与文档均无明文', async () => {
    const { handle, home } = await start();
    await api(handle, 'PUT', '/api/settings/models', {
      revision: (await api(handle, 'GET', '/api/settings/models')).json.revision,
      provider: { id: 'ch1', displayName: 'C1', protocol: 'openai', baseUrl: 'https://c.test/v1', models: [] },
    });
    const r = await api(handle, 'PUT', '/api/settings/models/credential', { route: 'ch1', key: NEW_KEY });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, reference: 'CH1_API_KEY' });
    expect(r.text).not.toContain(NEW_KEY);
    expect(readFileSync(join(home, '.harness2', 'auth.json'), 'utf8')).toContain(NEW_KEY);
    const docText = (await api(handle, 'GET', '/api/settings/models')).text;
    expect(docText).not.toContain(NEW_KEY);
  });

  it('非法密钥 → 400 validation，且不写 auth.json', async () => {
    const { handle, home } = await start();
    const before = readFileSync(join(home, '.harness2', 'auth.json'), 'utf8');
    const r = await api(handle, 'PUT', '/api/settings/models/credential', { route: 'ch1', key: 'sk-a b' });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe('key');
    expect(readFileSync(join(home, '.harness2', 'auth.json'), 'utf8')).toBe(before);
  });

  it('GET credential → 405', async () => {
    const { handle } = await start();
    expect((await api(handle, 'GET', '/api/settings/models/credential')).status).toBe(405);
  });
});

describe('A1 POST /api/settings/models/discover（代理发现；失败如实回错误）', () => {
  it('成功：命中本地 stub，返回解析后的模型行（含显示名回退 id），不含明文密钥', async () => {
    const { handle } = await start();
    const port = await startStubServer();
    const r = await api(handle, 'POST', '/api/settings/models/discover', {
      channel: 'ds',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: 'openai',
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.models).toEqual([
      { id: 'stub-model-1', displayName: 'Stub One' },
      { id: 'stub-model-2', displayName: 'stub-model-2' },
    ]);
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
  });

  it('无凭据渠道 / 非法端点：400 且 ok=false（不冒充成功）', async () => {
    const { handle } = await start();
    const noKey = await api(handle, 'POST', '/api/settings/models/discover', {
      channel: 'nope',
      baseUrl: 'https://a.test/v1',
      protocol: 'openai',
    });
    expect(noKey.status).toBe(400);
    expect(noKey.json.ok).toBe(false);
    expect(noKey.json.error).toContain('API 密钥');
    const badUrl = await api(handle, 'POST', '/api/settings/models/discover', {
      channel: 'ds',
      baseUrl: 'not a url',
      protocol: 'openai',
    });
    expect(badUrl.status).toBe(400);
    expect(badUrl.json.ok).toBe(false);
  });

  it('GET → 405', async () => {
    const { handle } = await start();
    expect((await api(handle, 'GET', '/api/settings/models/discover')).status).toBe(405);
  });
});

describe('A2 POST /api/settings/models/credential-status（凭据确认；只回状态无明文）', () => {
  it('200 回 routes 的确认状态（含具名引用），无明文；GET → 405', async () => {
    const { handle } = await start();
    const r = await api(handle, 'POST', '/api/settings/models/credential-status', { routes: ['ds', 'nope'] });
    expect(r.status).toBe(200);
    expect(r.json.ds).toEqual({ state: 'confirmed', source: 'auth.json', reference: 'DS_KEY' });
    expect(r.json.nope.state).toBe('unknown');
    expect(r.text).not.toContain(AUTH_PLAINTEXT);
    expect((await api(handle, 'GET', '/api/settings/models/credential-status')).status).toBe(405);
  });
});

describe('A2 POST /api/settings/models/ack-declaration（首运行声明确认；版本化落盘）', () => {
  it('合法版本 → 200 ok + declarationAckVersion 递增；写后文档 ack 版本同步', async () => {
    const { handle } = await start();
    const r = await api(handle, 'POST', '/api/settings/models/ack-declaration', { version: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, declarationAckVersion: 1 });
    expect((await api(handle, 'GET', '/api/settings/models')).json.declarationAckVersion).toBe(1);
  });

  it('非法版本 → 400 ok=false（不冒充成功）；GET → 405', async () => {
    const { handle } = await start();
    const bad = await api(handle, 'POST', '/api/settings/models/ack-declaration', { version: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.json.ok).toBe(false);
    expect((await api(handle, 'GET', '/api/settings/models/ack-declaration')).status).toBe(405);
  });
});
