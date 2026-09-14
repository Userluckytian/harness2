// D-37 附件测试：图片 FileReader data URL（注入缝）+ 文件 FIFO 上传队列（并发缺省 2、保序、失败不阻塞）。
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_FILE_UPLOADS,
  FileUploadQueue,
  readImageAsDataUrl,
  type FileReaderLike,
  type ImageReadIO,
  type UploadTask,
  type UploadTransport,
} from '@harness2/ui-shared/renderer/conversation/composer/attachments.js';

function fakeReader(dataUrl: string | null, errorMessage?: string): FileReaderLike {
  const reader: FileReaderLike = {
    result: null,
    error: null,
    onload: null,
    onerror: null,
    readAsDataURL: () => {
      queueMicrotask(() => {
        if (dataUrl === null) {
          reader.error = { message: errorMessage ?? '读失败' };
          reader.onerror?.();
          return;
        }
        reader.result = dataUrl;
        reader.onload?.();
      });
    },
  };
  return reader;
}

const task = (id: string): UploadTask => ({
  id,
  name: `${id}.bin`,
  mimeType: 'application/octet-stream',
  bytes: 10,
  file: { id },
});

function deferred(): {
  promise: Promise<{ token: string }>;
  resolve: (t: string) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (t: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ token: string }>((res, rej) => {
    resolve = (t) => res({ token: t });
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('D-37 图片：FileReader data URL', () => {
  it('读取成功：返回 data URL 与 bytes，mimeType 从 data URL 前缀推导', async () => {
    const io: ImageReadIO = { createReader: () => fakeReader('data:image/png;base64,AAAA') };
    const result = await readImageAsDataUrl({ size: 4, type: 'image/png' }, { name: 'a.png' }, io);
    expect(result.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(result.mimeType).toBe('image/png');
    expect(result.bytes).toBe(4);
  });

  it('显式 mimeType 优先；空结果或 onerror 一律 reject（调用方标 failed，不阻塞其余附件）', async () => {
    const io: ImageReadIO = { createReader: () => fakeReader('data:image/webp;base64,BBBB') };
    const result = await readImageAsDataUrl(
      { size: 2, type: 'image/webp' },
      { name: 'a.webp', mimeType: 'image/x-custom' },
      io,
    );
    expect(result.mimeType).toBe('image/x-custom');

    await expect(
      readImageAsDataUrl({ size: 1 }, { name: 'bad.png' }, { createReader: () => fakeReader(null, '磁盘读失败') }),
    ).rejects.toThrow('磁盘读失败');
    await expect(
      readImageAsDataUrl({ size: 1 }, { name: 'empty.png' }, { createReader: () => fakeReader(null) }),
    ).rejects.toThrow();
  });
});

describe('D-37 文件：FIFO 上传队列', () => {
  it('默认并发 2（D-37）；可配且非法值拒绝', () => {
    expect(DEFAULT_MAX_CONCURRENT_FILE_UPLOADS).toBe(2);
    const queue = new FileUploadQueue({ transport: { upload: async () => ({ token: 't' }) } });
    expect(queue.maxConcurrent).toBe(2);
    expect(
      () => new FileUploadQueue({ transport: { upload: async () => ({ token: 't' }) }, maxConcurrent: 0 }),
    ).toThrow();
    expect(
      new FileUploadQueue({ transport: { upload: async () => ({ token: 't' }) }, maxConcurrent: 3 }).maxConcurrent,
    ).toBe(3);
  });

  it('并发上限断言：3 条同时入队只跑 2 条，落定后泵下一条；附件顺序 = 入队顺序', async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const transport: UploadTransport = {
      upload: (t) => {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred();
        gates.set(t.id, gate);
        return gate.promise.finally(() => {
          active -= 1;
        });
      },
    };
    const queue = new FileUploadQueue({ transport });
    queue.enqueue([task('a'), task('b'), task('c')]);
    expect(queue.activeCount).toBe(2);
    expect(queue.pendingCount).toBe(1);
    expect(queue.peakConcurrency).toBe(2);
    expect(queue.uploadsPending).toBe(true);
    expect(queue.attachments().map((a) => a.id)).toEqual(['a', 'b', 'c']);

    gates.get('a')?.resolve('tok-a');
    await flush();
    expect(queue.activeCount).toBe(2); // c 顶上
    expect(queue.pendingCount).toBe(0);
    expect(queue.peakConcurrency).toBeLessThanOrEqual(2);

    gates.get('b')?.resolve('tok-b');
    gates.get('c')?.resolve('tok-c');
    await queue.whenIdle();
    expect(queue.uploadsPending).toBe(false);
    expect(queue.attachments().map((a) => a.state)).toEqual(['ready', 'ready', 'ready']);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('失败不阻塞后续：一条失败，其余照常完成（失败项留在列表供重提）', async () => {
    const transport: UploadTransport = {
      upload: async (t) => {
        if (t.id === 'a') throw new Error('网络断');
        return { token: `tok-${t.id}` };
      },
    };
    const queue = new FileUploadQueue({ transport });
    queue.enqueue([task('a'), task('b'), task('c')]);
    await queue.whenIdle();
    const list = queue.attachments();
    expect(list.map((a) => a.state)).toEqual(['failed', 'ready', 'ready']);
    expect(list[0]?.error).toBe('网络断');
  });

  it('失败重提：retryFailed 按原顺序重跑 failed 项（其余不动），重提不丢附件', async () => {
    let attempt = 0;
    const transport: UploadTransport = {
      upload: async (t) => {
        if (t.id === 'a' && attempt++ === 0) throw new Error('第一次失败');
        return { token: `tok-${t.id}` };
      },
    };
    const queue = new FileUploadQueue({ transport });
    queue.enqueue([task('a'), task('b')]);
    await queue.whenIdle();
    expect(queue.attachments()[0]?.state).toBe('failed');
    queue.retryFailed();
    await queue.whenIdle();
    expect(queue.attachments().map((a) => a.id)).toEqual(['a', 'b']);
    expect(queue.attachments().map((a) => a.state)).toEqual(['ready', 'ready']);
    expect(queue.attachments()[0]?.token).toBe('tok-a');
  });

  it('onUpdate 逐状态上报（queued → uploading → ready），移除后落定回调为 no-op', async () => {
    const seen: string[] = [];
    const gate = deferred();
    const queue = new FileUploadQueue({
      transport: { upload: () => gate.promise },
      onUpdate: (a) => seen.push(`${a.id}:${a.state}`),
    });
    queue.enqueue([task('a')]);
    expect(seen).toEqual(['a:queued', 'a:uploading']);
    queue.remove('a');
    gate.resolve('tok-a');
    await flush();
    expect(queue.attachments()).toHaveLength(0);
    expect(seen).toEqual(['a:queued', 'a:uploading']); // 移除后不再上报
  });

  it('多个 onUpdate 监听由调用方合成；transport 只被真实调度（排队项不提前调用）', async () => {
    const upload = vi.fn(async (t: UploadTask) => ({ token: `tok-${t.id}` }));
    const queue = new FileUploadQueue({ transport: { upload }, maxConcurrent: 1 });
    queue.enqueue([task('a'), task('b')]);
    await queue.whenIdle();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
  });
});
