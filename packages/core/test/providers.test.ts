// 真实 provider 协议测试：全部走 127.0.0.1 本地 stub server（CI 零真实 API）。
// Task 2: OpenAI-compatible（SSE 流式 / tool_calls 增量组装 / reasoning_content / usage /
//         错误脱敏 / 半帧断流 / abort / 多字节跨 chunk）。
import { afterEach, describe, expect, it } from 'vitest';
import { startSseStub, type StubServer } from './helpers/sse-stub.js';
import { OpenAICompatProvider, toOpenAIWireMessages } from '../src/provider/openai.js';
import { ProviderError } from '../src/provider/types.js';
import type { ChatMessage, ChatRequest, StreamChunk } from '../src/provider/types.js';

const servers: StubServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
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

async function collect(provider: OpenAICompatProvider, req: ChatRequest): Promise<StreamChunk[]> {
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
