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
  /**
   * 非空时 streamChat 抛 ProviderError（错误注入）。
   * 数字 → ProviderError(String(n))（如 429/503/401/400）；
   * 其他字符串 → ProviderError(s, s)（s 视为错误码，如 'stream_truncated'/'network'；
   * 常规描述串如 'boom: network down' 会归为 unknown 码，loop 不默认重试）。
   */
  error?: string | number;
  /** error 为非空时透传的 Retry-After 秒数（S4b 接线测试） */
  retryAfterSeconds?: number;
  /** 每个 text-delta 之间的延迟 ms（模拟流式节奏，供取消测试） */
  chunkDelayMs?: number;
  /** true = 产出完 text/reasoning/tool-calls 后抛 ProviderError(stream_truncated)（模拟半截断流）；缺省正常 done */
  truncateAfter?: boolean;
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
    if (reply.error !== undefined && reply.error !== null) {
      // 数字 → 码；字符串 → 其本身即码（未知码归类 unknown，loop 不默认重试）
      const code = typeof reply.error === 'number' ? String(reply.error) : (reply.error as string);
      throw new ProviderError(reply.error + '', code, reply.retryAfterSeconds);
    }

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
    if (reply.truncateAfter) {
      throw new ProviderError('连接在流结束前中断（mock 注入断流）', 'stream_truncated', reply.retryAfterSeconds);
    }
    yield { type: 'done', stopReason: reply.toolCalls?.length ? 'tool_use' : 'end_turn' };
  }
}
