// OpenAI-compatible provider（覆盖 DeepSeek/智谱 GLM 等）：SSE 流式、tool_calls 增量组装、
// reasoning_content → reasoning chunk、usage、abort → ProviderError('cancelled')。
// 协议手写 fetch（无 SDK）；请求/响应字段白名单处理，未知字段忽略。
// 红线：错误消息出口一律过 redactSecrets（HTTP body 可能回显请求头里的 key）。
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ProviderUsage,
  StreamChunk,
} from './types.js';
import { ProviderError } from './types.js';
import { redactedSummary } from '../config/redact.js';

export interface OpenAICompatOptions {
  /** provider 标识（写入 assistant/message.model），如 "deepseek/deepseek-chat" */
  name: string;
  /** 形如 https://api.deepseek.com/v1（请求路径 = {baseUrl}/chat/completions） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 提供时发送 max_tokens（OpenAI-compatible 通用字段） */
  maxOutputTokens?: number;
  /** 测试注入用 fetch（缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

/** ChatMessage → OpenAI wire 消息（provider/types.ts 映射规则的 OpenAI 形态） */
export function toOpenAIWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
    }
    return { role: 'user', content: m.content };
  });
}

/** baseUrl 规范化：补尾斜杠后拼相对路径（避免 new URL 吞掉末段） */
function joinUrl(baseUrl: string, relative: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relative, base).toString();
}

/** delta.tool_calls 的按 index 累积缓冲 */
interface CallBuffer {
  id: string;
  name: string;
  arguments: string;
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

const CANCELLED = 'cancelled';

export class OpenAICompatProvider implements ChatProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    const signal = opts?.signal;
    const wireBody: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIWireMessages(req.messages),
      stream: true,
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(this.maxOutputTokens !== undefined ? { max_tokens: this.maxOutputTokens } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(joinUrl(this.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(wireBody),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError(CANCELLED, CANCELLED);
      throw new ProviderError(redactedSummary(`连接失败: ${(e as Error)?.message ?? String(e)}`), 'network');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        redactedSummary(`HTTP ${res.status} ${res.statusText || ''}: ${text}`),
        `http_${res.status}`,
      );
    }
    if (!res.body) throw new ProviderError('响应缺少 body', 'network');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawDone = false;
    let finishReason: string | undefined;
    const calls = new Map<number, CallBuffer>();

    // SSE 解析：跨 chunk 缓冲 + 逐行处理（data: 帧 / [DONE] / 注释行忽略）；
    // TextDecoder 流式解码处理跨 chunk 的多字节 UTF-8（中文）。
    try {
      for await (const bytes of res.body) {
        if (signal?.aborted) throw new ProviderError(CANCELLED, CANCELLED);
        buffer += decoder.decode(bytes, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length === 0 || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue; // event:/id: 等字段忽略
          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') {
            sawDone = true;
            break;
          }
          let chunk: WireChunk;
          try {
            chunk = JSON.parse(payload) as WireChunk;
          } catch {
            continue; // 无法解析的帧跳过（协议未知字段/坏帧不致命）
          }
          yield* handleWireChunk(chunk, calls, (fr) => (finishReason = fr));
        }
        if (sawDone) break;
      }
    } catch (e) {
      if (signal?.aborted) throw new ProviderError(CANCELLED, CANCELLED);
      // 已收到 2xx 响应头后读流失败 = 连接在 [DONE] 前中断（断流），与建连失败（network）区分
      throw new ProviderError(
        redactedSummary(`连接在流结束前中断: ${(e as Error)?.message ?? String(e)}`),
        'stream_truncated',
      );
    } finally {
      await res.body.cancel().catch(() => {});
    }

    // 服务端“优雅”关闭但未发 [DONE] 同样视为截断（不冒充完整回复）
    if (!sawDone) {
      throw new ProviderError('连接在流结束前中断（未收到 [DONE]）', 'stream_truncated');
    }

    // finish 边界：按 index 顺序吐出组装完成的 tool-call（arguments 仍为 JSON 串，解析归 agent loop）
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, call] of ordered) {
      yield {
        type: 'tool-call',
        call: {
          id: call.id || `openai_tool_${index}`,
          name: call.name,
          arguments: call.arguments === '' ? '{}' : call.arguments,
        },
      };
    }
    const hasToolUse = ordered.length > 0 || finishReason === 'tool_calls';
    yield { type: 'done', stopReason: hasToolUse ? 'tool_use' : 'end_turn' };
  }
}

/** 处理单个 wire chunk：产出 text/reasoning/usage 增量，累积 tool_calls，捕获 finish_reason */
function* handleWireChunk(
  chunk: WireChunk,
  calls: Map<number, CallBuffer>,
  setFinish: (reason: string) => void,
): Generator<StreamChunk> {
  if (chunk.usage && (chunk.usage.prompt_tokens !== undefined || chunk.usage.completion_tokens !== undefined)) {
    const usage: ProviderUsage = {
      ...(chunk.usage.prompt_tokens !== undefined ? { inputTokens: chunk.usage.prompt_tokens } : {}),
      ...(chunk.usage.completion_tokens !== undefined ? { outputTokens: chunk.usage.completion_tokens } : {}),
    };
    yield { type: 'usage', usage };
  }
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta ?? {};
    // DeepSeek/GLM 的思考字段（OpenAI-compatible 扩展）
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      yield { type: 'reasoning-delta', text: delta.reasoning_content };
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield { type: 'text-delta', text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      const cur: CallBuffer = calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof tc.id === 'string' && tc.id.length > 0) cur.id = tc.id;
      if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) cur.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments;
      calls.set(index, cur);
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      setFinish(choice.finish_reason);
    }
  }
}
