// 真实 provider 协议测试：全部走 127.0.0.1 本地 stub server（CI 零真实 API）。
// Task 2: OpenAI-compatible（SSE 流式 / tool_calls 增量组装 / reasoning_content / usage /
//         错误脱敏 / 半帧断流 / abort / 多字节跨 chunk）。
// Task 3: Anthropic Messages API（事件映射 / tool_use+tool_result / thinking / 错误脱敏）。
import { afterEach, describe, expect, it } from 'vitest';
import { startSseStub, type StubServer } from './helpers/sse-stub.js';
import { OpenAICompatProvider, toOpenAIWireMessages } from '../src/provider/openai.js';
import { ANTHROPIC_VERSION, AnthropicProvider, toAnthropicWireMessages } from '../src/provider/anthropic.js';
import { ProviderError } from '../src/provider/types.js';
import type { ChatMessage, ChatRequest, StreamChunk } from '../src/provider/types.js';

const servers: StubServer[] = [];
const e2eDirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of e2eDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<StubServer> {
  const s = await startSseStub();
  servers.push(s);
  return s;
}

function makeProvider(baseUrl: string, name = 'deepseek/deepseek-chat'): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name,
    baseUrl,
    apiKey: 'test-key-local-stub', // 假 key：仅打本地 stub，非真实密钥
    model: 'deepseek-chat',
  });
}

async function collect(provider: OpenAICompatProvider | AnthropicProvider, req: ChatRequest): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of provider.streamChat(req)) chunks.push(c);
  return chunks;
}

const TEXT_FRAMES = [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  'data: {"choices":[{"delta":{"content":"你好"}}]}',
  'data: {"choices":[{"delta":{"content":"，世界"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
];

