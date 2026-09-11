// P1-b（A5 P1-3）回归补齐：QQ 侧 msg_seq 递增（含并发）+ WS 心跳 / op7 / op9 / 退避。
// 阶段 9 修复提交几乎零新增测试；本文件对既有契约做真实命中回归（同一新增文件覆盖 3 条）。
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { QqAdapter } from '../src/platforms/qq/adapter.js';
import { QqGatewayWs } from '../src/platforms/qq/gateway-ws.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

interface QqRestStub {
  port: number;
  sent: Array<{ path: string; body: Record<string, unknown> }>;
}

/** QQ REST stub：/token + /v2/* 出站捕获 */
async function startRestStub(): Promise<QqRestStub> {
  const sent: QqRestStub['sent'] = [];
  const server = createServer((req, res) => {
    if (req.url === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 7200 }));
      return;
    }
    if (req.url?.startsWith('/v2/')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        sent.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port, sent };
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

describe('P1-b ② msg_seq 严格递增（含并发）', () => {
  it('同一 msg_id 被动回复 msg_seq 1,2,3…；并发不重复不跳号；不同 msg_id 各自计数', async () => {
    const stub = await startRestStub();
    const adapter = new QqAdapter({
      config: { enabled: true, appId: 'a', dmPolicy: 'open', groupPolicy: 'open', allow: [] },
      auth: { appId: 'a', appSecret: 's' },
      tokenUrl: `http://127.0.0.1:${stub.port}/token`,
      apiBase: `http://127.0.0.1:${stub.port}`,
    });

    // 并发 3 条：2 条回同一 msg_id（m1）、1 条回另一 msg_id（m2）
    await Promise.all([adapter.send('u1', 'a1', 'm1'), adapter.send('u1', 'a2', 'm1'), adapter.send('u1', 'a3', 'm2')]);
    await waitFor(() => stub.sent.length >= 3, 8000, '出站 3 条');

    const m1 = stub.sent.filter((s) => s.body.msg_id === 'm1').map((s) => s.body.msg_seq);
    const m2 = stub.sent.filter((s) => s.body.msg_id === 'm2').map((s) => s.body.msg_seq);
    expect(m1).toEqual([1, 2]); // 递增、无重复、无跳号
    expect(m2).toEqual([1]); // 另一 msg_id 独立计数

    // 追加同 msg_id：继续 3（不因并发回退）
    await adapter.send('u1', 'a4', 'm1');
    await waitFor(() => stub.sent.length >= 4, 8000, '出站 4 条');
    expect(stub.sent.filter((s) => s.body.msg_id === 'm1').map((s) => s.body.msg_seq)).toEqual([1, 2, 3]);
  }, 20000);
});

/** 可编程 QQ WS 网关 stub：每连接发 hello；记录每连接的入站帧 */
async function startWsGateway(
  onIdentify: (socket: WebSocket, connectionIndex: number) => void,
): Promise<{ port: number; connections: () => number }> {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((resolve) =>
    wss.once('listening', () => resolve((wss.address() as { port: number }).port)),
  );
  let count = 0;
  wss.on('connection', (socket: WebSocket) => {
    count += 1;
    const index = count;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60 } }));
    socket.on('message', (data: unknown) => {
      let frame: { op: number };
      try {
        frame = JSON.parse(String(data)) as { op: number };
      } catch {
        return;
      }
      if (frame.op === 2) onIdentify(socket, index);
    });
  });
  cleanups.push(async () => {
    (wss as unknown as { closeAllConnections(): void }).closeAllConnections();
    await new Promise<void>((r) => wss.close(() => r()));
  });
  return { port, connections: () => count };
}

function startClient(port: number, extra: { onStatus?: (s: string, d?: string) => void } = {}): QqGatewayWs {
  const gw = new QqGatewayWs({
    url: async () => `ws://127.0.0.1:${port}`,
    token: async () => 'tok',
    intents: 1,
    onDispatch: () => {},
    ...(extra.onStatus !== undefined ? { onStatus: extra.onStatus } : {}),
  });
  gw.start();
  cleanups.push(async () => gw.stop());
  return gw;
}

describe('P1-b ⑤ QQ WS 心跳 / op7 / op9 / 退避', () => {
  it('hello 后按 heartbeat_interval 持续发心跳（op1）', async () => {
    const heartbeats: number[] = [];
    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((resolve) =>
      wss.once('listening', () => resolve((wss.address() as { port: number }).port)),
    );
    wss.on('connection', (socket: WebSocket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 40 } }));
      socket.on('message', (data: unknown) => {
        const frame = JSON.parse(String(data)) as { op: number };
        if (frame.op === 1) heartbeats.push(Date.now());
      });
    });
    cleanups.push(async () => {
      (wss as unknown as { closeAllConnections(): void }).closeAllConnections();
      await new Promise<void>((r) => wss.close(() => r()));
    });

    startClient(port);
    await waitFor(() => heartbeats.length >= 2, 5000, '心跳 ≥2');
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('服务端 op7（要求重连）→ 客户端断开并重新 Identify（第 2 个连接）', async () => {
    let firstSocket: WebSocket | null = null;
    const { port, connections } = await startWsGateway((socket, index) => {
      if (index === 1) {
        firstSocket = socket;
        socket.send(JSON.stringify({ op: 7 })); // 服务端要求重连
      } else {
        socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 's2' } }));
      }
    });
    startClient(port);
    await waitFor(() => firstSocket !== null, 5000, '第 1 连接 identify');
    await waitFor(() => connections() >= 2, 6000, '重连到第 2 连接');
    expect(connections()).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('服务端 op9（invalid session）→ 同样触发重连重新 Identify', async () => {
    const { port, connections } = await startWsGateway((socket, index) => {
      if (index === 1)
        socket.send(JSON.stringify({ op: 9 })); // invalid session
      else socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 's2' } }));
    });
    startClient(port);
    await waitFor(() => connections() >= 2, 6000, 'op9 后重连');
    expect(connections()).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('退避重连：连接被反复断开仍按 1s/2s… 继续重试（≥3 次连接）', async () => {
    // 不发送 READY：reconnectAttempt 不重置，退避按 1s → 2s 递增
    const { port, connections } = await startWsGateway((socket) => {
      socket.close(); // 每次 identify 后立即断开
    });
    const statuses: string[] = [];
    startClient(port, { onStatus: (s) => statuses.push(s) });
    await waitFor(() => connections() >= 3, 8000, '≥3 次连接尝试');
    expect(statuses).toContain('reconnecting');
    expect(connections()).toBeGreaterThanOrEqual(3);
  }, 15000);
});
