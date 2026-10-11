// Z6-A03 推理档位测试：resolveReasoningEffort / 预算映射表（纯函数 fixture 驱动）+
// provider 请求组装 wire 形态（openai reasoning_effort 透传 / anthropic thinking 映射，
// 走本地 stub server，零真实 API）+ config schema 新字段校验交叉覆盖见 config.test.ts。
import { afterEach, describe, expect, it } from 'vitest';
import { startSseStub, type StubServer } from './helpers/sse-stub.js';
import { OpenAICompatProvider } from '../src/provider/openai.js';
import { AnthropicProvider } from '../src/provider/anthropic.js';
import {
  REASONING_LEVEL_TO_THINKING_BUDGET,
  reasoningEffortToAnthropicThinking,
  resolveReasoningEffort,
} from '../src/provider/reasoning.js';
import { createProvider } from '../src/provider/factory.js';
import { ConfigError, type AuthFile, type HarnessConfig } from '../src/config/index.js';
import type { ChatRequest, StreamChunk } from '../src/provider/types.js';

const servers: StubServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(): Promise<StubServer> {
  const s = await startSseStub();
  servers.push(s);
  return s;
}

const OPENAI_TEXT_FRAMES = [
  'data: {"choices":[{"delta":{"content":"你好"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
];

const ANTHROPIC_TEXT_EVENTS = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
  'data: {"type":"message_stop"}',
];

async function collect(provider: OpenAICompatProvider | AnthropicProvider, req: ChatRequest): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of provider.streamChat(req)) chunks.push(c);
  return chunks;
}

describe('resolveReasoningEffort（纯函数）', () => {
  it('模型未声明 reasoning → undefined（档位配了也不发：fail-silent）', () => {
    expect(resolveReasoningEffort({ roleEffort: 'high' })).toBeUndefined();
    expect(resolveReasoningEffort({ roleEffort: 'high', reasoning: undefined })).toBeUndefined();
    expect(resolveReasoningEffort({ roleEffort: 'high', reasoning: { values: [] } })).toBeUndefined();
  });

  it('模型声明但档位未配置且无 default → undefined；有 default → 回退 default', () => {
    const spec = { values: ['low', 'high', 'max'] };
    expect(resolveReasoningEffort({ reasoning: spec })).toBeUndefined();
    // default 不在 values 内同样算无效档位（schema 已拦一道，这里纵深防御）
    expect(() => resolveReasoningEffort({ reasoning: { ...spec, default: 'medium' } })).toThrow(ConfigError);
    expect(resolveReasoningEffort({ reasoning: { values: ['low', 'high'], default: 'high' } })).toBe('high');
  });

  it('role.effort 优先于 default', () => {
    expect(
      resolveReasoningEffort({
        roleEffort: 'low',
        reasoning: { values: ['low', 'high'], default: 'high' },
      }),
    ).toBe('low');
  });

  it('无效档位（不在 values 内）→ ConfigError（纵深防御；schema 已拦一道）', () => {
    expect(() => resolveReasoningEffort({ roleEffort: 'ultra', reasoning: { values: ['low', 'high'] } })).toThrow(
      ConfigError,
    );
    expect(() => resolveReasoningEffort({ reasoning: { values: ['low', 'high'], default: 'bogus' } })).toThrow(
      ConfigError,
    );
  });
});

