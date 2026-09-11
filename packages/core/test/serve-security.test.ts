// A3 serve 安全加固测试（阶段 15 + 地基补丁 P2）：
//   A3-1 本地信任域：Origin/Host 白名单 + 启动时一次性 token——
//        合法 token 放行（header 两种形态）、错误 token 一律 401（兼容模式下也不回退）、
//        严格模式无 token 401、显式关闭严格模式时放行并计数、token 不入日志/错误体；
//   P2（地基补丁）：**默认即严格**——不传 requireToken（不设任何 env）时无 token 401、
//        带 token 200；显式 requireToken:false（或 HARNESS2_SERVE_REQUIRE_TOKEN=0）才回退兼容。
//        （本文件非鉴权用例显式传 requireToken:false，并把默认严格单列断言。）
//   A3-2 WS 帧大小上限：超 1MiB 断连（close 1009）并记账（security.wsOversizeClosed + onFrameOversize）；
//   A3-3 playwright 可选：无 playwright 时 import @harness2/core 不报错、browser_* 返回安装指引。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import WebSocketWS from 'ws';
import { startServe, type ServeHandle } from '../src/server/http.js';
import { SERVE_REQUIRE_TOKEN_ENV, serveRequireTokenFromEnv } from '../src/server/security.js';
import { MockProvider } from '../src/provider/mock.js';
import type { WsServerMessage } from '../src/server/ws.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TEST_TOKEN = 'a3-serve-token-0123456789abcdef';

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

async function start(
  opts: {
    requireToken?: boolean;
    onFrameOversize?: (info: { remote: string; limitBytes: number }) => void;
  } = {},
): Promise<ServeHandle> {
  const handle = await startServe({
    port: 0,
    home: tmpDir('h2-a3-home-'),
    root: tmpDir('h2-a3-root-'),
    provider: new MockProvider([{ text: '回复。' }]),
    token: TEST_TOKEN,
    // 本文件非鉴权用例默认显式关闭严格模式（默认严格另由「默认严格鉴权」块单独断言）
    requireToken: opts.requireToken ?? false,
    ...(opts.onFrameOversize !== undefined ? { wsOptions: { onFrameOversize: opts.onFrameOversize } } : {}),
  });
  handles.push(handle);
  return handle;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers });
  const body = await res.text();
  return { status: res.status, body };
}

/** 指定 Host 头的原生请求（fetch 不允许伪造 Host；带 token 以隔离 Host 白名单断言） */
function getWithHost(url: string, host: string, token: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { headers: { host, connection: 'close', 'x-harness2-token': token } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    })
      .on('error', reject)
      .end();
  });
}

/** 尝试 WS 握手：返回 opened（可连）/ rejected（被拒） */
function wsHandshake(url: string, headers?: Record<string, string>): Promise<'opened' | 'rejected'> {
  return new Promise((resolve) => {
    const sock = new WebSocketWS(url, headers !== undefined ? { headers } : undefined);
    sock.on('open', () => {
      sock.close();
      resolve('opened');
    });
    sock.on('error', () => resolve('rejected'));
    sock.on('unexpected-response', (_req, res) => resolve(res.statusCode === 101 ? 'opened' : 'rejected'));
  });
}

