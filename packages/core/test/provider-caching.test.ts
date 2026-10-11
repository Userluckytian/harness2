// Z6-A02 Prompt caching 测试：anthropic 稳定前缀 cache_control 组装（纯函数 + 本地 stub
// wire 形态）、usage 缓存 token 加性透出（anthropic cache_read/creation + openai
// prompt_tokens_details.cached_tokens）、红线⑨（cache_control 绝不出现在 messages[]）。
import { afterEach, describe, expect, it } from 'vitest';
import { startSseStub, type StubServer } from './helpers/sse-stub.js';
import { AnthropicProvider, toAnthropicSystemParam, toAnthropicTools } from '../src/provider/anthropic.js';
import { OpenAICompatProvider } from '../src/provider/openai.js';
import type { ChatRequest, ProviderUsage, StreamChunk, ToolSpec } from '../src/provider/types.js';

const servers: StubServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(): Promise<StubServer> {
  const s = await startSseStub();
  servers.push(s);
  return s;
}

const ANTHROPIC_TEXT_EVENTS = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
  'data: {"type":"message_stop"}',
];

const OPENAI_CACHED_FRAMES = [
  'data: {"choices":[{"delta":{"content":"你好"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":24}}}',
  'data: [DONE]',
];

async function collect(provider: OpenAICompatProvider | AnthropicProvider, req: ChatRequest): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of provider.streamChat(req)) chunks.push(c);
  return chunks;
}

function makeAnthropic(baseUrl: string): AnthropicProvider {
  return new AnthropicProvider({
    name: 'anthropic/claude-sonnet-4-5',
    baseUrl,
    apiKey: 'test-key-local-stub',
    model: 'claude-sonnet-4-5',
  });
}

const TOOLS: ToolSpec[] = [
  { name: 'read', description: '读文件', parameters: { type: 'object' } },
  { name: 'bash', description: '跑命令', parameters: { type: 'object' } },
];

describe('toAnthropicSystemParam / toAnthropicTools（纯函数）', () => {
  it('cacheStablePrefix=false → system 保持 string、工具无 cache_control（旧 wire 零变化）', () => {
    expect(toAnthropicSystemParam('sys', false)).toBe('sys');
    const tools = toAnthropicTools(TOOLS, false);
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => !('cache_control' in (t as Record<string, unknown>)))).toBe(true);
  });

  it('cacheStablePrefix=true → system 单文本块带 ephemeral；仅最后一个工具带 cache_control', () => {
    expect(toAnthropicSystemParam('sys', true)).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    const tools = toAnthropicTools(TOOLS, true) as Array<Record<string, unknown>>;
    expect(tools[0]!).not.toHaveProperty('cache_control');
    expect(tools[1]!['cache_control']).toEqual({ type: 'ephemeral' });
    // 名称/schema 等字段保持不变
    expect(tools[1]!['name']).toBe('bash');
    expect(tools[1]!['input_schema']).toEqual({ type: 'object' });
  });

  it('空 system / 无工具 → 组装器各自保持原语义（不产生空数组断点）', () => {
    expect(toAnthropicSystemParam('', true)).toBe('');
    expect(toAnthropicTools([], true)).toEqual([]);
  });
});

describe('A02 anthropic wire（本地 stub server）', () => {
  it('cacheStablePrefix=true：system 参数变块数组 + 末位工具带断点；messages[] 绝不携带 cache_control（红线⑨）', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    const provider = makeAnthropic(stub.url);
    await collect(provider, {
      system: '你是 harness2',
      tools: TOOLS,
      messages: [
        { role: 'user', content: '第一个问题' },
        { role: 'assistant', content: '第一个回答' },
        { role: 'user', content: '第二个问题' },
      ],
      cacheStablePrefix: true,
    });

    const body = stub.requests[0]!.body as {
      system: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
      messages: Array<Record<string, unknown>>;
    };
    expect(body.system).toEqual([{ type: 'text', text: '你是 harness2', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[0]!).not.toHaveProperty('cache_control');
    expect(body.tools.at(-1)!['cache_control']).toEqual({ type: 'ephemeral' });
    // 红线⑨：缓存边界只打在 system/工具定义，消息体（含最后一条 user）绝不携带标记
    for (const message of body.messages) {
      expect(message).not.toHaveProperty('cache_control');
      expect(JSON.stringify(message)).not.toContain('cache_control');
    }
  });

  it('cacheStablePrefix 缺省 → wire 与旧版完全一致（无 cache_control）', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    const provider = makeAnthropic(stub.url);
    await collect(provider, { system: 'sys', tools: TOOLS, messages: [{ role: 'user', content: 'x' }] });
    const raw = stub.requests[0]!.rawBody;
    expect(raw).not.toContain('cache_control');
  });
});

describe('A02 usage 缓存 token 透出（加性，旧消费者零破坏）', () => {
  it('anthropic：message_start 的 cache_read/creation → usage.cacheReadTokens/cacheWriteTokens', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    const provider = makeAnthropic(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const usage = chunks.find((c) => c.type === 'usage') as { usage: ProviderUsage } | undefined;
    expect(usage).toBeDefined();
    expect(usage!.usage).toEqual({ inputTokens: 12, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 50 });
  });

  it('anthropic：上游不报告缓存字段 → usage 无该键（不臆造 0）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
        'data: {"type":"message_stop"}',
      ],
    });
    const provider = makeAnthropic(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const usage = chunks.find((c) => c.type === 'usage') as { usage: ProviderUsage };
    expect(usage.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect('cacheReadTokens' in usage.usage).toBe(false);
    expect('cacheWriteTokens' in usage.usage).toBe(false);
  });

  it('openai 兼容：prompt_tokens_details.cached_tokens → usage.cacheReadTokens（同 usage 通道）', async () => {
    const stub = await start();
    stub.enqueue({ sse: OPENAI_CACHED_FRAMES });
    const provider = new OpenAICompatProvider({
      name: 'deepseek/deepseek-chat',
      baseUrl: stub.url,
      apiKey: 'test-key-local-stub',
      model: 'deepseek-chat',
    });
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const usage = chunks.find((c) => c.type === 'usage') as { usage: ProviderUsage };
    expect(usage.usage).toEqual({ inputTokens: 30, outputTokens: 5, cacheReadTokens: 24 });
  });

  it('openai 兼容：无 prompt_tokens_details → usage 形态与旧版一致', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
        'data: [DONE]',
      ],
    });
    const provider = new OpenAICompatProvider({
      name: 'deepseek/deepseek-chat',
      baseUrl: stub.url,
      apiKey: 'test-key-local-stub',
      model: 'deepseek-chat',
    });
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const usage = chunks.find((c) => c.type === 'usage') as { usage: ProviderUsage };
    expect(usage.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
});
