// P1-b（A5 P1-3）回归补齐：飞书策略三态 + verificationToken 强制校验。
// 契约：dmPolicy 在入站闸门执行（缺省 allowlist 防滥用）；配置 verificationToken 时
// 无/错 token 的 webhook 请求一律 401（不触发事件解析）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';
import type { InboundMessage } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

/** 取一个当前空闲端口（先 listen 0 再释放）：用于把 webhook 端点钉到已知端口 */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function eventBody(id: string, text: string, chatId: string): string {
  return JSON.stringify({
    type: 'event_callback',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: { chat_id: chatId, message_id: id, message_type: 'text', content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: 'ou_u1' } },
    },
  });
}

describe('P1-b ④ 飞书策略与 verificationToken', () => {
  it('dmPolicy=allowlist：白名单外静默忽略、白名单内投递', () => {
    const inbound: InboundMessage[] = [];
    const adapter = new FeishuAdapter({
      config: { enabled: true, appId: 'a', dmPolicy: 'allowlist', groupPolicy: 'open', allow: ['oc_ok'] },
      auth: { appId: 'a', appSecret: 's' },
    });
    adapter.onMessage((m) => inbound.push(m));

    adapter.handleEventBody(eventBody('m1', '越权', 'oc_evil'));
    expect(inbound).toHaveLength(0);
    adapter.handleEventBody(eventBody('m2', '合法', 'oc_ok'));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.chatId).toBe('oc_ok');
  });

  it('dmPolicy=disabled：一律不投递（即使 chat 在 allow 名单）', () => {
    const inbound: InboundMessage[] = [];
    const adapter = new FeishuAdapter({
      config: { enabled: true, appId: 'a', dmPolicy: 'disabled', groupPolicy: 'open', allow: ['oc_ok'] },
      auth: { appId: 'a', appSecret: 's' },
    });
    adapter.onMessage((m) => inbound.push(m));
    adapter.handleEventBody(eventBody('m1', 'hi', 'oc_ok'));
    expect(inbound).toHaveLength(0);
  });

  it('verificationToken：无/错 token 401 且不解析事件；正确 token 应答 url_verification 挑战', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const port = await freePort();
      const inbound: InboundMessage[] = [];
      const adapter = new FeishuAdapter({
        config: { enabled: true, appId: 'a', dmPolicy: 'open', groupPolicy: 'open', allow: [] },
        auth: { appId: 'a', appSecret: 's' },
        webhookPort: port,
        verificationToken: 'vtok-123',
      });
      adapter.onMessage((m) => inbound.push(m));
      await adapter.start();
      cleanups.push(() => adapter.stop());

      const url = `http://127.0.0.1:${port}/events`;
      const challengeBody = JSON.stringify({ type: 'url_verification', challenge: 'c-1' });

      const noToken = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: challengeBody,
      });
      expect(noToken.status).toBe(401);

      const badToken = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lark-token': 'wrong' },
        body: challengeBody,
      });
      expect(badToken.status).toBe(401);

      // 无 token 的消息事件也不得进入会话（闸门在解析之前）
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: eventBody('m1', '你好', 'oc_chat1'),
      });
      expect(inbound).toHaveLength(0);

      const ok = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lark-token': 'vtok-123' },
        body: challengeBody,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ challenge: 'c-1' });
    } finally {
      errSpy.mockRestore();
    }
  }, 15000);
});
