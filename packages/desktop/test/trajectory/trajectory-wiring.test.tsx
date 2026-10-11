// @vitest-environment jsdom
// Z2-05 路由改道验收（Z-14 / Z-16 / P2-5 / D-86②）：
//   ① Z-14：trajectory 是**右栏 tab**（id `model-trajectory:{sessionId}`），不再是主区视图环的
//      标签页（Z-16 主区无视图环）——启动器「模型轨迹」项真实打开并渲染投影（数据来自事件流）；
//   ② P2-5：工具卡「查看轨迹」→ 打开/激活右栏该会话的 trajectory tab + 定位参数（callId/seq）
//      经焦点通道到达记录表（选中 + 检查器就位）；右栏收起时自动展开（不静默丢请求）；
//   ③ 主区保持 chat：inspect 不再切换主视图（转录仍在）。
// 装配级用例走 side-pane.test.tsx 同款 bootApp 模式（真 App + fake window.harness2）。
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

/** 一轮真实事件：用户消息 + 工具调用/结果（callId=call-9，供 inspect 定位断言）+ 助手回复 */
function replay(): SessionEventsPayloadShape {
  return {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1' },
    events: [
      ev('user/message', { text: '第一句', turnId: 't1' }),
      ev('tool/call', { callId: 'call-9', tool: 'bash', args: { command: 'ls' }, turnId: 't1' }),
      ev('tool/result', { callId: 'call-9', ok: true, output: 'file.txt', turnId: 't1' }),
      ev('assistant/message', { text: '第一句回复', model: 'mock/m', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 4,
  };
}

function makeFakeApi() {
  const eventListeners: Array<(f: WsFrame) => void> = [];
  const api: Harness2Api & { emit: (f: WsFrame) => void } = {
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 4 },
    ]),
    createSession: vi.fn(async () => ({ id: 's2' })),
    events: vi.fn(async () => replay()),
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

describe('Z-14：trajectory = 右栏 tab（真装配，不是弹窗、不是主区视图）', () => {
  it('启动器「模型轨迹」→ 打开/激活 model-trajectory:s1 tab，渲染真实投影（轮次/行数来自事件）', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    openTabFromLauncher('model-trajectory');

    const tab = document.querySelector('[data-side-tab="model-trajectory:s1"]');
    expect(tab).not.toBeNull(); // Z-14 语义 id：model-trajectory:{sessionId}
    expect(tab?.getAttribute('data-side-tab-active')).toBe('true');
    expect(tab?.textContent).toContain('模型轨迹');

    const body = document.querySelector('[data-testid="side-pane-body"]');
    await waitFor(() => expect(body?.querySelector('[data-testid="trajectory-panel"]')).not.toBeNull());
    const panel = body?.querySelector('[data-testid="trajectory-panel"]');
    expect(panel?.getAttribute('data-turns')).toBe('1'); // 投影自真实事件，不是假数据
    expect(Number(panel?.getAttribute('data-rows'))).toBeGreaterThanOrEqual(3);
    // 不是弹窗：没有 dialog 形态的轨迹表面
    expect(document.querySelector('[role="dialog"][aria-label*="轨迹"]')).toBeNull();
  });

  it('主区事实单一 chat（Z-16）：tab 打开后主区仍是转录（无视图环、无 tablist）', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    openTabFromLauncher('model-trajectory');
    await waitFor(() => expect(document.querySelector('[data-side-tab="model-trajectory:s1"]')).not.toBeNull());

    // 主区：转录与工具卡都在（没有被 trajectory「顶掉」；范围取主区席位，避免右栏轨迹步骤文本同名干扰）
    const mainSeat = document.querySelector('[data-seat="main"]');
    expect(mainSeat?.textContent).toContain('第一句回复');
    expect(mainSeat?.querySelector('[data-tool-action="inspect"]')).not.toBeNull();
    expect(mainSeat?.querySelector('[role="tablist"]')).toBeNull();
    expect(mainSeat?.querySelector('.view-ring')).toBeNull();
  });

  it('轨迹 tab 可关闭：关闭后回启动器（按会话分桶的 tab 状态机对 composite id 一视同仁）', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    openTabFromLauncher('model-trajectory');
    await waitFor(() => expect(document.querySelector('[data-side-tab="model-trajectory:s1"]')).not.toBeNull());

    fireEvent.click(document.querySelector('[data-side-tab-close="model-trajectory:s1"]') as Element);
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
  });
});

