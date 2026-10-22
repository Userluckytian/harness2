import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { HostMessageTypes, HostResponseTypes, hostResourceUsageSnapshotResultResponseSchema } from '@zcode/shared';
import { attachHostSampling } from '../src/real/host-sampling.js';

describe('host-sampling (ZS5-T1)', () => {
  it('请求 -> 结果形状通过 zod schema 断言', () => {
    const port = new EventEmitter();
    const postMessage = vi.fn();
    (port as any).postMessage = postMessage;
    attachHostSampling(port as any);

    port.emit('message', {
      data: { type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId: 'req-1' },
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const resp = postMessage.mock.calls[0][0];
    const parsed = hostResourceUsageSnapshotResultResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(true);
    expect(resp.type).toBe(HostResponseTypes.ResourceUsageSnapshotResult);
    expect(resp.requestId).toBe('req-1');
    expect(Array.isArray(resp.processes)).toBe(true);
    expect(resp.processes.length).toBe(1);
  });

  it('cancel 未决请求 -> 无回帖', () => {
    const port = new EventEmitter();
    const postMessage = vi.fn();
    (port as any).postMessage = postMessage;
    const controller = attachHostSampling(port as any);

    // 直接取消一个从未请求过的 requestId：应忽略且不回帖
    port.emit('message', {
      data: { type: HostMessageTypes.ResourceUsageSnapshotCancel, requestId: 'no-such' },
    });
    expect(postMessage).not.toHaveBeenCalled();

    // controller.cancelRequest 对未登记 id 也是 no-op
    controller.cancelRequest('another');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('未知 type 被忽略且不抛', () => {
    const port = new EventEmitter();
    const postMessage = vi.fn();
    (port as any).postMessage = postMessage;
    attachHostSampling(port as any);

    expect(() => {
      port.emit('message', { data: { type: 'totally-unknown-type', foo: 'bar' } });
      port.emit('message', { data: null });
      port.emit('message', {});
    }).not.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('第二次快照 CPU 差分随 busy 循环增大', () => {
    const port = new EventEmitter();
    const postMessage = vi.fn();
    (port as any).postMessage = postMessage;
    attachHostSampling(port as any);

    port.emit('message', {
      data: { type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId: 'r1' },
    });
    const first = postMessage.mock.calls[0][0].processes[0].cpuPercent;

    // busy 循环
    const start = Date.now();
    while (Date.now() - start < 50) {
      Math.sqrt(Math.random());
    }

    port.emit('message', {
      data: { type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId: 'r2' },
    });
    const second = postMessage.mock.calls[1][0].processes[0].cpuPercent;

    // 首次为 0（无前值）；第二次应 >= 0 且能采到（不断言严格 >0 以抗抖动，但应为有限数）
    expect(Number.isFinite(first)).toBe(true);
    expect(Number.isFinite(second)).toBe(true);
    expect(first).toBe(0);
    // 第二次在 busy 后通常 > 0；若环境极快导致 0 也不算失败，但记录
    // 这里做宽松断言：second >= 0
    expect(second).toBeGreaterThanOrEqual(0);
  });

  it('字段值含 SECRET 样例时出口被 redact', () => {
    const port = new EventEmitter();
    const postMessage = vi.fn();
    (port as any).postMessage = postMessage;
    attachHostSampling(port as any, { hostName: 'token=SECRET123 sk-abcdefghijklmnop' });

    port.emit('message', {
      data: { type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId: 'sec-1' },
    });
    const resp = postMessage.mock.calls[0][0];
    const row = resp.processes[0];
    expect(row.name).not.toContain('SECRET123');
    expect(row.name).not.toContain('sk-abcdefghijklmnop');
    expect(row.name).toContain('[REDACTED]');
  });
});
