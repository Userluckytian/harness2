// A09 钩子分区测试（Z6 批次5）：
//   只读展示 config.hooks（事件/命令/matcher/超时/状态）、空态（无配置不摆假条目）、
//   describeHookEntry、经设置页导航可达。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Harness2Api, SettingsConfigShape } from '../../src/shared/protocol.js';
import { HooksSection, describeHookEntry } from '@harness2/ui-shared/renderer/settings/hooks/HooksSection.js';
import { SettingsPage } from '../../src/renderer/components/SettingsPage.js';

const CFG: SettingsConfigShape = {
  providers: {},
  roles: { main: { channel: 'ch', model: 'm' } },
  approval: { mode: 'default' },
  memory: { mode: 'off', nudgeInterval: 10 },
  browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
  plugins: { enabled: true, allow: [] },
  mcpServers: {},
  subagent: { maxDepth: 1, maxTurns: 25 },
  hooks: {
    enabled: true,
    timeoutMs: 30_000,
    maxOutputBytes: 32_768,
    entries: [
      { event: 'preTool', matcher: 'bash', command: 'guard.sh', timeoutMs: 1000 },
      { event: 'postTool', command: 'fmt.sh', enabled: false },
    ],
  },
  sources: { global: true, project: false },
  warnings: [],
  errors: [],
};

function pageApi(over: Partial<Harness2Api> = {}): Harness2Api {
  return {
    settingsGetConfig: vi.fn(async () => CFG),
    settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '/r', global: '/h' } })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsGetPreferences: vi.fn(async () => ({
      theme: 'system',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    })),
    settingsSetPreferences: vi.fn(async (p: unknown) => p),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    ...over,
  } as unknown as Harness2Api;
}

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

describe('A09 钩子分区（只读）', () => {
  it('配置存在 → 概览 + 逐条展示（事件/触发时机/命令/状态）；无编辑控件', () => {
    render(<HooksSection cfg={CFG} />);
    expect(document.querySelector('[data-hooks-list]')).not.toBeNull();
    expect(screen.getByText('preTool')).toBeTruthy();
    expect(screen.getByText('匹配 bash · guard.sh')).toBeTruthy();
    expect(screen.getByText('postTool')).toBeTruthy();
    expect(screen.getByText('fmt.sh')).toBeTruthy();
    // 停用条目如实标注；无勾选框/输入框（只读）
    expect(screen.getByText('停用')).toBeTruthy();
    expect(document.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('未配置 hooks → 空态指引（不摆假条目）', () => {
    render(<HooksSection cfg={{ ...CFG, hooks: undefined }} />);
    expect(screen.getByText(/未配置钩子。在 ~\/.harness2\/config.json/)).toBeTruthy();
    expect(document.querySelector('[data-hooks-list]')).toBeNull();
    expect(document.querySelectorAll('[data-hook-row]')).toHaveLength(0);
  });

  it('已配置但零条目 → 明示「未配置钩子条目」', () => {
    render(
      <HooksSection
        cfg={{ ...CFG, hooks: { enabled: false, timeoutMs: 30_000, maxOutputBytes: 32_768, entries: [] } }}
      />,
    );
    expect(screen.getByText('未配置钩子条目')).toBeTruthy();
    expect(screen.getByText(/否（hooks.enabled=false）/)).toBeTruthy();
  });

  it('describeHookEntry：有/无 matcher 两形态', () => {
    expect(describeHookEntry({ event: 'preTool', matcher: 'bash', command: 'a.sh' })).toBe('匹配 bash · a.sh');
    expect(describeHookEntry({ event: 'turnEnd', command: 'b.sh' })).toBe('b.sh');
  });
});

describe('设置页集成：钩子分区经导航可达', () => {
  it('导航含 hooks 分区；点击渲染 HooksSection 正文', async () => {
    (window as unknown as { harness2: Harness2Api }).harness2 = pageApi();
    render(<SettingsPage open onClose={() => {}} onThemeChange={() => {}} />);

    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs).toContain('hooks');

    fireEvent.click(document.querySelector('[data-section-nav="hooks"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-hooks-list]')).not.toBeNull());
    expect(screen.getByText('匹配 bash · guard.sh')).toBeTruthy();
  });
});
