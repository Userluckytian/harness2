// P1-a（A5 P1-1）回归：飞书适配器 listen 错误路径。
// 缺陷：`start()` 用 `new Promise((resolve) => server.listen(port, host, resolve))`，
// 端口被占用（EADDRINUSE）时只触发 `server.on('error')` 打日志，listening 回调永不执行
// → `await adapter.start()` 永久挂死（CLI `harness2 gateway` 假死）。
// 本文件先红后绿：断言 start() 在端口冲突时 reject 且不超时。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function makeAdapter(webhookPort: number): FeishuAdapter {
  return new FeishuAdapter({
    config: { enabled: true, appId: 'a', dmPolicy: 'open', groupPolicy: 'open', allow: [] },
    auth: { appId: 'a', appSecret: 's' },
    webhookPort,
  });
}

describe('FeishuAdapter.start 错误路径（A5 P1-1）', () => {
  it('webhook 端口被占用 → start() reject（EADDRINUSE），不永久挂起', async () => {
    const blocker = createServer();
    servers.push(blocker);
    const port = await listen(blocker);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const adapter = makeAdapter(port);
      const outcome = await Promise.race([
        adapter.start().then(
          () => 'resolved',
          (e: NodeJS.ErrnoException) => `rejected:${e.code ?? e.message}`,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
      ]);
      expect(outcome).not.toBe('timeout'); // 修复前：永久挂起 → 'timeout'
      expect(outcome).toContain('EADDRINUSE');
      await expect(adapter.stop()).resolves.toBeUndefined(); // 失败后 stop 仍安全（不留半启动状态）
    } finally {
      errSpy.mockRestore();
    }
  });

  it('端口释放后重试可正常启动（失败不留半启动状态）', async () => {
    const blocker = createServer();
    const port = await listen(blocker);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const adapter = makeAdapter(port);
      await expect(adapter.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await expect(adapter.start()).resolves.toBeUndefined();
      await adapter.stop();
    } finally {
      errSpy.mockRestore();
    }
  });
});
