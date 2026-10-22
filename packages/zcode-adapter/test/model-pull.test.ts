/**
 * ZS4.5 自动拉模型：纯函数面（URL 归一/提取/合并）+ 服务集成面（保存后回填+二次广播）。
 * 红线证据：apiKey 只进请求头；脏 ID 丢弃；失败静默不影响保存。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelsListUrl, extractModelIds, mergePulledModels } from '../src/real/model-pull.js';
import { resetCatalogCacheForTests } from '../src/real/model-catalog.js';
import { createProviderSettingsService } from '../src/real/provider-views.js';
import type { StoredProviderConfig } from '../src/real/provider-writes.js';

const SECRET = 'sk-pull-test';

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
) {
  return handler as unknown as typeof fetch;
}

describe('modelsListUrl（baseUrl 归一）', () => {
  it('openai：根补 /v1/models；已带 /v1 直接拼；尾斜杠/chat 端点后缀容错', () => {
    expect(modelsListUrl({ protocol: 'openai', baseUrl: 'https://api.x.com', apiKey: undefined })).toBe(
      'https://api.x.com/v1/models',
    );
    expect(modelsListUrl({ protocol: 'openai', baseUrl: 'https://api.x.com/v1/', apiKey: undefined })).toBe(
      'https://api.x.com/v1/models',
    );
    expect(
      modelsListUrl({ protocol: 'openai', baseUrl: 'https://api.x.com/v1/chat/completions', apiKey: undefined }),
    ).toBe('https://api.x.com/v1/models');
    expect(modelsListUrl({ protocol: 'openai', baseUrl: 'https://gateway.x.com/anthropic', apiKey: undefined })).toBe(
      'https://gateway.x.com/anthropic/models',
    );
  });
  it('anthropic：根→/v1/models；带 /v1 不重复拼', () => {
    expect(modelsListUrl({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: undefined })).toBe(
      'https://api.anthropic.com/v1/models',
    );
    expect(modelsListUrl({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: undefined })).toBe(
      'https://api.anthropic.com/v1/models',
    );
  });
  it('空/非 http baseUrl → null（不硬猜）', () => {
    expect(modelsListUrl({ protocol: 'openai', baseUrl: '', apiKey: undefined })).toBeNull();
    expect(modelsListUrl({ protocol: 'openai', baseUrl: 'api.x.com', apiKey: undefined })).toBeNull();
  });
});

describe('extractModelIds', () => {
  it('{data:[{id}]} 形状、保持顺序、去重、脏 ID 丢弃', () => {
    expect(
      extractModelIds({
        data: [{ id: 'gpt-a' }, { id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'bad id!' }, { noId: 1 }, { id: 42 }],
      }),
    ).toEqual(['gpt-a', 'gpt-b']);
  });
  it('非数组 data / 空体 → []', () => {
    expect(extractModelIds({})).toEqual([]);
    expect(extractModelIds({ data: 'x' })).toEqual([]);
    expect(extractModelIds(null)).toEqual([]);
  });
});

describe('mergePulledModels（就地合并 + 密钥只在头 + 静默失败）', () => {
  it('成功：新增进 models、已有键的用户配置不被覆盖、Bearer 头带 key', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const config: StoredProviderConfig = {
      protocol: 'openai',
      baseUrl: 'https://api.x.com/v1',
      models: { 'keep-me': { contextWindow: 999 } },
    };
    const added = await mergePulledModels(
      config,
      { protocol: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: SECRET },
      fakeFetch(async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }, { id: 'keep-me' }, { id: 'm2' }] }) };
      }),
    );
    expect(added).toEqual(['m1', 'm2']);
    expect(config.models).toEqual({ 'keep-me': { contextWindow: 999 }, m1: {}, m2: {} });
    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
  });
  it('anthropic：x-api-key + anthropic-version 头', async () => {
    let headers: Record<string, string> = {};
    await mergePulledModels(
      { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: {} },
      { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: SECRET },
      fakeFetch(async (_u, init) => {
        headers = init?.headers as Record<string, string>;
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-z' }] }) };
      }),
    );
    expect(headers['x-api-key']).toBe(SECRET);
    expect(headers['anthropic-version']).toBeDefined();
  });
  it('非 200 / 网络炸 / 形状坏 → [] 且不碰 config（静默）', async () => {
    const config: StoredProviderConfig = { protocol: 'openai', baseUrl: 'https://api.x.com/v1', models: { a: {} } };
    const snapshot = JSON.stringify(config);
    expect(
      await mergePulledModels(
        config,
        { protocol: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: undefined },
        fakeFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      ),
    ).toEqual([]);
    expect(
      await mergePulledModels(
        config,
        { protocol: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: undefined },
        fakeFetch(async () => {
          throw new Error('ECONNREFUSED');
        }),
      ),
    ).toEqual([]);
    expect(
      await mergePulledModels(
        config,
        { protocol: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: undefined },
        fakeFetch(async () => ({ ok: true, status: 200, json: async () => 'not-json-shape' })),
      ),
    ).toEqual([]);
    expect(JSON.stringify(config)).toBe(snapshot);
  });
  it('无 key 也拉（多数 OpenAI 兼容网关 /models 需鉴权则自然 401 静默）：不带 authorization 头', async () => {
    let called = false;
    let hasAuth = 'unset';
    await mergePulledModels(
      { protocol: 'openai', baseUrl: 'https://api.x.com/v1', models: {} },
      { protocol: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: undefined },
      fakeFetch(async (_u, init) => {
        called = true;
        hasAuth = String((init?.headers as Record<string, string>)?.authorization);
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }),
    );
    expect(called).toBe(true);
    expect(hasAuth).toBe('undefined');
  });
});

describe('服务集成：合法保存后 ZS4.5g 语义（不新增模型，只富化空壳）', () => {
  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'h2-pull-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'config.json'), JSON.stringify({ providers: {}, roles: {} }));
    return home;
  }
  const readCfg = (home: string) => JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8'));

  it('ZS4.5g：合法保存**不再拉渠道列表**（新增唯一入口=勾选/手填）；无模型=零后台网络零新播', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    let pulls = 0;
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: fakeFetch(async (url) => {
        if (String(url).includes('api.x.com')) pulls++; // 渠道列表请求
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'auto-1' }, { id: 'auto-2' }] }) };
      }),
    });
    const seen: any[] = [];
    svc.onDidChange((v: any) => seen.push(v));
    const created = await svc.createPersonalProvider({ providerName: 'x' });
    const pid = created.providerId;
    await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'https://api.x.com/v1' },
      access: { type: 'api-key', apiKey: SECRET },
      group: 'standard-personal',
    });
    await new Promise((r) => setTimeout(r, 400)); // 给任何后台任务充分机会
    expect(pulls).toBe(0); // 保存绝不碰渠道 /models（旧 ZS4.5 全量回填已移除）
    const cfg = readCfg(home);
    expect(Object.keys(cfg.providers[pid].models)).toEqual([]); // 磁盘模型零新增
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    expect(seen.length).toBe(2); // 建卡一播+保存一播，无回填二播
    rmSync(home, { recursive: true, force: true });
  });

  it('ZS4.5g：保存只富化既有空壳（目录命中填属性），仍绝不新增模型键', async () => {
    // 种子=旧 ZS4.5 时代产物：provider 已合法 + models 里躺一个仅-ID 空壳
    const home = mkdtempSync(join(tmpdir(), 'h2-pull2-'));
    resetCatalogCacheForTests();
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(
      join(home, '.harness2', 'config.json'),
      JSON.stringify({
        providers: {
          legacy: {
            protocol: 'openai',
            baseUrl: 'https://gw.example/v1',
            models: { 'shell-1': { enabled: true } },
            enabled: true,
          },
        },
        roles: {},
      }),
    );
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: fakeFetch(async (url) => {
        if (String(url).includes('models.opencode.ai'))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              gw: { models: { 'shell-1': { id: 'shell-1', limit: { context: 64000, output: 4000 } } } },
            }),
          };
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'never-added' }] }) };
      }),
    });
    const seen: any[] = [];
    svc.onDidChange((v: any) => seen.push(v));
    await svc.savePersonalProviderOverlay('legacy', {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
      group: 'standard-personal',
    });
    // 轮询等后台富化（上限 2s）
    for (let i = 0; i < 40 && readCfg(home).providers.legacy.models['shell-1'].contextWindow === undefined; i++)
      await new Promise((r) => setTimeout(r, 50));
    const m = readCfg(home).providers.legacy.models;
    expect(m['shell-1'].contextWindow).toBe(64000); // 空壳被目录补全（core 扁平键）
    expect(Object.keys(m)).toEqual(['shell-1']); // 键集不变：渠道列表绝不回填
    expect(Object.keys(m)).not.toContain('never-added');
    rmSync(home, { recursive: true, force: true });
  });

  it('拉取失败（fetch throw）：保存结果不受影响、无第二播、config 保持合法', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: fakeFetch(async () => {
        throw new Error('network down');
      }),
    });
    const created = await svc.createPersonalProvider({ providerName: 'y' });
    const pid = created.providerId;
    const view: any = await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'https://down.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    expect(view.providers.find((p: any) => p.providerId === pid)).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    const cfg = readCfg(home);
    expect(cfg.providers[pid].models).toBeDefined();
    expect(Object.keys(cfg.providers[pid].models)).toEqual([]);
    expect(existsSync(join(home, '.harness2', 'auth.json'))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('ZS4.5f 获取模型动作：discoverModels（不落盘）+ addDiscoveredModels（勾选落盘）', () => {
  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'h2-disc-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'config.json'), JSON.stringify({ providers: {}, roles: {} }));
    return home;
  }
  const readCfg = (home: string) => JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8'));

  /** fetch 相位开关：overlay 保存的后台自动拉取先回空（不污染测试），显式动作再放全量。 */
  function phaseFetch(listBody: () => unknown, catalogBody: () => unknown) {
    const state = { autoPull: true };
    const f = fakeFetch(async (url: any) => {
      if (String(url).includes('models.opencode.ai')) return { ok: true, status: 200, json: async () => catalogBody() };
      return { ok: true, status: 200, json: async () => (state.autoPull ? { data: [] } : listBody()) };
    });
    return { f, state };
  }

  async function savedProvider(home: string, fetchImpl: typeof fetch): Promise<string> {
    const svc: any = createProviderSettingsService({ home, fetchImpl });
    const created = await svc.createPersonalProvider({});
    const pid = created.providerId;
    await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    await new Promise((r) => setTimeout(r, 250)); // 等后台自动拉取（空响应）收口
    return pid;
  }

  it('discoverModels：返回全量+已有标记（脏 ID 过滤）；config 零改动、不广播', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const { f, state } = phaseFetch(
      () => ({ data: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'bad id!' }] }),
      () => ({}),
    );
    const pid = await savedProvider(home, f); // autoPull=true：保存期后台拉取回空
    state.autoPull = false; // discover 阶段：显式动作拿全量
    const svc: any = createProviderSettingsService({ home, fetchImpl: f });
    const before = JSON.stringify(readCfg(home));
    const seen: any[] = [];
    svc.onDidChange((v: any) => seen.push(v));
    const r = await svc.discoverModels(pid);
    expect(r.modelIds).toEqual(['m-1', 'm-2']);
    expect(r.existingIds).toEqual([]);
    expect(JSON.stringify(readCfg(home))).toBe(before); // 零落盘（含 _h2Ui）
    expect(seen.length).toBe(0); // 零广播
    rmSync(home, { recursive: true, force: true });
  });

  it('discoverModels：端点失败=如实 throw（显式动作不静默）；provider 不存在=throw', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    // savedProvider 的后台拉取对 502 静默（保存路径语义）；discover 必须炸出来
    const fetch502 = fakeFetch(async (url: any) => {
      if (String(url).includes('gw.example')) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const pid = await savedProvider(home, fetch502);
    const svc: any = createProviderSettingsService({ home, fetchImpl: fetch502 });
    await expect(svc.discoverModels(pid)).rejects.toThrow(/502/);
    await expect(svc.discoverModels('nope')).rejects.toThrow(/不存在/);
    rmSync(home, { recursive: true, force: true });
  });

  it('addDiscoveredModels：只落勾选 + 目录富化 + _h2Ui 模态位 + 广播含新行', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const { f } = phaseFetch(
      () => ({ data: [{ id: 'm-1' }, { id: 'm-2' }] }),
      () => ({
        gw: {
          models: {
            'm-1': {
              id: 'm-1',
              limit: { context: 64000 },
              modalities: { input: ['text', 'image'], output: ['text'] },
              tool_call: true,
            },
          },
        },
      }),
    );
    const pid = await savedProvider(home, f);
    const svc: any = createProviderSettingsService({ home, fetchImpl: f });
    const seen: any[] = [];
    svc.onDidChange((v: any) => seen.push(v));
    const view: any = await svc.addDiscoveredModels(pid, ['m-1', 'm-1']); // 去重
    const models = readCfg(home).providers[pid].models;
    expect(Object.keys(models)).toEqual(['m-1']); // m-2 未勾选=不入库
    expect(models['m-1'].contextWindow).toBe(64000); // 目录富化落 core 扁平键
    const uiBits = readCfg(home)['_h2Ui'][pid]['m-1'];
    expect(uiBits.inputFormat.supportsImage).toBe(true); // 目录模态进 _h2Ui
    const row = view.providers.find((p: any) => p.providerId === pid).models.find((m: any) => m.modelId === 'm-1');
    expect(row.effectiveConfig.properties.contextWindow).toBe(64000);
    expect(row.effectiveConfig.properties.inputFormat.supportsImage).toBe(true);
    expect(row.effectiveConfig.properties.outputFormat.supportsText).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    rmSync(home, { recursive: true, force: true });
  });

  it('addDiscoveredModels：已有键幂等（不 bump revision）；脏 ID throw 不半途写盘', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const { f } = phaseFetch(
      () => ({ data: [] }),
      () => ({}),
    );
    const pid = await savedProvider(home, f);
    const svc: any = createProviderSettingsService({ home, fetchImpl: f });
    await svc.addDiscoveredModels(pid, ['keep-me']);
    const rev = readCfg(home)._h2Revision;
    await svc.addDiscoveredModels(pid, ['keep-me']); // 幂等
    expect(readCfg(home)._h2Revision).toBe(rev);
    await expect(svc.addDiscoveredModels(pid, ['has space'])).rejects.toThrow(/形状/);
    expect(Object.keys(readCfg(home).providers[pid].models)).toEqual(['keep-me']);
    rmSync(home, { recursive: true, force: true });
  });

  it('addDiscoveredModels：草稿/非法 provider 如实 throw（与 discoverModels 对称，审查 P1#3）', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const { f } = phaseFetch(
      () => ({ data: [] }),
      () => ({}),
    );
    const svc: any = createProviderSettingsService({ home, fetchImpl: f });
    const created = await svc.createPersonalProvider({}); // 空 baseUrl 草稿，不落盘
    const seen: any[] = [];
    svc.onDidChange((v: any) => seen.push(v));
    await expect(svc.addDiscoveredModels(created.providerId, ['m-1'])).rejects.toThrow(/有效的 Base URL/);
    expect(seen.length).toBe(0); // throw 不得有半途广播
    rmSync(home, { recursive: true, force: true });
  });
});
