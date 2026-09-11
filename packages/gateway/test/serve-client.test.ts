// ServeClient 集成测试：对真实 serve（core startServe + MockProvider）全链验证。
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

async function start(): Promise<{ handle: ServeHandle; home: string; root: string }> {
  const home = mkdtempSync(join(tmpdir(), 'h2-gw-svc-home-'));
  const root = mkdtempSync(join(tmpdir(), 'h2-gw-svc-root-'));
  dirs.push(home, root);
  const handle = await startServe({ port: 0, home, root, provider: new MockProvider([{ text: '网关回复' }]) });
  handles.push(handle);
  return { handle, home, root };
}

function makeClient(handle: ServeHandle, frames: ServeFrame[]): ServeClient {
  const client = new ServeClient({
    baseUrl: `http://127.0.0.1:${handle.port}`,
    wsUrl: `ws://127.0.0.1:${handle.port}/ws`,
    // P2：真实 serve 默认严格鉴权——客户端必须携带一次性 token
    token: handle.token,
    onFrame: (f) => frames.push(f),
  });
  clients.push(client);
  return client;
}

describe('ServeClient（对真实 serve）', () => {
  it('createSession → waitReady → subscribe → sendMessage → 收到事件帧与 turn-end', async () => {
    const { handle, root } = await start();
    const frames: ServeFrame[] = [];
    const client = makeClient(handle, frames);

    const session = await client.createSession(root);
    expect(session.id).toBeTruthy();

    await client.waitReady();
    client.subscribe(session.id);
    client.sendMessage(session.id, '你好');

    const turnEnd = (await waitFor(frames, (f) => f.type === 'turn-end' && f.sessionId === session.id)) as {
      type: 'turn-end';
      sessionId: string;
      stopReason: string;
    };
    expect(turnEnd.stopReason).toBe('end_turn');
    const kinds = frames
      .filter((f) => f.type === 'event' && f.sessionId === session.id)
      .map((f) => (f as { event: { type: string } }).event.type);
    expect(kinds).toContain('user/message');
    expect(kinds).toContain('assistant/message');
  });

  it('未就绪时 waitReady 排队；断线后 close 不再重连', async () => {
    const { handle, root } = await start();
    const frames: ServeFrame[] = [];
    const client = makeClient(handle, frames);
    const session = await client.createSession(root);

    await client.waitReady(); // 就绪
    client.subscribe(session.id);
    client.sendMessage(session.id, 'hi');
    await waitFor(frames, (f) => f.type === 'turn-end');

    client.close(); // 断开后 close：重连定时器清空，不再产生新帧
    const count = frames.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(frames.length).toBe(count);
    void root;
  });
});

function waitFor<T extends ServeFrame>(
  frames: ServeFrame[],
  predicate: (f: ServeFrame) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const found = frames.find(predicate);
  if (found !== undefined) return Promise.resolve(found as T);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待帧超时（${timeoutMs}ms）`)), timeoutMs);
    const timer2 = setInterval(() => {
      const f = frames.find(predicate);
      if (f !== undefined) {
        clearTimeout(timer);
        clearInterval(timer2);
        resolve(f as T);
      }
    }, 50);
  });
}

void join;
