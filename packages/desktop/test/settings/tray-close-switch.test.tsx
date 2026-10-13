// @vitest-environment jsdom
// Z-47 设置页「关闭窗口时隐藏到托盘」开关（T3 渲染侧）：
//   - 初值来自 tray:status（closeToTray 有效值，含平台默认归一）；
//   - 切换 → tray:setCloseToTray 被调用（写后响应整像刷新开关，不闪回）；
//   - created=false（托盘创建失败）→ 开关禁用 + 可行动说明；
//   - 缺托盘通道（旧夹具/web 形态）→ 开关**不渲染**（不摆假开关，红线⑩）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api, SettingsPreferencesShape, TrayStatusShape } from '../../src/shared/protocol.js';
import { SettingsPage } from '../../src/renderer/components/SettingsPage.js';

const PREFS: SettingsPreferencesShape = {
  theme: 'system',
  defaultPaneCount: 1,
  showWelcome: true,
  notifyDetails: 'minimal',
};

function statusOf(over: Partial<TrayStatusShape> = {}): TrayStatusShape {
  return { created: true, platform: 'win32', closeToTray: true, ...over };
}

function makeApi(
  tray: { status?: () => Promise<TrayStatusShape>; set?: (v: boolean) => Promise<TrayStatusShape> } = {},
) {
  const api = {
    settingsGetPreferences: vi.fn(async () => PREFS),
    settingsSetPreferences: vi.fn(async (p: unknown) => p as SettingsPreferencesShape),
    settingsGetConfig: vi.fn(async () => ({
      providers: {},
      roles: {},
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 1, maxConcurrent: 1 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 1 },
      sources: { global: true, project: false },
      warnings: [],
      errors: [],
    })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 })),
    settingsGetCrashReports: vi.fn(async () => []),
    settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '', global: '' } })),
    ...(tray.status !== undefined ? { trayStatus: tray.status } : {}),
    ...(tray.set !== undefined ? { traySetCloseToTray: tray.set } : {}),
  };
  return api as unknown as Harness2Api;
}

beforeEach(() => {
  cleanup();
  (window as unknown as { harness2?: unknown }).harness2 = undefined;
});

afterEach(() => cleanup());

function switchInput(): HTMLButtonElement {
  return screen.getByRole('switch', { name: '关闭窗口时隐藏到托盘' }) as HTMLButtonElement;
}

describe('设置页：关窗驻留托盘开关（Z-47）', () => {
  it('通道就绪：初值 = tray:status.closeToTray（true）；切换 → setCloseToTray(false) 且以响应刷新', async () => {
    const status = vi.fn(async () => statusOf({ closeToTray: true }));
    const set = vi.fn(async (v: boolean) => statusOf({ closeToTray: v }));
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi({ status, set });
    render(<SettingsPage open onClose={() => {}} onThemeChange={() => {}} />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    // 初值 on（aria-checked=true）
    expect(await screen.findByRole('switch', { name: '关闭窗口时隐藏到托盘' })).toBeTruthy();
    expect(switchInput().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(switchInput());
    await waitFor(() => expect(set).toHaveBeenCalledWith(false));
    // 响应整像刷新：不闪回（checked=false）
    await waitFor(() => expect(switchInput().getAttribute('aria-checked')).toBe('false'));
  });

  it('托盘创建失败（created=false）→ 开关禁用 + 可行动说明在场', async () => {
    const status = vi.fn(async () => statusOf({ created: false, closeToTray: false }));
    const set = vi.fn(async (v: boolean) => statusOf({ closeToTray: v }));
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi({ status, set });
    render(<SettingsPage open onClose={() => {}} onThemeChange={() => {}} />);
    const sw = await screen.findByRole('switch', { name: '关闭窗口时隐藏到托盘' });
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(await screen.findByTestId('tray-unavailable-note')).toBeTruthy();
    fireEvent.click(sw); // 禁用钮点击不应触发写
    expect(set).not.toHaveBeenCalled();
  });

  it('缺托盘通道（旧夹具）→ 开关整块不渲染（不摆假开关）', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = makeApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={() => {}} />);
    await screen.findByRole('button', { name: '完整（含回复摘要）' }); // 常规分区已渲染
    expect(screen.queryByRole('switch', { name: '关闭窗口时隐藏到托盘' })).toBeNull();
  });
});