describe('OpenAI-compatible：SSE 流式与 wire 请求', () => {
  it('纯文本流：多帧 content → text-delta 序列 + done(end_turn)；请求 wire 形态正确', async () => {
    const stub = await start();
    stub.enqueue({ sse: TEXT_FRAMES });
    const provider = makeProvider(stub.url);

    const chunks = await collect(provider, { messages: [{ role: 'user', content: '打个招呼' }] });

    const texts = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text);
    expect(texts).toEqual(['你好', '，世界']);
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });

    const req = stub.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/chat/completions');
    expect(req.headers['authorization']).toBe('Bearer test-key-local-stub');
    expect(req.body).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      messages: [{ role: 'user', content: '打个招呼' }],
    });
    expect((req.body as { tools?: unknown }).tools).toBeUndefined();
  });

  it('tools 规格与 tool 结果消息的 wire 映射（function 格式 / tool_call_id）', async () => {
    const stub = await start();
    stub.enqueue({ sse: TEXT_FRAMES });
    const provider = makeProvider(stub.url);
    await collect(provider, {
      messages: [
        { role: 'user', content: '读文件' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
        },
        { role: 'tool', content: 'hello', toolCallId: 'call-1', name: 'read_file' },
      ],
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }],
    });

    const body = stub.requests[0]!.body as {
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'hello' });
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } } },
    ]);
  });

  it('tool_calls 跨帧增量组装：按 index 累积 id/name/arguments 字符串拼接，done=tool_use', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"write","arguments":"{\\"path\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\",\\"content\\":\\"hi\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: '写文件' }] });

    const calls = chunks.filter((c) => c.type === 'tool-call').map((c) => (c as { call: { id: string; name: string; arguments: string } }).call);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: 'call-a', name: 'write', arguments: '{"path":"a.txt","content":"hi"}' });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('多工具并发 index 各自累积；arguments 为坏 JSON 时原样透传（解析归 agent loop）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-b","function":{"name":"t2","arguments":"{\\"x\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"t1","arguments":"not-json"}}]}}]}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const calls = chunks.filter((c) => c.type === 'tool-call').map((c) => (c as { call: { id: string; arguments: string } }).call);
    expect(calls).toEqual([
      { id: 'call-a', name: 't1', arguments: 'not-json' },
      { id: 'call-b', name: 't2', arguments: '{"x":' },
    ]);
  });

  it('P2-5 回归：两个无 index 的完整 tool_calls → 两个独立调用（不并进槽 0）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"t1","arguments":"{\\"x\\":1}"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-2","function":{"name":"t2","arguments":"{\\"y\\":2}"}}]}}]}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const calls = chunks
      .filter((c) => c.type === 'tool-call')
      .map((c) => (c as { call: { id: string; name: string; arguments: string } }).call);
    expect(calls).toEqual([
      { id: 'call-1', name: 't1', arguments: '{"x":1}' },
      { id: 'call-2', name: 't2', arguments: '{"y":2}' },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('P2-5 回归：无 id 同名 name-only delta 延续累积（不重复拼接 name、不另开新槽）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"t1","arguments":"{\\"x\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"t1","arguments":"1}"}}]}}]}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    const calls = chunks
      .filter((c) => c.type === 'tool-call')
      .map((c) => (c as { call: { id: string; name: string; arguments: string } }).call);
    expect(calls).toEqual([{ id: 'call-1', name: 't1', arguments: '{"x":1}' }]);
  });

  it('P2-4 回归：finish_reason length/content_filter 透传为对应 stopReason（不再折叠为 end_turn）', async () => {
    const stub = await start();
    stub.enqueueAll([
      { sse: ['data: {"choices":[{"delta":{"content":"写到一半"},"finish_reason":"length"}]}', 'data: [DONE]'] },
      { sse: ['data: {"choices":[{"delta":{"content":"违禁内容"},"finish_reason":"content_filter"}]}', 'data: [DONE]'] },
    ]);
    const provider = makeProvider(stub.url);
    const first = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    expect(first.at(-1)).toEqual({ type: 'done', stopReason: 'length' });
    const second = await collect(provider, { messages: [{ role: 'user', content: 'x' }] });
    expect(second.at(-1)).toEqual({ type: 'done', stopReason: 'content_filter' });
  });

  it('reasoning_content → reasoning-delta；usage 帧 → usage chunk', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}',
        'data: {"choices":[{"delta":{"content":"答案是 4"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: '1+1?' }] });

    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text);
    expect(reasoning).toEqual(['让我想想']);
    const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } };
    expect(usage.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('多字节 UTF-8 跨 TCP chunk：中文字符被拆在两个网络帧也能正确解码', async () => {
    const stub = await start();
    // 单帧含中文 + [DONE]；把「世」的 3 字节 UTF-8 序列切成两段分别 write
    const frame =
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好，世界' } }] }) + '\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(frame);
    const shiCharIdx = frame.indexOf('世');
    const shiByteIdx = new TextEncoder().encode(frame.slice(0, shiCharIdx)).length;
    stub.enqueue({ rawBytes: [bytes.slice(0, shiByteIdx + 1), bytes.slice(shiByteIdx + 1)] }); // 切进多字节序列中间
    const provider = makeProvider(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: 'hi' }] });
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { text: string }).text)
      .join('');
    expect(text).toBe('你好，世界');
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });
});

