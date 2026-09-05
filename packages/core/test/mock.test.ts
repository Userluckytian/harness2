import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/provider/mock.js';
import { ProviderError, type ChatRequest, type StreamChunk } from '../src/provider/types.js';

const req = (content: string): ChatRequest => ({ messages: [{ role: 'user', content }] });

async function collect(provider: MockProvider, request: ChatRequest, signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of provider.streamChat(request, { signal })) chunks.push(c);
  return chunks;
}

describe('MockProvider', () => {
  it('脚本按序消费：两次请求分别产出对应回复，超出脚本长度抛 ProviderError', async () => {
    const provider = new MockProvider([{ text: 'first' }, { text: 'second' }]);
    expect((await collect(provider, req('q1'))).map((c) => c.type)).toEqual(['text-delta', 'done']);
    expect((await collect(provider, req('q2'))).map((c) => c.type)).toEqual(['text-delta', 'done']);
    expect(provider.consumed).toBe(2);
    await expect(collect(provider, req('q3'))).rejects.toThrow(ProviderError);
    await expect(collect(provider, req('q3'))).rejects.toThrow(/exhausted/);
  });

  it('流式分片：textChunks 逐片产出 text-delta，顺序与分片一致', async () => {
    const provider = new MockProvider([{ textChunks: ['你', '好', '！'] }]);
    const chunks = await collect(provider, req('hi'));
    expect(chunks).toEqual([
      { type: 'text-delta', text: '你' },
      { type: 'text-delta', text: '好' },
      { type: 'text-delta', text: '！' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('tool-call 回复：产出 tool-call 块与 usage，done.stopReason=tool_use', async () => {
    const provider = new MockProvider([
      {
        text: '查看文件',
        toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' }],
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    ]);
    const chunks = await collect(provider, req('读一下'));
    expect(chunks).toEqual([
      { type: 'text-delta', text: '查看文件' },
      { type: 'tool-call', call: { id: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('记录每次收到的 ChatRequest（含抛错的那次），内容与请求一致', async () => {
    const provider = new MockProvider([{ error: 'boom' }, { error: 'boom' }]);
    await expect(collect(provider, req('q1'))).rejects.toThrow(ProviderError);
    await expect(collect(provider, req('q2'))).rejects.toThrow(/boom/);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.messages[0]?.content).toBe('q1');
    expect(provider.requests[1]?.messages[0]?.content).toBe('q2');
  });

  it('错误注入：error 抛 ProviderError 且携带原文', async () => {
    const provider = new MockProvider([{ error: 'rate_limited: 429' }]);
    await expect(collect(provider, req('q'))).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'rate_limited: 429',
    });
  });

  it('signal 提前取消：迭代开始前已取消则抛错（AsyncIterable 短路）', async () => {
    const provider = new MockProvider([{ text: 'never' }]);
    const ac = new AbortController();
    ac.abort();
    await expect(collect(provider, req('q'), ac.signal)).rejects.toThrow();
    // 请求已被记录（收到即记录），但没有任何 chunk 产出
    expect(provider.requests).toHaveLength(1);
  });

  it('signal 流中取消：已产出部分 chunk 后，下一次 next 抛错', async () => {
    const provider = new MockProvider([{ textChunks: ['a', 'b', 'c'], chunkDelayMs: 15 }]);
    const ac = new AbortController();
    const iterator = provider.streamChat(req('q'), { signal: ac.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'text-delta', text: 'a' });
    ac.abort();
    await expect(iterator.next()).rejects.toThrow();
  });

  it('提前 break：AsyncIterable 正常短路收尾，不抛错', async () => {
    const provider = new MockProvider([{ textChunks: ['a', 'b', 'c'] }]);
    const chunks: StreamChunk[] = [];
    for await (const c of provider.streamChat(req('q'))) {
      chunks.push(c);
      break;
    }
    expect(chunks).toEqual([{ type: 'text-delta', text: 'a' }]);
  });
});
