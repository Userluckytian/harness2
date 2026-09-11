// @vitest-environment jsdom
// 对话 UI 组件测试（Task 4，jsdom + RTL）：会话列表与切换重放渲染、
// Enter 发送 / Shift+Enter 换行、turn 中停止按钮（abort）、审批按钮（allow/deny）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type {
  ConnectionStatus,
  Harness2Api,
  SessionEventsPayloadShape,
  SettingsPreferencesShape,
  StatusDetail,
  WsFrame,
} from '../src/shared/protocol.js';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): any {
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
      ev('assistant/message', { text: '第一句回复', reasoning: '暗自思考', model: 'mock/m', turnId: 't1' }),
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
    settingsGetPreferences: vi.fn(async () => ({ theme: 'warmPaper' }) as SettingsPreferencesShape),
    settingsSetPreferences: vi.fn(async (p: unknown) => p as SettingsPreferencesShape),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
    // —— D0：S7 只读查询 + S3 交互 op + 能力盘点（默认最小可用实现） ——
    runConfig: vi.fn(async () => ({ redacted: true }) as never),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({ readOnly: true }) as never),
    fork: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ probedAt: '', entries: [] })),
    notify: vi.fn(async () => undefined),
    metadataGet: vi.fn(async () => ({})),
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
  return import('../src/renderer/App');
}

describe('对话 UI（jsdom）', () => {
  beforeEach(() => {
    cleanup();
    seq = 0;
  });

  it('会话列表与切换重放：点击会话 → subscribe + 全量重放渲染气泡/reasoning/摘要', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);

    expect(await screen.findByText(/第一句/)).toBeTruthy(); // 列表摘要
    fireEvent.click(screen.getByRole('button', { name: /第一句/ }));

    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(api.events).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('第一句回复')).toBeTruthy(); // 分栏内 assistant 气泡
    expect(screen.getByText('思考过程')).toBeTruthy(); // reasoning 折叠块
    expect(screen.getByText('── turn')).toBeTruthy(); // turn 标头
  });

  it('分屏拖拽（HTML5 DnD）：dragStart 会话 → drop 分栏 → 绑定并渲染；dataTransfer 与回退两路', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    const item = await screen.findByRole('button', { name: /第一句/ });

    // 路径一：dataTransfer 有效载荷
    const dataTransfer = { getData: () => 's1', setData: () => {}, effectAllowed: '' };
    fireEvent.dragStart(item, { dataTransfer });
    fireEvent.drop(screen.getByText('空分栏').closest('section')!, { dataTransfer });
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('第一句回复')).toBeTruthy();

    // 解绑后走路径二：dragState 回退（jsdom 无 dataTransfer）
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    await waitFor(() => expect(screen.getByText('空分栏')).toBeTruthy());
    fireEvent.dragStart(item, {});
    fireEvent.drop(screen.getByText('空分栏').closest('section')!, {});
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(2));
  });

  it('分栏数切换：1→2→3 栏；布局经 saveLayout 持久化', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: '2 栏' }));
    await waitFor(() => expect(api.saveLayout).toHaveBeenCalled());
    expect(screen.getAllByText('空分栏')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '3 栏' }));
    expect(await screen.findAllByText('空分栏')).toHaveLength(3);
    const saveCalls = vi.mocked(api.saveLayout).mock.calls;
    expect(saveCalls.length).toBeGreaterThanOrEqual(2);
    expect((saveCalls.at(-1)?.[0] as { panes: unknown[] }).panes).toHaveLength(3);
  });

  it('输入框：Enter 发送（trim）→ 转运行中（停止按钮）→ 停止调 abort；Shift+Enter 换行不发送', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));

    const box = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '  你好  ' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true }); // 换行：不发送
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: false }); // 发送
    expect(api.sendMessage).toHaveBeenCalledWith('s1', '你好');
    expect(box.value).toBe(''); // 发送后清空

    // 乐观 running → 停止按钮出现
    expect(await screen.findByRole('button', { name: /停止/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    expect(api.abort).toHaveBeenCalledWith('s1');
  });

  it('审批条：approval-request 帧 → 允许/拒绝按钮 → respondApproval 带决策', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    expect(await screen.findByText('第一句回复')).toBeTruthy();

    api.emit({
      type: 'approval-request',
      sessionId: 's1',
      tool: 'write',
      args: { file_path: 'a.txt' },
      requestId: 'r1',
    });
    expect(await screen.findByText(/允许执行/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(api.respondApproval).toHaveBeenCalledWith('r1', 'allow');
  });

  it('后台帧缓冲：选中 s1 时 s2 的 assistant/message 计未读并显示徽标', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as {
      App: () => React.ReactNode;
      store: { peekStream(id: string): { unread: number } };
    };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复');

    api.emit({ type: 'event', sessionId: 's2', event: ev('assistant/message', { text: '后台产出', turnId: 'k' }) });
    api.emit({ type: 'turn-end', sessionId: 's2', stopReason: 'end_turn' });
    expect(App.store.peekStream('s2').unread).toBe(2);
  });
});