describe('OpenAI-compatible：错误与异常路径', () => {
  it('HTTP 401：错误含状态码与 body 摘要，但厂商回显的 key 被脱敏', async () => {
    const stub = await start();
    stub.enqueue({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: '{"error":{"message":"Invalid API key provided: sk-real-secret-9911","type":"auth_error"}}',
    });
    const provider = makeProvider(stub.url);
    const err = await collect(provider, { messages: [{ role: 'user', content: 'x' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    const msg = (err as Error).message;
    expect(msg).toContain('401');
    expect(msg).not.toContain('sk-real-secret-9911');
    expect(msg.length).toBeLessThanOrEqual(300); // body 摘要 ≤200 + 前缀
  });

  it('断流半帧：连接被销毁且未收到 [DONE] → ProviderError（不冒充完整回复、不悬挂）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: ['data: {"choices":[{"delta":{"content":"你"}}]}'],
      rawTail: 'data: {"choices":[{"delta":{"conte', // 半帧后 destroy
      destroy: true,
    });
    const provider = makeProvider(stub.url);
    await expect(collect(provider, { messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'stream_truncated',
    });
  });

  it('abort：流式中触发 signal → ProviderError(cancelled)，快速短路', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"choices":[{"delta":{"content":"第一段"}}]}',
        'data: {"choices":[{"delta":{"content":"第二段"}}]}',
        'data: {"choices":[{"delta":{"content":"第三段"}}]}',
        'data: [DONE]',
      ],
      frameDelayMs: 60,
    });
    const provider = makeProvider(stub.url);
    const ac = new AbortController();
    const iter = provider.streamChat({ messages: [{ role: 'user', content: 'x' }] }, { signal: ac.signal })[
      Symbol.asyncIterator
    ]();
    const first = await iter.next();
    expect((first.value as { type: string }).type).toBe('text-delta');
    ac.abort();
    await expect(iter.next()).rejects.toMatchObject({ name: 'ProviderError', message: 'cancelled' });
  }, 8000);

  it('P1-1 回归：流中错误帧+[DONE] → 脱敏抛 ProviderError（不再吞成空成功回复）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"error":{"message":"Insufficient Balance","type":"invalid_request_error"}}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    await expect(collect(provider, { messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'invalid_request',
      message: expect.stringContaining('Insufficient Balance'),
    });
  });

  it('P1-1 回归：错误帧且无 [DONE] → 保留错误帧 code（不被误报 stream_truncated）', async () => {
    const stub = await start();
    stub.enqueue({ sse: ['data: {"error":{"message":"boom","type":"server_error"}}'] });
    const provider = makeProvider(stub.url);
    await expect(collect(provider, { messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'server_error',
    });
  });

  it('P1-1 回归：错误帧 message 含假 key → 输出已脱敏', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"error":{"message":"Invalid API key provided: sk-real-secret-9911","type":"authentication_error"}}',
        'data: [DONE]',
      ],
    });
    const provider = makeProvider(stub.url);
    const err = await collect(provider, { messages: [{ role: 'user', content: 'x' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    const msg = (err as Error).message;
    expect(msg).not.toContain('sk-real-secret-9911');
    expect(msg).toContain('[REDACTED]');
    expect((err as { code?: string }).code).toBe('auth_error');
  });

  it('连接被拒（无服务）→ ProviderError(network) 且消息脱敏', async () => {
    // 使用一个确定没人监听的端口
    const provider = makeProvider('http://127.0.0.1:1');
    const err = await collect(provider, { messages: [{ role: 'user', content: 'x' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as { code?: string }).code).toBe('network');
  });
});

describe('toOpenAIWireMessages 纯函数', () => {
  it('user/assistant(+toolCalls)/tool 三种形态', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 'r', toolCallId: 'c1', name: 't' },
    ];
    expect(toOpenAIWireMessages(messages)).toEqual([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ]);
  });
});

// ---------- ChatRequest.system 缝（阶段 6：记忆快照注入；加性可选） ----------

describe('ChatRequest.system wire 映射', () => {
  it('openai：system → 首条 {role:"system"} 消息；缺省时消息列表不变', async () => {
    const stub = await start();
    stub.enqueueAll([{ sse: TEXT_FRAMES }, { sse: TEXT_FRAMES }]);
    const provider = makeProvider(stub.url);

    await collect(provider, { system: '你是记忆增强助手', messages: [{ role: 'user', content: 'u1' }] });
    await collect(provider, { messages: [{ role: 'user', content: 'u2' }] });

    const withSystem = (stub.requests[0]!.body as { messages: Array<{ role: string; content: string }> }).messages;
    expect(withSystem[0]).toEqual({ role: 'system', content: '你是记忆增强助手' });
    expect(withSystem.at(-1)).toEqual({ role: 'user', content: 'u1' });

    const withoutSystem = (stub.requests[1]!.body as { messages: Array<{ role: string; content: string }> }).messages;
    expect(withoutSystem).toEqual([{ role: 'user', content: 'u2' }]);
  });

  it('anthropic：system → 顶层 system 参数；缺省时不发送该键', async () => {
    const stub = await start();
    stub.enqueueAll([{ sse: ANTHROPIC_TEXT_EVENTS }, { sse: ANTHROPIC_TEXT_EVENTS }]);
    const provider = makeAnthropic(stub.url);

    await collect(provider, { system: '记忆快照内容', messages: [{ role: 'user', content: 'u1' }] });
    await collect(provider, { messages: [{ role: 'user', content: 'u2' }] });

    const body1 = stub.requests[0]!.body as { system?: string; messages: unknown[] };
    expect(body1.system).toBe('记忆快照内容');
    expect(body1.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'u1' }] }]);
    const body2 = stub.requests[1]!.body as { system?: string };
    expect(body2.system).toBeUndefined();
  });
});

// ---------- Anthropic ----------

function makeAnthropic(baseUrl: string, name = 'anthropic/claude-sonnet-4-5'): AnthropicProvider {
  return new AnthropicProvider({
    name,
    baseUrl,
    apiKey: 'test-key-local-stub', // 假 key：仅打本地 stub，非真实密钥
    model: 'claude-sonnet-4-5',
  });
}

