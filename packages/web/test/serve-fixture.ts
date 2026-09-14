// 测试夹具：一个**本地 server 夹具**（真 node:http + 真 ws），按 serve 契约回最小报文/帧。
//
// 为什么用真 server 而不是 mock 函数：web 壳的全部接入面就是 HTTP/WS 契约（token 头、
// `protocolVersion` 声明、op 形状、帧形状），只有走真 socket 才能证明「客户端发出去的确实是
// 契约要求的报文」，而不是「测试自己也认同的假形状」。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SessionEventShape, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';

export interface ServeFixture {
  readonly origin: string;
  /** 收到的 WS op（按到达顺序） */
  readonly ops: Array<Record<string, unknown>>;
  /** 收到的 HTTP 请求（method + path + token 头） */
  readonly http: Array<{ method: string; path: string; token?: string }>;
  /** 给「当前唯一连接」推一帧（测试驱动流式增量/终态） */
  push(frame: Record<string, unknown>): void;
  /** 是否已有 WS 连接 */
  connected(): boolean;
  close(): Promise<void>;
}

export function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): SessionEventShape & { active: boolean } {
  return { v: 1, seq, ts: '2026-09-14T00:00:00.000Z', type, payload, active: true };
}

export async function startServeFixture(options: {
  sessions?: SessionSummaryShape[];
  events?: Array<SessionEventShape & { active: boolean }>;
  /** 收到 submit 时的服务端行为（缺省 = 回 accepted ack） */
  onSubmit?: (socket: WebSocket, op: Record<string, unknown>) => void;
  /** 收到 cancel 时的服务端行为（缺省 = 回 stopping ack） */
  onCancel?: (socket: WebSocket, op: Record<string, unknown>) => void;
}): Promise<ServeFixture> {
  const ops: Array<Record<string, unknown>> = [];
  const httpLog: Array<{ method: string; path: string; token?: string }> = [];
  const sockets = new Set<WebSocket>();
  let lastSeq = options.events?.at(-1)?.seq ?? 0;

  const sessions: SessionSummaryShape[] = options.sessions ?? [
    {
      id: 's1',
      dir: '/tmp/s1',
      cwd: '/work',
      mtimeMs: 1000,
      firstUserText: '第一个会话',
      messageCount: 2,
      lastSeq,
    },
  ];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    httpLog.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      ...(typeof req.headers['x-harness2-token'] === 'string' ? { token: req.headers['x-harness2-token'] } : {}),
    });
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      send(200, { sessions });
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        const parsed = raw.length > 0 ? (JSON.parse(raw) as { cwd?: string }) : {};
        if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) {
          send(400, { error: 'cwd 必填' });
          return;
        }
        send(200, { id: 's-new', dir: '/tmp/s-new', cwd: parsed.cwd });
      });
      return;
    }
    const match =
      /^\/api\/sessions?\/([^/]+)(\/events|\/run-config|\/plan-state|\/execution-view|\/change-review|\/undo|\/redo)?$/.exec(
        url.pathname,
      );
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const sub = match[2] ?? '';
      if (sub === '/events') {
        send(200, {
          id,
          dir: `/tmp/${id}`,
          header: { sessionId: id, cwd: '/work' },
          events: options.events ?? [],
          warnings: [],
          lastSeq,
        });
        return;
      }
      if (sub === '/plan-state') {
        send(404, { error: '会话暂无计划数据（无 task/transition 账本）' });
        return;
      }
      if (sub === '/execution-view') {
        send(200, { views: [] });
        return;
      }
      if (sub === '/change-review') {
        send(200, { sourceDir: '/work', files: [], changedFiles: 0, dirtyFiles: 0, readOnly: true });
        return;
      }
      if (sub === '/run-config') {
        send(500, { error: '夹具未实现 run-config' });
        return;
      }
      if (sub === '/undo' || sub === '/redo') {
        send(200, { results: [] });
        return;
      }
      send(405, { error: '方法不被支持' });
      return;
    }
    send(404, { error: `not found: ${req.method} ${url.pathname}` });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 契约：/ws 路径 + protocolVersion 声明 + token（查询参数形态）
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    httpLog.push({
      method: 'UPGRADE',
      path: `${url.pathname}?${url.searchParams.toString()}`,
      ...(url.searchParams.get('token') !== null ? { token: url.searchParams.get('token')! } : {}),
    });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    ws.on('message', (data: Buffer) => {
      const op = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      ops.push(op);
      if (op['op'] === 'submit' && options.onSubmit !== undefined) options.onSubmit(ws, op);
      if (op['op'] === 'cancel' && options.onCancel !== undefined) options.onCancel(ws, op);
    });
    ws.on('close', () => sockets.delete(ws));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    ops,
    http: httpLog,
    push: (frame) => {
      if (typeof frame['seq'] === 'number' && frame['seq'] > lastSeq) lastSeq = frame['seq'] as number;
      for (const ws of sockets) ws.send(JSON.stringify(frame));
    },
    connected: () => sockets.size > 0,
    close: async () => {
      for (const ws of sockets) ws.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 轮询等待条件成立（避免对固定延时敏感） */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
