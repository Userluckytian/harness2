// 设置弹窗（设置壳组合根）测试（P6-C）：
//   ① 分区清单 = 通用 / 模型配置 / 凭据 + 既有分区；
//   ② 通用分区的主题**真生效**（走 P4 主题呈现器/store：D-15 四要素）并持久化偏好（全量写回）；
//   ③ 模型配置分区：B 棒 `ModelsSettings` 未注册 → 显式占位 + 过渡面板（不造假实现）；
//      注册（接管）→ 渲染 B 组件并收到 props 契约（active/config/onSaveConfig）。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api, SettingsPreferencesShape } from '../../src/shared/protocol.js';
import { setShellTheme, shellThemeStore } from '../../src/renderer/layout/shell-theme.js';
import { SettingsDialog } from '../../src/renderer/components/SettingsDialog.js';
import {
  MODELS_SECTION_ID,
  registerSettingsSection,
  resetSettingsSections,
} from '../../src/renderer/settings/shell/index.js';

const PREFS: SettingsPreferencesShape = {
  theme: 'warmPaper',
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
  document.body.removeAttribute('data-ds-dark-theme');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
}

beforeEach(() => {
  cleanup();
  resetSettingsSections();
});

afterEach(() => {
  cleanup();
  resetSettingsSections();
  clearThemeArtifacts();
  shellThemeStore.reset();
});

describe('设置弹窗：分区壳', () => {
  it('分区导航含 通用 / 模型配置 / 凭据，默认打开"通用"（只挂载当前分区）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);

    expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy();
    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs.slice(0, 3)).toEqual(['general', MODELS_SECTION_ID, 'credentials']);
    expect(navs).toContain('approval');
    expect(navs).toContain('diagnostics');
    // 默认分区 = general（order 0）
    await waitFor(() => expect(document.querySelector('[data-section]')?.getAttribute('data-section')).toBe('general'));
    // 主题控件在通用分区里（真实可用项）
    expect(screen.getByRole('button', { name: '深色' })).toBeTruthy();
  });

  it('切到"凭据"分区：只渲染凭据正文（旧分区卸载）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);
    await waitFor(() => expect(document.querySelector('[data-section-nav="credentials"]')).not.toBeNull());

    fireEvent.click(document.querySelector('[data-section-nav="credentials"]') as HTMLElement);
    expect(await screen.findByText(/IM 网关凭据/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '深色' })).toBeNull();
  });
});

describe('设置弹窗：通用分区的主题真生效（D-15 四要素）', () => {
  it('点"深色" → 壳主题呈现器写全四处，且偏好全量写回（不丢其它字段）', async () => {
    const api = makeApi();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);
    const dark = await screen.findByRole('button', { name: '深色' });
    await waitFor(() => expect(dark.getAttribute('aria-pressed')).toBe('false'));

    fireEvent.click(dark);

    // ① 即时呈现：一次写四处（html color-scheme / body 深色属性 / 正文字号变量 / meta theme-color）
    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('dark'));
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--dsh-content-font-size')).toBe('14px');
    expect(document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1b1d21');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark'); // 既有变量切换同源

    // ② 持久化：全量偏好写回（theme 改、其余字段原样）
    await waitFor(() => expect(api.settingsSetPreferences).toHaveBeenCalledWith({ ...PREFS, theme: 'dark' }));
    // ③ 受控回显：宿主 store 变了 → 按钮选中态跟随
    await waitFor(() => expect(dark.getAttribute('aria-pressed')).toBe('true'));
  });

  it('偏好保存失败：如实显示失败原因（主题仍已即时生效，不假装没发生）', async () => {
    const api = makeApi({
      settingsSetPreferences: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    } as unknown as Partial<Harness2Api>);
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByRole('button', { name: '深色' }));

    expect(await screen.findByText(/偏好保存失败：EACCES/)).toBeTruthy();
    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('dark'));
  });
});

describe('设置弹窗：模型配置分区（B 棒接入状态）', () => {
  it('B 组件未注册 → 显式占位 + 过渡面板（不造假实现）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);
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
    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);
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