const ANTHROPIC_TEXT_EVENTS = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，世界"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
  'data: {"type":"message_stop"}',
];

describe('Anthropic：SSE 事件与 wire 请求', () => {
  it('纯文本流：text_delta → text-delta；usage 合并 input/output；done(end_turn)', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    const provider = makeAnthropic(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: '打个招呼' }] });

    const texts = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text);
    expect(texts).toEqual(['你好', '，世界']);
    const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } };
    expect(usage.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });

    const req = stub.requests[0]!;
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe('test-key-local-stub');
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    const body = req.body as { model: string; max_tokens: number; stream: boolean; messages: unknown[] };
    expect(body).toMatchObject({ model: 'claude-sonnet-4-5', stream: true });
    expect(body.max_tokens).toBeGreaterThan(0); // Anthropic 必填
  });

  it('tool_use：input_json_delta 累积 → content_block_stop 发 tool-call；done=tool_use', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu-1","name":"write"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}',
        'data: {"type":"message_stop"}',
      ],
    });
    const provider = makeAnthropic(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: '写文件' }] });

    const calls = chunks.filter((c) => c.type === 'tool-call').map((c) => (c as { call: unknown }).call);
    expect(calls).toEqual([{ id: 'toolu-1', name: 'write', arguments: '{"path":"a.txt"}' }]);
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('thinking_delta → reasoning-delta（Anthropic 扩展思考）', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先算一下"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案是 4"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}',
        'data: {"type":"message_stop"}',
      ],
    });
    const provider = makeAnthropic(stub.url);
    const chunks = await collect(provider, { messages: [{ role: 'user', content: '1+1?' }] });
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text);
    expect(reasoning).toEqual(['先算一下']);
    const texts = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text);
    expect(texts).toEqual(['答案是 4']);
  });

  it('wire 映射：连续 tool 消息与相邻 user 合并（P1-2：末条 user 含 tool_result+text 两块，不产生连续 user 消息）；assistant.toolCalls → tool_use 块', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    const provider = makeAnthropic(stub.url);
    await collect(provider, {
      messages: [
        { role: 'user', content: '写并读' },
        {
          role: 'assistant',
          content: '好的',
          toolCalls: [
            { id: 'toolu-1', name: 'write', arguments: '{"path":"a.txt"}' },
            { id: 'toolu-2', name: 'read', arguments: '{"path":"a.txt"}' },
          ],
        },
        { role: 'tool', content: 'written', toolCallId: 'toolu-1', name: 'write' },
        { role: 'tool', content: 'hello', toolCallId: 'toolu-2', name: 'read' },
        { role: 'user', content: '继续' },
      ],
      tools: [{ name: 'write', description: '写文件', parameters: { type: 'object', properties: {} } }],
    });

    const body = stub.requests[0]!.body as {
      messages: Array<{ role: string; content: unknown }>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '写并读' }] });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'toolu-1', name: 'write', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'toolu-2', name: 'read', input: { path: 'a.txt' } },
      ],
    });
    // P1-2：tool_result 与后续 user 文本合并为同一条 user 消息（Anthropic 要求 user/assistant 交替）
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu-1', content: 'written' },
        { type: 'tool_result', tool_use_id: 'toolu-2', content: 'hello' },
        { type: 'text', text: '继续' },
      ],
    });
    expect(body.messages).toHaveLength(3); // 不再出现连续 user 消息
    expect(body.tools).toEqual([
      { name: 'write', description: '写文件', input_schema: { type: 'object', properties: {} } },
    ]);
  });
});

