// 桌面壳骨架测试（Task 3）：
//   纯函数：端口行解析 / 退避序列 / 重启决策 / 锁文件读取 / pid 存活
//   ServeManager：真实子进程 start（spawn -e 假 serve：打印端口 JSON + 起 HTTP 健康端点）、
//   stop 优雅退出、意外退出自动重启（退避可调小）、按锁文件采纳既有实例。
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ServeManager,
  backoffDelayMs,
  extractServePort,
  isPidAlive,
  parseServePortLine,
  readServeLock,
  shouldRestartChild,
  waitForHealth,
} from '../src/main/serve-manager.js';
import type { StatusDetail } from '../src/shared/protocol.js';
import { AppStore } from '../src/renderer/store.js';

const dirs: string[] = [];
const children: Array<{ kill: () => void }> = [];
const servers: Server[] = [];
function tmpDir(prefix = 'h2-desktop-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 假 serve 子进程脚本：HTTP 健康端点 + stdout 端口 JSON 行 + 保活；exitAfterMs 存在则定时退出 */
const FAKE_SERVE_SCRIPT = `
const http = require('node:http');
const exitAfterMs = Number(process.env['FAKE_EXIT_MS'] || 0);
const app = http.createServer((req, res) => { res.end(JSON.stringify({ ok: true })); });
app.listen(0, '127.0.0.1', () => {
  const port = app.address().port;
  console.log(JSON.stringify({ port, pid: process.pid }));
});
setInterval(() => {}, 1000);
if (exitAfterMs > 0) setTimeout(() => process.exit(0), exitAfterMs);
`;

type SpawnImpl = NonNullable<ConstructorParameters<typeof ServeManager>[0]['spawnImpl']>;

function fakeSpawn(): SpawnImpl {
  return ((file: string, _args: string[], opts: Record<string, unknown>) => {
    const child = spawn(file, ['-e', FAKE_SERVE_SCRIPT], opts as never);
    children.push(child);
    return child;
  }) as unknown as SpawnImpl;
}

function makeManager(opts: Partial<ConstructorParameters<typeof ServeManager>[0]> = {}): ServeManager {
  return new ServeManager({
    cliEntry: '',
    spawnImpl: fakeSpawn(),
    restartBaseDelayMs: 60,
    ...opts,
  });
}

describe('纯函数', () => {
  it('parseServePortLine：合法 JSON 行 / 非法输入 / 越界端口', () => {
    expect(parseServePortLine('{"port":54321,"pid":123}')).toEqual({ port: 54321, pid: 123 });
    expect(parseServePortLine('  {"port":54321,"pid":123,"ts":"x"}  ')).toEqual({ port: 54321, pid: 123, ts: 'x' });
    expect(parseServePortLine('hello')).toBeNull();
    expect(parseServePortLine('{"port":"x"}')).toBeNull();
    expect(parseServePortLine('{"port":70000,"pid":1}')).toBeNull();
    expect(parseServePortLine('{"port":0,"pid":1}')).toBeNull();
    expect(parseServePortLine('{"pid":1}')).toBeNull();
    expect(parseServePortLine('{bad json')).toBeNull();
  });

  it('extractServePort：多行/噪声中提取第一处有效端口行', () => {
    expect(extractServePort('some warning\n{"port":4001,"pid":9}\n{"port":4002,"pid":10}')).toEqual({
      port: 4001,
      pid: 9,
    });
    expect(extractServePort('')).toBeNull();
    expect(extractServePort('noise only')).toBeNull();
  });

  it('backoffDelayMs：1s→2s→4s→8s→15s 封顶；支持测试基准', () => {
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffDelayMs(a))).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    expect(backoffDelayMs(2, 50, 400)).toBe(200);
    expect(backoffDelayMs(9, 50, 400)).toBe(400);
    expect(backoffDelayMs(-3, 50, 400)).toBe(50);
  });

  it('shouldRestartChild：主动停止不重启，其余重启', () => {
    expect(shouldRestartChild(true)).toBe(false);
    expect(shouldRestartChild(false)).toBe(true);
  });

  it('readServeLock：合法/损坏/缺失；isPidAlive：存活与必死 pid', () => {
    const home = tmpDir();
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'serve.lock'), JSON.stringify({ pid: process.pid, port: 1234 }));
    expect(readServeLock(home)).toMatchObject({ pid: process.pid, port: 1234 });
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 40)).toBe(false);

    writeFileSync(join(home, '.harness2', 'serve.lock'), '{broken');
    expect(readServeLock(home)).toBeNull();
    expect(readServeLock(join(home, 'nope'))).toBeNull();
  });

  it('waitForHealth：健康端点通过；死端口超时抛错', async () => {
    const server = createServer((_req, res) => {
      res.end('{"ok":false}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await expect(waitForHealth(port, 2000)).resolves.toBeUndefined();

    await expect(waitForHealth(1, 250, fetch, 50)).rejects.toThrow('健康检查超时');
  });
});

describe('ServeManager（真实子进程）', () => {
  it('start：解析端口 + 健康检查通过 → connected；stop 优雅退出且不重启', async () => {
    const statuses: Array<{ status: string; detail?: StatusDetail }> = [];
    const mgr = makeManager({
      onStatus: (status, detail) => statuses.push({ status, detail }),
    });
    const { port, adopted } = await mgr.start();
    expect(adopted).toBe(false);
    expect(port).toBeGreaterThan(0);
    expect(mgr.baseUrl).toContain(`:${port}`);
    expect(mgr.wsUrl).toBe(`ws://127.0.0.1:${port}/ws`);
    expect(mgr.status).toBe('connected');
    expect(statuses.map((s) => s.status)).toEqual(['connecting', 'connected']);

    await mgr.stop();
    expect(mgr.status).toBe('offline');
    const connectedCount = statuses.filter((s) => s.status === 'connected').length;
    await new Promise((r) => setTimeout(r, 200));
    expect(statuses.filter((s) => s.status === 'connected').length).toBe(connectedCount); // 无重启
  });

  it('意外退出 → reconnecting → 自动重启回 connected；达上限后 offline', async () => {
    process.env['FAKE_EXIT_MS'] = '400'; // 子进程健康后 400ms 自杀，触发重启链
    try {
    const statuses: string[] = [];
    const mgr = makeManager({
      restartAttempts: 1,
      restartBaseDelayMs: 40,
      onStatus: (status) => statuses.push(status),
    });
    await mgr.start();
    statuses.length = 0; // 只看重启段

    // 等第一次意外退出（脚本 400ms 后 exit）→ reconnecting → 自动重启 → 第二次 connected
    for (let i = 0; i < 200 && mgr.status !== 'reconnecting'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(statuses).toContain('reconnecting');
    for (let i = 0; i < 200 && mgr.status !== 'connected'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(mgr.status).toBe('connected');

    // 第二次退出后达到上限（restartAttempts=1）→ offline
    for (let i = 0; i < 300 && mgr.status !== 'offline'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(mgr.status).toBe('offline');
    await mgr.stop();
    } finally {
      delete process.env['FAKE_EXIT_MS'];
    }
  }, 20000);

  it('adoptExisting：锁文件指向存活健康实例时直接采纳（不 spawn）', async () => {
    const server = createServer((_req, res) => {
      res.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const home = tmpDir();
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'serve.lock'), JSON.stringify({ pid: process.pid, port }));

    let spawned = 0;
    const mgr = makeManager({
      home,
      spawnImpl: ((file: string, args: string[], opts: Record<string, unknown>) => {
        spawned += 1;
        return spawn(file, args, opts as never);
      }) as never,
    });
    const result = await mgr.start();
    expect(result).toEqual({ port, adopted: true });
    expect(spawned).toBe(0);
    await mgr.stop();
  });
});

describe('AppStore（渲染端纯状态）', () => {
  it('status 变化 / sessions 排序与去重 / select / addSession 头插', () => {
    const store = new AppStore();
    expect(store.getState().status).toBe('connecting');
    const seen: string[] = [];
    let lastStatus = store.getState().status;
    store.subscribe(() => {
      const s = store.getState().status;
      if (s !== lastStatus) {
        lastStatus = s;
        seen.push(s);
      }
    });

    store.applyStatus('connected', { port: 1234 });
    expect(store.getState().status).toBe('connected');
    expect(store.getState().statusDetail?.port).toBe(1234);

    store.setSessions([
      { id: 'a', mtimeMs: 100, firstUserText: '甲', messageCount: 1, lastSeq: 2, dir: 'd' },
      { id: 'b', mtimeMs: 300, firstUserText: '乙', messageCount: 2, lastSeq: 3, dir: 'd' },
    ]);
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['b', 'a']); // mtime 倒序

    store.addSession({ id: 'c', mtimeMs: 0, firstUserText: '', messageCount: 0, lastSeq: 0 });
    expect(store.getState().sessions.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    store.addSession({ id: 'c', mtimeMs: 0, firstUserText: '', messageCount: 0, lastSeq: 0 }); // 幂等
    expect(store.getState().sessions.filter((s) => s.id === 'c')).toHaveLength(1);

    store.select('b');
    expect(store.getState().selectedId).toBe('b');
    expect(seen).toEqual(['connected']);
  });
});
