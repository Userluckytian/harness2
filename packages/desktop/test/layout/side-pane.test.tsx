// @vitest-environment jsdom
// 右栏标签宿主测试（Z2-04 / Z-13 / Z-14）：零 tab 启动器、按需开 tab、关闭回落、
// 审批徽章、D-86 openFile 路由（开「文件」tab + 自动开右栏）、新会话强制收起右栏。
// 装配级用例走 app.test.tsx 同款 bootApp 模式（真 App + fake window.harness2）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type {
  ConnectionStatus,
  Harness2Api,
  SessionEventShape,
  SessionEventsPayloadShape,
  SettingsPreferencesShape,
  StatusDetail,
  WsFrame,
} from '../../src/shared/protocol.js';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): SessionEventShape & { active: boolean } {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-06T00:00:00Z', type, payload, active: true };
}

function makeFakeApi() {
  const eventListeners: Array<(f: WsFrame) => void> = [];
  const replay: SessionEventsPayloadShape = {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1' },
    events: [
      ev('session/header', { sessionId: 's1' }),
      ev('user/message', { text: '第一句', turnId: 't1' }),
      ev('assistant/message', { text: '第一句回复', model: 'mock/m', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 3,
  };
  const api: Harness2Api & { emit: (f: WsFrame) => void } = {
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 3 },
    ]),
    createSession: vi.fn(async () => ({ id: 's2' })),
    events: vi.fn(async (id: string) => (id === 's1' ? replay : { ...replay, id, lastSeq: 0, events: [] })),
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
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: true, content: 'line1\nline2' })),
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
    metadataSet: vi.fn(async (id: string, patch: { title?: string; archived?: boolean; deleted?: boolean }) => {
      const meta: Record<string, { title?: string; archived?: boolean; deleted?: boolean }> = {};
      meta[id] = patch;
      return meta;
    }),
    onEvent: vi.fn((cb: (f: WsFrame) => void) => {
      eventListeners.push(cb);
      return () => {};
    }),
    onConnectionStatus: vi.fn((cb: (s: ConnectionStatus, d?: StatusDetail) => void) => {
      queueMicrotask(() => cb('connected'));
      return () => {};
    }),
    emit: (f: WsFrame): void => {
      for (const cb of eventListeners) cb(f);
    },
  };
  return api;
}

async function bootApp(api: Harness2Api): Promise<Record<string, unknown>> {
  vi.resetModules();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  return import('../../src/renderer/App');
}

/** 开右栏（会话列头的「右栏开关」）并断言此刻零 tab（启动器在场、标签条不在） */
async function openRightbarExpectLauncher(api: Harness2Api): Promise<void> {
  const App = (await bootApp(api)) as { App: () => React.ReactNode };
  render(<App.App />);
  fireEvent.click(await screen.findByRole('button', { name: /第一句/ })); // 选中会话
  await screen.findByText('第一句回复'); // 会话重放完成 → 会话列头（含右栏开关）才渲染
  fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
  await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
  expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
  expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
  expect(screen.getByText('打开标签页')).toBeTruthy();
}

/** 经加号菜单开一个 tab（零 tab 用启动器、已有标签条用右簇 +；Radix 菜单：Enter 开 → 点条目） */
function openTabFromLauncher(id: string): void {
  const trigger =
    document.querySelector('[data-testid="side-pane-launcher-trigger"]') ??
    document.querySelector('[data-testid="side-pane-add"]');
  fireEvent.keyDown(trigger as Element, { key: 'Enter' });
  fireEvent.click(document.querySelector(`[data-side-menu-item="${id}"]`) as Element);
}

afterEach(cleanup);
beforeEach(() => {
  seq = 0;
});

describe('右栏标签体系（Z2-04）', () => {
  it('Z-13：右栏打开但零 tab → 「打开标签页」加号启动器（无标签条）', async () => {
    await openRightbarExpectLauncher(makeFakeApi());
  });

  it('启动器开 tab → 标签条出现并激活；关闭 → 回到启动器', async () => {
    await openRightbarExpectLauncher(makeFakeApi());
    openTabFromLauncher('plan');
    expect(screen.queryByTestId('side-pane-launcher')).toBeNull();
    expect(document.querySelector('[data-side-tab="plan"]')?.getAttribute('data-side-tab-active')).toBe('true');
    // 面板本体渲染进 body（计划面板在无计划账本时如实显示依赖提示）
    await waitFor(() => expect(document.querySelector('[data-testid="side-pane-body"]')?.textContent).not.toBe(''));

    fireEvent.click(document.querySelector('[data-side-tab-close="plan"]') as Element);
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
  });

  it('开两个 tab；⋯ 菜单「关闭其他」「关闭全部」（Z-14 的下拉一处实现）', async () => {
    await openRightbarExpectLauncher(makeFakeApi());
    openTabFromLauncher('plan');
    openTabFromLauncher('tasks');
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(2);
    expect(document.querySelector('[data-side-tab="tasks"]')?.getAttribute('data-side-tab-active')).toBe('true');

    // 关闭其他：只留激活的 tasks
    fireEvent.keyDown(screen.getByTestId('side-pane-actions'), { key: 'Enter' });
    fireEvent.click(document.querySelector('[data-side-action="close-others"]') as Element);
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(1);
    expect(document.querySelector('[data-side-tab="tasks"]')).not.toBeNull();

    // 关闭全部：回启动器
    fireEvent.keyDown(screen.getByTestId('side-pane-actions'), { key: 'Enter' });
    fireEvent.click(document.querySelector('[data-side-action="close-all"]') as Element);
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
  });

  it('审批徽章：approval-request 到达 → 审批 tab 显示计数', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    act(() => {
      api.emit({
        v: 1,
        seq: 99,
        ts: '2026-09-06T00:00:01Z',
        type: 'approval-request',
        sessionId: 's1',
        requestId: 'r1',
        tool: 'bash',
        args: { cmd: 'ls' },
        active: true,
      } as unknown as WsFrame);
    });
    openTabFromLauncher('approvals');
    const badge = document.querySelector('[data-side-badge="approvals"]');
    expect(badge?.textContent).toBe('1');
  });

  it('D-86 ①：openFile 路由 → 开「文件」tab + 自动打开右栏 + 预览渲染', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复'); // 重放完成（会话列头在场）
    // 右栏此时关着：路由必须把它一起打开（不静默丢请求）
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);

    const { toolNavigation } = await import('@harness2/ui-shared/renderer/tool/index.js');
    act(() => {
      const r = toolNavigation.openFile({ path: 'src/a.ts' });
      expect(r.ok).toBe(true);
    });

    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    expect(document.querySelector('[data-side-tab="file"]')).not.toBeNull();
    // 预览按路径读取（fake readFileForRef 返回 line1/line2）
    expect(await screen.findByText('line1')).toBeTruthy();
    expect(document.querySelector('[data-file-path="src/a.ts"]')).not.toBeNull();
  });

  it('Z-13：新建会话强制收起右栏；新会话的桶为空 → 重开见启动器', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复'); // 重放完成（会话列头在场）
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    openTabFromLauncher('plan');
    expect(document.querySelector('[data-side-tab="plan"]')).not.toBeNull();

    // 浮层 New Task 仅在侧栏折叠时出现（Z-01）→ 先收侧栏
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));

    // 右栏被强制收起（Z-13 / ZCode draftFocusVersion 语义的对齐挂点）
    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true));
    expect(api.createSession).toHaveBeenCalled();

    // 重开右栏：新会话 s2 的桶为空 → 启动器（tab 状态按会话分桶，不复用 s1 的）
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    await waitFor(() => expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy());
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
  });
});
