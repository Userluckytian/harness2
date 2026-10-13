// web 设置覆层测试（Z7 → Z9-6b）：经侧栏设置入口打开共享设置页。
//   * 导航白名单 = WEB_SETTINGS_SECTIONS（数据面齐备的分区；防回归：数量与集合）；
//   * 外观：主题/字号真生效（浏览器存储镜像，例外 #1/#2）；
//   * config 读：getConfig 走端口并渲染**脱敏值**（approval 模式 / 工具规则）；
//   * config 写：成功路径经 updateConfig；失败（500/401/405）分区如实报错，不假装成功；
//   * diagnostics：doctor 端点失败 → 分区如实报错。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import type { ModelsSettingsApi, SettingsConfigShape } from '@harness2/ui-shared/shared/settings.js';
import { shellThemeStore } from '@harness2/ui-shared/renderer/theme/index.js';
import { resetSettingsSections } from '@harness2/ui-shared/renderer/settings/index.js';
// A2：注册 ui-shared 模型分区正文（同生产 main.tsx；未注册则 models 退化为过渡占位面板）
import { registerModelsSettingsSection } from '@harness2/ui-shared/renderer/settings/models/index.js';
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

/** 完整 config 视图（Z9-6c：各段为真实读取值；对应分区已进 allowList） */
const CFG: SettingsConfigShape = {
  providers: { ds: { protocol: 'openai', baseUrl: 'https://api.test/v1', envKey: 'DS_KEY', models: { 'm-1': {} } } },
  roles: { main: { channel: 'ds', model: 'm-1' } },
  approval: { mode: 'bypass', tools: { write: 'ask' } },
  memory: { mode: 'ask', nudgeInterval: 30 },
  browser: { enabled: false, idleDestroyMs: 120_000, maxConcurrent: 4 },
  plugins: { enabled: true, allow: ['plugin-x'] },
  mcpServers: { echo: { command: 'node', args: ['echo.mjs'] } },
  subagent: { maxDepth: 2, maxTurns: 40 },
  hooks: {
    enabled: true,
    timeoutMs: 3000,
    maxOutputBytes: 1024,
    entries: [{ event: 'turnEnd', command: 'echo done' }],
  },
  gateways: { qq: { enabled: true, appId: 'qq-app-id', dmPolicy: 'open' } },
  sources: { global: true, project: false },
  warnings: [],
  errors: [],
};

/** A2：模型通道面假实现（七法齐备 → 共享 modelsApiReady 为真，models 分区可用） */
function fakeModelsApi(over: Partial<ModelsSettingsApi> = {}): Partial<ModelsSettingsApi> {
  return {
    settingsGetModels: async () => ({
      revision: '0123456789abcdef',
      providers: [
        {
          id: 'ds',
          displayName: 'DeepSeek',
          protocol: 'openai',
          baseUrl: 'https://api.test/v1',
          apiKeyRef: 'DS_KEY',
          models: [{ id: 'm-1' }],
          layers: ['user'],
          deletable: true,
          credential: { state: 'confirmed', source: 'auth.json', reference: 'DS_KEY' },
        },
      ],
      declarationAckVersion: 1,
      sources: { global: true, project: false },
      warnings: [],
      errors: [],
    }),
    settingsUpdateModels: async () => ({ ok: true }),
    settingsDeleteProvider: async () => ({ ok: true }),
    settingsWriteChannelKey: async () => ({ ok: true, reference: 'DS_API_KEY' }),
    settingsGetCredentialStatus: async () => ({ ds: { state: 'confirmed', source: 'auth.json', reference: 'DS_KEY' } }),
    settingsAckModelsDeclaration: async (version) => ({ ok: true, declarationAckVersion: version }),
    settingsDiscoverModels: async () => ({ ok: true, models: [{ id: 'm-1', displayName: 'm-1' }] }),
    ...over,
  };
}