describe('reasoningEffortToAnthropicThinking（显式预算映射表）', () => {
  it('已知档位 → thinking {type:enabled, budget_tokens}', () => {
    expect(reasoningEffortToAnthropicThinking('minimal')).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(reasoningEffortToAnthropicThinking('low')).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(reasoningEffortToAnthropicThinking('medium')).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(reasoningEffortToAnthropicThinking('high')).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(reasoningEffortToAnthropicThinking('xhigh')).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(reasoningEffortToAnthropicThinking('max')).toEqual({ type: 'enabled', budget_tokens: 32768 });
    expect(reasoningEffortToAnthropicThinking('enabled')).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('映射表 ≥ Anthropic 协议下限 1024；未知/「关」语义档位 → undefined（不发参数）', () => {
    for (const budget of Object.values(REASONING_LEVEL_TO_THINKING_BUDGET)) {
      expect(budget).toBeGreaterThanOrEqual(1024);
    }
    expect(reasoningEffortToAnthropicThinking('disabled')).toBeUndefined();
    expect(reasoningEffortToAnthropicThinking('none')).toBeUndefined();
    expect(reasoningEffortToAnthropicThinking('off')).toBeUndefined();
    expect(reasoningEffortToAnthropicThinking('ultra')).toBeUndefined();
  });
});

describe('A03 wire 组装（本地 stub server）', () => {
  it('openai 协议：reasoningEffort → reasoning_effort 透传；未配置 → 字段不出现', async () => {
    const stub = await start();
    stub.enqueue({ sse: OPENAI_TEXT_FRAMES });
    stub.enqueue({ sse: OPENAI_TEXT_FRAMES });
    const withEffort = new OpenAICompatProvider({
      name: 'deepseek/deepseek-reasoner',
      baseUrl: stub.url,
      apiKey: 'test-key-local-stub',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    await collect(withEffort, { messages: [{ role: 'user', content: 'x' }] });
    expect((stub.requests[0]!.body as Record<string, unknown>)['reasoning_effort']).toBe('high');

    const without = new OpenAICompatProvider({
      name: 'deepseek/deepseek-chat',
      baseUrl: stub.url,
      apiKey: 'test-key-local-stub',
      model: 'deepseek-chat',
    });
    await collect(without, { messages: [{ role: 'user', content: 'x' }] });
    expect(stub.requests[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('anthropic 协议：reasoningEffort → thinking 按映射表；表外档位 → 字段不出现', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    const withEffort = new AnthropicProvider({
      name: 'anthropic/claude-sonnet-4-5',
      baseUrl: stub.url,
      apiKey: 'test-key-local-stub',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'xhigh',
    });
    await collect(withEffort, { messages: [{ role: 'user', content: 'x' }] });
    expect((stub.requests[0]!.body as Record<string, unknown>)['thinking']).toEqual({
      type: 'enabled',
      budget_tokens: 16384,
    });

    const tableOut = new AnthropicProvider({
      name: 'anthropic/claude-sonnet-4-5',
      baseUrl: stub.url,
      apiKey: 'test-key-local-stub',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'disabled',
    });
    await collect(tableOut, { messages: [{ role: 'user', content: 'x' }] });
    expect(stub.requests[1]!.body).not.toHaveProperty('thinking');
  });

  it('工厂接线：role.effort 经 resolveReasoningEffort 进入 provider 请求', async () => {
    const stub = await start();
    stub.enqueue({ sse: OPENAI_TEXT_FRAMES });
    const config: HarnessConfig = {
      providers: {
        deepseek: {
          protocol: 'openai',
          baseUrl: stub.url,
          models: { 'deepseek-reasoner': { reasoning: { values: ['low', 'high'], default: 'low' } } },
        },
      },
      roles: { main: { channel: 'deepseek', model: 'deepseek-reasoner', effort: 'high' } },
      approval: {},
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: false, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 25 },
    };
    const auth: AuthFile = { channels: { deepseek: { apiKey: 'test-auth-key' } } };
    const provider = createProvider(config, 'main', { auth, env: {} });
    for await (const _ of provider.streamChat({ messages: [{ role: 'user', content: 'x' }] })) break;
    expect((stub.requests[0]!.body as Record<string, unknown>)['reasoning_effort']).toBe('high');
  });

  it('工厂接线：role.effort 缺省回退 reasoning.default；无效 effort → ConfigError', async () => {
    const stub = await start();
    stub.enqueue({ sse: OPENAI_TEXT_FRAMES });
    const base: HarnessConfig = {
      providers: {
        deepseek: {
          protocol: 'openai',
          baseUrl: stub.url,
          models: { 'deepseek-reasoner': { reasoning: { values: ['low', 'high'], default: 'low' } } },
        },
      },
      roles: { main: { channel: 'deepseek', model: 'deepseek-reasoner' } },
      approval: {},
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: false, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 25 },
    };
    const auth: AuthFile = { channels: { deepseek: { apiKey: 'test-auth-key' } } };
    const provider = createProvider(base, 'main', { auth, env: {} });
    for await (const _ of provider.streamChat({ messages: [{ role: 'user', content: 'x' }] })) break;
    expect((stub.requests[0]!.body as Record<string, unknown>)['reasoning_effort']).toBe('low');

    const invalid: HarnessConfig = {
      ...base,
      roles: { main: { channel: 'deepseek', model: 'deepseek-reasoner', effort: 'ultra' } },
    };
    expect(() => createProvider(invalid, 'main', { auth, env: {} })).toThrow(ConfigError);
  });
});
