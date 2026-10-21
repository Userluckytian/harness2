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
/**
 * 多模态内容 part（provider 无关）。provider 层映射到各自 wire：
 * - OpenAI 兼容 → `image_url` data URL；
 * - Anthropic → `image` source(base64)。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 多模态内容（ZS3.5 加性）：存在时 provider 优先使用它；content 保留文本摘要/回退，
   * 供 token 估算、压缩与旧消费者继续使用。
   */
  parts?: ChatContentPart[];
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
  /**
   * 可选 system 提示（阶段 6 记忆快照缝；加性可选，缺省时 wire 完全不变）：
   *   openai 协议 → 首条 {role:'system', content} 消息；
   *   anthropic 协议 → 顶层 system 参数。
   * 唯一来源 = 会话日志 memory/snapshot 事件（Model-visible ⟺ logged 扩展到 system）。
   */
  system?: string;
  /**
   * Z6-A02 Prompt caching 开关（对照点在 agent loop 消息组装处；加性可选，缺省关闭）：
   * true 时 provider 对「会话内稳定前缀」打缓存标记——anthropic 协议给 system 参数与
   * 工具定义加 cache_control: {type:'ephemeral'}；openai 兼容协议无显式开关（服务端
   * 自动前缀缓存），本标记被忽略。
   * 红线⑨：缓存边界只允许打在 system / 工具定义 / 稳定前缀——**绝不**打在消息体中间。
   * 理由：消息体逐 turn 追加变化（日志投影重建），中途断点会把每 turn 的新增内容
   * 变成缓存写入点，反复失效前缀、放大 cache_creation 计费；而 system+工具定义在
   * 会话生命周期内字节级稳定，一次标记全程命中。
   */
  cacheStablePrefix?: boolean;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Z6-A02 加性：命中缓存的输入 token 数。
   * anthropic = usage.cache_read_input_tokens；openai 兼容 = prompt_tokens_details.cached_tokens
   * （服务端自动缓存，无显式开关）。字段缺省 = 上游未报告（不臆造 0）。
   */
  cacheReadTokens?: number;
  /**
   * Z6-A02 加性：写入缓存的输入 token 数（anthropic = usage.cache_creation_input_tokens；
   * openai 兼容协议无对应字段）。旧消费者只读 inputTokens/outputTokens，零破坏。
   */
  cacheWriteTokens?: number;
}

/**
 * 流终止原因（P2-4 白名单透传）：
 *   end_turn/tool_use 为基线；OpenAI finish_reason length/content_filter、
 *   Anthropic stop_reason max_tokens/refusal 原样透传，不再折叠为 end_turn；
 *   Anthropic pause_turn 映射为 paused（续跑未实现，登记 OPEN.md）。
 */
export type ProviderStopReason =
  'end_turn' | 'tool_use' | 'length' | 'content_filter' | 'max_tokens' | 'refusal' | 'paused';

/**
 * 流式响应块：文本增量 / 工具调用 / 用量 / 结束标记。
 * `reasoning-delta` 是阶段 3 的最小加性扩展（DeepSeek/GLM reasoning_content、
 * Anthropic thinking）：不改变既有块的语义；不消费方（如阶段 2 loop 的 if/else 链）
 * 天然忽略该变体，消费方（loop 汇总进 assistant/message.reasoning）按需读取。
 */
export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done'; stopReason: ProviderStopReason };

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
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