describe('A3-1 一次性 token（HTTP）', () => {
  it('显式关闭严格模式（requireToken:false）：无 token 仍放行并计数', async () => {
    const handle = await start();
    const r = await get(`http://127.0.0.1:${handle.port}/api/sessions`);
    expect(r.status).toBe(200);
    expect(handle.security.noTokenAllowed).toBeGreaterThan(0);
    expect(handle.security.noTokenRejected).toBe(0);
    expect(handle.security.invalidTokenRejected).toBe(0);
  });

  it('合法 token 放行：x-harness2-token 与 Authorization: Bearer 两种形态', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    expect((await get(base, { 'x-harness2-token': handle.token })).status).toBe(200);
    expect((await get(base, { authorization: `Bearer ${handle.token}` })).status).toBe(200);
    expect(handle.security.noTokenAllowed).toBe(0); // 带 token 不走回退
  });

  it('错误 token 一律 401（兼容模式下也不回退，杜绝降级绕过）', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    const r = await get(base, { 'x-harness2-token': 'wrong-token-000000' });
    expect(r.status).toBe(401);
    expect(handle.security.invalidTokenRejected).toBe(1);
    expect(handle.security.noTokenAllowed).toBe(0);
    expect(r.body).not.toContain(handle.token); // 错误体不回显 token
  });

  it('严格模式：无 token 401、合法 token 200、回退计数恒为 0', async () => {
    const handle = await start({ requireToken: true });
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    expect((await get(base)).status).toBe(401);
    expect(handle.security.noTokenRejected).toBe(1);
    expect((await get(base, { 'x-harness2-token': handle.token })).status).toBe(200);
    expect(handle.security.noTokenAllowed).toBe(0);
  });

  it('token 不入日志：错误 token / 无 token 请求的 stderr 均不含 token 明文', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handle = await start({ requireToken: true });
      const base = `http://127.0.0.1:${handle.port}/api/sessions`;
      const bad = await get(base, { 'x-harness2-token': 'nope' });
      await get(base); // 严格模式无 token
      expect(bad.body).not.toContain(handle.token);
      const logged = spy.mock.calls
        .flat()
        .map((a) => String(a))
        .join('\n');
      expect(logged).not.toContain(handle.token);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('A3-1 Origin/Host 白名单（A3 回归）', () => {
  it('合法来源放行（file:// / http://localhost:* / http://127.0.0.1:*）', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    for (const origin of ['file://', 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect((await get(base, { origin, 'x-harness2-token': handle.token })).status).toBe(200);
    }
  });

  it('跨站/相似域名 Origin 403 并计数', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.com']) {
      expect((await get(base, { origin, 'x-harness2-token': handle.token })).status).toBe(403);
    }
    expect(handle.security.trustRejected).toBe(3);
  });

  it('错误 Host（DNS rebinding）403；正确 Host 放行', async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    expect((await getWithHost(base, `127.0.0.1:${handle.port}`, handle.token)).status).toBe(200);
    expect((await getWithHost(base, 'evil.example', handle.token)).status).toBe(403);
    expect(handle.security.trustRejected).toBe(1);
  });
});

describe('A3-1 一次性 token（WS 升级握手）', () => {
  function wsUrl(handle: ServeHandle): string {
    return `ws://127.0.0.1:${handle.port}/ws`;
  }

  it('严格模式：无 token 升级被拒（401），带 token 可连', async () => {
    const handle = await start({ requireToken: true });
    expect(await wsHandshake(wsUrl(handle))).toBe('rejected');
    expect(handle.security.noTokenRejected).toBe(1);
    expect(await wsHandshake(`${wsUrl(handle)}?token=${handle.token}`)).toBe('opened');
    expect(await wsHandshake(wsUrl(handle), { 'x-harness2-token': handle.token })).toBe('opened');
  });

  it('错误 token 升级被拒并计数', async () => {
    const handle = await start();
    expect(await wsHandshake(`${wsUrl(handle)}?token=wrong`)).toBe('rejected');
    expect(handle.security.invalidTokenRejected).toBe(1);
  });

  it('兼容回退（显式关闭严格模式）：无 token 升级放行', async () => {
    const handle = await start();
    expect(await wsHandshake(wsUrl(handle))).toBe('opened');
    expect(handle.security.noTokenAllowed).toBe(1);
  });
});

describe('P2 默认严格鉴权（不传 requireToken、不设任何 env）', () => {
  /** 直连 startServe，不传 requireToken 选项（走默认值） */
  async function startDefaultStrict(): Promise<ServeHandle> {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-a3-strict-home-'),
      root: tmpDir('h2-a3-strict-root-'),
      provider: new MockProvider([{ text: '回复。' }]),
      token: TEST_TOKEN,
    });
    handles.push(handle);
    return handle;
  }

  it('默认严格：无 token HTTP 401、带 token 200、回退计数恒为 0', async () => {
    const handle = await startDefaultStrict();
    const base = `http://127.0.0.1:${handle.port}/api/sessions`;
    expect((await get(base)).status).toBe(401);
    expect(handle.security.noTokenRejected).toBe(1);
    expect(handle.security.noTokenAllowed).toBe(0);
    expect((await get(base, { 'x-harness2-token': handle.token })).status).toBe(200);
    expect(handle.security.noTokenAllowed).toBe(0);
  });

  it('默认严格：无 token 的第三方进程连不上 WS；带 token 可连', async () => {
    const handle = await startDefaultStrict();
    expect(await wsHandshake(`ws://127.0.0.1:${handle.port}/ws`)).toBe('rejected');
    expect(handle.security.noTokenRejected).toBe(1);
    expect(await wsHandshake(`ws://127.0.0.1:${handle.port}/ws?token=${handle.token}`)).toBe('opened');
  });

  it('serveRequireTokenFromEnv：未设/空值默认 true；显式 0/false/no 才关闭', () => {
    expect(serveRequireTokenFromEnv({})).toBe(true);
    expect(serveRequireTokenFromEnv({ [SERVE_REQUIRE_TOKEN_ENV]: '' })).toBe(true);
    expect(serveRequireTokenFromEnv({ [SERVE_REQUIRE_TOKEN_ENV]: '1' })).toBe(true);
    expect(serveRequireTokenFromEnv({ [SERVE_REQUIRE_TOKEN_ENV]: '0' })).toBe(false);
    expect(serveRequireTokenFromEnv({ [SERVE_REQUIRE_TOKEN_ENV]: 'false' })).toBe(false);
    expect(serveRequireTokenFromEnv({ [SERVE_REQUIRE_TOKEN_ENV]: 'NO' })).toBe(false);
  });
});

