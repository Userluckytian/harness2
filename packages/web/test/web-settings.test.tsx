// web 设置覆层测试（Z7）：经侧栏设置入口打开共享设置页；外观分区主题/字号真生效；
// 网关 / IM 分区如实只读指引（无数据面不摆假条目）；未提供的数据面不出现在导航。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import { shellThemeStore } from '@harness2/ui-shared/renderer/theme/index.js';
import { WebApp } from '../src/app.js';

(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const SESSION: SessionSummaryShape = {
  id: 's1',
  dir: '/tmp/s1',
  cwd: '/work',
  mtimeMs: 1000,
  firstUserText: '第一个会话',
  messageCount: 2,
  lastSeq: 0,
};

function fakeClient(): HarnessClient {
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  return {
    listSessions: async () => [SESSION],
    createSession: async () => ({ id: 's2' }),
    events: async (id) => ({
      id,
      dir: `/tmp/${id}`,
      header: { sessionId: id, cwd: '/work' },
      events: [],
      warnings: [],
      lastSeq: 0,
    }),
    subscribe: async () => undefined,
    sendMessage: async () => undefined,
    abort: async () => undefined,
    respondApproval: async () => undefined,
    getStatus: async () => ({ status: 'connected' }),
    onEvent: () => () => undefined,
    onConnectionStatus: (listener) => {
      statusListeners.add(listener);
      listener('connected');
      return () => statusListeners.delete(listener);
    },
    submit: async () => undefined,
    cancel: async () => undefined,
    resumeSubscription: async () => undefined,
    fork: async () => undefined,
    undo: async () => ({ results: [] }),
    redo: async () => ({ results: [] }),
    runConfig: async () => {
      throw new Error('未提供');
    },
    planState: async () => null,
    executionViews: async () => [],
    changeReview: async () => ({ sourceDir: '/work', files: [], changedFiles: 0, dirtyFiles: 0, readOnly: true }),
  };
}

async function mount(): Promise<() => void> {
  const shell = createAppShell(fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(React.createElement(WebApp, { shell, onNewSession: () => undefined }));
  return stop;
}

async function openSettings(): Promise<void> {
  fireEvent.click(await screen.findByTestId('sidebar-settings'));
  await screen.findByRole('dialog', { name: '设置' });
}

function clearThemeArtifacts(): void {
  document.documentElement.style.cssText = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('theme-zai-light', 'theme-zai-dark', 'dark');
  document.body.removeAttribute('data-ds-dark-theme');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
}

afterEach(() => {
  cleanup();
  shellThemeStore.reset();
  window.localStorage.clear();
  clearThemeArtifacts();
});

describe('web 设置覆层（Z7）', () => {
  it('侧栏设置入口 → 打开共享设置页；默认落外观分区', async () => {
    const stop = await mount();
    await openSettings();
    expect(document.querySelector('[data-section="appearance"]')).not.toBeNull();
    // 导航只见有真数据面的分区（appearance / gateway）；不出现 models/skill 等无通道分区
    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs).toEqual(['appearance', 'gateway']);
    stop();
  });

  it('外观：选择「深色」→ 主题真生效（D-15 四要素）+ 浏览器存储镜像（例外 #1）', async () => {
    const stop = await mount();
    await openSettings();
    const trigger = await screen.findByRole('combobox', { name: '界面主题' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: '深色' }));

    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('zai-dark'));
    expect(document.documentElement.classList.contains('theme-zai-dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem('harness2-theme')).toBe('zai-dark');
    stop();
  });

  it('外观：提交界面字号 → 写根 --ui-font-size + 浏览器存储镜像（例外 #2）', async () => {
    const stop = await mount();
    await openSettings();
    const field = await screen.findByRole('spinbutton', { name: '界面字号' });
    fireEvent.change(field, { target: { value: '16' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('16px'));
    expect(window.localStorage.getItem('harness2-font-size')).toBe('16');
    stop();
  });

  it('网关 / IM：web 无配置/凭据数据面 → 如实只读指引 + 「未探测」，不摆假条目/假绿点', async () => {
    const stop = await mount();
    await openSettings();
    fireEvent.click(document.querySelector('[data-section-nav="gateway"]') as HTMLElement);

    expect(await screen.findByText(/此壳不提供 config.json 读取/)).toBeTruthy();
    expect(document.querySelector('[data-gateway-unavailable]')).not.toBeNull();
    // 两个渠道都只报「未探测」，且网关分区内无「已连接」等假状态（状态角标在侧栏页脚，不在此分区）
    expect(document.querySelectorAll('[data-gateway-status="unprobed"]').length).toBe(2);
    const gatewayText = document.querySelector('[data-section="gateway"]')?.textContent ?? '';
    expect(gatewayText).not.toContain('已连接');
    expect(gatewayText).not.toContain('连接中');
    // 无凭据写入入口（不渲染假的 AppSecret 输入）
    expect(screen.queryByLabelText('QQ AppSecret')).toBeNull();
    stop();
  });

  it('分区切换：外观 ↔ 网关 正文互斥（旧分区卸载）', async () => {
    const stop = await mount();
    await openSettings();
    fireEvent.click(document.querySelector('[data-section-nav="gateway"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-section="gateway"]')).not.toBeNull());
    expect(document.querySelector('[data-section="appearance"]')).toBeNull();

    fireEvent.click(document.querySelector('[data-section-nav="appearance"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-section="appearance"]')).not.toBeNull());
    expect(document.querySelector('[data-section="gateway"]')).toBeNull();
    stop();
  });
});
