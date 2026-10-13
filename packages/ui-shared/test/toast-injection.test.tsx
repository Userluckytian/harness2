// @vitest-environment jsdom
// Z10-8b 真实使用点接入单测（每个接入点一条失败路径 + 反向钉：成功不产生 error toast）。
//   1. MessageActions 复制失败（原来静默）
//   2. ToolCard 复制错误失败（原来静默）
//   3. 会话重命名/归档/置顶/删除持久化失败（原来只进 store 的 error 帧，仅角标 tooltip 可见）
//   4. 模型凭据写入结果（A2 写路径：成功 → success；失败 → error）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageActions } from '../src/renderer/components/MessageActions.js';
import { ToolCard, resetToolOpenMemoryForTests } from '../src/renderer/tool/ToolCard.js';
import { createController } from '../src/renderer/app-controller.js';
import { AppStore } from '../src/renderer/store.js';
import { ProviderCard } from '../src/renderer/settings/models/ProviderCard.js';
import { toastStore } from '../src/renderer/toast/index.js';
import type { HarnessClient } from '../src/renderer/ports.js';

function toastItems(): ReturnType<typeof toastStore.getSnapshot> {
  return toastStore.getSnapshot();
}
function hasToast(kind: 'info' | 'success' | 'error', message: string): boolean {
  return toastItems().some((t) => t.kind === kind && t.message === message);
}

beforeEach(() => {
  resetToolOpenMemoryForTests();
});

afterEach(() => {
  cleanup();
  toastStore.clear();
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

describe('接入点 1：MessageActions 复制', () => {
  it('复制失败（无剪贴板通道）→ error toast「复制失败」', async () => {
    render(<MessageActions text="正文内容" />);
    fireEvent.click(screen.getByTestId('message-action-copy'));
    await waitFor(() => expect(hasToast('error', '复制失败')).toBe(true));
  });

  it('反向钉：复制成功 → 显示已复制且**不**产生 error toast', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
    render(<MessageActions text="正文内容" />);
    fireEvent.click(screen.getByTestId('message-action-copy'));
    await waitFor(() => expect(screen.getByTestId('message-action-copy').getAttribute('data-copied')).toBe('true'));
    expect(toastItems().some((t) => t.kind === 'error')).toBe(false);
  });
});

describe('接入点 2：ToolCard 复制错误', () => {
  it('复制错误失败（无剪贴板通道）→ error toast「复制失败」', async () => {
    render(
      <ToolCard
        card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: false, error: '读取失败' }, callId: 'c1' }}
      />,
    );
    fireEvent.click(screen.getByTestId('tool-copy-error'));
    await waitFor(() => expect(hasToast('error', '复制失败')).toBe(true));
  });

  it('反向钉：复制错误成功 → 不产生 error toast', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
    render(
      <ToolCard
        card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: false, error: '读取失败' }, callId: 'c1' }}
      />,
    );
    fireEvent.click(screen.getByTestId('tool-copy-error'));
    await waitFor(() => expect(screen.getByTestId('tool-copy-error').textContent).toContain('已复制'));
    expect(toastItems().some((t) => t.kind === 'error')).toBe(false);
  });
});

describe('接入点 3：会话展示态持久化失败', () => {
  function failingController(): ReturnType<typeof createController> {
    const store = new AppStore();
    const api = {
      metadataSet: async () => {
        throw new Error('磁盘只读');
      },
    } as unknown as HarnessClient;
    return createController(store, api);
  }

  it('重命名失败 → error toast，detail 带底层原因', async () => {
    await failingController().renameSession('s1', '新标题');
    const item = toastItems().find((t) => t.message === '重命名失败');
    expect(item?.kind).toBe('error');
    expect(item?.detail).toBe('磁盘只读');
  });

  it('归档 / 置顶 / 删除失败各报一条 error toast', async () => {
    const c = failingController();
    await c.archiveSession('s1', true);
    await c.pinSession('s1', true);
    await c.deleteSession('s1');
    expect(hasToast('error', '归档失败')).toBe(true);
    expect(hasToast('error', '置顶失败')).toBe(true);
    expect(hasToast('error', '删除失败')).toBe(true);
  });

  it('无持久化通道（降级）→ info toast 如实告知「仅在本次会话内生效」，不是 error', async () => {
    const controller = createController(new AppStore(), {} as unknown as HarnessClient);
    await controller.renameSession('s1', '新标题');
    expect(hasToast('info', '重命名未持久化')).toBe(true);
    expect(toastItems().some((t) => t.kind === 'error')).toBe(false);
  });

  it('反向钉：持久化成功 → 不产生 error toast', async () => {
    const controller = createController(new AppStore(), {
      metadataSet: async () => ({}),
    } as unknown as HarnessClient);
    await controller.renameSession('s1', '新标题');
    await controller.archiveSession('s1', true);
    await controller.pinSession('s1', true);
    await controller.deleteSession('s1');
    expect(toastItems().some((t) => t.kind === 'error')).toBe(false);
  });
});

describe('接入点 4：模型凭据写入（A2）', () => {
  function renderCard(
    write: (route: string, key: string) => Promise<{ ok: boolean; error?: string; reference?: string }>,
  ) {
    render(
      <ProviderCard
        mode="create"
        api={{ settingsWriteChannelKey: write }}
        revision="r1"
        row={null}
        existingIds={[]}
        onSaved={() => {}}
        onDeleted={() => {}}
        onRefresh={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'zai' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-abc123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));
  }

  it('写入失败 → error toast「API 密钥保存失败」，detail 带原因', async () => {
    renderCard(async () => ({ ok: false, error: '密钥被拒绝' }));
    await waitFor(() => expect(hasToast('error', 'API 密钥保存失败')).toBe(true));
    expect(toastItems().find((t) => t.message === 'API 密钥保存失败')?.detail).toBe('密钥被拒绝');
  });

  it('反向钉：写入成功 → success toast，且不产生 error toast', async () => {
    renderCard(async () => ({ ok: true, reference: 'ref-zai' }));
    await waitFor(() => expect(hasToast('success', 'API 密钥已保存')).toBe(true));
    expect(toastItems().some((t) => t.kind === 'error')).toBe(false);
  });
});
