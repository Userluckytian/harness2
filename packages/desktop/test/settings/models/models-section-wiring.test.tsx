// @vitest-environment jsdom
// P6 接线棒：模型配置页**真的装配进设置壳**（D-50～D-59 的最后一公里）。
// A/B 两棒只写了模块（`registerModelsSettingsSection` 无调用方、SettingsDialog 里是过渡面板），
// 本文件证明应用入口的那次注册生效：设置弹窗的「模型配置」分区渲染真页面，过渡面板让位。
// 通道面 = 真主进程函数 + 临时 home/root（同 models-page.test.tsx 手法），不手改文件。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Harness2Api, ModelsSettingsApi, SettingsPreferencesShape } from '../../../src/shared/protocol.js';
import {
  ackModelsDeclaration,
  readCredentialStatuses,
  readModelsDocument,
  updateModelsProvider,
  writeChannelKey,
} from '../../../src/main/models-config.js';
import { setShellTheme, shellThemeStore } from '../../../src/renderer/layout/shell-theme.js';
import { SettingsDialog } from '../../../src/renderer/components/SettingsDialog.js';
import {
  MODELS_SECTION_ID,
  findSettingsSection,
  resetSettingsSections,
} from '../../../src/renderer/settings/shell/index.js';
import { registerModelsSettingsSection } from '../../../src/renderer/settings/models/index.js';

const PREFS: SettingsPreferencesShape = {
  theme: 'warmPaper',
  defaultPaneCount: 1,
  showWelcome: true,
  notifyDetails: 'minimal',
};

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  cleanup();
  resetSettingsSections();
  shellThemeStore.reset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => cleanup());

describe('D-50～D-59：模型配置页装配进设置壳（真注册，不是过渡面板）', () => {
  it('注册后 /models 分区归 ui-settings-models 拥有，点击导航渲染真页面', async () => {
    const home = tmp('h2-wire-home-');
    const root = tmp('h2-wire-root-');
    const dispose = registerModelsSettingsSection();
    expect(findSettingsSection(MODELS_SECTION_ID)?.owner).toBe('ui-settings-models');

    const models: Partial<ModelsSettingsApi> = {
      settingsGetModels: () => Promise.resolve(readModelsDocument(home, root)),
      settingsUpdateModels: (opts) => Promise.resolve(updateModelsProvider(home, root, opts)),
      settingsDeleteProvider: () => Promise.resolve({ ok: false }),
      settingsWriteChannelKey: (route, key) => Promise.resolve(writeChannelKey(home, root, route, key)),
      settingsGetCredentialStatus: (routes) => Promise.resolve(readCredentialStatuses(home, root, routes)),
      settingsAckModelsDeclaration: (version) => Promise.resolve(ackModelsDeclaration(home, version)),
      settingsDiscoverModels: () => Promise.resolve({ ok: false, error: '未接网络' }),
      onSettingsEvent: () => () => {},
    };
    const api = {
      ...models,
      settingsGetPreferences: async () => PREFS,
      settingsSetPreferences: async (p: unknown) => p as SettingsPreferencesShape,
      settingsGetConfig: async () => ({
        providers: {},
        roles: {},
        approval: { mode: 'default', tools: {} },
        memory: { mode: 'off', nudgeInterval: 10 },
        browser: { enabled: true, idleDestroyMs: 1, maxConcurrent: 1 },
        plugins: { enabled: true, allow: [] },
        mcpServers: {},
        subagent: { maxDepth: 1, maxTurns: 1 },
        sources: { global: false, project: false },
        warnings: [],
        errors: [],
      }),
      settingsGetAuthMasked: async () => ({ channels: [], gateways: [] }),
      settingsUpdateConfig: async () => ({ ok: true }),
      settingsUpdateAuth: async () => ({ ok: true }),
      settingsGetDoctorReport: async () => ({ checks: [], exitCode: 0 as const }),
      settingsGetCrashReports: async () => [],
    } as unknown as Harness2Api;
    (window as unknown as { harness2: Harness2Api }).harness2 = api;

    render(<SettingsDialog open onClose={() => {}} onThemeChange={setShellTheme} />);
    fireEvent.click(await screen.findByText('模型配置'));

    // 真页面：标题 + 首运行声明 + 「新增提供方」入口；过渡面板与「待接入」占位都不在
    expect(await screen.findByRole('button', { name: '新增提供方' })).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: '模型配置声明' })).toBeTruthy();
    expect(screen.queryByText(/模型配置页待接入/)).toBeNull();
    expect(screen.queryByRole('button', { name: '保存主模型' })).toBeNull();

    dispose();
    expect(findSettingsSection(MODELS_SECTION_ID)).toBeUndefined();
  });
});
