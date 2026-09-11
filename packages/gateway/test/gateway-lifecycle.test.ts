// P1-b（A5 P1-3）回归补齐：startGateway 生命周期。
// 契约：启动时对每个已装配适配器调用一次 start()；stop() 逆序释放（适配器 stop + WS 关闭）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startGateway } from '../src/index.js';
import type { GatewayChannelName, InboundMessage, PlatformAdapter } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
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
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakeAdapter implements PlatformAdapter {
  started = 0;
  stopped = 0;
  handler: ((m: InboundMessage) => void) | null = null;
  constructor(readonly channel: GatewayChannelName) {}
  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  async send(): Promise<void> {}
}

describe('P1-b ③ startGateway 生命周期', () => {
  it('启动调用每个 adapter.start()；stop() 调用 adapter.stop() 并关闭 WS 连接', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((resolve) =>
      wss.once('listening', () => resolve((wss.address() as { port: number }).port)),
    );
    const openSockets: unknown[] = [];
    let connected = 0;
    let closed = 0;
    wss.on('connection', (socket) => {
      openSockets.push(socket);
      connected += 1;
      socket.on('close', () => (closed += 1));
    });
    cleanups.push(async () => {
      (wss as unknown as { closeAllConnections(): void }).closeAllConnections();
      await new Promise<void>((r) => wss.close(() => r()));
    });

    const home = mkdtempSync(join(tmpdir(), 'h2-gw-life-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-gw-life-root-'));
    dirs.push(home, root);
    const qq = new FakeAdapter('qq');
    const feishu = new FakeAdapter('feishu');

    const handle = await startGateway({
      root,
      home,
      serve: { baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` },
      adapters: [qq, feishu],
    });
    cleanups.push(async () => handle.stop());

    expect(qq.started).toBe(1);
    expect(feishu.started).toBe(1); // 启动确实接线到全部适配器（修复前漏调导致聋哑）

    await waitFor(() => connected >= 1, 3000, 'ServeClient WS 连接建立');
    const established = connected;

    await handle.stop();
    expect(qq.stopped).toBe(1);
    expect(feishu.stopped).toBe(1);
    // 资源释放：WS 连接已被关闭
    await waitFor(() => closed >= established, 3000, 'ServeClient WS 连接关闭');
    expect(closed).toBe(established);
    expect(openSockets.length).toBe(established);
  }, 15000);
});
