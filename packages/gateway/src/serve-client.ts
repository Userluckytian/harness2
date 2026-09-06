// serve 客户端（网关侧）：HTTP 控制 + WS 事件面——与桌面桥同款契约（服务 API 契约 v1）。
// 零新写入路径：一切会话操作经 serve API；网关只是 serve 的又一个观察者。
import { WebSocket } from 'ws';

export type ServeFrame =
  | { type: 'delta'; sessionId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'delta'; sessionId: string; kind: 'tool'; call: { callId: string; tool: string; args?: unknown } }
  | { type: 'event'; sessionId: string; event: { seq: number; type: string; payload: Record<string, unknown> } }
  | { type: 'turn-end'; sessionId: string; stopReason: string; error?: string; warning?: string }
  | { type: 'approval-request'; sessionId: string; tool: string; args: unknown; requestId: string }
  | { type: 'error'; error: string };

export interface ServeClientOptions {
  baseUrl: string;
  wsUrl: string;
  /** WS 帧回调（网关据此渲染出站） */
  onFrame: (frame: ServeFrame) => void;
  /** 连接状态变化（适配器可用于提示平台侧） */
  onStatus?: (status: 'connecting' | 'connected' | 'reconnecting' | 'offline', detail?: string) => void;
}

export class ServeClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 首次连接就绪（open）后 resolve；断线重连不重置——订阅调用在就绪前排队等待 */
  private readyPromise: Promise<void> | null = null;
  /** 已订阅会话（P1-1：serve 侧订阅随连接重建，重连 open 后自动重发） */
  private subscribed = new Set<string>();

  constructor(private readonly options: ServeClientOptions) {}

  /** 等待 WS 就绪（resolve 后 subscribe/sendMessage 可用；断线后重新调用会重连） */
  waitReady(): Promise<void> {
    if (this.readyPromise === null) this.connect();
    return this.readyPromise ?? Promise.reject(new Error('serve 连接未初始化'));
  }

  get base(): string {
    return this.options.baseUrl.replace(/\/$/, '');
  }

  // —— HTTP 控制面 ——

  async createSession(cwd: string): Promise<{ id: string; dir: string }> {
    return this.httpJson(`${this.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
  }

  async listSessions(cwd?: string): Promise<{ sessions: Array<Record<string, unknown>> }> {
    const q = cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : '';
    return this.httpJson(`${this.base}/api/sessions${q}`);
  }

  async events(sessionId: string): Promise<unknown> {
    return this.httpJson(`${this.base}/api/sessions/${encodeURIComponent(sessionId)}/events`);
  }

  async undo(sessionId: string, opts: { n?: number; dryRun?: boolean } = {}): Promise<unknown> {
    return this.httpJson(`${this.base}/api/sessions/${encodeURIComponent(sessionId)}/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
  }

  private async httpJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`serve 响应不是 JSON（status ${res.status}）`);
      }
    }
    if (!res.ok) {
      const msg = (body as { error?: string } | null)?.error ?? `serve 错误（status ${res.status}）`;
      throw new Error(msg);
    }
    return body as T;
  }

  // —— WS 事件面 ——

  connect(): void {
    if (this.closed) return;
    if (this.readyPromise !== null) return; // 已连接/重连中：单飞
    this.options.onStatus?.('connecting');
    this.readyPromise = new Promise<void>((resolve, reject) => {
      try {
        const socket = new WebSocket(this.options.wsUrl);
        socket.on('open', () => {
          this.ws = socket;
          // P1-1：serve 侧订阅按连接存储，重连后重发全部订阅（否则一次掉线即永久失联）
          for (const sessionId of this.subscribed) {
            try {
              socket.send(JSON.stringify({ op: 'subscribe', sessionId }));
            } catch {
              // 发送失败由 close 链路兜底
            }
          }
          this.options.onStatus?.('connected');
          resolve();
        });
        socket.on('message', (data: unknown) => {
          try {
            this.options.onFrame(JSON.parse(String(data)) as ServeFrame);
          } catch {
            // 非 JSON 帧：忽略
          }
        });
        socket.on('close', () => {
          if (this.ws === socket) this.ws = null;
          this.readyPromise = null; // 断线后下次 waitReady 重新连接
          if (this.closed) return;
          this.options.onStatus?.('reconnecting');
          if (this.reconnectTimer === null) {
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              if (!this.closed) this.connect();
            }, 1000);
          }
        });
        socket.on('error', (e: Error) => {
          if (this.ws !== socket) {
            this.readyPromise = null;
            reject(e);
          }
          // 已建立后的错误由 close 统一收尾
        });
      } catch (e) {
        this.readyPromise = null;
        this.options.onStatus?.('offline', (e as Error).message);
        reject(e);
      }
    });
  }

  /** 订阅会话（路由命中后调用；断线重连后自动重发） */
  subscribe(sessionId: string): void {
    this.subscribed.add(sessionId);
    this.wsSend({ op: 'subscribe', sessionId });
  }

  /** 发送用户消息到会话（hub 同会话串行排队） */
  sendMessage(sessionId: string, text: string): void {
    this.wsSend({ op: 'user-message', sessionId, text });
  }

  /** 审批应答（P1-2：未连接不抛——返回 false 由调用方感知，杜绝平台事件监听器同步路径崩溃） */
  respondApproval(requestId: string, decision: 'allow' | 'deny'): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      this.options.onStatus?.('reconnecting', '审批应答时事件通道未连接（已丢弃，hub 超时拒绝兜底）');
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ op: 'approval-response', requestId, decision }));
      return true;
    } catch {
      return false;
    }
  }

  private wsSend(frame: unknown): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('与 serve 的事件通道未连接');
    }
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // 已关闭
      }
      this.ws = null;
    }
  }
}
