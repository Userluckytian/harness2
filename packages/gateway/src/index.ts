// 网关入口：进程内已就绪的 serve + 平台适配器接线 + 审批桥接。
// 数据流：平台消息 → InboundMessage → 路由解析（routes.json 持久化） → ServeClient.sendMessage
//        → serve 事件帧（assistant 文本累积 + turn-end + 审批请求）→ render.ts 渲染 → 平台适配器出站。
// 审批桥接：approval-request 帧 → 平台消息「回复 1/2」；该 chat 的下一条「1/2」消息 → approval-response。
// 红线：网关对会话的一切操作经 serve HTTP/WS API（与桌面同权），零新写入路径。
import { ServeClient, type ServeFrame } from './serve-client.js';
import { SessionRouter } from './router.js';
import { renderApprovalRequest, renderTurnEnd, parseApprovalReply } from './render.js';
import { homedir } from 'node:os';
import type { GatewayChannelName, InboundMessage, PlatformAdapter } from './types.js';

export { QqAdapter } from './platforms/qq/adapter.js';
export { FeishuAdapter } from './platforms/feishu/adapter.js';
export { policyAllows } from './types.js';
export type { PlatformAdapter, InboundMessage, GatewayPolicy, GatewayChannelName } from './types.js';

export interface StartGatewayOptions {
  root: string;
  /** 用户数据根（缺省 ~/.harness2） */
  home?: string;
  serve: { baseUrl: string; wsUrl: string };
  /** 已构建的平台适配器（凭据/策略由装配方注入） */
  adapters: PlatformAdapter[];
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

export async function startGateway(options: StartGatewayOptions): Promise<GatewayHandle> {
  const home = options.home ?? homedir();
  const adapters = new Map<GatewayChannelName, PlatformAdapter>(
    options.adapters.map((a) => [a.channel, a]),
  );
  const sessionToMeta = new Map<string, ChatMeta & { sessionKey: string }>();
  const sessionText = new Map<string, string>();
  const toolLines = new Map<string, string[]>();
  /** 待审批：chatKey → requestId（同一 chat 同时至多一个 pending；hub 串行保证不会并发） */
  const pendingApproval = new Map<string, string>();

  const client = new ServeClient({
    baseUrl: options.serve.baseUrl,
    wsUrl: options.serve.wsUrl,
    onFrame: (frame) => {
      if (frame.type === 'error') {
        // 陈旧路由/协议错误：一行可见（此前静默会让 chat 永久失联无反馈）
        console.error(`[gateway] serve 错误帧: ${frame.error}`);
        return;
      }
      // 审批请求：仅处理已路由映射的会话（子会话审批 v1 忽略，由 hub 120s 超时拒绝兜底）
      if (frame.type === 'approval-request') {
        const meta = sessionToMeta.get(frame.sessionId);
        if (meta === undefined) return;
        const chatKey = meta.sessionKey;
        if (pendingApproval.has(chatKey)) return; // 上一审批未决：忽略新请求（hub 串行保证不会并发）
        pendingApproval.set(chatKey, frame.requestId);
        const adapter = adapters.get(meta.channel);
        void adapter
          ?.send(meta.chatId, renderApprovalRequest(frame.tool, frame.args), meta.replyToMessageId, meta.isGroup)
          .catch(() => {});
        return;
      }
      const meta = sessionToMeta.get(frame.sessionId);
      if (meta === undefined) return;
      const chatKey = meta.sessionKey;
      if (frame.type === 'event') {
        if (frame.event.type === 'assistant/message') {
          const text = frame.event.payload['text'];
          if (typeof text === 'string') sessionText.set(frame.sessionId, text);
        } else if (frame.event.type === 'tool/call') {
          const tool = frame.event.payload['tool'];
          if (typeof tool === 'string') {
            const lines = toolLines.get(frame.sessionId) ?? [];
            lines.push(`> ${tool}`);
            toolLines.set(frame.sessionId, lines.slice(-3));
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
        const rendered = renderTurnEnd({
          finalText,
          toolLines: toolSummary,
          stopReason: frame.stopReason,
          ...(frame.error !== undefined ? { error: frame.error } : {}),
        });
        if (rendered.length === 0) return;
        const hadPending = pendingApproval.delete(chatKey);
        void hadPending;
        void adapter
          .send(meta.chatId, rendered, meta.replyToMessageId, meta.isGroup)
          .catch(() => {}); // 出站失败不阻塞网关
      }
    },
  });

  const router = new SessionRouter(home, (cwd) => client.createSession(cwd), options.root);

  // 入站接线：先判审批回复，否则作为普通用户消息
  const handleInbound = (message: InboundMessage): void => {
    const adapter = adapters.get(message.channel);
    if (adapter === undefined) return;
    const chatKey = `${message.channel}:${message.chatId}`;
      const requestId = pendingApproval.get(chatKey);
      if (requestId !== undefined) {
        const decision = parseApprovalReply(message.text);
        if (decision !== undefined) {
          pendingApproval.delete(chatKey);
          client.respondApproval(requestId, decision);
          return; // 审批回复不进会话
        }
        // 非决策文本：带 pending 时的普通消息照常入会话（审批保留待决或已超时）
      }
    void router
      .resolve(message.channel, message.chatId)
      .then(async (sessionId) => {
        await client.waitReady();
        if (!sessionToMeta.has(sessionId)) client.subscribe(sessionId);
        sessionToMeta.set(sessionId, {
          sessionKey: chatKey,
          channel: message.channel,
          chatId: message.chatId,
          isGroup: message.isGroup,
          replyToMessageId: message.messageId.length > 0 ? message.messageId : undefined,
        });
        client.sendMessage(sessionId, message.text);
      })
      .catch(() => {
        // 路由/建会话失败：平台侧本轮无回复
      });
  };
  for (const adapter of options.adapters) adapter.onMessage(handleInbound);
  // P0-1（审查 fail 判定）：启动全部适配器——此前漏调导致网关对平台完全聋哑
  for (const adapter of options.adapters) await adapter.start();
  client.connect();

  // 子会话（subagent）的审批请求在网关侧 v1 不支持路由映射，忽略——由 hub 120s 超时拒绝兜底

  return {
    async stop(): Promise<void> {
      client.close();
      for (const a of options.adapters) await a.stop().catch(() => {});
    },
  };
}
