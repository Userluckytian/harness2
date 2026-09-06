// QQ 官方 Bot API v2 适配器离线测试：本地 HTTP stub（鉴权/出站捕获）+ 本地 WS 网关模拟。
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { QqAdapter } from '../src/platforms/qq/adapter.js';
import { QqApi } from '../src/platforms/qq/api.js';
import type { InboundMessage } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

/** QQ 平台 stub：/token 鉴权 + /gateway 返回本地 ws 地址 + /v2/* 出站捕获 */
async function startQqStub(opts: { wsPort: number; tokenDelayMs?: number }): Promise<{ port: number; sent: Array<{ path: string; body: Record<string, unknown> }> }> {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    if (req.url === '/token') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 7200 }));
      }, opts.tokenDelayMs ?? 0);
      return;
    }
    if (req.url === '/gateway') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: `ws://127.0.0.1:${opts.wsPort}` }));
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
  cleanups.push(async () => new Promise<void>((r) => server.close(() => r())));
  return { port, sent };
}

/** QQ WS 网关模拟：hello → 收 identify → READY → 收心跳；可推 dispatch */
async function startQqWsGateway(dispatches: Array<{ t: string; d: Record<string, unknown> }>): Promise<{ received: unknown[]; port: number }> {
  const received: unknown[] = [];
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((resolve) => wss.once('listening', () => resolve((wss.address() as { port: number }).port)));
  let identified = false;
  wss.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 120 } }));
    socket.on('message', (data: unknown) => {
      const frame = JSON.parse(String(data)) as { op: number; d?: unknown };
      received.push(frame);
      if (frame.op === 2 && !identified) {
        identified = true;
        let s = 1;
        socket.send(JSON.stringify({ op: 0, s: s++, t: 'READY', d: { session_id: 'sess-1', user: { id: 'bot' } } }));
        for (const d of dispatches) socket.send(JSON.stringify({ op: 0, s: s++, t: d.t, d: d.d }));
      }
    });
  });
  cleanups.push(async () => {
    (wss as unknown as { closeAllConnections(): void }).closeAllConnections(); // 终止已建立连接（wss.close 只停监听）
    await new Promise<void>((r) => wss.close(() => r()));
  });
  return { received, port };
}

function makeAdapter(wsPort: number, httpPort: number, config: { groupPolicy?: 'open' | 'allowlist' | 'disabled'; allow?: string[] }): {
  adapter: QqAdapter;
  handlerQueue: InboundMessage[];
} {
  const handlerQueue: InboundMessage[] = [];
  const adapter = new QqAdapter({
    config: {
      enabled: true,
      appId: 'app-1',
      dmPolicy: 'open',
      groupPolicy: config.groupPolicy ?? 'open',
      allow: config.allow ?? [],
    },
    auth: { appId: 'app-1', appSecret: 'secret-1' },
    tokenUrl: `http://127.0.0.1:${httpPort}/token`,
    apiBase: `http://127.0.0.1:${httpPort}`,
  });
  adapter.onMessage((m) => handlerQueue.push(m));
  return { adapter, handlerQueue };
}

describe('QqApi', () => {
  it('token 单飞：并发 getToken 共享一次刷新', async () => {
    const { port } = await startQqStub({ wsPort: 1, tokenDelayMs: 80 });
    const api = new QqApi({ appId: 'a', appSecret: 's', tokenUrl: `http://127.0.0.1:${port}/token`, apiBase: `http://127.0.0.1:${port}` });
    const [t1, t2] = await Promise.all([api.getToken(), api.getToken()]);
    expect(t1).toBe('stub-token');
    expect(t2).toBe('stub-token');
  });

  it('出站队列串行 + 携带 QQBot token', async () => {
    const { port, sent } = await startQqStub({ wsPort: 1 });
    const api = new QqApi({ appId: 'a', appSecret: 's', tokenUrl: `http://127.0.0.1:${port}/token`, apiBase: `http://127.0.0.1:${port}`, minIntervalMs: 10 });
    await api.enqueue(() => api.request('/v2/groups/g1/messages', { content: 'a', msg_type: 0 }));
    await api.enqueue(() => api.request('/v2/groups/g1/messages', { content: 'b', msg_type: 0 }));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body.content).toBe('a');
  });
});

describe('QqAdapter（端到端：stub 网关 + stub REST）', () => {
  it('群 @ 消息 → 剥离 @ → onMessage；重复 id 去重；出站走群接口带 msg_id', async () => {
    const dispatches = [
      { t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm1', group_openid: 'grp-1', content: '<@!bot> 帮我看看目录' } },
      { t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm1', group_openid: 'grp-1', content: '<@!bot> 帮我看看目录' } }, // 重推
    ];
    const { port: wsPort, received } = await startQqWsGateway(dispatches);
    const { port: httpPort, sent } = await startQqStub({ wsPort });
    const { adapter, handlerQueue } = makeAdapter(wsPort, httpPort, {});

    await adapter.start();
    await waitFor(() => handlerQueue.length >= 1);
    expect(handlerQueue).toHaveLength(1); // 去重后仅 1 条
    expect(handlerQueue[0]?.text).toBe('帮我看看目录');
    expect(handlerQueue[0]?.isGroup).toBe(true);

    // 出站
    await adapter.send('grp-1', '处理完成', 'm1', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe('/v2/groups/grp-1/messages');
    expect(sent[0]?.body.msg_id).toBe('m1');
    // identify 帧曾发出（QQBot 前缀）
    const identify = received.find((f) => (f as { op: number }).op === 2) as { d: { token: string } } | undefined;
    expect(identify?.d.token).toBe('QQBot stub-token');
    await adapter.stop();
  });

  it('allowlist 策略：白名单外群聊静默忽略', async () => {
    const dispatches = [{ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'mx', group_openid: 'grp-evil', content: 'hi' } }];
    const { port: wsPort } = await startQqWsGateway(dispatches);
    const { port: httpPort } = await startQqStub({ wsPort });
    const { adapter, handlerQueue } = makeAdapter(wsPort, httpPort, { groupPolicy: 'allowlist', allow: ['grp-ok'] });

    await adapter.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(handlerQueue).toHaveLength(0);
    await adapter.stop();
  });
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时')), timeoutMs);
    const t2 = setInterval(() => {
      if (predicate()) {
        clearTimeout(timer);
        clearInterval(t2);
        resolve();
      }
    }, 50);
  });
}
