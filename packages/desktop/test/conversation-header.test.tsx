// B4 对话头组件测试：纯函数（水条百分比/类名/分支简称/模型简称）+ 组件渲染逻辑。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  ConversationHeader,
  usageBarPercent,
  usageBarClass,
  shortBranch,
  shortModel,
} from '../src/renderer/components/ConversationHeader.js';
import type { Harness2Api, SettingsPreferencesShape, WsFrame } from '../src/shared/protocol.js';

/* —— 纯函数 —— */

describe('usageBarPercent', () => {
  it('null → 0', () => expect(usageBarPercent(null)).toBe(0));
  it('负值 → 0', () => expect(usageBarPercent(-0.1)).toBe(0));
  it('0 → 0', () => expect(usageBarPercent(0)).toBe(0));
  it('0.45 → 45', () => expect(usageBarPercent(0.45)).toBe(45));
  it('1 → 100', () => expect(usageBarPercent(1)).toBe(100));
  it('> 1 → 100（上限）', () => expect(usageBarPercent(1.5)).toBe(100));
});

describe('usageBarClass', () => {
  it('null → ok', () => expect(usageBarClass(null)).toContain('ctx-ok'));
  it('0.3 → ok', () => expect(usageBarClass(0.3)).toContain('ctx-ok'));
  it('0.69 → ok', () => expect(usageBarClass(0.69)).toContain('ctx-ok'));
  it('0.7 → warn', () => expect(usageBarClass(0.7)).toContain('ctx-warn'));
  it('0.99 → warn', () => expect(usageBarClass(0.99)).toContain('ctx-warn'));
});

describe('shortBranch', () => {
  it('main → main', () => expect(shortBranch('main')).toBe('main'));
  it('heads/main → main', () => expect(shortBranch('heads/main')).toBe('main'));
  it('heads/feat/x → feat/x', () => expect(shortBranch('heads/feat/x')).toBe('feat/x'));
});

describe('shortModel', () => {
  it('anthropic/claude-sonnet → claude-sonnet', () => expect(shortModel('anthropic/claude-sonnet')).toBe('claude-sonnet'));
  it('gpt-4o → gpt-4o（无 / 不截断）', () => expect(shortModel('gpt-4o')).toBe('gpt-4o'));
  it('provider/sub/model → model', () => expect(shortModel('provider/sub/model')).toBe('model'));
});

/* —— 组件渲染 —— */

function makeFakeApi(): Harness2Api {
  return {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: 's2' })),
    events: vi.fn(async () => ({ id: 's1', dir: '', header: null, events: [], warnings: [], lastSeq: 0 })),
    undo: vi.fn(async () => ({ results: [] })),
    redo: vi.fn(async () => ({ results: [] })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    loadLayout: vi.fn(async () => undefined),
    saveLayout: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ status: 'connected' as const })),
    settingsGetConfig: vi.fn(async () => ({
      providers: {},
      roles: { main: { channel: 'anthropic', model: 'anthropic/claude-sonnet' } },
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 25 },
      sources: { global: true, project: false },
      warnings: [],
      errors: [],
    })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetPreferences: vi.fn(async () => ({ theme: 'warmPaper' } as SettingsPreferencesShape)),
    settingsSetPreferences: vi.fn(async (p: unknown) => p as SettingsPreferencesShape),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    gitBranch: vi.fn(async () => 'heads/feat/desktop-settings'),
    getContextUsage: vi.fn(async () => ({ usage: 0.45, label: '45%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
    notify: vi.fn(async () => undefined),
    metadataGet: vi.fn(async () => ({})),
    metadataSet: vi.fn(async (id: string) => ({ [id]: {} })),
    onEvent: vi.fn((_cb: (f: WsFrame) => void) => () => {}),
    onConnectionStatus: vi.fn((_cb: (s: string, d?: unknown) => void) => () => {}),
  };
}

describe('ConversationHeader 组件', () => {
  beforeEach(() => {
    cleanup();
  });

  it('渲染 cwd / 分支 / 模型 / 上下文标签', async () => {
    const api = makeFakeApi();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<ConversationHeader sessionId="s1" cwd="D:/Projects/my-app" />);

    // cwd 显示
    expect(await screen.findByText('D:/Projects/my-app')).toBeTruthy();
    // 分支（去掉 heads/ 前缀）
    expect(await screen.findByText('feat/desktop-settings')).toBeTruthy();
    // 模型（取最后一段）
    expect(await screen.findByText('claude-sonnet')).toBeTruthy();
    // 上下文标签
    expect(await screen.findByText('45%')).toBeTruthy();
  });

  it('cwd 为 undefined 时显示 (无 cwd) 且不请求 gitBranch', async () => {
    const api = makeFakeApi();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<ConversationHeader sessionId="s1" />);

    expect(await screen.findByText('(无 cwd)')).toBeTruthy();
    // cwd 为空时不应调用 gitBranch
    await waitFor(() => expect(api.gitBranch).not.toHaveBeenCalled());
  });

  it('gitBranch 返回 null 时不显示分支信息', async () => {
    const api = makeFakeApi();
    api.gitBranch = vi.fn(async () => null);
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<ConversationHeader sessionId="s1" cwd="/tmp" />);

    // cwd 正常显示
    expect(await screen.findByText('/tmp')).toBeTruthy();
    // gitBranch 返回 null → 不渲染分支
    await waitFor(() => {
      expect(screen.queryByText(/feat\/desktop-settings/)).toBeNull();
    });
  });

  it('水条宽度与 usage 匹配', async () => {
    const api = makeFakeApi();
    api.getContextUsage = vi.fn(async () => ({ usage: 0.8, label: '80%' }));
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<ConversationHeader sessionId="s1" cwd="/tmp" />);

    const fill = await screen.findByText('80%').then(() =>
      document.querySelector('.ctx-bar-fill'),
    );
    expect(fill).toBeTruthy();
    expect((fill as HTMLElement).style.width).toBe('80%');
    // usage >= 0.7 → warn class
    expect(fill!.className).toContain('ctx-warn');
  });

  it('usage = null 时水条为 0% 且显示 —', async () => {
    const api = makeFakeApi();
    api.getContextUsage = vi.fn(async () => ({ usage: null, label: '—' }));
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    render(<ConversationHeader sessionId="s1" cwd="/tmp" />);

    expect(await screen.findByText('—')).toBeTruthy();
    const fill = document.querySelector('.ctx-bar-fill');
    expect(fill).toBeTruthy();
    expect((fill as HTMLElement).style.width).toBe('0%');
  });
});