function fakeDataPorts(over: Partial<WebSettingsDataPorts> = {}): WebSettingsDataPorts {
  return {
    getConfig: async () => CFG,
    updateConfig: async () => ({ ok: true, config: CFG }),
    getAuthMasked: async () => ({ channels: [], gateways: [] }),
    updateAuth: async () => ({ ok: true }),
    getDoctorReport: async () => ({ checks: [], exitCode: 0 }),
    getSkills: async () => ({ skills: [], warnings: [], roots: { project: '/p', global: '/g' } }),
    getCrashReports: async () => [],
    modelsApi: fakeModelsApi(),
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

beforeEach(() => {
  // A2：注册模型分区正文（幂等）；afterEach 复位注册表，避免跨用例泄漏
  registerModelsSettingsSection();
});

afterEach(() => {
  cleanup();
  resetSettingsSections();
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
    expect(WEB_SETTINGS_SECTIONS).toHaveLength(17);
    // A2：数据面齐备的分区全部放开进导航（含 models：serve 模型端点七法齐备）
    expect(new Set(navIds())).toEqual(
      new Set([
        'general',
        'appearance',
        'models',
        'browser',
        'approval',
        'shortcuts',
        'memory',
        'subagent',
        'plugins',
        'mcp',
        'skill',
        'cron',
        'hooks',
        'gateway',
        'sessions',
        'diagnostics',
        'about',
      ]),
    );
    // A2：models 已进导航（serve 模型端点齐备；modelsApiReady 为真）
    expect(navIds()).toContain('models');
    stop();
  });

  // A2：模型分区可开且经端口读取（settingsGetModels → 渲染分层文档）
  it('模型：分区可开并渲染 getModels 端口返回的提供方行', async () => {
    const settingsGetModels = vi.fn(fakeModelsApi().settingsGetModels as ModelsSettingsApi['settingsGetModels']);
    const stop = await mount(fakeDataPorts({ modelsApi: fakeModelsApi({ settingsGetModels }) }));
    await openSettings();
    await gotoSection('models');

    expect(settingsGetModels).toHaveBeenCalled();
    const text = document.querySelector('[data-section="models"]')?.textContent ?? '';
    expect(text).toContain('DeepSeek');
    expect(text).toContain('ds');
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

  // ② Z9-6c：新放开分区（memory）的读写路径——读真实值 + 保存经 updateConfig 写 patch
  it('记忆：新放开分区渲染真实 cfg.memory 值；保存经 updateConfig 写 patch', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true, config: CFG }));
    const stop = await mount(fakeDataPorts({ updateConfig }));
    await openSettings();
    await gotoSection('memory');

    // 读：真实值（mode=ask →「询问」选中；nudgeInterval=30）
    const on = document.querySelector('[data-section="memory"] .seg-on');
    expect(on?.textContent).toContain('询问');
    const interval = document.querySelector('[data-section="memory"] input[type="number"]') as HTMLInputElement;
    expect(interval.value).toBe('30');

    // 写：改间隔 → 保存
    fireEvent.change(interval, { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ memory: { mode: 'ask', nudgeInterval: 45 } }));
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

describe('web 设置覆层：措辞按壳注入（不含桌面专属事实）', () => {
  it('通用分区：偏好措辞为浏览器本地存储，全页不含 desktop-preferences.json 与 Ctrl+,', async () => {
    const stop = await mount();
    await openSettings();
    const gen = document.querySelector('[data-section="general"]')?.textContent ?? '';
    expect(gen).toContain('浏览器本地存储');
    expect(gen).not.toContain('desktop-preferences.json');
    expect(gen).not.toContain('Ctrl+,');
    // 全页（含导航 / 页脚）也不含桌面专属事实
    const all = document.body.textContent ?? '';
    expect(all).not.toContain('desktop-preferences.json');
    expect(all).not.toContain('Ctrl+,');
    stop();
  });

  it('快捷键分区：只列 web 真实绑定（Ctrl+K / N / J），不含 Ctrl+,', async () => {
    const stop = await mount();
    await openSettings();
    await gotoSection('shortcuts');
    const text = document.querySelector('[data-section="shortcuts"]')?.textContent ?? '';
    expect(text).toContain('Ctrl+K / Cmd+K');
    expect(text).toContain('Ctrl+N / Cmd+N');
    expect(text).toContain('Ctrl+J / Cmd+J');
    expect(text).not.toContain('Ctrl+,');
    stop();
  });

  it('关于分区：标题为「harness2 Web」，不含「桌面端」', async () => {
    const stop = await mount();
    await openSettings();
    await gotoSection('about');
    expect(document.querySelector('[data-section="about"] h3')?.textContent).toBe('harness2 Web');
    expect(document.querySelector('[data-section="about"]')?.textContent ?? '').not.toContain('桌面端');
    stop();
  });

  it('定时任务分区：不再写「见后续版本」，指向侧栏「自动化」', async () => {
    const stop = await mount();
    await openSettings();
    await gotoSection('cron');
    const text = document.querySelector('[data-section="cron"]')?.textContent ?? '';
    expect(text).not.toContain('见后续版本');
    expect(text).toContain('自动化');
    stop();
  });

  it('网关分区：web 已具备凭据写入通道 → 渲染凭据表单，不再提示「请用桌面端」', async () => {
    const updateAuth = vi.fn(async () => ({ ok: true }));
    const stop = await mount(fakeDataPorts({ updateAuth }));
    await openSettings();
    await gotoSection('gateway');
    const text = document.querySelector('[data-section="gateway"]')?.textContent ?? '';
    expect(text).not.toContain('请用桌面端');
    expect(document.querySelector('[data-section="gateway"] [data-gateway-credential-form]')).not.toBeNull();
    stop();
  });
});
