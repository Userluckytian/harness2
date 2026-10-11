// Z6-A01 模型发现测试：纯函数解析器（fixture 驱动）+ 合并策略（静态优先/去重）+
// discoverProviderModels 全链路（fetchImpl 注入，零真实网络；超时/HTTP错误/形状非法 fail-closed）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_DISCOVERY_TIMEOUT_MS,
  discoverProviderModels,
  mergeDiscoveredModels,
  parseAnthropicModelsResponse,
  parseOpenAIModelsResponse,
} from '../src/provider/discover.js';
import { ANTHROPIC_VERSION } from '../src/provider/anthropic.js';
import { ConfigError, type AuthFile, type HarnessConfig } from '../src/config/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<HarnessConfig['providers']> = {}): HarnessConfig {
  return {
    providers: {
      deepseek: {
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        models: { 'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192 } },
      },
      claude: {
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: { 'claude-sonnet-4-5': { maxOutputTokens: 64000 } },
      },
      ...overrides,
    },
    roles: { main: { channel: 'deepseek', model: 'deepseek-chat' } },
    approval: {},
    memory: { mode: 'off', nudgeInterval: 10 },
    browser: { enabled: false, idleDestroyMs: 300_000, maxConcurrent: 2 },
    plugins: { enabled: true, allow: [] },
    mcpServers: {},
    subagent: { maxDepth: 1, maxTurns: 25 },
  };
}

const AUTH: AuthFile = {
  channels: { deepseek: { apiKey: 'test-key-deepseek' }, claude: { apiKey: 'test-key-claude' } },
};

/** 注入 fetch：捕获请求（url/method/headers）并回放响应脚本 */
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}
function stubFetch(
  respond: (req: CapturedRequest) => { status?: number; body?: string } | Promise<{ status?: number; body?: string }>,
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers);
    h.forEach((v, k) => (headers[k] = v));
    requests.push({ url: String(input), method: init?.method ?? 'GET', headers });
    const script = await respond(requests.at(-1)!);
    return new Response(script.body ?? '', { status: script.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl: impl, requests };
}

describe('parseOpenAIModelsResponse（纯函数 fixture）', () => {
  it('标准 {data:[...]}：id + 容量元数据白名单（context_length/max_output_tokens 及常见别名）', () => {
    const rows = parseOpenAIModelsResponse({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'glm-4.7', context_length: 200000, max_output_tokens: 128000 },
        { id: 'local-model', max_context_length: 8192, max_completion_tokens: 4096 },
        { id: 'vllm-model', max_model_len: 32768 },
      ],
    });
    expect(rows).toEqual([
      { id: 'deepseek-chat' },
      { id: 'glm-4.7', contextWindow: 200000, maxOutputTokens: 128000 },
      { id: 'local-model', contextWindow: 8192, maxOutputTokens: 4096 },
      { id: 'vllm-model', contextWindow: 32768 },
    ]);
  });

  it('fail-closed：顶层非对象 / 缺 data 数组 / data 项缺非空 id → 全部抛错（绝不部分当全量）', () => {
    expect(() => parseOpenAIModelsResponse([1, 2])).toThrow(/不是 JSON 对象/);
    expect(() => parseOpenAIModelsResponse({ object: 'list' })).toThrow(/缺少 data 数组/);
    expect(() => parseOpenAIModelsResponse({ data: 'nope' })).toThrow(/缺少 data 数组/);
    expect(() => parseOpenAIModelsResponse({ data: [{ id: 'a' }, { object: 'model' }] })).toThrow(/data\[1\]/);
    expect(() => parseOpenAIModelsResponse({ data: [{ id: '' }] })).toThrow(/id/);
    expect(() => parseOpenAIModelsResponse({ data: ['a'] })).toThrow(/data\[0\]/);
  });

  it('容量元数据非法值忽略（advisory 不致命）；条目可为 null（fail-closed）', () => {
    const rows = parseOpenAIModelsResponse({
      data: [
        { id: 'a', context_length: 'lots', max_output_tokens: -5 },
        { id: 'b', context_length: 1.5 },
      ],
    });
    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(() => parseOpenAIModelsResponse({ data: [null] })).toThrow(/data\[0\]/);
  });
});

describe('parseAnthropicModelsResponse（纯函数 fixture）', () => {
  it('标准 {data:[{type,id,...}]}：只取 id（无容量元数据）', () => {
    const rows = parseAnthropicModelsResponse({
      data: [
        { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: '2025-01-01' },
        { type: 'model', id: 'claude-opus-4-1' },
      ],
      first_id: 'claude-sonnet-4-5',
      has_more: false,
    });
    expect(rows).toEqual([{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }]);
  });

  it('fail-closed：形状不合法/缺 id 全部抛错', () => {
    expect(() => parseAnthropicModelsResponse(null)).toThrow(/不是 JSON 对象/);
    expect(() => parseAnthropicModelsResponse({})).toThrow(/缺少 data 数组/);
    expect(() => parseAnthropicModelsResponse({ data: [{ type: 'model' }] })).toThrow(/id/);
  });
});

