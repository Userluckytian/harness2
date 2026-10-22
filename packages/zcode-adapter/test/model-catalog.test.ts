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

describe('拉取富化集成：空 provider 保存 → 新增带真实配置 + 既有空壳补富化', () => {
  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'h2-cat-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'config.json'), JSON.stringify({ providers: {}, roles: {} }));
    return home;
  }
  const readCfg = (home: string) => JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8'));
  const SECRET = 'sk-cat-test';

  it('保存合法 provider → /models 两 ID → 目录命中 big-pickle：磁盘条目带 contextWindow/reasoning', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: (async (url: any) => {
        if (String(url).includes('models.opencode.ai')) return { ok: true, status: 200, json: async () => CATALOG };
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'big-pickle' }, { id: 'space-bunny' }] }) };
      }) as unknown as typeof fetch,
    });
    const created = await svc.createPersonalProvider({ providerName: 'cat' });
    const pid = created.providerId;
    await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    for (let i = 0; i < 60; i++) {
      const ms = readCfg(home).providers?.[pid]?.models ?? {};
      if (ms['big-pickle']?.contextWindow !== undefined && Object.keys(ms).length === 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const models = readCfg(home).providers[pid].models;
    expect(Object.keys(models)).toEqual(['big-pickle', 'space-bunny']);
    expect(models['big-pickle']).toMatchObject({ contextWindow: 200000, maxOutputTokens: 8192 });
    expect(models['big-pickle'].reasoning.values).toEqual(['none', 'low', 'high']);
    expect(JSON.stringify(readCfg(home))).not.toContain(SECRET);
    rmSync(home, { recursive: true, force: true });
  });

  it('二次保存（added=0）仍补富化既有空壳；已富化不重复写（revision 不动）', async () => {
    const home = makeHome();
    resetCatalogCacheForTests();
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: (async (url: any) => {
        if (String(url).includes('models.opencode.ai')) return { ok: true, status: 200, json: async () => CATALOG };
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'big-pickle' }] }) };
      }) as unknown as typeof fetch,
    });
    const created = await svc.createPersonalProvider({});
    const pid = created.providerId;
    const overlay = {
      api: { type: 'openai-chat-completions', baseUrl: 'https://gw.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    };
    await svc.savePersonalProviderOverlay(pid, overlay);
    for (let i = 0; i < 60 && readCfg(home).providers?.[pid]?.models?.['big-pickle']?.contextWindow === undefined; i++)
      await new Promise((r) => setTimeout(r, 50));
    const revAfterFirst = readCfg(home)._h2Revision;
    // 再保存一次：/models 无新增（已在磁盘），目录命中但键已存在 → 不得无谓 bump
    await svc.savePersonalProviderOverlay(pid, overlay);
    await new Promise((r) => setTimeout(r, 400));
    expect(readCfg(home).providers[pid].models['big-pickle'].contextWindow).toBe(200000);
    // 第二次保存自身 bump 一次（合法写），富化不得再 bump 第二次 → 总增量 ≤2
    expect(readCfg(home)._h2Revision).toBeLessThanOrEqual(revAfterFirst + 2);
    rmSync(home, { recursive: true, force: true });
  });
});
