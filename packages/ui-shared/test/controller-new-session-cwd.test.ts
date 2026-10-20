// @vitest-environment jsdom
// Z-48 controller.newSession(cwd)：显式 cwd 透传到 api.createSession(cwd)；
// 缺省 = 无参调用（既有行为不变）。纯 fake api，无 DOM 断言。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import type { HarnessClient } from '../src/renderer/ports.js';

function makeFakeApi(overrides: Partial<HarnessClient> = {}): HarnessClient {
  const listeners: Array<(frame: never) => void> = [];
  const base = {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: 'new-1' })),
    events: vi.fn(async () => ({
      id: 'new-1',
      dir: '',
      header: { sessionId: 'new-1' },
      events: [],
      warnings: [],
      lastSeq: 0,
    })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    loadLayout: vi.fn(async () => undefined),
    saveLayout: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ status: 'connected' as const })),
    settingsGetConfig: vi.fn(async () => ({})),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetPreferences: vi.fn(async () => ({})),
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
    metadataGet: vi.fn(async () => ({})),
    metadataSet: vi.fn(async () => ({})),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    undo: vi.fn(async () => ({ results: [] })),
    redo: vi.fn(async () => ({ results: [] })),
    fork: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ probedAt: '', entries: [] })),
    setBusy: vi.fn(async () => undefined),
    setTitleBarTheme: vi.fn(async () => undefined),
    runConfig: vi.fn(async () => ({})),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({})),
    onEvent: vi.fn((cb: (frame: never) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    onConnectionStatus: vi.fn(() => () => {}),
    onStopAll: vi.fn(() => () => {}),
    ...overrides,
  };
  return base as unknown as HarnessClient;
}

describe('Z-48 controller.newSession 透传 cwd', () => {
  it('带 cwd → api.createSession(cwd) 被以该 cwd 调用', async () => {
    const api = makeFakeApi();
    const store = new AppStore();
    const controller = createController(store, api);
    await controller.newSession('D:/p/alpha');
    expect(api.createSession).toHaveBeenCalledWith('D:/p/alpha');
    // 新会话被选中（既有语义：create → subscribe → select → replay）
    expect(store.getState().selectedId).toBe('new-1');
    expect(api.subscribe).toHaveBeenCalledWith('new-1');
  });

  it('缺省（空白新会话）→ api.createSession() 无参调用（行为不变，主进程补默认 cwd）', async () => {
    const api = makeFakeApi();
    const store = new AppStore();
    const controller = createController(store, api);
    await controller.newSession();
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect((api.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.length).toBe(0);
  });

  it('空串 cwd 视同缺省（不污染参数面）', async () => {
    const api = makeFakeApi();
    const store = new AppStore();
    const controller = createController(store, api);
    await controller.newSession('');
    expect((api.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.length).toBe(0);
  });
});