describe('Anthropic：错误与异常路径', () => {
  it('HTTP 401：错误含状态码、key 回显被脱敏', async () => {
    const stub = await start();
    stub.enqueue({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key: sk-ant-real-secret-77"}}',
    });
    const provider = makeAnthropic(stub.url);
    const err = await collect(provider, { messages: [{ role: 'user', content: 'x' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    const msg = (err as Error).message;
    expect(msg).toContain('401');
    expect(msg).not.toContain('sk-ant-real-secret-77');
  });

  it('error 事件（overloaded_error）→ ProviderError 且脱敏', async () => {
    const stub = await start();
    stub.enqueue({
      sse: ['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded with token=secret-tok-1122"}}'],
    });
    const provider = makeAnthropic(stub.url);
    const err = await collect(provider, { messages: [{ role: 'user', content: 'x' }] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    const msg = (err as Error).message;
    expect(msg).toContain('overloaded_error');
    expect(msg).not.toContain('secret-tok-1122');
    // P2-3：error 事件保留原 code，不被 catch 误包成 stream_truncated
    expect((err as { code?: string }).code).toBe('api_error');
  });

  it('P2-4 回归：stop_reason max_tokens/refusal/pause_turn 透传（pause_turn → paused）', async () => {
    const stub = await start();
    const frame = (reason: string) =>
      `data: {"type":"message_delta","delta":{"stop_reason":"${reason}"},"usage":{"output_tokens":1}}`;
    stub.enqueueAll([
      { sse: [frame('max_tokens'), 'data: {"type":"message_stop"}'] },
      { sse: [frame('refusal'), 'data: {"type":"message_stop"}'] },
      { sse: [frame('pause_turn'), 'data: {"type":"message_stop"}'] },
    ]);
    const provider = makeAnthropic(stub.url);
    const req: ChatRequest = { messages: [{ role: 'user', content: 'x' }] };
    expect((await collect(provider, req)).at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
    expect((await collect(provider, req)).at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
    expect((await collect(provider, req)).at(-1)).toEqual({ type: 'done', stopReason: 'paused' });
  });

  it('断流半帧：未收到 message_stop → stream_truncated', async () => {
    const stub = await start();
    stub.enqueue({
      sse: ['data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}'],
      rawTail: 'data: {"type":"content_block_delta","inde',
      destroy: true,
    });
    const provider = makeAnthropic(stub.url);
    await expect(collect(provider, { messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'stream_truncated',
    });
  });

  it('abort：流式中触发 signal → ProviderError(cancelled)', async () => {
    const stub = await start();
    stub.enqueue({
      sse: [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"第一段"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"第二段"}}',
        'data: {"type":"message_stop"}',
      ],
      frameDelayMs: 60,
    });
    const provider = makeAnthropic(stub.url);
    const ac = new AbortController();
    const iter = provider.streamChat({ messages: [{ role: 'user', content: 'x' }] }, { signal: ac.signal })[
      Symbol.asyncIterator
    ]();
    const first = await iter.next();
    expect((first.value as { type: string }).type).toBe('text-delta');
    ac.abort();
    await expect(iter.next()).rejects.toMatchObject({ name: 'ProviderError', message: 'cancelled' });
  }, 8000);
});

describe('toAnthropicWireMessages 纯函数', () => {
  it('坏 JSON arguments 兜底为 {}（wire 层必须给合法 input）', () => {
    const wire = toAnthropicWireMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', arguments: 'not-json' }] },
    ]) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(wire[0]!.content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'x', input: {} });
  });

  it('P1-2 回归：[user, assistant(tool_use), tool, user] → user/assistant/user 三条，末条 user 含 tool_result+text 两块', () => {
    const wire = toAnthropicWireMessages([
      { role: 'user', content: '写文件' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu-1', name: 'write', arguments: '{}' }] },
      { role: 'tool', content: 'written', toolCallId: 'toolu-1', name: 'write' },
      { role: 'user', content: '继续' },
    ]) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(wire[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu-1', content: 'written' },
      { type: 'text', text: '继续' },
    ]);
  });
});

// ---------- Task 4: 工厂 + 端到端（runTurn × stub server） ----------

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider, resolveApiKey } from '../src/provider/factory.js';
import { ConfigError, type AuthFile, type HarnessConfig } from '../src/config/index.js';
import { runTurn } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { loadSession } from '../src/session/reader.js';

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-e2e-'));
  e2eDirs.push(d);
  return d;
}

const FACTORY_CONFIG: HarnessConfig = {
  providers: {
    deepseek: {
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      envKey: 'DEEPSEEK_API_KEY',
      models: { 'deepseek-chat': { contextWindow: 128000, maxOutputTokens: 8192 } },
    },
    claude: {
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      models: { 'claude-sonnet-4-5': { maxOutputTokens: 64000 } },
    },
  },
  roles: {
    main: { channel: 'deepseek', model: 'deepseek-chat' },
    subagent: { channel: 'claude', model: 'claude-sonnet-4-5' },
  },
  approval: { mode: 'default' },
  memory: { mode: 'off', nudgeInterval: 10 },
  browser: { enabled: false, idleDestroyMs: 300000, maxConcurrent: 2 },
  plugins: { enabled: true, allow: [] },
};

describe('createProvider 工厂', () => {
  const auth: AuthFile = { channels: { deepseek: { apiKey: 'test-auth-key' } } };

  it('openai 协议分派：name 为 channel/model，key 取自 auth.json', () => {
    const p = createProvider(FACTORY_CONFIG, 'main', { auth, env: {} });
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe('deepseek/deepseek-chat');
  });

  it('anthropic 协议分派：maxOutputTokens 从 models 配置透传', async () => {
    const stub = await start();
    stub.enqueue({ sse: ANTHROPIC_TEXT_EVENTS });
    // 红线：baseUrl 指向本地 stub，绝不触达真实端点
    const config: HarnessConfig = {
      ...FACTORY_CONFIG,
      providers: {
        ...FACTORY_CONFIG.providers,
        claude: { ...FACTORY_CONFIG.providers['claude']!, baseUrl: stub.url },
      },
    };
    const p = createProvider(config, 'subagent', {
      auth: { channels: { claude: { apiKey: 'test-claude-key' } } },
      env: {},
    });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe('claude/claude-sonnet-4-5');
    for await (const _ of p.streamChat({ messages: [{ role: 'user', content: 'x' }] })) break;
    const body = stub.requests[0]!.body as { max_tokens: number };
    expect(body.max_tokens).toBe(64000);
  });

  it('key 来源顺序：auth.json 优先于 env；env 兜底可用', () => {
    const env = { DEEPSEEK_API_KEY: 'test-env-key' };
    const viaEnv = createProvider(FACTORY_CONFIG, 'main', { auth: { channels: {} }, env });
    expect(viaEnv).toBeInstanceOf(OpenAICompatProvider); // env key 可用即构造成功
    // resolveApiKey 直测来源
    expect(resolveApiKey('deepseek', FACTORY_CONFIG.providers['deepseek']!, auth, env)).toMatchObject({ kind: 'auth.json' });
    expect(resolveApiKey('deepseek', FACTORY_CONFIG.providers['deepseek']!, { channels: {} }, env)).toMatchObject({
      kind: 'env',
      envKey: 'DEEPSEEK_API_KEY',
    });
    expect(resolveApiKey('deepseek', FACTORY_CONFIG.providers['deepseek']!, { channels: {} }, {})).toMatchObject({ kind: 'missing' });
  });

  it('错误路径：role 缺失 / channel 不存在 / model 未声明 / key 缺失 → ConfigError 单行消息', () => {
    expect(() => createProvider(FACTORY_CONFIG, 'ghost', { auth, env: {} })).toThrow(ConfigError);
    expect(() => createProvider(FACTORY_CONFIG, 'ghost', { auth, env: {} })).toThrow(/未在 config.roles 中配置/);

    const badChannel = { ...FACTORY_CONFIG, roles: { main: { channel: 'nowhere', model: 'm' } } } as HarnessConfig;
    expect(() => createProvider(badChannel, 'main', { auth, env: {} })).toThrow(/不存在于 config.providers/);

    const badModel = { ...FACTORY_CONFIG, roles: { main: { channel: 'deepseek', model: 'nope' } } } as HarnessConfig;
    expect(() => createProvider(badModel, 'main', { auth, env: {} })).toThrow(/未在 providers.deepseek.models 中声明/);

    expect(() => createProvider(FACTORY_CONFIG, 'subagent', { auth: { channels: {} }, env: {} })).toThrow(
      /缺少 API key/,
    );
  });
});

describe('端到端：runTurn × 本地 stub server（openai 协议，含一轮工具调用）', () => {
  it('两步 turn：wire 请求与日志投影一致（不变量）、reasoning/usage 落 assistant/message', async () => {
    const stub = await start();
    stub.enqueueAll([
      {
        sse: [
          'data: {"choices":[{"delta":{"reasoning_content":"用户要写文件"}}]}',
          'data: {"choices":[{"delta":{"reasoning_content":"，先调用工具"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":10}}',
          'data: [DONE]',
        ],
      },
      {
        sse: [
          'data: {"choices":[{"delta":{"content":"已写入 a.txt"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":6}}',
          'data: [DONE]',
        ],
      },
    ]);

    const config: HarnessConfig = {
      providers: {
        deepseek: { protocol: 'openai', baseUrl: stub.url, models: { 'deepseek-chat': {} } },
      },
      roles: { main: { channel: 'deepseek', model: 'deepseek-chat' } },
      approval: {},
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: false, idleDestroyMs: 300000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: [] },
    };
    const provider = createProvider(config, 'main', { auth: { channels: { deepseek: { apiKey: 'test-key-e2e' } } }, env: {} });

    const registry = new ToolRegistry();
    const writeTool: ToolDefinition = {
      name: 'write_file',
      description: '写文件',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ output: 'written' }),
    };
    registry.register(writeTool);

    const dir = tmpDir();
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '写 a.txt' });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.finalText).toBe('已写入 a.txt');

    // stub 恰好收到 2 次请求
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.headers['authorization']).toBe('Bearer test-key-e2e');

    // —— 不变量：stub 捕获的 wire 消息 === 从日志独立重建后映射的 wire 消息 ——
    const session = loadSession(dir);
    computeMessagesSnapshots(session, stub);
    // 第二次请求的 wire 消息应包含 tool 结果回传
    const secondWire = (stub.requests[1]!.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(secondWire.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'written' });
    expect(secondWire[0]).toEqual({ role: 'user', content: '写 a.txt' });

    // reasoning / usage 落盘
    const assistantMsgs = session.events
      .filter((e) => e.event.type === 'assistant/message')
      .map((e) => (e.event.type === 'assistant/message' ? e.event.payload : null)!);
    expect(assistantMsgs[0]).toMatchObject({
      text: '',
      model: 'deepseek/deepseek-chat',
      reasoning: '用户要写文件，先调用工具',
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    expect(assistantMsgs[1]).toMatchObject({ text: '已写入 a.txt', usage: { inputTokens: 50, outputTokens: 6 } });
    expect(assistantMsgs[1]!.reasoning).toBeUndefined(); // 第二步无思考内容则不写字段

    // 日志中的 tool/call 与 tool/result
    const callEvents = session.events.filter((e) => e.event.type === 'tool/call');
    const resultEvents = session.events.filter((e) => e.event.type === 'tool/result');
    expect(callEvents).toHaveLength(1);
    expect(resultEvents).toHaveLength(1);
  }, 10000);
});

