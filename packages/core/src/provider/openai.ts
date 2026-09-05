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
import { redactObject, redactedSummary } from '../config/redact.js';

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

/** 单个 tool_calls delta（部分厂商不传 index，见 bufferOpenToolCall 的分槽规则） */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** JSON 可解析的错误帧（无 choices），如 {"error":{"message":"Insufficient Balance","type":"..."}} */
  error?: { message?: string; type?: string; code?: string };
}

/** OpenAI-compatible 错误帧 type → ProviderError code（未知 type 一律 api_error）（P1-1） */
const ERROR_TYPE_TO_CODE: Record<string, string> = {
  invalid_request_error: 'invalid_request',
  authentication_error: 'auth_error',
  auth_error: 'auth_error',
  permission_error: 'permission_denied',
  not_found_error: 'not_found',
  rate_limit_error: 'rate_limit',
  insufficient_quota: 'insufficient_quota',
  server_error: 'server_error',
};

/** finish_reason → done.stopReason 白名单透传（P2-4），未知值归 end_turn */
function mapFinishReason(reason: string | undefined): 'end_turn' | 'length' | 'content_filter' {
  if (reason === 'length' || reason === 'content_filter') return reason;
  return 'end_turn';
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
    const openCalls: CallBuffer[] = []; // 无 index 的 tool_calls delta 累积槽（P2-5）

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
          yield* handleWireChunk(chunk, calls, openCalls, (fr) => (finishReason = fr));
        }
        if (sawDone) break;
      }
    } catch (e) {
      if (signal?.aborted) throw new ProviderError(CANCELLED, CANCELLED);
      if (e instanceof ProviderError) throw e; // 错误帧等已分类脱敏的异常保留原 code，不误报 stream_truncated（P2-3）
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

    // finish 边界：吐出组装完成的 tool-call（arguments 仍为 JSON 串，解析归 agent loop）；
    // 有 index 的按 index 升序，无 index 的按到达顺序追加在后（P2-5）
    const indexed = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    const all = [...indexed, ...openCalls];
    for (const [i, call] of all.entries()) {
      yield {
        type: 'tool-call',
        call: {
          id: call.id || `openai_tool_${i}`,
          name: call.name,
          arguments: call.arguments === '' ? '{}' : call.arguments,
        },
      };
    }
    const hasToolUse = all.length > 0 || finishReason === 'tool_calls';
    yield { type: 'done', stopReason: hasToolUse ? 'tool_use' : mapFinishReason(finishReason) };
  }
}

/** 处理单个 wire chunk：产出 text/reasoning/usage 增量，累积 tool_calls，捕获 finish_reason */
function* handleWireChunk(
  chunk: WireChunk,
  calls: Map<number, CallBuffer>,
  openCalls: CallBuffer[],
  setFinish: (reason: string) => void,
): Generator<StreamChunk> {
  if (chunk.error) {
    // P1-1：JSON 可解析的错误帧（无 choices）不得静默吞掉——结构化脱敏后抛出，保留厂商 message
    const safe = redactObject(chunk.error) as { message?: string; type?: string; code?: string };
    const type = typeof safe.type === 'string' && safe.type.length > 0 ? safe.type : 'unknown';
    const message =
      typeof safe.message === 'string' && safe.message.length > 0 ? safe.message : JSON.stringify(safe);
    throw new ProviderError(
      redactedSummary(`上游流中错误帧 (${type}): ${message}`),
      ERROR_TYPE_TO_CODE[type] ?? 'api_error',
    );
  }
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
      if (tc.index === undefined) {
        bufferOpenToolCall(openCalls, tc); // P2-5：无 index 分槽，不并入槽 0
        continue;
      }
      const cur: CallBuffer = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (typeof tc.id === 'string' && tc.id.length > 0) cur.id = tc.id;
      if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) cur.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      setFinish(choice.finish_reason);
    }
  }
}

/**
 * P2-5：无 index 的 tool_calls delta 分槽规则——
 *   有 id → 按 id 匹配既有槽，无则新槽；仅有 name → 与当前开放槽同名则延续累积
 *   （不重复拼接 name），新名字开新槽；只有 arguments → 追加进当前开放槽。
 */
function bufferOpenToolCall(open: CallBuffer[], tc: ToolCallDelta): void {
  const id = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : undefined;
  const name = typeof tc.function?.name === 'string' && tc.function.name.length > 0 ? tc.function.name : undefined;
  const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : undefined;
  let cur: CallBuffer | undefined;
  if (id !== undefined) {
    cur = open.find((c) => c.id === id);
    if (!cur) {
      cur = { id, name: '', arguments: '' };
      open.push(cur);
    }
    if (name !== undefined) cur.name = cur.name === '' ? name : cur.name + name;
  } else if (name !== undefined) {
    const last = open.at(-1);
    if (last && (last.name === name || last.name === '')) {
      cur = last;
      if (last.name === '') last.name = name; // 同名延续：不重复拼接（区别于索引路径的部分名流 +=）
    } else {
      cur = { id: '', name, arguments: '' };
      open.push(cur);
    }
  } else {
    cur = open.at(-1);
    if (!cur) {
      cur = { id: '', name: '', arguments: '' };
      open.push(cur);
    }
  }
  if (args !== undefined) cur.arguments += args;
}
