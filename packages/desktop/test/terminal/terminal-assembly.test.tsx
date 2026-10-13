// Z9-5：桌面终端装配级测试（席位条目 + Ctrl+J 开合 + 命令面板「切换终端」转真 + port.available 两态）。
//
// jsdom 夹具无 preload 终端通道 → 渲染级用例走 **available=false** 的如实降级路径（不创建 xterm，
// 面板显示「终端不可用」，红线⑩）；`createDesktopTerminalPort()` 的两态在端口层单独断言。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import type {
  ConnectionStatus,
  Harness2Api,
  SessionEventsPayloadShape,
  SettingsPreferencesShape,
  StatusDetail,
  WsFrame,
} from '../../src/shared/protocol.js';

function makeFakeApi(): Harness2Api {
  const eventListeners: Array<(f: WsFrame) => void> = [];
  const replay: SessionEventsPayloadShape = {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1' },
    events: [],
    warnings: [],
    lastSeq: 0,
  };
  return {
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 3 },
    ]),
    createSession: vi.fn(async () => ({ id: 's2' })),
    events: vi.fn(async (id: string) => (id === 's1' ? replay : { ...replay, id, lastSeq: 0 })),
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
    settingsGetConfig: vi.fn(async () => ({ warnings: [], errors: [] }) as never),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetPreferences: vi.fn(
      async () =>
        ({
          theme: 'system',
          defaultPaneCount: 1,
          showWelcome: true,
          notifyDetails: 'minimal',
        }) as SettingsPreferencesShape,
    ),
    settingsSetPreferences: vi.fn(async (p: unknown) => p as SettingsPreferencesShape),
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
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    metadataSet: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ [id]: patch })),
    onEvent: vi.fn((cb: (f: WsFrame) => void) => {
      eventListeners.push(cb);
      return () => {};
    }),
    onConnectionStatus: vi.fn((cb: (s: ConnectionStatus, d?: StatusDetail) => void) => {
      queueMicrotask(() => cb('connected'));
      return () => {};
    }),
  };
}

/** 每次用例前装假宿主（无终端通道 → 端口 available=false，如实降级） */
function installFakeHost(): void {
  (window as unknown as { harness2: Harness2Api }).harness2 = makeFakeApi();
}

async function bootApp(): Promise<void> {
  vi.resetModules();
  installFakeHost();
  const App = (await import('../../src/renderer/App')) as unknown as { App: () => React.ReactNode };
  render(<App.App />);
  await screen.findByRole('button', { name: /第一句/ });
}

const terminalToggle = (): HTMLElement => screen.getByTestId('terminal-toggle');
const terminalPanel = (): HTMLElement => document.querySelector('[data-panel="terminal"]') as HTMLElement;

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { harness2?: Harness2Api }).harness2;
});

describe('Z9-5 桌面终端席位装配', () => {
  it('席位条目存在：中栏出现 terminal 面板与开关（注册缝被注入）', async () => {
    await bootApp();
    expect(terminalPanel()).not.toBeNull();
    expect(terminalToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('无终端 IPC 通道 → 面板如实不可用（available=false，不摆假终端）', async () => {
    await bootApp();
    // 展开后可见如实不可用占位（红线⑩），而非 xterm
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(screen.getByTestId('terminal-panel').getAttribute('data-terminal-available')).toBe('false');
    expect(screen.getByTestId('terminal-unavailable')).toBeTruthy();
  });

  it('Ctrl+J 展开 → 再按收起（aria-pressed / data-open 同步；同款动作）', async () => {
    await bootApp();
    expect(terminalPanel().getAttribute('data-open')).toBe('false');
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(terminalToggle().getAttribute('aria-pressed')).toBe('true');
    expect(terminalPanel().getAttribute('data-open')).toBe('true');
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(terminalToggle().getAttribute('aria-pressed')).toBe('false');
    expect(terminalPanel().getAttribute('data-open')).toBe('false');
  });

  it('命令面板「切换终端」非占位（未 disabled）；执行后切换终端面板', async () => {
    await bootApp();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('搜索操作、任务或文件');
    fireEvent.change(input, { target: { value: '切换终端' } });
    const option = screen.getByText('切换终端').closest('[role="option"]');
    expect(option?.getAttribute('aria-disabled')).not.toBe('true');
    expect(option?.hasAttribute('data-placeholder')).toBe(false);
    expect(terminalPanel().getAttribute('data-open')).toBe('false');
    fireEvent.keyDown(input, { key: 'Enter' });
    // 执行后：面板展开（与 Ctrl+J 同源动作）
    expect(terminalPanel().getAttribute('data-open')).toBe('true');
  });

  it('「添加终端标签」保留占位（disabled + disabledHint）', async () => {
    await bootApp();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('搜索操作、任务或文件');
    fireEvent.change(input, { target: { value: '添加终端标签' } });
    const option = screen.getByText('添加终端标签').closest('[role="option"]');
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(option?.hasAttribute('data-placeholder')).toBe(true);
  });

  it('port.available 两态：无通道 → false；注入终端 IPC 通道 → true', async () => {
    installFakeHost();
    const { createDesktopTerminalPort } = await import('../../src/renderer/terminal/desktop-port.js');
    expect(createDesktopTerminalPort().available).toBe(false);

    const api = makeFakeApi() as Harness2Api & Record<string, unknown>;
    api.terminalOpen = vi.fn(async () => ({ id: 't-1' }));
    api.terminalWrite = vi.fn(async () => undefined);
    api.terminalResize = vi.fn(async () => undefined);
    api.terminalClose = vi.fn(async () => undefined);
    api.onTerminalEvent = vi.fn(() => () => {});
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    expect(createDesktopTerminalPort().available).toBe(true);
  });
});
