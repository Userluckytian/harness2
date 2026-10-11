// 设置页（设置壳组合根）测试（Z5；原 P6-C 弹窗测试的全屏页等价物）：
//   ① 分区清单 = 配置表（page-config）装配：常规 / 外观 / 模型配置 + 既有分区，分组导航（Z-89）；
//   ② 外观分区的主题**真生效**（走 P4 主题呈现器/store：D-15 四要素）并持久化偏好（全量写回）；
//   ③ 界面字号提交 → 写根 --ui-font-size + localStorage 镜像（D-14 例外 #2）；
//   ④ 模型配置分区：B 棒 `ModelsSettings` 未注册 → 显式占位 + 过渡面板（不造假实现）；
//      注册（接管）→ 渲染 B 组件并收到 props 契约（active/config/onSaveConfig）。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api, SettingsPreferencesShape } from '../../src/shared/protocol.js';
import { setShellTheme, shellThemeStore } from '../../src/renderer/layout/shell-theme.js';
import { SettingsPage } from '../../src/renderer/components/SettingsPage.js';
import {
  MODELS_SECTION_ID,
  registerSettingsSection,
  resetSettingsSections,
} from '@harness2/ui-shared/renderer/settings/shell/index.js';
import { UI_FONT_SIZE_STORAGE_KEY } from '../../src/renderer/ui-font-size.js';

// Radix Select 在 jsdom 下的两个已知前提：滚动定位 API 缺失（高亮时调用）、Item 非触摸 click 即提交
(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const PREFS: SettingsPreferencesShape = {
  theme: 'system',
  defaultPaneCount: 1,
  showWelcome: true,
  notifyDetails: 'minimal',
};

function makeApi(over: Partial<Harness2Api> = {}): Harness2Api & { settingsSetPreferences: ReturnType<typeof vi.fn> } {
  const api = {
    settingsGetPreferences: vi.fn(async () => PREFS),
    settingsSetPreferences: vi.fn(async (p: unknown) => p as SettingsPreferencesShape),
    settingsGetConfig: vi.fn(async () => ({
      providers: { 'local-oai': { protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1' } },
      roles: { main: { channel: 'local-oai', model: 'm1' } },
      approval: { mode: 'default', tools: {} },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: ['p'] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 25 },
      sources: { global: true, project: false },
      warnings: [],
      errors: [],
    })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    ...over,
  } as unknown as Harness2Api & { settingsSetPreferences: ReturnType<typeof vi.fn> };
  return api;
}

function clearThemeArtifacts(): void {
  document.documentElement.style.cssText = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('theme-zai-light', 'theme-zai-dark', 'dark');
  document.body.removeAttribute('data-ds-dark-theme');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
}

beforeEach(() => {
  cleanup();
  resetSettingsSections();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetSettingsSections();
  clearThemeArtifacts();
  shellThemeStore.reset();
  window.localStorage.clear();
});

/** Radix Select（jsdom）：先切到外观分区 → 触发器 Enter 打开 → 目标 option click 提交（非 touch 即选中） */
async function chooseTheme(label: string): Promise<void> {
  fireEvent.click(await screen.findByText('外观'));
  const trigger = await screen.findByRole('combobox', { name: '界面主题' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: label }));
}

describe('设置页：分区壳（Z-88/Z-89）', () => {
  it('分组导航 = 配置表装配（basics 在前），默认打开「常规」（只挂载当前分区）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);

    expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy();
    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs.slice(0, 3)).toEqual(['general', 'appearance', MODELS_SECTION_ID]);
    expect(navs).toContain('approval');
    expect(navs).toContain('diagnostics');
    // 组标题（Z-89 三组）与组内首分区
    const groupIds = [...document.querySelectorAll('[data-settings-nav-group]')].map((n) =>
      n.getAttribute('data-settings-nav-group'),
    );
    expect(groupIds).toEqual(['basics', 'agentCapabilities', 'dataAndStats']);
    // 默认分区 = general（组内 order 0）
    await waitFor(() => expect(document.querySelector('[data-section]')?.getAttribute('data-section')).toBe('general'));
    // 外观分区的主题控件存在（Z-90：主题迁到外观，Select 形态）
    fireEvent.click(document.querySelector('[data-section-nav="appearance"]') as HTMLElement);
    expect(await screen.findByRole('combobox', { name: '界面主题' })).toBeTruthy();
  });

  it('切到「网关 / IM」分区：只渲染网关正文（旧分区卸载）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);
    await waitFor(() => expect(document.querySelector('[data-section-nav="gateway"]')).not.toBeNull());

    fireEvent.click(document.querySelector('[data-section-nav="gateway"]') as HTMLElement);
    expect((await screen.findAllByText(/IM 网关/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('combobox', { name: '界面主题' })).toBeNull();
  });

  it('返回按钮（返回工作区）= 关 overlay', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    const onClose = vi.fn();
    render(<SettingsPage open onClose={onClose} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByRole('button', { name: '返回工作区' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('设置页：外观分区的主题真生效（D-15 四要素，Z-90 Select）', () => {
  it('选「深色」→ 壳主题呈现器写全四处，且偏好全量写回（不丢其它字段）', async () => {
    const api = makeApi();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);

    await chooseTheme('深色');

    // ① 即时呈现：一次写四处（html color-scheme / body 深色属性 / 正文字号变量 / meta theme-color）
    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('dark'));
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--dsh-content-font-size')).toBe('14px');
    expect(document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#161616');
    expect(document.documentElement.getAttribute('data-theme')).toBe('zai-dark'); // 根契约：class + data-theme 同源
    expect(document.documentElement.classList.contains('theme-zai-dark')).toBe(true);

    // ② 持久化：全量偏好写回（theme 改、其余字段原样）
    await waitFor(() => expect(api.settingsSetPreferences).toHaveBeenCalledWith({ ...PREFS, theme: 'zai-dark' }));
    // ③ 受控回显：宿主 store 变了 → Select 显示跟随
    await waitFor(() => expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toContain('深色'));
  });

  it('偏好保存失败：如实显示失败原因（主题仍已即时生效，不假装没发生）', async () => {
    const api = makeApi({
      settingsSetPreferences: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    } as unknown as Partial<Harness2Api>);
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);
    await chooseTheme('深色');

    expect(await screen.findByText(/偏好保存失败：EACCES/)).toBeTruthy();
    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('dark'));
  }, 20_000);
});

describe('设置页：外观分区的界面字号（Z-90 / 例外 #2）', () => {
  it('提交字号 → 写根 --ui-font-size + localStorage 镜像（harness2-font-size）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByText('外观'));
    const field = await screen.findByRole('spinbutton', { name: '界面字号' });
    fireEvent.change(field, { target: { value: '16' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('16px'));
    expect(window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY)).toBe('16');
  });

  it('字号越界提交被钳制（99 → 20），不写越界值', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByText('外观'));
    const field = await screen.findByRole('spinbutton', { name: '界面字号' });
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.focusOut(field);

    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('20px'));
    expect(window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY)).toBe('20');
  });
});

