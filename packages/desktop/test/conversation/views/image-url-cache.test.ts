// 图片 URL 缓存测试（D-39）：逐会话缓存 + 一次授权读取共享 + 清理/失效。
// node 环境（纯逻辑，无 React）。
import { describe, expect, it, vi } from 'vitest';
import { createImageUrlCache, ImageUrlCacheError } from '@harness2/ui-shared/renderer/conversation/views/index.js';
import type { ConversationImageAttachment } from '@harness2/ui-shared/renderer/conversation/views/index.js';

const A1: ConversationImageAttachment = { id: 'a1', mimeType: 'image/png' };
const A2: ConversationImageAttachment = { id: 'a2', mimeType: 'image/jpeg' };

describe('ImageUrlCache（D-39）', () => {
  it('Chat 与 Trajectory 并发取同一附件：只授权读取一次，拿到同一个 promise 与同一个 URL', async () => {
    let resolveRead: (url: string) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const cache = createImageUrlCache({ read });

    const chatPromise = cache.imageUrl('s1', A1);
    const trajectoryPromise = cache.imageUrl('s1', A1); // Trajectory 同帧要同一张图
    expect(read).toHaveBeenCalledTimes(1);
    expect(trajectoryPromise).toBe(chatPromise); // 同一次读取（promise 引用相等）
    expect(cache.pendingCount()).toBe(1);

    resolveRead('data:image/png;base64,AAAA');
    const [chatUrl, trajectoryUrl] = await Promise.all([chatPromise, trajectoryPromise]);
    expect(chatUrl).toBe('data:image/png;base64,AAAA');
    expect(trajectoryUrl).toBe(chatUrl);
    expect(cache.pendingCount()).toBe(0);

    // 已解析：后续两次都命中缓存，不再触发授权读取
    await cache.imageUrl('s1', A1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.peek('s1', A1)).toBe(chatUrl);
    expect(cache.cachedCount()).toBe(1);
  });

  it('逐会话隔离：同一附件标识在不同会话各读一次、互不串味', async () => {
    const read = vi.fn(
      (sessionId: string, attachment: ConversationImageAttachment) => `blob:${sessionId}/${attachment.id}`,
    );
    const cache = createImageUrlCache({ read });
    const u1 = await cache.imageUrl('s1', A1);
    const u2 = await cache.imageUrl('s2', A1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(u1).not.toBe(u2);
    expect(cache.peek('s1', A1)).toBe('blob:s1/a1');
    expect(cache.peek('s2', A1)).toBe('blob:s2/a1');
    // 不同附件在同会话内也是不同缓存键
    await cache.imageUrl('s1', A2);
    expect(read).toHaveBeenCalledTimes(3);
    expect(cache.cachedCount()).toBe(3);
  });

  it('invalidate：单附件失效只清该键；无 attachmentId 时清整会话', async () => {
    const read = vi.fn(
      (sessionId: string, attachment: ConversationImageAttachment) => `blob:${sessionId}/${attachment.id}`,
    );
    const cache = createImageUrlCache({ read });
    await cache.imageUrl('s1', A1);
    await cache.imageUrl('s1', A2);
    await cache.imageUrl('s2', A1);

    cache.invalidate('s1', 'a1');
    expect(cache.peek('s1', A1)).toBeNull();
    expect(cache.peek('s1', A2)).toBe('blob:s1/a2');
    expect(cache.peek('s2', A1)).toBe('blob:s2/a1');

    cache.invalidate('s1');
    expect(cache.peek('s1', A2)).toBeNull();
    expect(cache.peek('s2', A1)).toBe('blob:s2/a1'); // 别的会话不受影响

    // 失效后重新取会再次授权读取
    await cache.imageUrl('s1', A1);
    expect(read).toHaveBeenCalledTimes(4);

    cache.clear();
    expect(cache.cachedCount()).toBe(0);
    expect(cache.peek('s2', A1)).toBeNull();
  });

  it('失败不缓存（可重试）：reject 与同步抛错都返回 null 且下次重新读取', async () => {
    let attempt = 0;
    const read = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('授权失败'));
      if (attempt === 2) throw new Error('同步拒绝');
      return 'blob:ok';
    });
    const cache = createImageUrlCache({ read });

    await expect(cache.imageUrl('s1', A1)).resolves.toBeNull();
    expect(cache.pendingCount()).toBe(0);
    await expect(cache.imageUrl('s1', A1)).resolves.toBeNull();
    expect(cache.pendingCount()).toBe(0);
    await expect(cache.imageUrl('s1', A1)).resolves.toBe('blob:ok');
    expect(read).toHaveBeenCalledTimes(3);
    expect(cache.peek('s1', A1)).toBe('blob:ok');
  });

  it('授权读取成功但无图（null）不缓存：允许下次再问', async () => {
    const read = vi.fn(() => null);
    const cache = createImageUrlCache({ read });
    await expect(cache.imageUrl('s1', A1)).resolves.toBeNull();
    await expect(cache.imageUrl('s1', A1)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.cachedCount()).toBe(0);
  });

  it('订阅：解析完成 / 失效 / 清空时通知（无变化不通知）', async () => {
    const cache = createImageUrlCache({ read: () => 'blob:x' });
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);
    await cache.imageUrl('s1', A1);
    expect(listener).toHaveBeenCalledTimes(1);

    // 命中缓存不再通知
    await cache.imageUrl('s1', A1);
    expect(listener).toHaveBeenCalledTimes(1);

    // 失效无效键（其它会话）不通知
    cache.invalidate('s9');
    expect(listener).toHaveBeenCalledTimes(1);

    cache.invalidate('s1', 'a1');
    expect(listener).toHaveBeenCalledTimes(2);

    await cache.imageUrl('s2', A1);
    cache.clear();
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    await cache.imageUrl('s3', A1);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('peekUrl 是绑定本缓存的稳定解析器（D-39 ctx 形态）', async () => {
    const cache = createImageUrlCache({ read: () => 'blob:z' });
    const resolver = cache.peekUrl;
    expect(cache.peekUrl).toBe(resolver); // 引用稳定，可安全解构传入视图
    expect(resolver('s1', A1)).toBeNull(); // 未授权读取前不触发读取
    expect(cache.pendingCount()).toBe(0);
    await cache.imageUrl('s1', A1);
    expect(resolver('s1', A1)).toBe('blob:z');
  });

  it('空 sessionId / 空 attachment.id 抛错（不静默缓存错位）', () => {
    const cache = createImageUrlCache({ read: () => 'blob:x' });
    expect(() => cache.peek('', A1)).toThrow(ImageUrlCacheError);
    expect(() => cache.peek('s1', { id: '' })).toThrow(ImageUrlCacheError);
    expect(() => cache.imageUrl('', A1)).toThrow(ImageUrlCacheError);
    expect(() => cache.invalidate('')).toThrow(ImageUrlCacheError);
  });
});