describe('P2-5 改道：工具卡「查看轨迹」→ 右栏 trajectory tab + 定位', () => {
  it('右栏收起时点击：自动展开右栏 + 打开/激活 trajectory tab + 定位到 callId 对应记录（端到端）', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复');
    // 右栏此时关着：路由必须把它一起打开（不静默丢请求）
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);

    const { toolNavigation } = await import('@harness2/ui-shared/renderer/tool/index.js');
    expect(toolNavigation.canInspect()).toBe(true); // 消费者已装配 → 工具卡才渲染入口

    const inspectButton = document.querySelector('[data-tool-action="inspect"]') as HTMLButtonElement;
    expect(inspectButton).not.toBeNull();
    act(() => {
      fireEvent.click(inspectButton); // 真点击：卡片 → toolNavigation.inspect → 右栏路由
    });

    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    const tab = document.querySelector('[data-side-tab="model-trajectory:s1"]');
    expect(tab?.getAttribute('data-side-tab-active')).toBe('true');

    // 定位（P2-5）：callId=call-9 的步骤行被选中，检查器就位（不是只开一个空标签页）
    const body = document.querySelector('[data-testid="side-pane-body"]');
    await waitFor(() => expect(body?.querySelector('[data-testid="trajectory-panel"]')).not.toBeNull());
    const toolRow = body?.querySelector('[data-row-kind="step"][data-role="tool"]') as HTMLElement | null;
    expect(toolRow).not.toBeNull();
    expect(toolRow?.getAttribute('data-selected')).toBe('true');
    const inspector = body?.querySelector('[data-testid="trajectory-inspector"]');
    expect(inspector?.getAttribute('data-empty')).toBe('false');
    expect(inspector?.getAttribute('data-inspector-key')).toBe(toolRow?.getAttribute('data-row-key'));
  });

  it('主区不切视图（Z-16）：inspect 后转录仍在主区（改的是右栏，不是主区状态位）', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复');

    const { toolNavigation } = await import('@harness2/ui-shared/renderer/tool/index.js');
    act(() => {
      const r = toolNavigation.inspect({ sessionId: 's1', callId: 'call-9', seq: 2 });
      expect(r).toEqual({ ok: true, target: 'trajectory' });
    });

    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    expect(document.querySelector('[data-side-tab="model-trajectory:s1"]')).not.toBeNull();
    // 主区转录原样（气泡还在）——对照旧实现：视图环切到 trajectory 会把转录顶掉
    const mainSeat = document.querySelector('[data-seat="main"]');
    expect(mainSeat?.textContent).toContain('第一句回复');
    expect(mainSeat?.querySelector('.trajectory-panel')).toBeNull(); // 轨迹面板在右栏，不在主区
  });

  it('已开 trajectory tab 的会话再次 inspect：幂等激活并更新定位请求（不重复开第二个 tab）', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复');

    const { toolNavigation } = await import('@harness2/ui-shared/renderer/tool/index.js');
    act(() => {
      toolNavigation.inspect({ sessionId: 's1', callId: 'call-9', seq: 2 });
    });
    await waitFor(() => expect(document.querySelector('[data-side-tab="model-trajectory:s1"]')).not.toBeNull());
    act(() => {
      toolNavigation.inspect({ sessionId: 's1', callId: 'call-9', seq: 2 });
    });
    expect(document.querySelectorAll('[data-side-tab="model-trajectory:s1"]')).toHaveLength(1);
    expect(document.querySelector('[data-side-tab="model-trajectory:s1"]')?.getAttribute('data-side-tab-active')).toBe(
      'true',
    );
  });
});
