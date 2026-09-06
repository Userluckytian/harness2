// IM 网关类型：平台适配器统一接口（对照 hermes BasePlatformAdapter 思想）。
// 红线：适配器只做「平台协议 ⇄ 统一消息」的翻译，会话操作一律经 ServeClient（零新写入路径）。
export type GatewayPolicy = 'open' | 'allowlist' | 'disabled';

export type GatewayChannelName = 'qq' | 'feishu';

/** 适配器从平台收到的统一入站消息 */
export interface InboundMessage {
  channel: GatewayChannelName;
  /** 平台侧会话标识（群 openid / 私聊 openid / chat_id） */
  chatId: string;
  /** 平台侧消息 id（去重 + 被动回复关联） */
  messageId: string;
  /** 纯文本内容（已剥离 @ 前缀等平台噪音） */
  text: string;
  /** 是否群聊（false = 私聊/C2C） */
  isGroup: boolean;
}

/** 平台适配器：收消息回调由网关注入；send 由网关调用（渲染后的最终文本） */
export interface PlatformAdapter {
  readonly channel: GatewayChannelName;
  /** 注册入站消息回调（网关启动时调用一次；适配器在收到平台消息后逐条回调） */
  onMessage(handler: (message: InboundMessage) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 渲染后的出站文本（网关已做合并/截断）；msgId 关联被动回复（平台支持时） */
  send(chatId: string, text: string, replyToMessageId?: string, isGroup?: boolean): Promise<void>;
}

/** 策略判定（三态，缺省 allowlist——防滥用） */
export function policyAllows(policy: GatewayPolicy, chatId: string, allow: readonly string[]): boolean {
  switch (policy) {
    case 'open':
      return true;
    case 'disabled':
      return false;
    case 'allowlist':
      return allow.includes(chatId);
  }
}
