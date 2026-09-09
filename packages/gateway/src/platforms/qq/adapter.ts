// QQ 平台适配器：官方 WS 网关入站 → 统一 InboundMessage；出站经 REST（频率限制队列）。
// 只走官方 API（bots.qq.com / api.sgroup.qq.com；测试可注入 base 覆盖）。
import { QqApi, type QqApiOptions } from './api.js';
import { QqGatewayWs, QQ_INTENT_DIRECT_MESSAGE, QQ_INTENT_GROUP_AND_C2C } from './gateway-ws.js';
import { policyAllows, type GatewayChannelName, type InboundMessage, type PlatformAdapter } from '../../types.js';
import type { GatewayChannelConfig } from '@harness2/core';

export interface QqAdapterOptions {
  config: GatewayChannelConfig;
  auth: { appId: string; appSecret: string };
  /** 出站 REST/WS base 覆盖（测试注入本地 stub） */
  tokenUrl?: string;
  apiBase?: string;
  /** 事件去重表容量（默认 500） */
  dedupeCapacity?: number;
}

interface QqMessagePayload {
  id?: unknown;
  group_openid?: unknown;
  user_openid?: unknown;
  content?: unknown;
  openid?: unknown;
}

export class QqAdapter implements PlatformAdapter {
  readonly channel: GatewayChannelName = 'qq';
  private api: QqApi;
  private gateway: QqGatewayWs | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** P1-3（审查）：QQ 去重规则——同 msg_id + msg_seq 重复发送被拒，须按 msg_id 递增 msg_seq */
  private readonly msgSeqByMsgId = new Map<string, number>();
  private inboundHandler: ((message: InboundMessage) => void) | null = null;

  constructor(private readonly options: QqAdapterOptions) {
    const apiOptions: QqApiOptions = {
      appId: options.auth.appId,
      appSecret: options.auth.appSecret,
      ...(options.tokenUrl !== undefined ? { tokenUrl: options.tokenUrl } : {}),
      ...(options.apiBase !== undefined ? { apiBase: options.apiBase } : {}),
    };
    this.api = new QqApi(apiOptions);
  }

  /** 注册入站回调（PlatformAdapter 契约；网关启动时调用一次） */
  onMessage(handler: (message: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async start(): Promise<void> {
    const intents = QQ_INTENT_GROUP_AND_C2C | QQ_INTENT_DIRECT_MESSAGE;
    this.gateway = new QqGatewayWs({
      url: () => this.api.getGatewayUrl(),
      token: () => this.api.getToken(),
      intents,
      onDispatch: (eventType, payload) => this.handleDispatch(eventType, payload),
    });
    this.gateway.start();
  }

  async stop(): Promise<void> {
    this.gateway?.stop();
    this.gateway = null;
  }

  /** 出站：群 / 私聊 v2 接口（频率限制队列；msg_id 被动回复 + msg_seq 按 msg_id 递增） */
  async send(chatId: string, text: string, replyToMessageId?: string, isGroup?: boolean): Promise<void> {
    const path =
      isGroup === true
        ? `/v2/groups/${encodeURIComponent(chatId)}/messages`
        : `/v2/users/${encodeURIComponent(chatId)}/messages`;
    let msgSeq: number | undefined;
    if (replyToMessageId !== undefined) {
      const next = (this.msgSeqByMsgId.get(replyToMessageId) ?? 0) + 1;
      this.msgSeqByMsgId.set(replyToMessageId, next);
      msgSeq = next;
    }
    const body: Record<string, unknown> = {
      msg_type: 0,
      content: text,
      ...(replyToMessageId !== undefined ? { msg_id: replyToMessageId, msg_seq: msgSeq } : {}),
    };
    await this.api.enqueue(() => this.api.request(path, body));
  }

  private handleDispatch(eventType: string, payload: Record<string, unknown>): void {
    // 仅处理官方消息事件（其余事件类型忽略）
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const isC2C = eventType === 'C2C_MESSAGE_CREATE';
    if (!isGroup && !isC2C) return;

    const p = payload as QqMessagePayload;
    const messageId = typeof p.id === 'string' ? p.id : '';
    if (messageId.length > 0) {
      if (this.seen.has(messageId)) return; // 平台重推去重
      this.seen.add(messageId);
      this.seenOrder.push(messageId);
      if (this.seenOrder.length > (this.options.dedupeCapacity ?? 500)) {
        const oldest = this.seenOrder.shift();
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }

    const rawText = typeof p.content === 'string' ? p.content : '';
    // 剥离 @ 前缀：官方 content 形如 <@!USER_OPENID>（openid 含字母数字）或纯 @昵称
    const text = rawText.replace(/^\s*(?:<@[^>]*>|@[\w-]+)\s*/, '').trim();
    if (text.length === 0) return;

    const chatId = (isGroup ? p.group_openid : (p.user_openid ?? p.openid)) ?? '';
    if (typeof chatId !== 'string' || chatId.length === 0) return;

    const policy = isGroup ? this.options.config.groupPolicy : this.options.config.dmPolicy;
    if (!policyAllows(policy, chatId, this.options.config.allow)) return; // 策略外静默忽略

    this.inboundHandler?.({
      channel: 'qq',
      chatId,
      messageId,
      text,
      isGroup,
    });
  }
}
