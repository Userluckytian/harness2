// QQ 官方 WS 网关客户端：hello(10)/心跳(1)/identify(2)/dispatch(0)/reconnect(7)/resume(6)。
// 断线指数退避重连（v1 简化：重连走重新 Identify，不用 resume——session 丢失可接受，如实声明）。
import WebSocket from 'ws';

export interface QqGatewayOptions {
  url: () => Promise<string>;
  token: () => Promise<string>;
  intents: number;
  onDispatch: (eventType: string, payload: Record<string, unknown>) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'reconnecting' | 'offline', detail?: string) => void;
}

/** 官方 intents（默认：群聊@ + C2C 私聊 + 单聊 DIRECT_MESSAGE） */
export const QQ_INTENT_GROUP_AND_C2C = 1 << 25;
export const QQ_INTENT_DIRECT_MESSAGE = 1 << 12;

interface PendingSend {
  resolve: () => void;
  reject: (e: Error) => void;
}

export class QqGatewayWs {
  private ws: WebSocket | null = null;
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private lastSeq: number | null = null;

  constructor(private readonly options: QqGatewayOptions) {}

  start(): void {
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    this.options.onStatus?.('connecting');
    try {
      const url = await this.options.url();
      const token = await this.options.token();
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('message', (data: unknown) => {
        try {
          const frame = JSON.parse(String(data)) as QqFrame; // P2-2：平台侧畸形帧不击穿进程
          this.handleFrame(frame, token);
        } catch {
          return;
        }
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
        if (!this.closed) this.scheduleReconnect();
      });
      ws.on('error', () => {
        // close 统一收尾
      });
    } catch (e) {
      this.options.onStatus?.('offline', (e as Error).message);
      if (!this.closed) this.scheduleReconnect();
    }
  }

  private handleFrame(frame: QqFrame, token: string): void {
    if (typeof frame.s === 'number') this.lastSeq = frame.s;
    switch (frame.op) {
      case 10: {
        // Hello：按服务端间隔起心跳并发 Identify
        const interval =
          typeof frame.d === 'object' &&
          frame.d !== null &&
          typeof (frame.d as { heartbeat_interval?: unknown }).heartbeat_interval === 'number'
            ? (frame.d as { heartbeat_interval: number }).heartbeat_interval
            : 30_000;
        this.heartbeatTimer = setInterval(() => this.rawSend({ op: 1, d: this.lastSeq }), interval);
        this.rawSend({
          op: 2,
          d: { token: `QQBot ${token}`, intents: this.options.intents, shard: [0, 1] },
        });
        break;
      }
      case 0: {
        // Dispatch：READY 带 session_id（v1 不 resume，仅记录）
        if (frame.t === 'READY') {
          this.reconnectAttempt = 0;
          this.options.onStatus?.('connected');
        }
        if (typeof frame.t === 'string') {
          this.options.onDispatch(frame.t, (frame.d as Record<string, unknown>) ?? {});
        }
        break;
      }
      case 7: {
        // 服务端要求重连：立即断开触发重连链
        this.ws?.close();
        break;
      }
      case 9: {
        // P2-3：invalid session（Identify/Resume 被拒）——关闭触发重连链重新 Identify
        this.ws?.close();
        break;
      }
      case 11:
        // Heartbeat ack
        break;
    }
  }

  private rawSend(frame: unknown): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    this.options.onStatus?.('reconnecting');
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) void this.connect();
    }, delay);
  }
}

interface QqFrame {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
}

export type { PendingSend };
