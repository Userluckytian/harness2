// 网关入口：进程内已就绪的 serve + 平台适配器接线。
// 数据流：平台消息 → InboundMessage → 路由解析（routes.json 持久化） → ServeClient.sendMessage
//        → serve 事件帧（assistant 文本累积 + turn-end）→ 出站渲染 → 平台适配器。
// 红线：网关对会话的一切操作经 serve HTTP/WS API（与桌面同权），零新写入路径。
import { ServeClient, type ServeFrame } from './serve-client.js';
import { SessionRouter } from './router.js';
import type { GatewayChannelName, InboundMessage, PlatformAdapter } from './types.js';

export interface StartGatewayOptions {
  root: string;
  home: string;
  serve: { baseUrl: string; wsUrl: string };
  /** 已构建的平台适配器（凭据/策略由装配方注入） */
  adapters: PlatformAdapter[];
  /** turn 结束出站文本渲染（缺省 = 助手最终文本精简版）；返回 '' = 不发送 */
  renderTurnEnd?: (inbound: InboundMessage, frame: TurnEndFrame, finalText: string) => string;
  /** 工具行渲染开关（缺省 false：QQ 场景默认静默工具调用） */
  renderToolLines?: boolean;
}

export type TurnEndFrame = Extract<ServeFrame, { type: 'turn-end' }>;

export interface GatewayHandle {
  stop(): Promise<void>;
}

interface ChatMeta {
  channel: GatewayChannelName;
  chatId: string;
  isGroup: boolean;
  replyToMessageId?: string;
}

const MAX_OUTBOUND_CHARS = 1800;

export async function startGateway(options: StartGatewayOptions): Promise<GatewayHandle> {
  const adapters = new Map<GatewayChannelName, PlatformAdapter>(
    options.adapters.map((a) => [a.channel, a]),
  );
  const sessionToMeta = new Map<string, ChatMeta & { sessionKey: string }>();
  const sessionText = new Map<string, string>();
  const toolLines = new Map<string, string[]>();

  const client = new ServeClient({
    baseUrl: options.serve.baseUrl,
    wsUrl: options.serve.wsUrl,
    onFrame: (frame) => {
      if (frame.type === 'error') return; // 协议错误帧：网关侧不渲染（serve 状态回调已呈现）
      const meta = sessionToMeta.get(frame.sessionId);
      if (meta === undefined) return; // 未订阅的会话
      if (frame.type === 'event') {
        if (frame.event.type === 'assistant/message') {
          const text = frame.event.payload['text'];
          if (typeof text === 'string') sessionText.set(frame.sessionId, text);
        } else if (frame.event.type === 'tool/call' && options.renderToolLines === true) {
          const tool = frame.event.payload['tool'];
          if (typeof tool === 'string') {
            const lines = toolLines.get(frame.sessionId) ?? [];
            lines.push(`> ${tool}`);
            toolLines.set(frame.sessionId, lines.slice(-3)); // 最多 3 行工具摘要
          }
        }
        return;
      }
      if (frame.type === 'turn-end') {
        const adapter = adapters.get(meta.channel);
        if (adapter === undefined) return;
        const toolSummary = toolLines.get(frame.sessionId) ?? [];
        toolLines.delete(frame.sessionId);
        const finalText = sessionText.get(frame.sessionId) ?? '';
        sessionText.delete(frame.sessionId);
        const renderInput = inboundOf(meta);
        const rendered =
          options.renderTurnEnd?.(renderInput, frame, finalText) ??
          [
            ...(toolSummary.length > 0 ? [toolSummary.join('\n'), ''] : []),
            finalText.length > 0 ? finalText : `(turn 结束：${frame.stopReason}${frame.error !== undefined ? `：${frame.error}` : ''})`,
          ].join('\n');
        if (rendered.length === 0) return;
        void adapter
          .send(meta.chatId, rendered.slice(0, MAX_OUTBOUND_CHARS), meta.replyToMessageId, meta.isGroup)
          .catch(() => {}); // 出站失败不阻塞网关（平台不可达等）
      }
    },
  });

  const router = new SessionRouter(options.home, (cwd) => client.createSession(cwd), options.root);

  // 入站接线：适配器消息 → 路由 → 订阅 → 发送
  const handleInbound = (message: InboundMessage): void => {
    const adapter = adapters.get(message.channel);
    if (adapter === undefined) return;
    void router
      .resolve(message.channel, message.chatId)
      .then(async (sessionId) => {
        await client.waitReady();
        if (!sessionToMeta.has(sessionId)) client.subscribe(sessionId);
        const sessionKey = `${message.channel}:${message.chatId}`;
        sessionToMeta.set(sessionId, {
          sessionKey,
          channel: message.channel,
          chatId: message.chatId,
          isGroup: message.isGroup,
          replyToMessageId: message.messageId.length > 0 ? message.messageId : undefined,
        });
        client.sendMessage(sessionId, message.text);
      })
      .catch(() => {
        // 路由/建会话失败：平台侧本轮无回复（错误经 ServeClient 状态回调呈现）
      });
  };
  for (const adapter of options.adapters) adapter.onMessage(handleInbound);
  client.connect();

  return {
    async stop(): Promise<void> {
      client.close();
      for (const a of options.adapters) await a.stop().catch(() => {});
    },
  };
}

function inboundOf(meta: { channel: GatewayChannelName; chatId: string; isGroup: boolean }): InboundMessage {
  return { channel: meta.channel, chatId: meta.chatId, messageId: '', text: '', isGroup: meta.isGroup };
}
