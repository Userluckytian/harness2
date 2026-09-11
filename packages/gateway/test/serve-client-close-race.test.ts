// B1 回归：close() 发生在客户端 'open' 派发之前时，不得留下孤儿连接。
//
// 修复前：this.ws 只在 'open' 回调里赋值，且该回调不检查 this.closed。于是：
//   close() 时 this.ws === null → `if (this.ws !== null)` 什么都不关；
//   随后 'open' 触发 → this.ws = socket → 这条 WS 永久留活，服务端永远收不到 close。
// 表现：gateway-lifecycle 用例在 Linux runner 上偶发 3s 超时（CI run #34600671647）；
// 生产含义：网关 stop() 之后仍有一条活着的 WS 在回调 onFrame。取证见 docs/issue-log/2026-09-11-review-T.md §1。
//
// 确定性说明：同一 tick 内 connect() 后立即 close()，客户端 'open' 必定尚未派发（它至少要等服务端
// 完成握手响应），因此无需押调度就能稳定命中该窗口——与审查方的 PROOF-A 同场景。
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ServeClient } from '../src/serve-client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

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

type ServerStats = { connected: number; closed: number };

/** 真 WS 服务端：正常完成握手，并统计服务端观察到的连接建立 / 关闭数 */
async function startWsServer(): Promise<{ port: number; stats: () => ServerStats }> {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((resolve) =>
    wss.once('listening', () => resolve((wss.address() as { port: number }).port)),
  );
  let connected = 0;
  let closed = 0;
  wss.on('connection', (socket) => {
    connected += 1;
    socket.on('close', () => (closed += 1));
  });
  cleanups.push(async () => {
    (wss as unknown as { closeAllConnections(): void }).closeAllConnections();
    await new Promise<void>((r) => wss.close(() => r()));
  });
  return { port, stats: () => ({ connected, closed }) };
}

function clientFor(port: number): ServeClient {
  return new ServeClient({
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    onFrame: () => {},
  });
}

describe('B1 ServeClient close() 与在途连接的竞态', () => {
  it("close() 在 'open' 派发之前 → 握手完成后该连接被关闭，不留孤儿", async () => {
    const { port, stats } = await startWsServer();
    const client = clientFor(port);

    client.connect();
    client.close(); // 同 tick：此刻客户端 'open' 必定尚未派发

    await waitFor(() => stats().connected >= 1, 3000, '服务端完成 WS 握手');
    // 修复前：'open' 里无条件 this.ws = socket，而 close() 早已返回 → 此处必定超时
    await waitFor(() => stats().closed >= stats().connected, 5000, '在途连接被关闭');
    expect(stats().closed).toBe(stats().connected);
  }, 15000);

  it("'open' 之后 close() 仍正常关闭（正常路径不回归）", async () => {
    const { port, stats } = await startWsServer();
    const client = clientFor(port);
    await client.waitReady();
    await waitFor(() => stats().connected >= 1, 3000, '服务端观察到 WS 连接');
    const established = stats().connected;

    client.close();

    await waitFor(() => stats().closed >= established, 3000, 'WS 连接关闭');
    expect(stats().closed).toBe(established);
  }, 15000);

  it('无人 await 就绪时，关闭引发的拒绝不会变成 unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { port, stats } = await startWsServer();
      const client = clientFor(port);
      client.connect(); // 故意不 await waitReady()：就绪 promise 无人消费
      client.close(); // 触发 'open' 的 closed 分支 → reject 无人接收
      await waitFor(() => stats().closed >= 1, 5000, '在途连接被关闭');
      await new Promise<void>((r) => setTimeout(r, 300));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 15000);

  it('同步构造失败（wsUrl 非法）不把就绪 promise 卡成已拒绝值', async () => {
    const statuses: string[] = [];
    const client = new ServeClient({
      baseUrl: 'http://127.0.0.1:1',
      wsUrl: 'not-a-ws-url',
      onFrame: () => {},
      onStatus: (status) => {
        statuses.push(status);
      },
    });

    await expect(client.waitReady()).rejects.toThrow();
    await expect(client.waitReady()).rejects.toThrow();

    // 修复前：readyPromise 被赋值覆盖成已拒绝 promise → connect() 单飞判定永久命中 →
    // 第二次 waitReady() 根本不再尝试连接（'connecting' 只会出现 1 次）。
    expect(statuses.filter((s) => s === 'connecting').length).toBe(2);
    client.close();
  });
});
