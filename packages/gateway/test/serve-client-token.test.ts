// P2 回归：ServeClient 携带一次性 token 打通严格鉴权的 serve（网关端）。
// 缺陷：serve 默认切严格后，网关 ServeClient 不带 token 会被 401（三端互斥的另一半）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import { ServeClient, type ServeFrame } from '../src/serve-client.js';

const handles: ServeHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const clients: ServeClient[] = [];

/** 默认严格（不传 requireToken）的真实 serve */
async function startStrictServe(): Promise<{ handle: ServeHandle; root: string }> {
  const home = mkdtempSync(join(tmpdir(), 'h2-gw-token-home-'));
  const root = mkdtempSync(join(tmpdir(), 'h2-gw-token-root-'));
  dirs.push(home, root);
  const handle = await startServe({ port: 0, home, root, provider: new MockProvider([{ text: '网关回复' }]) });
  handles.push(handle);
  return { handle, root };
}

function makeClient(handle: ServeHandle, frames: ServeFrame[], token?: string): ServeClient {
  const client = new ServeClient({
    baseUrl: `http://127.0.0.1:${handle.port}`,
    wsUrl: `ws://127.0.0.1:${handle.port}/ws`,
    onFrame: (f) => frames.push(f),
    ...(token !== undefined ? { token } : {}),
  });
  clients.push(client);
  return client;
}

function waitFor<T extends ServeFrame>(
  frames: ServeFrame[],
  predicate: (f: ServeFrame) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const found = frames.find(predicate);
  if (found !== undefined) return Promise.resolve(found as T);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待帧超时（${timeoutMs}ms）`)), timeoutMs);
    const poll = setInterval(() => {
      const f = frames.find(predicate);
      if (f !== undefined) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(f as T);
      }
    }, 50);
  });
}

describe('P2 网关 ServeClient 携带 token（严格 serve）', () => {
  it('带 token：HTTP 建会话 + WS 订阅 + 发消息全链可用', async () => {
    const { handle, root } = await startStrictServe();
    const frames: ServeFrame[] = [];
    const client = makeClient(handle, frames, handle.token);

    const session = await client.createSession(root);
    await client.waitReady();
    client.subscribe(session.id);
    client.sendMessage(session.id, '你好');
    const end = await waitFor(frames, (f) => f.type === 'turn-end' && f.sessionId === session.id);
    expect(end.type === 'turn-end' && end.stopReason).toBe('end_turn');
  });

  it('不带 token：HTTP 被 401 拒绝，WS 升级被拒（第三方进程连不上）', async () => {
    const { handle, root } = await startStrictServe();
    const frames: ServeFrame[] = [];
    const client = makeClient(handle, frames); // 无 token
    await expect(client.createSession(root)).rejects.toThrow('缺少 serve token');
    await expect(client.waitReady()).rejects.toThrow();
    expect(handle.security.noTokenRejected).toBeGreaterThanOrEqual(1);
  });
});
