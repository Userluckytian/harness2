// Provider 缝：阶段 2 只定义契约，MockProvider 是唯一实现（阶段 3 接真实厂商）。
// 红线：Provider 层不接触任何密钥；请求内容由 agent loop 从会话日志投影组装。
// 会话事件类型 v1 —— 唯一事实源的 schema 见 session/types.ts。

/** 工具调用请求（对齐 OpenAI function-calling 形态：arguments 为 JSON 字符串） */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON 编码的参数串；解析由 agent loop 负责（解析失败不执行） */
  arguments: string;
}

/**
 * 会话消息（provider 侧形态）与日志事件的映射规则：
 *   日志 user/message      → { role: 'user', content: text }
 *   日志 assistant/message  → { role: 'assistant', content: text,
 *                               toolCalls?: 紧随其后的 tool/call 事件 }
 *   日志 tool/result        → { role: 'tool',
 *                               content: ok ? (output ?? '')
 *                                           : [error, output].filter(Boolean).join('\n'),
 *                               toolCallId: callId, name: tool }
 * 重建唯一来源 = 会话日志投影（Model-visible ⟺ logged）；禁止内存旁路。
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息携带的工具调用请求（重建自日志 tool/call 事件） */
  toolCalls?: ToolCallRequest[];
  /** tool 消息：对应的调用 id（重建自日志 tool/result.callId） */
  toolCallId?: string;
  /** tool 消息：工具名（重建自日志 tool/result.tool） */
  name?: string;
}

/** 注册给模型的工具规格（来自工具注册表的 ToolDefinition 投影） */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** 流式响应块：文本增量 / 工具调用 / 用量 / 结束标记 */
export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' };

export interface StreamOptions {
  signal?: AbortSignal;
}

/** 可替换的模型 Provider 缝（阶段 3 落地真实实现） */
export interface ChatProvider {
  /** provider 标识（写入 assistant/message.model） */
  readonly name: string;
  /** 流式对话；signal 触发后必须尽快短路（抛错或结束迭代） */
  streamChat(req: ChatRequest, opts?: StreamOptions): AsyncIterable<StreamChunk>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
