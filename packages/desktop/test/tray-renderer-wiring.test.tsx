// @vitest-environment jsdom
// Z-47（T3 渲染侧接线）：托盘菜单事件（IPC_TRAY_EVENT）到达对应 dispatch。
//   - `tray:new-session` → 与侧栏顶部「+」同一路径（controller.newSession → api.createSession）；
//   - `tray:add-project` → 与组头「添加项目」同一真源（api.projectsPickFolder → projectsAdd）。
// fake 桥暴露 onTrayEvent 并留存 listener，测试手动 emit 事件驱动。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type { ConnectionStatus, Harness2Api, StatusDetail, TrayUiEvent, WsFrame } from '../src/shared/protocol.js';

function makeFakeApi(): Harness2Api & { emitTray: (e: TrayUiEvent) => void } {
  const trayListeners: Array<(e: TrayUiEvent) => void> = [];
  const api = {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: 's-new' })),
    events: vi.fn(async () => ({
      id: 's1',
      dir: '',
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
    settingsGetConfig: vi.fn(async () => ({ providers: {}, roles: {} })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetPreferences: vi.fn(async () => ({ theme: 'system', notifyDetails: 'minimal' })),
    settingsSetPreferences: vi.fn(async (p: unknown) => p),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 })),
    settingsGetCrashReports: vi.fn(async () => []),
    settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '', global: '' } })),
    gitBranch: vi.fn(async () => null),
    getContextUsage: vi.fn(async () => ({ usage: null, label: '—' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false })),
    readFileForRef: vi.fn(async () => ({ ok: false })),
    listDir: vi.fn(async () => ({ ok: true, path: '', entries: [], truncated: false })),
    notify: vi.fn(async () => undefined),
    projectsList: vi.fn(async () => ({ projects: [] })),
    projectsAdd: vi.fn(async (cwd: string) => ({ projects: [{ cwd, addedAt: 1 }] })),
    projectsRemove: vi.fn(async () => ({ projects: [] })),
    projectsPickFolder: vi.fn(async () => 'D:/picked'),
    metadataGet: vi.fn(async () => ({})),
    metadataSet: vi.fn(async (id: string) => ({ [id]: {} })),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    runConfig: vi.fn(async () => ({})),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({})),
    fork: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ probedAt: '', entries: [] })),
    setBusy: vi.fn(async () => undefined),
    setTitleBarTheme: vi.fn(async () => undefined),
    onStopAll: vi.fn(() => () => {}),
    onEvent: vi.fn((_cb: (f: WsFrame) => void) => () => {}),
    onConnectionStatus: vi.fn((cb: (s: ConnectionStatus, d?: StatusDetail) => void) => {
      queueMicrotask(() => cb('connected'));
      return () => {};
    }),
    onTrayEvent: vi.fn((cb: (e: TrayUiEvent) => void) => {
      trayListeners.push(cb);
      return () => {
        const i = trayListeners.indexOf(cb);
        if (i >= 0) trayListeners.splice(i, 1);
      };
    }),
    emitTray: (e: TrayUiEvent): void => {
      for (const cb of [...trayListeners]) cb(e);
    },
  };
  return api as unknown as Harness2Api & { emitTray: (e: TrayUiEvent) => void };
}

async function bootApp(api: Harness2Api): Promise<{ App: () => React.ReactNode }> {
  vi.resetModules();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  return import('../src/renderer/App.js') as unknown as Promise<{ App: () => React.ReactNode }>;
}

afterEach(() => cleanup());

describe('Z-47 托盘事件 → 渲染端动作', () => {
  it('tray:new-session → createSession（与顶部「+」同一路径）', async () => {
    const api = makeFakeApi();
    const { App } = await bootApp(api);
    render(<App />);
    // 等席位挂载（侧栏常驻，onTrayEvent 已登记 listener）
    await waitFor(() => expect(api.onTrayEvent).toHaveBeenCalled());
    await act(async () => {
      api.emitTray({ type: 'tray:new-session' });
    });
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(1));
    expect(api.createSession).toHaveBeenLastCalledWith(); // 空白新会话（不带 cwd）
  });

  it('tray:add-project → projectsPickFolder + projectsAdd（组头「添加项目」同真源）', async () => {
    const api = makeFakeApi();
    const { App } = await bootApp(api);
    render(<App />);
    await waitFor(() => expect(api.onTrayEvent).toHaveBeenCalled());
    await act(async () => {
      api.emitTray({ type: 'tray:add-project' });
    });
    await waitFor(() => expect(api.projectsPickFolder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.projectsAdd).toHaveBeenCalledWith('D:/picked'));
    // 项目出现在侧栏（写后整表刷新）
    expect(await screen.findByText('picked')).toBeTruthy();
  });

  it('退订生效：卸载后事件不再触达（无泄漏）', async () => {
    const api = makeFakeApi();
    const { App } = await bootApp(api);
    const view = render(<App />);
    await waitFor(() => expect(api.onTrayEvent).toHaveBeenCalled());
    view.unmount();
    const before = (api.createSession as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      api.emitTray({ type: 'tray:new-session' });
    });
    expect((api.createSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('反向钉：缺 onTrayEvent 通道（旧夹具）→ 不订阅、不报错', async () => {
    const api = makeFakeApi();
    delete (api as { onTrayEvent?: unknown }).onTrayEvent;
    const { App } = await bootApp(api);
    render(<App />);
    // App 正常渲染（空态文案在）
    expect(await screen.findByText(/选择左侧会话开始对话/)).toBeTruthy();
  });
});

// 触发未使用告警消除（fireEvent 在其它用例复用则不需要；此处保留引用面）
void fireEvent;