describe('mergeDiscoveredModels（纯函数：静态优先 / 补缺 / 去重）', () => {
  it('静态容量声明不被覆盖；reasoning 声明原样保留；发现的模型补入缺失项', () => {
    const staticModels = {
      'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192, reasoning: { values: ['low', 'high'] } },
    };
    const merged = mergeDiscoveredModels(staticModels, [
      { id: 'deepseek-chat', contextWindow: 999 }, // 同名：静态优先
      { id: 'deepseek-reasoner', contextWindow: 64000, maxOutputTokens: 8192 },
      { id: 'bare-model' },
    ]);
    expect(merged['deepseek-chat']).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 8192,
      reasoning: { values: ['low', 'high'] },
    });
    expect(merged['deepseek-reasoner']).toEqual({ contextWindow: 64000, maxOutputTokens: 8192 });
    expect(merged['bare-model']).toEqual({});
    expect(Object.keys(merged)).toHaveLength(3);
  });

  it('无静态表 / 静态 undefined → 发现结果即全量；发现内重复 id 保留首个；不改入参', () => {
    const discovered = [{ id: 'a' }, { id: 'a', contextWindow: 1 }, { id: 'b' }];
    expect(mergeDiscoveredModels(undefined, discovered)).toEqual({ a: {}, b: {} });
    const staticInput = { x: { contextWindow: 1 } };
    mergeDiscoveredModels(staticInput, discovered);
    expect(staticInput).toEqual({ x: { contextWindow: 1 } });
  });
});

describe('discoverProviderModels（fetchImpl 注入）', () => {
  it('openai 协议：GET {baseUrl}/models + Bearer；结果与静态表合并', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({
      body: JSON.stringify({
        data: [{ id: 'deepseek-chat', context_length: 999999 }, { id: 'deepseek-reasoner' }],
      }),
    }));
    const merged = await discoverProviderModels('deepseek', makeConfig(), { fetchImpl, auth: AUTH, env: {} });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.deepseek.com/v1/models' });
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-key-deepseek');
    expect(merged).toEqual({
      'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192 }, // 静态容量优先
      'deepseek-reasoner': {},
    });
  });

  it('anthropic 协议：GET {baseUrl}/v1/models + x-api-key + anthropic-version 头', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({
      body: JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-4-1' }] }),
    }));
    const merged = await discoverProviderModels('claude', makeConfig(), { fetchImpl, auth: AUTH, env: {} });
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.anthropic.com/v1/models' });
    expect(requests[0]!.headers['x-api-key']).toBe('test-key-claude');
    expect(requests[0]!.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(merged).toEqual({
      'claude-sonnet-4-5': { maxOutputTokens: 64000 },
      'claude-opus-4-1': {},
    });
  });

  it('key 解析顺序与工厂同口径：auth.json 优先，env 兜底（envKey 声明时）', async () => {
    const { fetchImpl, requests } = stubFetch(() => ({ body: '{"data":[]}' }));
    const config = makeConfig({
      deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY' },
    });
    await discoverProviderModels('deepseek', config, {
      fetchImpl,
      auth: { channels: {} },
      env: { DEEPSEEK_API_KEY: 'test-env-key' },
    });
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-env-key');
  });

  it('fail-closed：渠道不存在 / 缺 key → ConfigError（消息不含 key）', async () => {
    await expect(discoverProviderModels('ghost', makeConfig(), { auth: AUTH })).rejects.toThrow(ConfigError);
    await expect(discoverProviderModels('deepseek', makeConfig(), { auth: { channels: {} }, env: {} })).rejects.toThrow(
      /缺少 API key/,
    );
  });

  it('fail-closed：非 2xx（401/500）→ ProviderError 带规范化 code；错误体脱敏', async () => {
    const leakBody = '{"error":{"message":"invalid x-api-key: sk-test-key-claude"}}';
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: leakBody }));
    // 响应体可能回显 key：错误出口必须脱敏——消息含 [REDACTED]、绝不含明文 key
    const err = await discoverProviderModels('claude', makeConfig(), { fetchImpl, auth: AUTH }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[REDACTED]');
    expect((err as Error).message).not.toContain('sk-test-key-claude');
    expect((err as { code?: string }).code).toBe('401');

    const { fetchImpl: fetch5xx } = stubFetch(() => ({ status: 503, body: 'overloaded' }));
    await expect(
      discoverProviderModels('claude', makeConfig(), { fetchImpl: fetch5xx, auth: AUTH }),
    ).rejects.toMatchObject({
      code: 'server_5xx',
    });
  });

  it('fail-closed：网络失败 / 非 JSON / 形状非法（含缺 id 条目）→ ProviderError，绝不返回部分列表', async () => {
    const failing: typeof fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      discoverProviderModels('deepseek', makeConfig(), { fetchImpl: failing, auth: AUTH }),
    ).rejects.toMatchObject({
      code: 'network',
    });

    const badJson = stubFetch(() => ({ body: 'not-json{{' }));
    await expect(
      discoverProviderModels('deepseek', makeConfig(), { fetchImpl: badJson.fetchImpl, auth: AUTH }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const missingId = stubFetch(() => ({ body: '{"data":[{"id":"ok"},{"object":"model"}]}' }));
    await expect(
      discoverProviderModels('deepseek', makeConfig(), { fetchImpl: missingId.fetchImpl, auth: AUTH }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('超时 >10s → ProviderError(code=timeout)；注入 fetch 收到 abort signal', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null | undefined;
    const hanging: typeof fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
      });
    }) as typeof fetch;
    const pending = discoverProviderModels('deepseek', makeConfig(), { fetchImpl: hanging, auth: AUTH });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_TIMEOUT_MS + 1);
    await assertion;
    expect(observedSignal?.aborted).toBe(true);
    // 红线：超时上限 ≤ 10s
    expect(MODEL_DISCOVERY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
