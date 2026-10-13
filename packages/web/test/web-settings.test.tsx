// web 设置覆层测试（Z7 → Z9-6b）：经侧栏设置入口打开共享设置页。
//   * 导航白名单 = WEB_SETTINGS_SECTIONS（数据面齐备的分区；防回归：数量与集合）；
//   * 外观：主题/字号真生效（浏览器存储镜像，例外 #1/#2）；
//   * config 读：getConfig 走端口并渲染**脱敏值**（approval 模式 / 工具规则）；
//   * config 写：成功路径经 updateConfig；失败（500/401/405）分区如实报错，不假装成功；
//   * diagnostics：doctor 端点失败 → 分区如实报错。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import type { SettingsConfigShape } from '@harness2/ui-shared/shared/settings.js';
import { shellThemeStore } from '@harness2/ui-shared/renderer/theme/index.js';
import { WebApp } from '../src/app.js';
import { WEB_SETTINGS_SECTIONS, type WebSettingsDataPorts } from '../src/web-settings.js';

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

/** 脱敏 config 视图（approval 有真实值；其余段是「不渲染的占位」——对应分区不进 allowList） */
const CFG: SettingsConfigShape = {
  providers: { ds: { protocol: 'openai', baseUrl: 'https://api.test/v1', envKey: 'DS_KEY', models: { 'm-1': {} } } },
  roles: { main: { channel: 'ds', model: 'm-1' } },
  approval: { mode: 'bypass', tools: { write: 'ask' } },
  memory: { mode: 'off', nudgeInterval: 10 },
  browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
  plugins: { enabled: true, allow: [] },
  mcpServers: {},
  subagent: { maxDepth: 1, maxTurns: 25 },
  sources: { global: true, project: false },
  warnings: [],
  errors: [],
};

function fakeDataPorts(over: Partial<WebSettingsDataPorts> = {}): WebSettingsDataPorts {
  return {
    getConfig: async () => CFG,
    updateConfig: async () => ({ ok: true, config: CFG }),
    getAuthMasked: async () => ({ channels: [], gateways: [] }),
    getDoctorReport: async () => ({ checks: [], exitCode: 0 }),
    getSkills: async () => ({ skills: [], warnings: [], roots: { project: '/p', global: '/g' } }),
    getCrashReports: async () => [],
    ...over,
  };
}

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

async function mount(data: WebSettingsDataPorts = fakeDataPorts()): Promise<() => void> {
  const shell = createAppShell(fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(React.createElement(WebApp, { shell, onNewSession: () => undefined, settingsDataPorts: data }));
  return stop;
}

async function openSettings(): Promise<void> {
  fireEvent.click(await screen.findByTestId('sidebar-settings'));
  await screen.findByRole('dialog', { name: '设置' });
}

function navIds(): Array<string | null> {
  return [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
}

async function gotoSection(id: string): Promise<void> {
  fireEvent.click(document.querySelector(`[data-section-nav="${id}"]`) as HTMLElement);
  await waitFor(() => expect(document.querySelector(`[data-section="${id}"]`)).not.toBeNull());
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

describe('web 设置覆层（Z9-6b：与桌面对齐）', () => {
  it('侧栏设置入口 → 打开共享设置页；默认落常规分区；导航 = 数据面齐备的分区集合', async () => {
    const stop = await mount();
    await openSettings();
    expect(document.querySelector('[data-section="general"]')).not.toBeNull();
    // ④ 防回归：导航集合与顺序 = WEB_SETTINGS_SECTIONS（数量与集合一致）
    expect(navIds()).toEqual([...WEB_SETTINGS_SECTIONS]);
    expect(WEB_SETTINGS_SECTIONS).toHaveLength(9);
    // 无数据面的分区不进导航（隐藏而非摆禁用假控件）
    for (const absent of ['models', 'memory', 'browser', 'plugins', 'mcp', 'subagent', 'hooks', 'gateway']) {
      expect(navIds()).not.toContain(absent);
    }
    stop();
  });

  it('外观：选择「深色」→ 主题真生效（D-15 四要素）+ 浏览器存储镜像（例外 #1）', async () => {
    const stop = await mount();
    await openSettings();
    await gotoSection('appearance');
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
    await gotoSection('appearance');
    const field = await screen.findByRole('spinbutton', { name: '界面字号' });
    fireEvent.change(field, { target: { value: '16' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('16px'));
    expect(window.localStorage.getItem('harness2-font-size')).toBe('16');
    stop();
  });

  // ① config 读走端点并渲染脱敏值
  it('审批与安全：config 经 getConfig 端口读取 → 渲染脱敏的审批模式与工具规则', async () => {
    const getConfig = vi.fn(async () => CFG);
    const stop = await mount(fakeDataPorts({ getConfig }));
    await openSettings();
    await gotoSection('approval');

    expect(getConfig).toHaveBeenCalled();
    // 审批模式（config.approval.mode = bypass）→「完全控制」为选中态
    const on = document.querySelector('[data-section="approval"] .choice-on');
    expect(on?.textContent).toContain('完全控制');
    // 工具级规则（config.approval.tools）如实渲染
    const text = document.querySelector('[data-section="approval"]')?.textContent ?? '';
    expect(text).toContain('write');
    expect(text).toContain('ask');
    stop();
  });

  // ② config 写成功路径走后端
  it('审批与安全：改模式保存 → 经 updateConfig 端口写入 patch', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true, config: CFG }));
    const stop = await mount(fakeDataPorts({ updateConfig }));
    await openSettings();
    await gotoSection('approval');

    fireEvent.click(screen.getByRole('button', { name: /先计划再执行/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ approval: { mode: 'plan' } }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    stop();
  });

  // ③ 端点失败时分区如实报错（写 500/401/405）
  it('审批与安全：写失败（400/500/405）→ 分区显示可读错误，不假装成功', async () => {
    const updateConfig = vi.fn(async () => ({ ok: false, error: '配置写入失败：HTTP 500' }));
    const stop = await mount(fakeDataPorts({ updateConfig }));
    await openSettings();
    await gotoSection('approval');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/配置写入失败：HTTP 500/)).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
    stop();
  });

  // ③ 端点失败时分区如实报错（doctor 500）
  it('诊断：doctor 端点失败 → 分区如实报错（不画成空数据/成功）', async () => {
    const getDoctorReport = vi.fn(async () => {
      throw new Error('doctor 请求失败：HTTP 500');
    });
    const stop = await mount(fakeDataPorts({ getDoctorReport }));
    await openSettings();
    await gotoSection('diagnostics');

    expect(await screen.findByText(/doctor 请求失败：HTTP 500/)).toBeTruthy();
    stop();
  });

  it('分区切换：常规 ↔ 审批 正文互斥（旧分区卸载）', async () => {
    const stop = await mount();
    await openSettings();
    await gotoSection('approval');
    expect(document.querySelector('[data-section="general"]')).toBeNull();

    await gotoSection('general');
    expect(document.querySelector('[data-section="approval"]')).toBeNull();
    stop();
  });
});
