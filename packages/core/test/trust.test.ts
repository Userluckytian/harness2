// 信任域加固测试（阶段 7 Task 4，M2 发布前加固项）：
// 合法三种 Origin 放行 / 恶意 Origin 403 / Host 校验（错误 Host 403）/ WS upgrade 同规则 /
// WS 超限帧断开（close code 1009）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import WebSocketWS from 'ws';
import { startServe, type ServeHandle } from '../src/server/http.js';
import { MockProvider } from '../src/provider/mock.js';
import type { WsServerMessage } from '../src/server/ws.js';

const handles: ServeHandle[] = [];
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<ServeHandle> {
  const handle = await startServe({
    port: 0,
    home: tmpDir('h2-trust-home-'),
    root: tmpDir('h2-trust-root-'),
    provider: new MockProvider([{ text: '回复。' }]),
  });
  handles.push(handle);
  return handle;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  const res = await fetch(url, { headers });
  await res.arrayBuffer(); // 排空 body 便于连接复用
  return { status: res.status };
}

/** 指定 Host 头的原生请求（fetch 不允许伪造 Host）。
 *  必须带 connection: close——默认 globalAgent（keep-alive）会把连接留在空闲池，
 *  server.close() 等待其关闭导致 afterEach 超时。 */
function getWithHost(url: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { headers: { host, connection: 'close' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    }).on('error', reject).end(); // end() 不可省：不发完请求服务器不会应答
  });
}

/** 原生 socket 发原始请求报文（重复 Origin 头——http.request/fetch 无法发出重复头） */
function rawRequest(port: number, raw: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(raw));
    let buf = '';
    socket.on('data', (d: Buffer) => (buf += d.toString('utf8')));
    socket.on('close', () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0 });
    });
    socket.on('error', reject);
  });
}

describe('HTTP 信任域（Origin/Host）', () => {
  it('合法三种来源放行：无 Origin（非浏览器）、file://、http://localhost:*、http://127.0.0.1:*', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    expect((await get(base)).status).toBe(200); // 非浏览器客户端无 Origin
    expect((await get(base, { Origin: 'file://' })).status).toBe(200);
    expect((await get(base, { Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await get(base, { Origin: 'http://127.0.0.1:5173' })).status).toBe(200);
    expect((await get(base, { Origin: 'http://localhost' })).status).toBe(200);
  });

  it('恶意 Origin 403：外部站点、相似域名、null origin、其他协议', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    for (const origin of [
      'https://evil.example',
      'http://evil.example',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'null',
      'ftp://localhost',
      'ws://localhost:5173',
    ]) {
      expect((await get(base, { Origin: origin })).status).toBe(403);
    }
  });

  it('Host 校验：必须为 127.0.0.1:<port>；错误 Host/域名 rebinding 403；无 Host 放行', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    expect((await getWithHost(base, `127.0.0.1:${handle.port}`)).status).toBe(200);
    for (const host of ['evil.example', `localhost:${handle.port}`, `127.0.0.1:${handle.port + 1}`, '127.0.0.1']) {
      expect((await getWithHost(base, host)).status).toBe(403);
    }
  });

  it('重复 Origin 头（原生请求）→ 403：数组/拼接形态不得绕过信任域（审查 P2-5）', async () => {
    const handle = await start();
    const res = await rawRequest(
      handle.port,
      'GET /api/sessions HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${handle.port}\r\n` +
        'Origin: https://evil.example\r\n' +
        'Origin: file://\r\n' +
        'Connection: close\r\n\r\n',
    );
    expect(res.status).toBe(403);
  });
});

describe('WS 信任域与帧上限', () => {
  function wsUrl(handle: ServeHandle): string {
    return `ws://127.0.0.1:${handle.port}/ws`;
  }

  it('合法来源（带 Origin 头）正常连接与订阅（回归）', async () => {
    const handle = await start();
    const sock = new WebSocketWS(wsUrl(handle), { headers: { origin: 'http://localhost:5173' } });
    // 合法格式但不存在于 hub 的会话 id（阶段 5 复审起 hub 对非法格式先抛「无效的会话 id」）
    const fakeId = '20260906-000000-abc123';
    const result = await new Promise<WsServerMessage>((resolve, reject) => {
      sock.on('open', () => sock.send(JSON.stringify({ op: 'subscribe', sessionId: fakeId })));
      sock.on('message', (data) => resolve(JSON.parse(String(data)) as WsServerMessage));
      sock.on('error', reject);
      sock.on('close', (code) => reject(new Error(`closed: ${code}`)));
    });
    expect(result).toMatchObject({ type: 'error', error: `session not found: ${fakeId}` }); // 协议路径正常到达
    sock.close();
  });

  it('恶意 Origin 的 upgrade 被 403 拒绝（与 HTTP 同规则）', async () => {
    const handle = await start();
    const outcome = await new Promise<'opened' | 'rejected'>((resolve) => {
      const sock = new WebSocketWS(wsUrl(handle), { headers: { origin: 'https://evil.example' } });
      sock.on('open', () => resolve('opened'));
      sock.on('error', () => resolve('rejected'));
      sock.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode === 403 ? 'rejected' : 'opened');
      });
    });
    expect(outcome).toBe('rejected');
  });

  it('错误 Host 的 upgrade 被拒绝（DNS rebinding 防护）', async () => {
    const handle = await start();
    const outcome = await new Promise<'opened' | 'rejected'>((resolve) => {
      const sock = new WebSocketWS(wsUrl(handle), { headers: { host: 'evil.example' } });
      sock.on('open', () => resolve('opened'));
      sock.on('error', () => resolve('rejected'));
      sock.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode === 403 ? 'rejected' : 'opened');
      });
    });
    expect(outcome).toBe('rejected');
  });

  it('WS 帧超 1MiB 断开（close code 1009，对齐 HTTP 上限）', async () => {
    const handle = await start();
    const sock = new WebSocketWS(wsUrl(handle));
    const closeCode = await new Promise<number>((resolve) => {
      sock.on('open', () => {
        sock.send('x'.repeat(1.5 * 1024 * 1024)); // 1.5MiB > maxPayload
      });
      sock.on('close', (code) => resolve(code));
      sock.on('error', () => {}); // 断开时的 socket 错误不影响断言
    });
    expect(closeCode).toBe(1009);
  }, 10_000);
});
