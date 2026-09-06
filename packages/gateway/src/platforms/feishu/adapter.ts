// 飞书基础适配器（阶段 9）：webhook 事件接收（本地 HTTP 端点）+ REST 出站。
// 传输模式依据：飞书事件订阅的 webhook 模式要求公网可达 URL——真机部署由用户环境决定
// （内网穿透/公网部署）；本适配器只实现协议面（url_verification 挑战应答 + im.message.receive_v1
// 解析 + im/v1/messages 出站），端点由装配方暴露。
// 红线：文本收发；tenant_access_token 单飞刷新（internal app：app_id+app_secret）；零新写入路径。
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { policyAllows, type GatewayChannelName, type InboundMessage, type PlatformAdapter } from '../../types.js';
import type { GatewayChannelConfig } from '@harness2/core';

export interface FeishuAdapterOptions {
  config: GatewayChannelConfig;
  auth: { appId: string; appSecret: string };
  /** 入站消息回调（经 onMessage(handler) 注册；此字段仅为兼容保留，可选） */
  onEventMessage?: (message: InboundMessage) => void;
  /** webhook 监听端口（本地；公网暴露由装配方负责） */
  webhookPort?: number;
  /** 飞书开放平台「Verification Token」（事件订阅页配置；配置后强制校验请求头 token）——P1-5 */
  verificationToken?: string;
  /** 飞书 API 基址（默认官方；测试注入本地 stub） */
  apiBase?: string;
  /** 出站最小间隔 ms（与 QQ 同款限速；默认 300） */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface FeishuEventEnvelope {
  type?: unknown; // url_verification | event_callback
  challenge?: unknown;
  header?: { event_type?: unknown };
  event?: {
    message?: { chat_id?: unknown; message_id?: unknown; content?: unknown; message_type?: unknown };
    sender?: { sender_id?: { open_id?: unknown } };
  };
}

export class FeishuAdapter implements PlatformAdapter {
  readonly channel: GatewayChannelName = 'feishu';
  private server: Server | null = null;
  private tokenState: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private inboundHandler: ((message: InboundMessage) => void) | null = null;
  /** 出站限速队列（P2-7：与 QQ 同款，防多 chat 突发撞 QPS） */
  private outboundQueue: Promise<void> = Promise.resolve();
  private lastSentAt = 0;

  constructor(private readonly options: FeishuAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? 'https://open.feishu.cn';
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  /** 启动本地 webhook 接收端点（P1-5：配置 verificationToken 时强制校验；未配置启动告警「仅限内网」） */
  async start(): Promise<void> {
    if (this.options.verificationToken === undefined) {
      console.error('[gateway/feishu] 警告：未配置 verificationToken，webhook 无鉴权——仅限 127.0.0.1 内网/穿透环境使用');
    }
    const port = this.options.webhookPort ?? 9800;
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('events')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const token = typeof req.headers['x-lark-token'] === 'string' ? req.headers['x-lark-token'] : undefined;
        if (this.options.verificationToken !== undefined && token !== this.options.verificationToken) {
          res.writeHead(401);
          res.end('invalid verification token');
          return;
        }
        void this.handleEventBody(raw, res);
      });
    });
    server.on('error', (e: Error) => {
      console.error(`[gateway/feishu] webhook 端点错误: ${e.message}`);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  }

  /** 解析飞书事件体：url_verification 应答挑战；消息事件 → 统一 InboundMessage */
  handleEventBody(raw: string, res?: ServerResponse): void {
    let body: FeishuEventEnvelope;
    try {
      body = JSON.parse(raw) as FeishuEventEnvelope;
    } catch {
      res?.writeHead(400);
      res?.end();
      return;
    }
    if (body.type === 'url_verification') {
      res?.writeHead(200, { 'content-type': 'application/json' });
      res?.end(JSON.stringify({ challenge: body.challenge ?? '' }));
      return;
    }
    if (body.type === 'event_callback' && body.header?.event_type === 'im.message.receive_v1') {
      const message = body.event?.message;
      const messageId = typeof message?.message_id === 'string' ? message.message_id : '';
      const chatId = typeof message?.chat_id === 'string' ? message.chat_id : '';
      const contentRaw = typeof message?.content === 'string' ? message.content : '';
      const messageIdType = message?.message_type;
      if (messageId.length > 0 && chatId.length > 0 && messageIdType === 'text') {
        if (!this.seen.has(messageId)) {
          this.seen.add(messageId);
          this.seenOrder.push(messageId);
          if (this.seenOrder.length > 500) {
            const oldest = this.seenOrder.shift();
            if (oldest !== undefined) this.seen.delete(oldest);
          }
          // 飞书 text content 是 JSON：{"text":"..."}
          let text = '';
          try {
            const parsed = JSON.parse(contentRaw) as { text?: unknown };
            if (typeof parsed.text === 'string') text = parsed.text.trim();
          } catch {
            text = '';
          }
          if (text.length > 0 && this.inboundHandler !== null) {
            // 飞书 p2p 会话 chat_id 为 oc_*；群聊同为 oc_*——v1 一律按私聊（p2p chat_type 判定需要额外字段，留真机联调）
            // P1-4（审查）：策略三态在入站闸门执行（与 QQ 同位）——缺省 allowlist 防滥用
            if (!policyAllows(this.options.config.dmPolicy, chatId, this.options.config.allow)) return;
            this.inboundHandler({ channel: 'feishu', chatId, messageId, text, isGroup: false });
          }
        }
      }
    }
    res?.writeHead(200, { 'content-type': 'application/json' });
    res?.end('{}');
  }

  /** tenant_access_token 单飞刷新 */
  private async getToken(): Promise<string> {
    if (this.tokenState !== null && Date.now() < this.tokenState.expiresAt - 60_000) {
      return this.tokenState.token;
    }
    if (this.refreshing === null) {
      this.refreshing = this.refreshToken().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refreshToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.options.auth.appId, app_secret: this.options.auth.appSecret }),
    });
    const body = (await res.json()) as { tenant_access_token?: unknown; expire?: unknown };
    if (typeof body.tenant_access_token !== 'string' || body.tenant_access_token.length === 0) {
      throw new Error('feishu token 刷新失败（响应缺少 tenant_access_token）');
    }
    const expire = typeof body.expire === 'number' && body.expire > 60 ? body.expire : 3600;
    this.tokenState = { token: body.tenant_access_token, expiresAt: Date.now() + expire * 1000 };
    return this.tokenState.token;
  }

  /** 出站文本消息（P2-7：回复走官方 reply API；普通消息走 im/v1/messages；最小间隔限速与 QQ 同款） */
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const token = await this.getToken();
    const content = JSON.stringify({ text });
    const path =
      replyToMessageId !== undefined
        ? `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
        : `/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const body: Record<string, unknown> =
      replyToMessageId !== undefined
        ? { msg_type: 'text', content }
        : { receive_id: chatId, msg_type: 'text', content };
    const run = this.outboundQueue.then(async () => {
      const wait = this.lastSentAt + 300 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`feishu 出站失败（status ${res.status}）: ${errText.slice(0, 200)}`);
      }
      await res.arrayBuffer().catch(() => {});
      this.lastSentAt = Date.now();
    });
    this.outboundQueue = run.then(
      () => undefined,
      () => undefined,
    ); // 队列容错：单次失败不阻塞后续
    await run;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = null;
  }
}
