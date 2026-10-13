// A1：模型配置文档读写（已下沉 core，源桌面 `models-config.ts`）单测。
// 覆盖：分层合并读视图（层归属/可删性/凭据三态）· 写/删 provider（落盘 + 回读 + revision 并发）·
// 渠道密钥只写（响应/日志绝不回显明文）· 校验归一（四类拒绝，与桌面同口径）·
// 发现模型（注入假 fetch：URL/鉴权头构造、错误如实、不臆造模型）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODELS_OVERLAY_FILE,
  ackModelsDeclaration,
  deleteModelsProvider,
  deriveApiKeyRef,
  discoverModelsFor,
  normalizeProviderInput,
  readCredentialStatuses,
  readModelsDocument,
  updateModelsProvider,
  validateApiKeyInput,
  validateProviderInput,
  writeChannelKey,
} from '../../src/settings/models-document.js';
import type { ModelsProviderInputShape } from '../../src/settings/models-document.js';
import { discoverProviderModels } from '../../src/provider/discover.js';
import type { HarnessConfig } from '../../src/config/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const HARNESS_DIR = '.harness2';
const KEY_VALUE = 'sk-fixture-secret-abcdef123456';

function writeConfig(home: string, raw: unknown): void {
  mkdirSync(join(home, HARNESS_DIR), { recursive: true });
  writeFileSync(join(home, HARNESS_DIR, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function writeProjectConfig(root: string, raw: unknown): void {
  mkdirSync(join(root, HARNESS_DIR), { recursive: true });
  writeFileSync(join(root, HARNESS_DIR, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function writeAuth(home: string, raw: unknown): void {
  mkdirSync(join(home, HARNESS_DIR), { recursive: true });
  writeFileSync(join(home, HARNESS_DIR, 'auth.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function configText(home: string): string {
  return readFileSync(join(home, HARNESS_DIR, 'config.json'), 'utf8');
}

function overlayText(home: string): string {
  const p = join(home, HARNESS_DIR, MODELS_OVERLAY_FILE);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function providerInput(over: Partial<ModelsProviderInputShape> = {}): ModelsProviderInputShape {
  return {
    id: 'local-oai',
    displayName: '本地统一网关',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:40080/v1',
    models: [{ id: 'big-pickle', contextWindow: 200000, maxOutputTokens: 2048 }],
    ...over,
  };
}

describe('A1 校验归一（与桌面 D-57/D-85 同口径）', () => {
  it('API 密钥：非可打印 ASCII / NAME=value / 成对引号 拒绝；base64 padding 放行', () => {
    expect(validateApiKeyInput('sk-abc def').ok).toBe(false);
    expect(validateApiKeyInput('  ').ok).toBe(false);
    expect(validateApiKeyInput(123).ok).toBe(false);
    expect(validateApiKeyInput('NAME=value').ok).toBe(false);
    expect(validateApiKeyInput('"sk-abc"').ok).toBe(false);
    expect(validateApiKeyInput('ABCD==')).toEqual({ ok: true, value: 'ABCD==' });
    expect(validateApiKeyInput('  sk-abcDEF0123  ').value).toBe('sk-abcDEF0123');
  });

  it('提供方：空 id / 重复 id / 空显示名 / 非正整容量 / 端点语法 / 协议非法 都拒绝', () => {
    const ctx = { existingIds: ['local-oai'] };
    expect(validateProviderInput(providerInput({ id: '   ' }), ctx).map((i) => i.field)).toContain('id');
    expect(
      validateProviderInput(providerInput(), ctx)
        .map((i) => i.message)
        .join(),
    ).toContain('已存在');
    expect(validateProviderInput(providerInput({ id: 'new-one' }), ctx)).toEqual([]);
    expect(
      validateProviderInput(providerInput({ id: 'new-one', baseUrl: 'ftp://host/v1' }), ctx).map((i) => i.message)[0],
    ).toContain('http');
    expect(
      validateProviderInput(providerInput({ id: 'new-one', models: [{ id: 'm', contextWindow: 0 }] }), ctx).map(
        (i) => i.field,
      ),
    ).toEqual(['models.0.contextWindow']);
  });

  it('规范化：非对象 / 非字符串字段 / 模型非数组收集为问题而非抛错', () => {
    expect(normalizeProviderInput(null).issues).toHaveLength(1);
    expect(normalizeProviderInput({ id: 1, models: 'x' }).issues.map((i) => i.field)).toEqual(['id', 'models']);
  });

  it('凭据引用派生：数字开头前置下划线、空路由兜底 ROUTE_API_KEY', () => {
    expect(deriveApiKeyRef('local-oai')).toBe('LOCAL_OAI_API_KEY');
    expect(deriveApiKeyRef('9x')).toBe('_9X_API_KEY');
    expect(deriveApiKeyRef('')).toBe('ROUTE_API_KEY');
  });
});

describe('A1 文档读视图（分层合并 / 凭据三态 / 密钥不回显）', () => {
  it('空 home：空列表 + 无错误 + 指纹非空', () => {
    const home = tmp('h2-core-home-');
    const doc = readModelsDocument(home, home, {});
    expect(doc.providers).toEqual([]);
    expect(doc.sources).toEqual({ global: false, project: false });
    expect(doc.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.errors).toEqual([]);
  });

  it('分层合并：用户层独有可删、项目层携带不可删、两层同 id 层并列且项目层覆盖', () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    writeConfig(home, {
      providers: {
        'user-only': { protocol: 'openai', baseUrl: 'https://u.test/v1' },
        both: { protocol: 'openai', baseUrl: 'https://u.test/v1' },
      },
      roles: {},
    });
    writeProjectConfig(root, {
      providers: {
        'proj-only': { protocol: 'openai', baseUrl: 'https://p.test/v1' },
        both: { protocol: 'anthropic', baseUrl: 'https://p.test/v1' },
      },
      roles: {},
    });
    const doc = readModelsDocument(home, root, {});
    const byId = Object.fromEntries(doc.providers.map((p) => [p.id, p]));
    expect(byId['user-only']?.layers).toEqual(['user']);
    expect(byId['user-only']?.deletable).toBe(true);
    expect(byId['proj-only']?.layers).toEqual(['project']);
    expect(byId['proj-only']?.deletable).toBe(false);
    expect(byId['proj-only']?.lockedReason).toContain(join(root, HARNESS_DIR, 'config.json'));
    expect(byId['both']?.layers).toEqual(['user', 'project']);
    expect(byId['both']?.deletable).toBe(false);
    expect(byId['both']?.protocol).toBe('anthropic');
    expect(doc.sources).toEqual({ global: true, project: true });
  });

  it('凭据三态：无引用=unknown；有引用但缺失=missing；auth.json 有条目=confirmed（不含明文）', () => {
    const home = tmp('h2-core-home-');
    writeConfig(home, {
      providers: {
        noRef: { protocol: 'openai', baseUrl: 'https://a.test/v1' },
        withRefMissing: { protocol: 'openai', baseUrl: 'https://b.test/v1', envKey: 'B_KEY' },
        withAuth: { protocol: 'openai', baseUrl: 'https://c.test/v1', envKey: 'C_KEY' },
      },
      roles: {},
    });
    writeAuth(home, { channels: { withAuth: { apiKey: KEY_VALUE } } });
    const doc = readModelsDocument(home, home, {});
    const byId = Object.fromEntries(doc.providers.map((p) => [p.id, p.credential]));
    expect(byId['noRef']).toEqual({ state: 'unknown' });
    expect(byId['withRefMissing']).toEqual({ state: 'missing', reference: 'B_KEY' });
    expect(byId['withAuth']).toEqual({ state: 'confirmed', source: 'auth.json', reference: 'C_KEY' });
    expect(JSON.stringify(doc)).not.toContain(KEY_VALUE);
  });

  it('readCredentialStatuses：env 注入确认 env 来源；输出绝不含明文', () => {
    const home = tmp('h2-core-home-');
    writeConfig(home, {
      providers: { envs: { protocol: 'openai', baseUrl: 'https://d.test/v1', envKey: 'H2_TEST_ENV_KEY' } },
      roles: {},
    });
    const statuses = readCredentialStatuses(home, home, ['envs'], { H2_TEST_ENV_KEY: KEY_VALUE });
    expect(statuses['envs']).toEqual({ state: 'confirmed', source: 'env', reference: 'H2_TEST_ENV_KEY' });
    expect(JSON.stringify(statuses)).not.toContain(KEY_VALUE);
  });

  it('显示名称来自覆层（缺省回退 id）', () => {
    const home = tmp('h2-core-home-');
    writeConfig(home, { providers: { fancy: { protocol: 'openai', baseUrl: 'https://f.test/v1' } }, roles: {} });
    mkdirSync(join(home, HARNESS_DIR), { recursive: true });
    writeFileSync(
      join(home, HARNESS_DIR, MODELS_OVERLAY_FILE),
      JSON.stringify({ displayNames: { fancy: '花名' }, declarationAckVersion: 3 }),
      'utf8',
    );
    const doc = readModelsDocument(home, home, {});
    expect(doc.providers[0]?.displayName).toBe('花名');
    expect(doc.declarationAckVersion).toBe(3);
  });
});

describe('A1 写 / 删 provider（落盘 + 回读）', () => {
  it('保存提供方：派生 envKey 写进 config（只有名字），无密钥值；revision 前进', () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    const before = readModelsDocument(home, root, {});
    const res = updateModelsProvider(home, root, { revision: before.revision, provider: providerInput() });
    expect(res.ok).toBe(true);
    const text = configText(home);
    expect(text).toContain('"envKey": "LOCAL_OAI_API_KEY"');
    expect(text).not.toContain('apiKey');
    expect(res.document?.providers[0]?.apiKeyRef).toBe(deriveApiKeyRef('local-oai'));
    expect(res.document?.providers[0]?.models).toEqual([
      { id: 'big-pickle', contextWindow: 200000, maxOutputTokens: 2048 },
    ]);
    expect(res.document?.revision).not.toBe(before.revision);
  });

  it('revision 并发：旧 revision → settings/conflict 且不落盘', () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    const first = readModelsDocument(home, root, {});
    expect(updateModelsProvider(home, root, { revision: first.revision, provider: providerInput() }).ok).toBe(true);
    const stale = updateModelsProvider(home, root, {
      revision: first.revision,
      provider: providerInput({ displayName: '并发改写' }),
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('settings/conflict');
    expect(configText(home)).not.toContain('并发改写');
  });

  it('校验失败不落盘：空 id / 重复 id / 端点语法 六次拒绝后指纹不变', () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    expect(
      updateModelsProvider(home, root, {
        revision: readModelsDocument(home, root, {}).revision,
        provider: providerInput(),
      }).ok,
    ).toBe(true);
    const rev = readModelsDocument(home, root, {}).revision;
    const cases: Array<[ModelsProviderInputShape, string]> = [
      [providerInput({ id: '' }), 'id'],
      [providerInput(), 'id'],
      [providerInput({ id: 'x', displayName: ' ' }), 'displayName'],
      [providerInput({ id: 'x', baseUrl: 'nope' }), 'baseUrl'],
    ];
    for (const [provider, field] of cases) {
      const res = updateModelsProvider(home, root, { revision: rev, provider });
      expect(res.ok, JSON.stringify(provider)).toBe(false);
      expect(res.code).toBe('validation');
      expect(res.field).toBe(field);
    }
    expect(readModelsDocument(home, root, {}).revision).toBe(rev);
  });

  it('删除：用户层独有可删（恢复组合基线）；确认名不一致即拒', () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput(),
      mainModel: 'big-pickle',
    });
    const bad = deleteModelsProvider(home, root, { route: 'local-oai', confirmRoute: 'other' });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('validation');
    const res = deleteModelsProvider(home, root, { route: 'local-oai', confirmRoute: 'local-oai' });
    expect(res.ok).toBe(true);
    expect(res.document?.providers).toEqual([]);
    expect(configText(home)).not.toContain('big-pickle');
  });

  it('首运行声明：版本化落盘（单调不回退；非法版本拒绝）', () => {
    const home = tmp('h2-core-home-');
    expect(ackModelsDeclaration(home, 1)).toEqual({ ok: true, declarationAckVersion: 1 });
    expect(ackModelsDeclaration(home, 2).declarationAckVersion).toBe(2);
    expect(ackModelsDeclaration(home, 1).declarationAckVersion).toBe(2);
    expect(ackModelsDeclaration(home, 0).ok).toBe(false);
    expect(readModelsDocument(home, home, {}).declarationAckVersion).toBe(2);
    expect(overlayText(home)).toContain('declarationAckVersion');
  });
});

describe('A1 凭据通道（只写 / 响应与日志绝不回显明文）', () => {
  it('写密钥：落 auth.json，回读只有引用名；响应与全部 console 出口都不含明文', () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    const captured: string[] = [];
    const spies = [console.log, console.error, console.warn, console.info].map((fn) =>
      vi.spyOn(
        console,
        fn === console.log ? 'log' : fn === console.error ? 'error' : fn === console.warn ? 'warn' : 'info',
      ),
    );
    for (const s of spies)
      s.mockImplementation((...args: unknown[]) => void captured.push(args.map((a) => String(a)).join(' ')));
    try {
      const res = writeChannelKey(home, root, 'local-oai', KEY_VALUE);
      expect(res.ok).toBe(true);
      expect(res.reference).toBe('LOCAL_OAI_API_KEY');
      expect(JSON.stringify(res)).not.toContain(KEY_VALUE);
      expect(captured.join('\n')).not.toContain(KEY_VALUE);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    // 明文只应落在 auth.json（唯一合法位置），且文档视图不含明文
    expect(readFileSync(join(home, HARNESS_DIR, 'auth.json'), 'utf8')).toContain(KEY_VALUE);
    expect(JSON.stringify(readModelsDocument(home, root, {}))).not.toContain(KEY_VALUE);
  });

  it('四类密钥拒绝：一律不写 auth.json', () => {
    const home = tmp('h2-core-home-');
    for (const bad of ['sk-a b', 'LOCAL_KEY=sk-abc', '"sk-abc"', '   ']) {
      const res = writeChannelKey(home, home, 'local-oai', bad);
      expect(res.ok, bad).toBe(false);
      expect(res.code).toBe('validation');
      expect(res.field).toBe('key');
    }
    expect(existsSync(join(home, HARNESS_DIR, 'auth.json'))).toBe(false);
  });

  it('auth.json 损坏：拒绝写入（不覆盖既有凭据）', () => {
    const home = tmp('h2-core-home-');
    mkdirSync(join(home, HARNESS_DIR), { recursive: true });
    const broken = '{ "channels": {';
    writeFileSync(join(home, HARNESS_DIR, 'auth.json'), broken, 'utf8');
    const res = writeChannelKey(home, home, 'local-oai', KEY_VALUE);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('io');
    expect(readFileSync(join(home, HARNESS_DIR, 'auth.json'), 'utf8')).toBe(broken);
  });
});

describe('A1 发现模型（注入假 fetch：URL/鉴权头 / 错误如实）', () => {
  it('openai：命中 {baseUrl}/models 带 Bearer 头；id+显示名解析（缺显示名回退 id）', async () => {
    const home = tmp('h2-core-home-');
    const root = tmp('h2-core-root-');
    writeAuth(home, { channels: { 'local-oai': { apiKey: KEY_VALUE } } });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const res = await discoverModelsFor(
      home,
      root,
      { route: 'local-oai', baseUrl: 'http://127.0.0.1:40080/v1/', protocol: 'openai' },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ data: [{ id: 'big-pickle', display_name: 'Big Pickle' }, { id: 'plain' }] }),
          { status: 200 },
        );
      },
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([
      { id: 'big-pickle', displayName: 'Big Pickle' },
      { id: 'plain', displayName: 'plain' },
    ]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:40080/v1/models');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY_VALUE}`);
    expect(JSON.stringify(res)).not.toContain(KEY_VALUE);
  });

  it('anthropic：走 {baseUrl}/v1/models + x-api-key + anthropic-version', async () => {
    const home = tmp('h2-core-home-');
    writeAuth(home, { channels: { ant: { apiKey: KEY_VALUE } } });
    let seen: { url: string; init: RequestInit } | null = null;
    const res = await discoverModelsFor(
      home,
      home,
      { route: 'ant', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' },
      async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 });
      },
      {},
    );
    expect(res.ok).toBe(true);
    expect(seen!.url).toBe('https://api.anthropic.com/v1/models');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY_VALUE);
    expect(headers['anthropic-version']).toBeDefined();
  });

  it('本请求 apiKey 优先（草稿即测）：无需已存凭据也会发起请求', async () => {
    const home = tmp('h2-core-home-');
    let called = false;
    const res = await discoverModelsFor(
      home,
      home,
      { route: 'fresh', baseUrl: 'https://a.test/v1', protocol: 'openai', apiKey: 'draft-key-123' },
      async () => {
        called = true;
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      },
      {},
    );
    expect(called).toBe(true);
    expect(res.ok).toBe(true);
  });

  it('无凭据 / 端点语法错误：如实拒绝且不发起网络请求', async () => {
    const home = tmp('h2-core-home-');
    let called = false;
    const noKey = await discoverModelsFor(
      home,
      home,
      { route: 'nope', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      {},
    );
    expect(noKey.ok).toBe(false);
    expect(noKey.error).toContain('API 密钥');
    const badUrl = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'not a url', protocol: 'openai' },
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      {},
    );
    expect(badUrl.ok).toBe(false);
    expect(badUrl.error).toContain('http');
    expect(called).toBe(false);
  });

  it('HTTP 失败 / 网络异常 / 空列表 / 非 JSON：如实报错（错误经脱敏，不臆造模型）', async () => {
    const home = tmp('h2-core-home-');
    writeAuth(home, { channels: { a: { apiKey: KEY_VALUE } } });
    const http = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response(`bad key ${KEY_VALUE}`, { status: 401 }),
      {},
    );
    expect(http.ok).toBe(false);
    expect(http.error).toContain('HTTP 401');
    expect(http.error).not.toContain(KEY_VALUE);
    const net = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      () => Promise.reject(new Error(`connect ECONNREFUSED bearer ${KEY_VALUE}`)),
      {},
    );
    expect(net.ok).toBe(false);
    expect(net.error).not.toContain(KEY_VALUE);
    const empty = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      {},
    );
    expect(empty.ok).toBe(false);
    const notJson = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response('<html>', { status: 200 }),
      {},
    );
    expect(notJson.ok).toBe(false);
  });

  it('与 core provider/discover 同口径：同一 baseUrl/协议/密钥 → 相同 URL 与鉴权头', async () => {
    const home = tmp('h2-core-home-');
    writeAuth(home, { channels: { c: { apiKey: KEY_VALUE } } });
    const cases: Array<{ protocol: 'openai' | 'anthropic'; baseUrl: string }> = [
      { protocol: 'openai', baseUrl: 'https://api.x.com/v1' },
      { protocol: 'anthropic', baseUrl: 'https://api.x.com' },
    ];
    for (const { protocol, baseUrl } of cases) {
      let mine: { url: string; headers: Record<string, string> } | null = null;
      await discoverModelsFor(
        home,
        home,
        { route: 'c', baseUrl, protocol },
        async (url, init) => {
          mine = { url, headers: init.headers as Record<string, string> };
          return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
        },
        {},
      );
      const config = {
        providers: { c: { protocol, baseUrl } },
        roles: {},
        approval: {},
        memory: { mode: 'off', nudgeInterval: 10 },
        browser: { enabled: false, idleDestroyMs: 1, maxConcurrent: 1 },
        plugins: { enabled: false, allow: [] },
        mcpServers: {},
        subagent: { maxDepth: 1, maxTurns: 1 },
      } as unknown as HarnessConfig;
      let theirs: { url: string; headers: Record<string, string> } | null = null;
      await discoverProviderModels('c', config, {
        auth: { channels: { c: { apiKey: KEY_VALUE } } },
        env: {},
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          theirs = { url: String(url), headers: init?.headers as Record<string, string> };
          return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
        }) as typeof fetch,
      });
      expect(mine!.url, protocol).toBe(theirs!.url);
      expect(mine!.headers['authorization'], protocol).toBe(theirs!.headers['authorization']);
      expect(mine!.headers['x-api-key'], protocol).toBe(theirs!.headers['x-api-key']);
      expect(mine!.headers['anthropic-version'], protocol).toBe(theirs!.headers['anthropic-version']);
    }
  });
});