describe('A3-2 WS 帧大小上限与记账', () => {
  function wsUrl(handle: ServeHandle): string {
    return `ws://127.0.0.1:${handle.port}/ws`;
  }

  it('超 1MiB 帧 → 断连（close 1009）+ 计数 + onFrameOversize 回调', async () => {
    const oversize: Array<{ remote: string; limitBytes: number }> = [];
    const handle = await start({ onFrameOversize: (info) => oversize.push(info) });
    const sock = new WebSocketWS(wsUrl(handle));
    const closeCode = await new Promise<number>((resolve) => {
      sock.on('open', () => sock.send('x'.repeat(1.5 * 1024 * 1024))); // 1.5MiB > maxPayload
      sock.on('close', (code) => resolve(code));
      sock.on('error', () => {}); // 断开时的 socket 错误不影响断言
    });
    expect(closeCode).toBe(1009);
    expect(handle.security.wsOversizeClosed).toBe(1);
    expect(oversize).toHaveLength(1);
    expect(oversize[0]!.limitBytes).toBe(1024 * 1024);
    expect(oversize[0]!.remote.length).toBeGreaterThan(0);
  }, 10_000);

  it('正常大小帧不断连、不误记账（协议错误仍走既有 error 帧）', async () => {
    const handle = await start();
    const sock = new WebSocketWS(wsUrl(handle));
    const frame = await new Promise<WsServerMessage>((resolve, reject) => {
      sock.on('open', () => sock.send(JSON.stringify({ op: 'subscribe', sessionId: 'not-a-session' })));
      sock.on('message', (data) => resolve(JSON.parse(String(data)) as WsServerMessage));
      sock.on('error', reject);
      sock.on('close', (code) => reject(new Error(`unexpected close ${code}`)));
    });
    expect(frame.type).toBe('error');
    expect(handle.security.wsOversizeClosed).toBe(0);
    sock.close();
  });
});

describe('A3-3 playwright 可选依赖与降级', () => {
  it('无 playwright 时 import @harness2/core 不报错，browser_* 返回安装指引', async () => {
    vi.doMock('playwright', () => {
      throw new Error("Cannot find package 'playwright'");
    });
    vi.resetModules();
    try {
      const core = await import('../src/index.js'); // 静态导入若依赖 playwright 会在这一步抛错
      expect(typeof core.startServe).toBe('function');
      expect(typeof core.createBrowserTools).toBe('function');
      const pool = new core.BrowserPool({ loader: () => import('playwright') });
      const [navigate] = core.createBrowserTools('s-a3-3', pool);
      const out = await navigate!.execute(
        { url: 'https://example.com/' },
        { signal: new AbortController().signal, cwd: process.cwd() },
      );
      const text = out.error ?? out.output ?? '';
      expect(text).toContain('harness2 browser install');
      expect(text).toContain('playwright');
    } finally {
      vi.doUnmock('playwright');
      vi.resetModules();
    }
  });

  it('browser.ts 无运行时静态 playwright 依赖（仅 import type + 动态 import）', () => {
    const src = readFileSync(resolve(TEST_DIR, '../src/tools/predefined/browser.ts'), 'utf8');
    const runtimeImports = src
      .split('\n')
      .filter(
        (line) => /^\s*import\b/.test(line) && /['"]playwright['"]/.test(line) && !/^\s*import\s+type\b/.test(line),
      );
    expect(runtimeImports).toEqual([]);
  });
});
