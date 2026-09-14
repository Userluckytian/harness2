// 宿主能力端口（HostBridge）：
//   1. 壳**没有**该能力时，组件如实说明「此壳未提供…通道」——不假装加载中、不伪造内容；
//   2. 壳注入实现后（React 上下文优先，其次 globalThis.harness2）功能真实可用。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HostBridgeProvider } from '../src/renderer/host-bridge.jsx';
import { DiffCard } from '../src/renderer/components/DiffCard.js';
import { ToolFilePreviewPanel } from '../src/renderer/tool/index.js';

const globals = globalThis as { harness2?: unknown };

beforeEach(() => {
  delete globals.harness2;
});

afterEach(() => cleanup());

describe('HostBridge 缺失：如实降级', () => {
  it('diff 卡片：没有快照读取通道 → 明确说明，不渲染假 diff', () => {
    render(createElement(DiffCard, { sessionId: 's1', seq: 3, onUndo: () => undefined }));
    expect(screen.getByText(/此壳未提供快照读取通道/)).toBeTruthy();
  });

  it('文件预览：没有文件读取通道 → 明确说明，不假装加载中', async () => {
    render(
      createElement(ToolFilePreviewPanel, {
        preview: { path: 'src/a.ts', openedAt: 1 },
      }),
    );
    await waitFor(() => expect(screen.getByText(/此壳未提供文件读取通道/)).toBeTruthy());
  });
});

describe('HostBridge 注入：功能真实可用', () => {
  it('经 React 上下文注入快照读取 → 渲染红绿 diff 行', async () => {
    render(
      createElement(
        HostBridgeProvider,
        {
          value: {
            getSnapshotForCall: async () => ({
              ok: true,
              entry: { file: 'src/a.ts', before: 'a\n', after: 'a\nb\n' },
            }),
          },
        },
        createElement(DiffCard, { sessionId: 's1', seq: 3, onUndo: () => undefined }),
      ),
    );
    await waitFor(() => expect(screen.getByText('src/a.ts')).toBeTruthy());
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('经 globalThis.harness2（桌面 preload 的既有形状）注入文件读取 → 显示内容', async () => {
    globals.harness2 = {
      readFileForRef: async () => ({ ok: true, content: 'line-1\nline-2' }),
    };
    render(createElement(ToolFilePreviewPanel, { preview: { path: 'src/a.ts', openedAt: 1 }, cwd: '/work' }));
    await waitFor(() => expect(screen.getByText('line-1')).toBeTruthy());
    expect(screen.getByText('line-2')).toBeTruthy();
  });

  it('壳给出 ok:false → 如实显示错误（不静默吞）', async () => {
    globals.harness2 = {
      readFileForRef: async () => ({ ok: false, error: '越界：文件不在会话 cwd 半径内' }),
    };
    render(createElement(ToolFilePreviewPanel, { preview: { path: '../etc/passwd', openedAt: 1 }, cwd: '/work' }));
    await waitFor(() => expect(screen.getByText(/越界/)).toBeTruthy());
  });
});
