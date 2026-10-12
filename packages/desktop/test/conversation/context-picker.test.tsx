// @vitest-environment jsdom
// P0「添加上下文」桌面接线：desktopContextPicker 把文件清单接到既有 listDir 白名单 IPC；
// 缺通道时如实失败（不臆造空列表）。组件语义在 ui-shared 侧覆盖，这里只钉壳注入这一跳。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopContextPicker } from '../../src/renderer/conversation/assembly.js';

afterEach(() => {
  delete (globalThis as { harness2?: unknown }).harness2;
});

describe('desktopContextPicker（桌面注入 listDir 数据源）', () => {
  it('转发到 window.harness2.listDir，原样带回相对路径结果', async () => {
    const listDir = vi.fn(async (p: string) => ({
      ok: true,
      path: p,
      entries: [{ name: 'a.ts', kind: 'file' }],
      truncated: false,
    }));
    (globalThis as { harness2?: unknown }).harness2 = { listDir };

    const result = await desktopContextPicker.listDir!('src/');
    expect(listDir).toHaveBeenCalledWith('src/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toEqual([{ name: 'a.ts', kind: 'file' }]);
  });

  it('未暴露目录通道 → 如实返回失败（不摆假文件树）', async () => {
    const result = await desktopContextPicker.listDir!('');
    expect(result).toEqual({ ok: false, error: '桌面未暴露目录通道' });
  });
});
