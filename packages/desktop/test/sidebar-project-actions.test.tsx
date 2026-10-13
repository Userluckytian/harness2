// @vitest-environment jsdom
// Z-48/Z-49 桌面装配贯通：项目行 hover「在此项目新建会话」→ createSession(cwd)；
// 行菜单「删除」→ 确认框 → metadata:set {deleted:true} → 列表移除（软删，零新后端）。
// 全量 App 启动（侧栏席位经 shell-registry 真注入），fake 桥含 projects/metadata 通道。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type { ConnectionStatus, Harness2Api, StatusDetail, WsFrame } from '../src/shared/protocol.js';

const ALPHA = 'D:/p/alpha';

function makeFakeApi(): Harness2Api & Record<string, unknown> {
  const api: Harness2Api & Record<string, unknown> = {
    platform: 'win32' as const,
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd1', cwd: ALPHA, mtimeMs: 10, firstUserText: 'alpha会话', messageCount: 2, lastSeq: 3 },
    ]),
    createSession: vi.fn(async (cwd?: string) => ({ id: cwd === ALPHA ? 's-new-alpha' : 's-new-blank' })),
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
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '', global: '' } })),
    gitBranch: vi.fn(async () => null),
    getContextUsage: vi.fn(async () => ({ usage: null, label: '—' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '' })),
    readFileForRef: vi.fn(async () => ({ ok: false })),
    listDir: vi.fn(async () => ({ ok: true as const, path: '', entries: [], truncated: false })),
    notify: vi.fn(async () => undefined),
    // —— 桌面专属通道：projects.json / metadata 覆层 ——
    projectsList: vi.fn(async () => ({ projects: [{ cwd: ALPHA, addedAt: 1 }] })),
    projectsAdd: vi.fn(async (cwd: string) => ({
      projects: [
        { cwd: ALPHA, addedAt: 1 },
        { cwd, addedAt: 2 },
      ],
    })),
    projectsRemove: vi.fn(async () => ({ projects: [] })),
    projectsPickFolder: vi.fn(async () => null),
    metadataGet: vi.fn(async () => ({})),
    metadataSet: vi.fn(async (id: string, patch: { deleted?: boolean }) => ({ [id]: patch })),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    // S7 只读契约最小面
    runConfig: vi.fn(async () => ({ redacted: true })),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({ readOnly: true })),
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
    windowMinimize: vi.fn(async () => undefined),
    windowToggleMaximize: vi.fn(async () => undefined),
    windowClose: vi.fn(async () => undefined),
    windowGetState: vi.fn(async () => ({ maximized: false })),
    onWindowState: vi.fn(() => () => {}),
  };
  return api;
}

async function bootApp(api: Harness2Api): Promise<{ App: () => React.ReactNode }> {
  vi.resetModules();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  return import('../src/renderer/App.js') as unknown as Promise<{ App: () => React.ReactNode }>;
}

/** 等项目组头出现（title 撞名：组头与「移出项目」钮同 title=cwd，用 testid 定位） */
async function projectGroupHeadRow(): Promise<HTMLElement> {
  await screen.findByTestId('sidebar-group-head');
  return screen.getByTestId('sidebar-group-head').closest('.h2-sidebar-group-head-row') as HTMLElement;
}

afterEach(() => cleanup());

describe('Z-48 桌面装配：项目行「在此项目新建会话」带 cwd', () => {
  it('hover 项目组头 → 新建钮出现 → 点击后 createSession 收到项目 cwd 且新会话被选中', async () => {
    const api = makeFakeApi();
    const { App } = await bootApp(api);
    render(<App />);
    // 项目组在场（projectsList 通道）→ hover 组头行
    const headRow = await projectGroupHeadRow();
    fireEvent.mouseOver(headRow);
    const btn = await screen.findByTestId('sidebar-group-new-session-project-D--p-alpha');
    await act(async () => {
      fireEvent.click(btn);
    });
    // createSession 收到项目 cwd（区别于顶部「+」的空白新会话）
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(ALPHA));
    // 新会话被选中（controller 链路：create → subscribe → select）
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith('s-new-alpha'));
  });

  it('顶部「+」仍是不带 cwd 的空白新会话（两入口区分）', async () => {
    const api = makeFakeApi();
    const { App } = await bootApp(api);
    render(<App />);
    await projectGroupHeadRow();
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-new-session'));
    });
    await waitFor(() => expect(api.createSession).toHaveBeenCalled());
    // 顶部入口无参调用
    expect(api.createSession).toHaveBeenLastCalledWith();
    expect(api.createSession).not.toHaveBeenCalledWith(ALPHA);
  });
});

describe('Z-49 桌面装配：行菜单删除（软删贯通）', () => {
  it('⋯ 菜单「删除」→ 确认框 → metadataSet(deleted:true) → 列表移除', async () => {
    const api = makeFakeApi();
    const { App } = await bootApp(api);
    render(<App />);
    const row = await screen.findByRole('button', { name: /alpha会话/ });
    fireEvent.contextMenu(row);
    const menu = await screen.findByTestId('session-row-menu');
    const del = menu.querySelector('[data-menu-action="delete"]');
    expect(del, '壳给了删除通道，菜单应出现「删除」项').not.toBeNull();
    fireEvent.click(del!);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(screen.getByTestId('confirm-dialog-title').textContent).toBe('删除这个会话？');
    void dialog;
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(api.metadataSet).toHaveBeenCalledWith('s1', { deleted: true }));
    // 列表即时移除（store.removeSessionFromView）
    await waitFor(() => expect(screen.queryByRole('button', { name: /alpha会话/ })).toBeNull());
  });
});