describe('设置页：模型配置分区（B 棒接入状态）', () => {
  it('B 组件未注册 → 显式占位 + 过渡面板（不造假实现）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByText('模型配置'));

    expect(await screen.findByText(/模型配置页待接入（B 棒 ui-settings-models）/)).toBeTruthy();
    // 过渡面板保留既有真实能力（主模型改写）
    expect(screen.getByRole('button', { name: '保存主模型' })).toBeTruthy();
  });

  it('B 组件注册（接管）→ 渲染 B 组件，占位与过渡面板让位；props 契约生效', async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerSettingsSection({
      id: MODELS_SECTION_ID,
      label: '模型配置',
      en: 'Models',
      owner: 'ui-settings-models',
      order: 10,
      component: (props) => {
        seen.push(props as unknown as Record<string, unknown>);
        return <div data-testid="models-settings-b">B 的 ModelsSettings</div>;
      },
    });
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByText('模型配置'));

    expect(await screen.findByTestId('models-settings-b')).toBeTruthy();
    expect(screen.queryByText(/模型配置页待接入/)).toBeNull();
    expect(screen.queryByRole('button', { name: '保存主模型' })).toBeNull();
    // props 契约：active=true + 宿主注入的 config / onSaveConfig
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]?.['active']).toBe(true);
    expect(seen[0]?.['config']).toBeDefined();
    expect(typeof seen[0]?.['onSaveConfig']).toBe('function');
  });
});
