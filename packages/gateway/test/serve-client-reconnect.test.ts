// P1-b（A5 P1-3）回归补齐：ServeClient 断线重连 + 重订阅。
// 契约：serve 侧订阅按连接存储，重连 open 后必须重发全部订阅（否则一次掉线即永久失联）。
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ServeClient } from '../src/serve-client.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

interface OpenedFrame {
  op: string;
  sessionId?: string;
}

function waitFor(predicate: () => boolean, timeoutMs = 8000, label = '条件'): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`等待超时: ${label}`));
      }
    }, 20);
  });
}

describe('P1-b ① ServeClient 断线重连 + 重订阅', () => {
  it('首连发送订阅；服务端断开后自动重连并重发全部订阅（帧不丢）', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((resolve) =>
      wss.once('listening', () => resolve((wss.address() as { port: number }).port)),
    );
    /** 每次连接收到的帧（按连接分桶） */
    const perConnection: OpenedFrame[][] = [];
    const sockets: WebSocket[] = [];
    wss.on('connection', (socket: WebSocket) => {
      const bucket: OpenedFrame[] = [];
      perConnection.push(bucket);
      sockets.push(socket);
      socket.on('message', (data: unknown) => {
        try {
          bucket.push(JSON.parse(String(data)) as OpenedFrame);
        } catch {
          // 非 JSON 忽略
        }
      });
    });
    cleanups.push(async () => {
      (wss as unknown as { closeAllConnections(): void }).closeAllConnections();
      await new Promise<void>((r) => wss.close(() => r()));
    });

    const client = new ServeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      onFrame: () => {},
    });
    cleanups.push(async () => client.close());

    await client.waitReady();
    client.subscribe('s-1');
    client.subscribe('s-2');
    await waitFor(() => perConnection[0]?.length === 2, 5000, '首连订阅 2 条');

    // 强制断开首连接（模拟网络抖动 / serve 重启）
    sockets[0]?.terminate();
    await waitFor(() => perConnection.length >= 2, 6000, '自动重连');
    // 重连后必须重发订阅（否则服务端不知道这个连接订阅了哪些会话）
    await waitFor(() => perConnection[1]?.filter((f) => f.op === 'subscribe').length === 2, 5000, '重订阅 2 条');
    expect(perConnection[1]?.map((f) => f.sessionId).sort()).toEqual(['s-1', 's-2']);
  }, 20000);
});
