// 漏洞 #309 回归：飞书 fail-closed + 入站 content 过滤；QQ 入站过滤。
// 契约：
// 1. 未配置 verificationToken 时 FeishuAdapter.start() 拒绝启动（fail-closed）；
// 2. 飞书/QQ 入站 text 剥离控制字符（保留制表符与换行），超长截断到 MAX_INBOUND_TEXT_LENGTH。
import { describe, expect, it } from 'vitest';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';
import { QqAdapter } from '../src/platforms/qq/adapter.js';
import { MAX_INBOUND_TEXT_LENGTH, sanitizeInboundText } from '../src/platforms/sanitize.js';
import type { InboundMessage } from '../src/types.js';

describe('FeishuAdapter.start fail-closed（#309）', () => {
  it('未配置 verificationToken 时 start() reject，不监听端口', async () => {
    const adapter = new FeishuAdapter({
      config: { enabled: true, appId: 'a', dmPolicy: 'open', groupPolicy: 'open', allow: [] },
      auth: { appId: 'a', appSecret: 's' },
      webhookPort: 0,
    });
    await expect(adapter.start()).rejects.toThrow(/verificationToken|拒绝启动/);
  });
});

describe('入站 content 过滤（#309）', () => {
  it('sanitizeInboundText 剥离控制字符、保留制表/换行、截断超长', () => {
    // 控制字符用 fromCharCode 构造，避免源码里出现转义序列
    const dirty = [
      'a',
      String.fromCharCode(0),
      'b',
      String.fromCharCode(0x1f),
      'c',
      String.fromCharCode(13),
      'd',
      String.fromCharCode(9),
      'e',
      String.fromCharCode(10),
      'f',
      String.fromCharCode(0x7f),
      'g',
      String.fromCharCode(0x200b),
      'h',
    ].join('');
    const clean = sanitizeInboundText(dirty);
    // 契约：C0/C1/零宽剥离，\t(\x09) 与 \n(\x0a) 不在剥离区间——保留制表/换行
    // （输入序列 …d \t e \n f… → 'abcd\te\nfgh'）
    expect(clean).toBe('abcd\te\nfgh');
    const long = 'a'.repeat(MAX_INBOUND_TEXT_LENGTH + 10);
    expect(sanitizeInboundText(long)).toBe('a'.repeat(MAX_INBOUND_TEXT_LENGTH));
    const emoji = '😀'.repeat(MAX_INBOUND_TEXT_LENGTH + 5);
    expect(Array.from(sanitizeInboundText(emoji)).length).toBe(MAX_INBOUND_TEXT_LENGTH);
  });

  it('飞书 handleEventBody 过滤控制字符/超长文本（不经 start）', () => {
    const received: InboundMessage[] = [];
    const adapter = new FeishuAdapter({
      config: { enabled: true, appId: 'a', dmPolicy: 'open', groupPolicy: 'open', allow: [] },
      auth: { appId: 'a', appSecret: 's' },
    });
    adapter.onMessage((m) => received.push(m));
    const event = (id: string, text: string): string =>
      JSON.stringify({
        type: 'event_callback',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            chat_id: 'c1',
            message_id: id,
            message_type: 'text',
            content: JSON.stringify({ text }),
          },
        },
      });
    const dirty = 'hi' + String.fromCharCode(0) + 'there' + String.fromCharCode(13) + String.fromCharCode(0x1f);
    adapter.handleEventBody(event('m1', dirty));
    adapter.handleEventBody(event('m2', 'x'.repeat(MAX_INBOUND_TEXT_LENGTH + 100)));
    expect(received).toHaveLength(2);
    expect(received[0]!.text).toBe('hithere');
    expect(received[1]!.text).toBe('x'.repeat(MAX_INBOUND_TEXT_LENGTH));
  });

  it('QQ handleDispatch 过滤控制字符', () => {
    const received: InboundMessage[] = [];
    const adapter = new QqAdapter({
      config: { enabled: true, appId: 'a', dmPolicy: 'open', groupPolicy: 'open', allow: [] },
      auth: { appId: 'a', appSecret: 's' },
      tokenUrl: 'http://127.0.0.1:1/token',
      apiBase: 'http://127.0.0.1:1',
    });
    adapter.onMessage((m) => received.push(m));
    (adapter as unknown as { handleDispatch: (e: string, p: Record<string, unknown>) => void }).handleDispatch(
      'C2C_MESSAGE_CREATE',
      { id: 'm1', content: 'he' + String.fromCharCode(0) + 'llo' + String.fromCharCode(0x1f), user_openid: 'u1' },
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('hello');
  });
});
