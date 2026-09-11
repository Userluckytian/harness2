// P2 回归（桌面端）：bridge 的 serve HTTP 请求携带一次性 token。
// 严格 serve 下若不携带，桌面会「已连接但全部请求 401」——本用例断言 header 真的带上。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import type { BridgeDeps, Bridge } from '../src/main/bridge.js';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { handle: () => {} },
}));

import { createBridge } from '../src/main/bridge.js';

const servers: Server[] = [];
const handles: ServeHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

function waitFor(predicate: () => boolean, timeoutMs = 6000, label = '条件'): Promise<void> {
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

/** WS 尚未 open 时 subscribe/sendMessage 会抛「未连接」——重试直到就绪 */
async function invokeWhenReady(bridge: Bridge, req: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await bridge.handleInvoke({} as never, req);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function makeDeps(baseUrl: string, wsUrl: string, authToken: string | null): BridgeDeps {
  return {
    serve: {
      baseUrl,
      wsUrl,
      authToken,
      status: 'connected',
      getStatus: () => ({ status: 'connected' }),
    } as never,
    root: 'C:\\work',
    home: 'C:\\Users\\test\\.harness2',
    sendEvent: () => {},
    sendStatus: () => {},
  };
}

describe('P2 bridge 携带 serve token', () => {
  it('listSessions：带 token 的请求 200；无 token 的同一请求 401（证明 header 真的带上）', async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      const token = req.headers['x-harness2-token'];
      seen.push(typeof token === 'string' ? token : undefined);
      if (token !== 'tok-bridge') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"缺少 serve token（严格模式）"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: [{ id: 's1' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const withToken = createBridge(makeDeps(`http://127.0.0.1:${port}`, `ws://127.0.0.1:${port}/ws`, 'tok-bridge'));
    const sessions = await withToken.handleInvoke({} as never, { cmd: 'listSessions' });
    expect(sessions).toEqual([{ id: 's1' }]);

    const noToken = createBridge(makeDeps(`http://127.0.0.1:${port}`, `ws://127.0.0.1:${port}/ws`, null));
    await expect(noToken.handleInvoke({} as never, { cmd: 'listSessions' })).rejects.toThrow('缺少 serve token');
    expect(seen).toEqual(['tok-bridge', undefined]);
  });

  it('connectWs 以 ?token= 连上严格 serve：订阅 + 发消息能收到 turn-end（桌面端全链）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-bridge-token-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-bridge-token-root-'));
    dirs.push(home, root);
    const handle = await startServe({ port: 0, home, root, provider: new MockProvider([{ text: '桌面回复' }]) });
    handles.push(handle);

    const frames: Array<{ type?: string; sessionId?: string }> = [];
    const deps = makeDeps(`http://127.0.0.1:${handle.port}`, `ws://127.0.0.1:${handle.port}/ws`, handle.token);
    deps.sendEvent = (f) => frames.push(f as { type?: string });
    const bridge = createBridge(deps);
    bridge.connectWs();

    const session = (await bridge.handleInvoke({} as never, { cmd: 'createSession', cwd: root })) as {
      id: string;
    };
    await invokeWhenReady(bridge, { cmd: 'subscribe', sessionId: session.id });
    await invokeWhenReady(bridge, { cmd: 'sendMessage', sessionId: session.id, text: '你好' });
    await waitFor(() => frames.some((f) => f.type === 'turn-end'), 6000, 'turn-end');
    expect(frames.some((f) => f.type === 'event' && f.sessionId === session.id)).toBe(true);
    bridge.disconnectWs();
  }, 20000);
});
