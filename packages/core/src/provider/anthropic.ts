// Anthropic Messages API provider：SSE（message_*/content_block_* 事件）、
// tool_use/tool_result 映射、system 顶层参数（v1 ChatMessage 无 system 角色，保留扩展位）、
// x-api-key + anthropic-version 头。协议手写 fetch；错误出口一律过 redactSecrets。
import type { ChatMessage, ChatProvider, ChatRequest, StreamChunk } from './types.js';
import { ProviderError } from './types.js';
import { redactedSummary } from '../config/redact.js';

export interface AnthropicOptions {
  /** provider 标识（写入 assistant/message.model），如 "anthropic/claude-sonnet-4-5" */
  name: string;
  /** 形如 https://api.anthropic.com（请求路径 = {baseUrl}/v1/messages，baseUrl 不含 /v1） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Anthropic API 必填；默认 4096（工厂会传模型配置的 maxOutputTokens） */
  maxOutputTokens?: number;
  /** 测试注入用 fetch（缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * ChatMessage → Anthropic wire messages。
 * 合并规则（P1-2）：Anthropic API 要求 user/assistant 严格交替，相邻的 tool 消息与
 * user 消息必须合并为同一条 user 消息的 content 块数组（tool_result 与 text 块可共存）。
 * 真实触发路径：上一 turn 以 error/cancel/max_steps 结束（无 assistant/message）时，
 * 下一轮的 user 与 tool_result-user 相邻——不合并在真实 API 必 400。
 */
export function toAnthropicWireMessages(messages: readonly ChatMessage[]): unknown[] {
  const wire: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }> = [];
  /** 追加进末条 user 消息的 content 块数组；末条不是 user（或为空）时新开 user 消息 */
  const appendToLastUser = (block: Record<string, unknown>): void => {
    const last = wire.at(-1);
    if (last?.role === 'user') last.content.push(block);
    else wire.push({ role: 'user', content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      appendToLastUser({ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content });
      continue;
    }
    if (m.role === 'user') {
      appendToLastUser({ type: 'text', text: m.content });
      continue;
    }
    // assistant：text 块（空文本不发）+ tool_use 块；assistant 必然新开消息（恢复交替）
    const blocks: Record<string, unknown>[] = [];
    if (m.content.length > 0) blocks.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseInputOrEmpty(c.arguments) });
    }
    wire.push({ role: 'assistant', content: blocks });
  }
  return wire;
}

/** arguments 解析失败时以 {} 兜底（wire 层必须给合法 input 对象；信息损失记录在案） */
function parseInputOrEmpty(argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.trim() === '') return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return {};
  }
}

function joinUrl(baseUrl: string, relative: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relative, base).toString();
}

interface WireEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

interface ToolBlockBuffer {
  id: string;
  name: string;
  json: string;
}

const CANCELLED = 'cancelled';

