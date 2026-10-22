/**
 * ZS4.5b opencode 目录增强：纯函数面（匹配/映射/合并）+ 拉取富化集成面。
 * 网络经 fetchImpl 注入 fixture；红线⑩：只映射目录真实字段。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lookupCatalogEntry,
  lookupCatalogEntryLoose,
  catalogEntryToCoreModel,
  flatCoreModelToUiConfig,
  mergeUiModelConfigs,
  toStoredModelConfig,
  enrichModelsFromCatalog,
  resetCatalogCacheForTests,
  UI_REASONING_MAP,
  type CatalogMap,
} from '../src/real/model-catalog.js';
import { createProviderSettingsService } from '../src/real/provider-views.js';

const CATALOG: CatalogMap = {
  opencode: {
    models: {
      'big-pickle': {
        id: 'big-pickle',
        limit: { context: 200000, output: 8192 },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
      },
      'space-bunny': { id: 'space-bunny', limit: { context: 128000 } },
      'weird-no-limits': { id: 'weird-no-limits', reasoning_options: [{ type: 'budget', values: [1, 2] }] },
    },
  },
  other: { models: { 'big-pickle': { id: 'big-pickle', limit: { context: 1 } } } },
};

beforeEach(() => resetCatalogCacheForTests());

describe('lookupCatalogEntry（精确优先/前缀退化/宁缺勿滥）', () => {
  it('全 ID 精确命中多 provider → provider 键字典序稳定取一', () => {
    const e = lookupCatalogEntry(CATALOG, 'big-pickle');
    expect(e).toBe(CATALOG['opencode'].models!['big-pickle']); // opencode < other 字典序
  });
  it('目录键带前缀形式命中（m.id 全等也算）', () => {
    const cat: CatalogMap = {
      nvidia: { models: { 'nvidia/llama-x': { id: 'nvidia/llama-x', limit: { context: 8 } } } },
    };
    expect(lookupCatalogEntry(cat, 'nvidia/llama-x')?.limit?.context).toBe(8);
  });
  it('恰有一段前缀 → 试 {catProvider}/{id}；无命中 null', () => {
    const cat: CatalogMap = { nvidia: { models: { 'llama-y': { id: 'nvidia/llama-y', limit: { context: 9 } } } } };
    expect(lookupCatalogEntry(cat, 'nvidia/llama-y')?.limit?.context).toBe(9);
    expect(lookupCatalogEntry(cat, 'unknown/model-z')).toBeNull();
  });
});

describe('catalogEntryToCoreModel / flatCoreModelToUiConfig（只映真实字段）', () => {
  it('core 扁平：limit+effort → contextWindow/maxOutputTokens/reasoning.values；budget 型档位不猜', () => {
    expect(catalogEntryToCoreModel(CATALOG['opencode'].models!['big-pickle'])).toEqual({
      contextWindow: 200000,
      maxOutputTokens: 8192,
      reasoning: { values: ['none', 'low', 'high'] },
    });
    expect(catalogEntryToCoreModel({ id: 'x', limit: { context: 4096, output: -1 }, reasoning_options: [] })).toEqual({
      contextWindow: 4096,
    });
    expect(catalogEntryToCoreModel(CATALOG['opencode'].models!['weird-no-limits'])).toBeNull();
  });
  it('UI 嵌套形：properties.contextWindow + optionSpecs.maxOutputTokens.max + reasoningLevel{values,map}', () => {
    const ui = flatCoreModelToUiConfig({
      contextWindow: 200000,
      maxOutputTokens: 8192,
      reasoning: { values: ['low', 'high'] },
    });
    expect(ui).toEqual({
      properties: { contextWindow: 200000 },
      optionSpecs: {
        maxOutputTokens: { max: 8192 },
        reasoningLevel: { values: ['low', 'high'], map: UI_REASONING_MAP },
      },
    });
    expect(flatCoreModelToUiConfig(undefined)).toEqual({});
    expect(flatCoreModelToUiConfig({ enabled: true })).toEqual({});
  });
});

describe('mergeUiModelConfigs / toStoredModelConfig（边界归一往返）', () => {
  it('嵌套 personal 覆盖 inherited（两层浅合并）', () => {
    const base = { properties: { contextWindow: 100 }, optionSpecs: { reasoningLevel: { values: ['a'], map: 'x' } } };
    const over = { properties: { contextWindow: 200 } };
    expect(mergeUiModelConfigs(base, over)).toEqual({
      properties: { contextWindow: 200 },
      optionSpecs: { reasoningLevel: { values: ['a'], map: 'x' } },
    });
  });
  it('嵌套→扁平；扁平→直通；脏键不炸', () => {
    expect(
      toStoredModelConfig({
        properties: { contextWindow: 4096 },
        optionSpecs: {
          maxOutputTokens: { max: 512 },
          reasoningLevel: { values: ['low', ' ', 'high'], map: '{"x":y}' },
        },
      }),
    ).toEqual({ contextWindow: 4096, maxOutputTokens: 512, reasoning: { values: ['low', 'high'] } });
    expect(toStoredModelConfig({ contextWindow: 77, enabled: true })).toEqual({ contextWindow: 77, enabled: true });
    expect(toStoredModelConfig(null)).toEqual({});
    expect(toStoredModelConfig([1, 2])).toEqual({});
  });
});

describe('enrichModelsFromCatalog + loadOpencodeCatalog（单例/静默失败）', () => {
  function catalogFetch(body: unknown, ok = true) {
    return (async (_url: any, _init?: any) => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    })) as unknown as typeof fetch;
  }
  it('首拉成功缓存单例（第二次不再 fetch）；命中返回扁平映射', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => CATALOG };
    }) as unknown as typeof fetch;
    const m1 = await enrichModelsFromCatalog(['big-pickle', 'space-bunny', 'nope-x'], f);
    expect(calls).toBe(1);
    expect(m1.get('big-pickle')).toEqual({
      contextWindow: 200000,
      maxOutputTokens: 8192,
      reasoning: { values: ['none', 'low', 'high'] },
    });
    expect(m1.get('space-bunny')).toEqual({ contextWindow: 128000 });
    expect(m1.has('nope-x')).toBe(false);
    await enrichModelsFromCatalog(['big-pickle'], f);
    expect(calls).toBe(1); // 缓存：目录只拉一次
  });
  it('拉失败（非 ok）→ 空 Map 且下次保存允许重试（失败不入缓存）', async () => {
    expect(await enrichModelsFromCatalog(['big-pickle'], catalogFetch({}, false))).toEqual(new Map());
    const m = await enrichModelsFromCatalog(['big-pickle'], catalogFetch(CATALOG));
    expect(m.size).toBe(1); // 回线后可成功
  });
});

describe('lookupCatalogEntryLoose（ZS4.5c 尾段松配：仅 UI 基线层）', () => {
  const cat: CatalogMap = {
    neuralwatt: { models: { 'deepseek-v4.1-flash': { id: 'deepseek-v4.1-flash', limit: { context: 160000 } } } },
    'minimax-coding-plan': {
      models: { 'minimax-m3.1-flash': { id: 'MiniMax-M3.1-Flash', limit: { context: 1000000 } } },
    },
    openrouter: {
      models: { 'recursive/flint-v1.0:free': { id: 'recursive/flint-v1.0:free', limit: { context: 40000 } } },
    },
    tiny: { models: { beam: { id: 'beam', limit: { context: 1 } } } },
  };
  it('网关前缀/大小写/cn: 前缀/:free 后缀 → 归一命中真底层', () => {
    expect(lookupCatalogEntryLoose(cat, 'loomy/DeepSeek-V4.1-Flash')?.limit?.context).toBe(160000);
    expect(lookupCatalogEntryLoose(cat, 'buddyhub/cn:deepseek-v4.1-flash')?.limit?.context).toBe(160000);
    expect(lookupCatalogEntryLoose(cat, 'mmxproxy/MiniMax-M3.1-Flash')?.limit?.context).toBe(1000000);
    expect(lookupCatalogEntryLoose(cat, 'or/minimax/minimax-m3.1-flash:free')?.limit?.context).toBe(1000000);
  });
  it('尾段 <4 字符放弃（beam 防误配）；全 miss → null', () => {
    expect(lookupCatalogEntryLoose(cat, 'gateway/beam')).toBeNull();
    expect(lookupCatalogEntryLoose(cat, 'qw2api/qwork-auto')).toBeNull();
  });
  it('写盘富化（enrichModelsFromCatalog）不含松配——只有精确命中落盘', async () => {
    resetCatalogCacheForTests();
    const f = (async () => ({ ok: true, status: 200, json: async () => cat })) as unknown as typeof fetch;
    const m = await enrichModelsFromCatalog(['loomy/DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash'], f);
    expect(m.has('loomy/DeepSeek-V4.1-Flash')).toBe(false); // 松配不富化落盘
    expect(m.get('deepseek-v4.1-flash')).toEqual({ contextWindow: 160000 }); // 精确才落
  });
});

describe('富化集成（ZS4.5g 语义：新增只走显式勾选；保存只补既有空壳）', () => {
  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'h2-cat-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'config.json'), JSON.stringify({ providers: {}, roles: {} }));
    return home;
  }
  const readCfg = (home: string) => JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8'));
  const SECRET = 'sk-cat-test';
  // 渠道 /models 永远回全量列表；任何「保存后列表自己变多」的回归都会在这里炸
  const gwList: unknown = { data: [{ id: 'big-pickle' }, { id: 'space-bunny' }] };

  it('合法保存不新增模型；勾选 addDiscoveredModels → 目录命中 big-pickle：磁盘条目带 contextWindow/reasoning', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: (async (url: any) => {
        if (String(url).includes('models.opencode.ai')) return { ok: true, status: 200, json: async () => CATALOG };
        return { ok: true, status: 200, json: async () => gwList };
      }) as unknown as typeof fetch,
    });
    const created = await svc.createPersonalProvider({ providerName: 'cat' });
    const pid = created.providerId;
    await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    await new Promise((r) => setTimeout(r, 300)); // 旧语义=此处会悄悄回填两 ID（ZS4.5g 禁止）
    expect(Object.keys(readCfg(home).providers[pid].models ?? {})).toEqual([]);
    // 显式勾选入口才新增；勾选两个 → 带真实配置落盘
    await svc.addDiscoveredModels(pid, ['big-pickle', 'space-bunny']);
    for (let i = 0; i < 60 && readCfg(home).providers[pid].models['big-pickle']?.contextWindow === undefined; i++)
      await new Promise((r) => setTimeout(r, 50));
    const models = readCfg(home).providers[pid].models;
    expect(Object.keys(models)).toEqual(['big-pickle', 'space-bunny']);
    expect(models['big-pickle']).toMatchObject({ contextWindow: 200000, maxOutputTokens: 8192 });
    expect(models['big-pickle'].reasoning.values).toEqual(['none', 'low', 'high']);
    expect(JSON.stringify(readCfg(home))).not.toContain(SECRET);
    rmSync(home, { recursive: true, force: true });
  });

  it('保存路径富化磁盘既有空壳（目录命中填属性）；已富化后再保存不重复 bump', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-cat2-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    // 种子=旧 ZS4.5 时代仅-ID 空壳产物（合法 provider）
    writeFileSync(
      join(home, '.harness2', 'config.json'),
      JSON.stringify({
        providers: {
          legacy: {
            protocol: 'openai',
            baseUrl: 'https://gw.example/v1',
            models: { 'big-pickle': { enabled: true } },
            enabled: true,
          },
        },
        roles: {},
      }),
    );
    resetCatalogCacheForTests();
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: (async (url: any) => {
        if (String(url).includes('models.opencode.ai')) return { ok: true, status: 200, json: async () => CATALOG };
        return { ok: true, status: 200, json: async () => gwList };
      }) as unknown as typeof fetch,
    });
    await svc.savePersonalProviderOverlay('legacy', {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    for (let i = 0; i < 60 && readCfg(home).providers.legacy.models['big-pickle']?.contextWindow === undefined; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(readCfg(home).providers.legacy.models['big-pickle'].contextWindow).toBe(200000); // 空壳补全
    expect(Object.keys(readCfg(home).providers.legacy.models)).toEqual(['big-pickle']); // 渠道列表不回填 space-bunny
    const revAfter = readCfg(home)._h2Revision;
    await svc.savePersonalProviderOverlay('legacy', {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    await new Promise((r) => setTimeout(r, 400));
    // 再保存=保存自身 bump 1 次；富化零变化不得再 bump
    expect(readCfg(home)._h2Revision).toBeLessThanOrEqual(revAfter + 1);
    rmSync(home, { recursive: true, force: true });
  });
});
