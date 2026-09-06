// 脚本化确定性 MockProvider：CI 零 API key 下驱动真实 agent loop 语义。
// 脚本数组逐次消费；每次回复可携带文本/工具调用/用量，或注入错误；
// 每次收到的 ChatRequest 记录进 requests 数组（供 Model-visible ⟺ logged 不变量断言）。
import type { ChatProvider, ChatRequest, ProviderUsage, StreamChunk, ToolCallRequest } from './types.js';
import { ProviderError } from './types.js';

/** 脚本中的一条回复 */
export interface MockReply {
  text?: string;
  /** 拆成多个 text-delta 逐片产出（验证流式语义） */
  textChunks?: string[];
  /** 拆成多个 reasoning-delta 逐片产出（先于 text；阶段 5 服务层增量推送验证用） */
  reasoningChunks?: string[];
  toolCalls?: ToolCallRequest[];
  usage?: ProviderUsage;
  /** 非空时 streamChat 抛 ProviderError（错误注入） */
  error?: string;
  /** 每个 text-delta 之间的延迟 ms（模拟流式节奏，供取消测试） */
  chunkDelayMs?: number;
}

export type MockScript = readonly MockReply[];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockProvider implements ChatProvider {
  readonly name = 'mock';
  private cursor = 0;

  /** 每次收到 ChatRequest（无论后续是否抛错）都会记录 */
  readonly requests: ChatRequest[] = [];

  constructor(private readonly script: MockScript) {}

  /** 已消费的脚本条数（测试断言用） */
  get consumed(): number {
    return this.cursor;
  }

  async *streamChat(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    this.requests.push(req);
    opts?.signal?.throwIfAborted();
    const reply = this.script[this.cursor];
    if (!reply) {
      throw new ProviderError(`mock script exhausted (${this.cursor} of ${this.script.length} consumed)`);
    }
    this.cursor += 1;
    if (reply.error) throw new ProviderError(reply.error);

    for (const reasoning of reply.reasoningChunks ?? []) {
      if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
      opts?.signal?.throwIfAborted();
      yield { type: 'reasoning-delta', text: reasoning };
    }
    const chunks = reply.textChunks ?? (reply.text === undefined ? [] : [reply.text]);
    for (const text of chunks) {
      if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
      opts?.signal?.throwIfAborted();
      yield { type: 'text-delta', text };
    }
    for (const call of reply.toolCalls ?? []) {
      opts?.signal?.throwIfAborted();
      yield { type: 'tool-call', call };
    }
    if (reply.usage) yield { type: 'usage', usage: reply.usage };
    yield { type: 'done', stopReason: reply.toolCalls?.length ? 'tool_use' : 'end_turn' };
  }
}