/** 按 step/start 切分，断言每次 stub 请求的消息列表与日志逐步重建一致 */
function computeMessagesSnapshots(
  session: ReturnType<typeof loadSession>,
  stub: StubServer,
): void {
  const { events } = session;
  const messages: ChatMessage[] = [];
  const expected: string[] = [];
  for (const { event: e } of events) {
    if (e.type === 'step/start') {
      expected.push(JSON.stringify(messages));
      continue;
    }
    if (e.type === 'user/message') messages.push({ role: 'user', content: e.payload.text });
    else if (e.type === 'assistant/message') messages.push({ role: 'assistant', content: e.payload.text });
    else if (e.type === 'tool/call' && messages.at(-1)?.role === 'assistant') {
      const last = messages.at(-1) as { toolCalls?: { id: string; name: string; arguments: string }[] };
      (last.toolCalls ??= []).push({
        id: e.payload.callId,
        name: e.payload.tool,
        arguments: JSON.stringify(e.payload.args ?? {}),
      });
    } else if (e.type === 'tool/result') {
      const content = e.payload.ok
        ? (e.payload.output ?? '')
        : [e.payload.error, e.payload.output].filter(Boolean).join('\n');
      messages.push({ role: 'tool', content, toolCallId: e.payload.callId, name: e.payload.tool });
    }
  }
  const actual = stub.requests.map((r) =>
    JSON.stringify((r.body as { messages: unknown[] }).messages.map(normalizeWireMessage)),
  );
  const expectedWire = expected.map((snapshot) =>
    JSON.stringify(toOpenAIWireMessages(JSON.parse(snapshot) as ChatMessage[]).map(normalizeWireMessage)),
  );
  expect(actual).toEqual(expectedWire);
}

/** wire 消息归一化（stub 捕获的 body 字段顺序无关） */
function normalizeWireMessage(m: unknown): unknown {
  const msg = m as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['role', 'content', 'tool_call_id'] as const) {
    if (msg[k] !== undefined) out[k] = msg[k];
  }
  if (msg['tool_calls'] !== undefined) out['tool_calls'] = msg['tool_calls'];
  return out;
}
