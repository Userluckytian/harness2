/**
 * ZS4.5 自动拉模型：纯函数面（URL 归一/提取/合并）+ 服务集成面（保存后回填+二次广播）。
 * 红线证据：apiKey 只进请求头；脏 ID 丢弃；失败静默不影响保存。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelsListUrl, extractModelIds, mergePulledModels } from '../src/real/model-pull.js';
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

describe('服务集成：合法保存后后台回填 + 二次广播', () => {
  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'h2-pull-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'config.json'), JSON.stringify({ providers: {}, roles: {} }));
    return home;
  }
  const readCfg = (home: string) => JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8'));

  it('savePersonalProviderOverlay 合法落盘 → 拉取 → config.models 回填 + onDidChange 第二播', async () => {
    const home = makeHome();
    let pulls = 0;
    const svc: any = createProviderSettingsService({
      home,
      fetchImpl: fakeFetch(async () => {
        pulls++;
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'auto-1' }, { id: 'auto-2' }] }) };
      }),
    });
    const seen: any[] = [];
    svc.onDidChange((v: any) => seen.push(v));
    // 真实 UI 流：先建卡（空 baseUrl 草稿）→ 表单填完 overlay 保存
    const created = await svc.createPersonalProvider({ providerName: 'x' });
    const pid = created.providerId;
    await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'https://api.x.com/v1' },
      access: { type: 'api-key', apiKey: SECRET },
      group: 'standard-personal',
    });
    // fire-and-forget：轮询等待后台完成（上限 2s）
    for (let i = 0; i < 40 && readCfg(home).providers?.[pid] === undefined; i++)
      await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 40 && Object.keys(readCfg(home).providers[pid].models || {}).length === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(pulls).toBe(1);
    const cfg = readCfg(home);
    expect(Object.keys(cfg.providers[pid].models)).toEqual(['auto-1', 'auto-2']);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    // 拉取回填后最后一次广播的视图应含新模型
    const last = seen[seen.length - 1].providers.find((p: any) => p.providerId === pid);
    expect(last.models.map((m: any) => m.modelId)).toEqual(['auto-1', 'auto-2']);
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
