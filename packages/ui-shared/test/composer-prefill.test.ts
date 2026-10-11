// composer 预填通道（Z4-02/Z4-03）：请求分配 nonce、监听器收载荷、consume 首个当事；
// 追加语义（prefillAppendText）。node 环境即可（纯逻辑，零 DOM）。
import { describe, expect, it, vi } from 'vitest';
import {
  composerPrefill,
  createComposerPrefillChannel,
  prefillAppendText,
  type ComposerPrefillRequest,
} from '../src/renderer/conversation/composer/prefill.js';

describe('composerPrefill 通道', () => {
  it('request 同步通知订阅者（载荷含单调 nonce），退订后不再收到', () => {
    const channel = createComposerPrefillChannel();
    const received: ComposerPrefillRequest[] = [];
    const unsubscribe = channel.subscribe((req) => received.push(req));

    const first = channel.request({ sessionId: 's1', quote: '`p:1`\n> x', focus: false });
    expect(first.nonce).toBe(1);
    const second = channel.request({ sessionId: 's1', quote: '`p:2`\n> y', focus: true });
    expect(second.nonce).toBe(2);
    expect(received.map((r) => r.nonce)).toEqual([1, 2]);
    expect(received[0]?.quote).toBe('`p:1`\n> x');

    unsubscribe();
    channel.request({ sessionId: 's1', quote: '`p:3`\n> z', focus: false });
    expect(received.map((r) => r.nonce)).toEqual([1, 2]);
  });

  it('consume 首个当事：同一 nonce 只有一个消费者为 true（同会话多席位去重依据）', () => {
    const channel = createComposerPrefillChannel();
    channel.request({ sessionId: 's1', quote: 'q', focus: false });
    expect(channel.consume(1)).toBe(true);
    expect(channel.consume(1)).toBe(false);
    // 下一个请求的 nonce 仍可被消费（单调递增，不互相吞）
    channel.request({ sessionId: 's1', quote: 'q2', focus: false });
    expect(channel.consume(2)).toBe(true);
    expect(channel.consume(2)).toBe(false);
  });

  it('应用单例与工厂实例互不串扰', () => {
    const isolated = createComposerPrefillChannel();
    const received: number[] = [];
    isolated.subscribe((req) => received.push(req.nonce));
    isolated.request({ sessionId: 'x', quote: 'q', focus: false });
    expect(received).toEqual([1]);
    // 单例自己也有独立计数（应用内已用过多少次不落后于工厂实例）
    expect(composerPrefill.request({ sessionId: 'x', quote: 'q', focus: false }).nonce).toBeGreaterThan(0);
  });
});

describe('prefillAppendText（追加语义：非覆盖 + 空行分隔）', () => {
  it('空草稿 → 直接引块开头', () => {
    expect(prefillAppendText('', '`p:1`\n> x')).toBe('`p:1`\n> x');
  });

  it('纯空白草稿视同空草稿（不留噪声前缀）', () => {
    expect(prefillAppendText('  \n\t', '`p:1`\n> x')).toBe('`p:1`\n> x');
  });

  it('非空草稿 → 返回空行分隔的追加段（不覆盖既有内容；既有内容由席位在草稿末尾保留）', () => {
    expect(prefillAppendText('已有草稿', '`p:1`\n> x')).toBe('\n\n`p:1`\n> x');
  });

  it('空引块 → 空串（调用方跳过派发）', () => {
    expect(prefillAppendText('已有草稿', '')).toBe('');
    expect(prefillAppendText('', '')).toBe('');
  });

  it('通道请求为可监听对象（vi.fn 兼容订阅面）', () => {
    const listener = vi.fn();
    const channel = createComposerPrefillChannel();
    channel.subscribe(listener);
    channel.request({ sessionId: 's9', quote: 'q', focus: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