export class AnthropicProvider implements ChatProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    const signal = opts?.signal;
    const wireBody: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      stream: true,
      messages: toAnthropicWireMessages(req.messages),
      // ChatRequest.system → Anthropic 顶层 system 参数（阶段 6 加性缝；v1 ChatMessage 无 system 角色）
      ...(req.system !== undefined && req.system.length > 0 ? { system: req.system } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(joinUrl(this.baseUrl, 'v1/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
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
      const httpCode = String(res.status);
      const normalizedCode = res.status === 429 ? '429'
        : res.status === 503 ? '503'
        : res.status >= 400 && res.status < 500 ? httpCode
        : res.status >= 500 ? 'server_5xx'
        : httpCode;
      const retryAfterRaw = res.headers.get('retry-after');
      const retryAfter = retryAfterRaw !== null ? Number(retryAfterRaw) : undefined;
      const retryAfterSeconds = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter : undefined;
      throw new ProviderError(
        redactedSummary(`HTTP ${res.status} ${res.statusText || ''}: ${text}`),
        normalizedCode,
        retryAfterSeconds,
      );
    }
    if (!res.body) throw new ProviderError('响应缺少 body', 'network');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawStop = false;
    let stopReason: string | undefined;
    let toolCallCount = 0;
    const inputTokens: { value?: number } = {};
    const outputTokens: { value?: number } = {};
    const toolBlocks = new Map<number, ToolBlockBuffer>();

    try {
      for await (const bytes of res.body) {
        if (signal?.aborted) throw new ProviderError(CANCELLED, CANCELLED);
        buffer += decoder.decode(bytes, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length === 0 || line.startsWith(':') || !line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          let event: WireEvent;
          try {
            event = JSON.parse(payload) as WireEvent;
          } catch {
            continue;
          }
          if (event.type === 'error') {
            // API 错误事件（overloaded_error 等）：立即脱敏抛出
            // overloaded_error → 429（可恢复重试）；其余（rate_limit_error/auth_error 等）走 HTTP 语义码
            const errType = event.error?.type ?? 'unknown';
            const code = errType === 'overloaded_error' ? '429'
              : errType === 'rate_limit_error' ? '429'
              : errType === 'authentication_error' ? '401'
              : errType === 'permission_error' ? '403'
              : errType === 'invalid_request_error' ? 'invalid_request'
              : errType === 'api_error' ? 'server_5xx'
              : 'server_5xx';
            throw new ProviderError(
              redactedSummary(`Anthropic error (${errType}): ${event.error?.message ?? ''}`),
              code,
            );
          }
          if (event.type === 'message_stop') {
            sawStop = true;
            break;
          }
          for (const chunk of handleWireEvent(event, toolBlocks, inputTokens, outputTokens, (sr) => (stopReason = sr))) {
            if (chunk.type === 'tool-call') toolCallCount += 1;
            yield chunk;
          }
        }
        if (sawStop) break;
      }
    } catch (e) {
      if (signal?.aborted) throw new ProviderError(CANCELLED, CANCELLED);
      if (e instanceof ProviderError) throw e; // error 事件等已分类脱敏的异常保留原 code，不误报 stream_truncated（P2-3）
      throw new ProviderError(
        redactedSummary(`连接在流结束前中断: ${(e as Error)?.message ?? String(e)}`),
        'stream_truncated',
      );
    } finally {
      await res.body.cancel().catch(() => {});
    }

    if (!sawStop) {
      throw new ProviderError('连接在流结束前中断（未收到 message_stop）', 'stream_truncated');
    }

    // usage：合并 message_start 的输入与 message_delta 的输出
    if (inputTokens.value !== undefined || outputTokens.value !== undefined) {
      yield {
        type: 'usage',
        usage: {
          ...(inputTokens.value !== undefined ? { inputTokens: inputTokens.value } : {}),
          ...(outputTokens.value !== undefined ? { outputTokens: outputTokens.value } : {}),
        },
      };
    }
    const hasToolUse = toolCallCount > 0 || stopReason === 'tool_use';
    yield { type: 'done', stopReason: hasToolUse ? 'tool_use' : mapStopReason(stopReason) };
  }
}

/** stop_reason → done.stopReason 白名单透传（P2-4），未知值归 end_turn；pause_turn → paused */
function mapStopReason(reason: string | undefined): 'end_turn' | 'max_tokens' | 'refusal' | 'paused' {
  if (reason === 'max_tokens' || reason === 'refusal') return reason;
  if (reason === 'pause_turn') return 'paused';
  return 'end_turn';
}

/** 处理单个 SSE 事件：产出 text/reasoning/tool-call 增量，捕获 usage 与 stop_reason */
function* handleWireEvent(
  event: WireEvent,
  toolBlocks: Map<number, ToolBlockBuffer>,
  inputTokens: { value?: number },
  outputTokens: { value?: number },
  setStop: (reason: string) => void,
): Generator<StreamChunk> {
  switch (event.type) {
    case 'message_start':
      if (typeof event.message?.usage?.input_tokens === 'number') {
        inputTokens.value = event.message.usage.input_tokens;
      }
      if (typeof event.message?.usage?.output_tokens === 'number' && event.message.usage.output_tokens > 0) {
        outputTokens.value = event.message.usage.output_tokens;
      }
      return;
    case 'content_block_start': {
      if (event.content_block?.type === 'tool_use' && event.content_block.id && event.content_block.name) {
        toolBlocks.set(event.index ?? 0, {
          id: event.content_block.id,
          name: event.content_block.name,
          json: '',
        });
      }
      return;
    }
    case 'content_block_delta': {
      const delta = event.delta ?? {};
      if (typeof delta.text === 'string' && delta.text.length > 0) {
        yield { type: 'text-delta', text: delta.text };
      }
      if (typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        yield { type: 'reasoning-delta', text: delta.thinking };
      }
      if (typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
        const block = toolBlocks.get(event.index ?? 0);
        if (block) block.json += delta.partial_json;
      }
      return;
    }
    case 'content_block_stop': {
      const block = toolBlocks.get(event.index ?? 0);
      if (block) {
        toolBlocks.delete(event.index ?? 0); // 删除防重复 stop 重发
        yield {
          type: 'tool-call',
          call: { id: block.id, name: block.name, arguments: block.json === '' ? '{}' : block.json },
        };
      }
      return;
    }
    case 'message_delta': {
      if (typeof event.delta?.stop_reason === 'string') setStop(event.delta.stop_reason);
      if (typeof event.usage?.output_tokens === 'number') outputTokens.value = event.usage.output_tokens;
      if (typeof event.usage?.input_tokens === 'number') inputTokens.value = event.usage.input_tokens;
      return;
    }
    default:
      return; // ping / 其他未知事件忽略
  }
}
