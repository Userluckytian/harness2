// @vitest-environment jsdom
// Z-46 空态窗控：桌面壳层常驻 overlay（AppFrame 顶层），空态（selectedId=null）也可见，
// 且**单实例**——选中会话后屏上仍恰有一套窗控（会话列头内嵌那组已删除）。
// 判据平台门 win/linux + 通道门（缺 windowMinimize 不摆假按钮）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type { ConnectionStatus, Harness2Api, StatusDetail, WsFrame } from '../src/shared/protocol.js';

/* —— App 装配所需的完整假桥（与 app.test.tsx 同族，最小可启动面） —— */

function makeFakeApi(platform: 'win32' | 'linux' | 'darwin', withWindowChannels: boolean): Harness2Api {
  const base: Record<string, unknown> = {
    platform,
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 3 },
    ]),
    createSession: vi.fn(async () => ({ id: 's2' })),
    events: vi.fn(async () => ({
      id: 's1',
      dir: 'd',
      header: { sessionId: 's1' },
      events: [],
      warnings: [],
      lastSeq: 0,
    })),
    undo: vi.fn(async () => ({ results: [] })),
    redo: vi.fn(async () => ({ results: [] })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    loadLayout: vi.fn(async () => undefined),
    saveLayout: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ status: 'connected' as ConnectionStatus })),
    settingsGetConfig: vi.fn(async () => ({
      providers: {},
      roles: {},
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
    settingsGetPreferences: vi.fn(async () => ({
      theme: 'system',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    })),
    settingsSetPreferences: vi.fn(async (p: unknown) => p),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '', global: '' } })),
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
    listDir: vi.fn(async () => ({ ok: true as const, path: '', entries: [], truncated: false })),
    runConfig: vi.fn(async () => ({ redacted: true }) as never),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({ readOnly: true }) as never),
    fork: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ probedAt: '', entries: [] })),
    setBusy: vi.fn(async () => undefined),
    setTitleBarTheme: vi.fn(async () => undefined),
    onStopAll: vi.fn(() => () => {}),
    notify: vi.fn(async () => undefined),
    metadataGet: vi.fn(async () => ({})),
    metadataSet: vi.fn(async (id: string) => ({ [id]: {} })),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    onEvent: vi.fn((_cb: (f: WsFrame) => void) => () => {}),
    onConnectionStatus: vi.fn((_cb: (s: ConnectionStatus, d?: StatusDetail) => void) => () => {}),
  };
  if (withWindowChannels) {
    base['windowMinimize'] = vi.fn(async () => undefined);
    base['windowToggleMaximize'] = vi.fn(async () => undefined);
    base['windowClose'] = vi.fn(async () => undefined);
    base['windowGetState'] = vi.fn(async () => ({ maximized: false }));
    base['onWindowState'] = vi.fn(() => () => {});
  }
  return base as unknown as Harness2Api;
}

async function bootApp(api: Harness2Api): Promise<{ App: () => React.ReactNode }> {
  vi.resetModules();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  return import('../src/renderer/App.js') as unknown as Promise<{ App: () => React.ReactNode }>;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { harness2?: unknown }).harness2;
});

describe('Z-46 空态窗控 overlay（壳层常驻，单实例）', () => {
  it('win32 冷启动（selectedId=null 空态）：DOM 含 window-controls 且三键可点回传 IPC', async () => {
    const api = makeFakeApi('win32', true);
    const { App } = await bootApp(api);
    render(<App />);
    // 空态文案在场（无会话）
    expect(await screen.findByText(/选择左侧会话开始对话/)).toBeTruthy();
    const controls = await screen.findByTestId('window-controls');
    fireEvent.click(within3(controls, '最小化'));
    fireEvent.click(within3(controls, '最大化'));
    fireEvent.click(within3(controls, '关闭'));
    await waitFor(() => expect(api.windowMinimize).toHaveBeenCalledTimes(1));
    expect(api.windowToggleMaximize).toHaveBeenCalledTimes(1);
    expect(api.windowClose).toHaveBeenCalledTimes(1);
  });

  it('win32 选中会话后：屏上仍恰有一套窗控（列头内嵌组已删除，单实例保证）', async () => {
    const api = makeFakeApi('win32', true);
    const { App } = await bootApp(api);
    render(<App />);
    const row = await screen.findByRole('button', { name: /第一句/ });
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith('s1'));
    expect(document.querySelectorAll('[data-testid="window-controls"]')).toHaveLength(1);
    expect(document.querySelector('.pane-header .window-controls')).toBeNull();
  });

  it('linux 同样常驻；darwin 完全不渲染（系统红绿灯）', async () => {
    const linuxApi = makeFakeApi('linux', true);
    const { App: LinuxApp } = await bootApp(linuxApi);
    const linuxRender = render(<LinuxApp />);
    expect(await screen.findByTestId('window-controls')).toBeTruthy();
    linuxRender.unmount();

    const macApi = makeFakeApi('darwin', true);
    const { App: MacApp } = await bootApp(macApi);
    const macRender = render(<MacApp />);
    await screen.findByText(/选择左侧会话开始对话/);
    expect(document.querySelectorAll('[data-testid="window-controls"]')).toHaveLength(0);
    macRender.unmount();
  });

  it('win32 但主进程无窗控通道：不摆假按钮（如实降级；overlay 与旧内嵌同一判据）', async () => {
    const api = makeFakeApi('win32', false);
    const { App } = await bootApp(api);
    render(<App />);
    await screen.findByText(/选择左侧会话开始对话/);
    expect(document.querySelectorAll('[data-testid="window-controls"]')).toHaveLength(0);
  });

  it('overlay 挂载时窗口根带 window-controls-active（CSS 让位判据）', async () => {
    const api = makeFakeApi('win32', true);
    const { App } = await bootApp(api);
    const { container } = render(<App />);
    await screen.findByTestId('window-controls');
    expect(container.querySelector('.desktop-window-frame')?.className).toContain('window-controls-active');
  });

  it('ErrorBoundary fallback（Z-46：启动壳也可见）：渲染出错后窗控仍在场', async () => {
    const api = makeFakeApi('win32', true);
    vi.resetModules();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    const { ErrorBoundary } = await import('../src/renderer/ErrorBoundary.js');
    function Boom(): React.ReactNode {
      throw new Error('测试崩溃');
    }
    // 子树抛错被边界接住（console.error 噪音静音）
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(await screen.findByText('界面渲染出错')).toBeTruthy();
    expect(await screen.findByTestId('window-controls')).toBeTruthy();
    spy.mockRestore();
  });
});

function within3(scope: HTMLElement, name: string): HTMLElement {
  const btn = [...scope.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name);
  if (!btn) throw new Error(`窗控内找不到按钮：${name}`);
  return btn;
}
