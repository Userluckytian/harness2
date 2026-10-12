// @vitest-environment jsdom
// 对话 UI 组件测试（Task 4，jsdom + RTL）：会话列表与切换重放渲染、
// Enter 发送 / Shift+Enter 换行、turn 中停止按钮（abort）、审批按钮（allow/deny）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type {
  ConnectionStatus,
  Harness2Api,
  SessionEventsPayloadShape,
  SettingsPreferencesShape,
  StatusDetail,
  WsFrame,
} from '../src/shared/protocol.js';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import { createController } from '@harness2/ui-shared/renderer/app-controller.js';
import type { ChatItem } from '@harness2/ui-shared/renderer/chat-model.js';

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
    expect(await screen.findByText('第一句回复')).toBeTruthy(); // 分栏内 assistant 正文
    // Z-92：reasoning 是一等行（默认折叠的触发行，文案「思考」）；展开后内容如实可见
    const reasoningToggle = screen.getByText('思考');
    expect(reasoningToggle.closest('[data-testid="reasoning-row"]')).not.toBeNull();
    fireEvent.click(reasoningToggle);
    expect(await screen.findByText('暗自思考')).toBeTruthy();
    // P0-1：轮次头**无文案**（ZCode 分组渲染，不渲染 `── turn`）—— 定位锚点 data-turn-id 仍在
    expect(screen.queryByText(/──\s*turn/)).toBeNull();
    expect(document.querySelector('.turn-header[data-turn-id="t1"]')).not.toBeNull();
    // P0-1：移除角色标签（「你」/ provider 名 `mock/m` 都不再出现在行内）
    expect(screen.queryByText('你')).toBeNull();
    expect(screen.queryByText('mock/m')).toBeNull();
    expect(document.querySelector('.bubble-user .role')).toBeNull();
    expect(document.querySelector('.bubble-assistant .role')).toBeNull();
  });

  // P0-1（装配级）：经 App.tsx 再导出的真身组件渲染消息行结构 —— 用户右对齐气泡 / 助手无气泡、
  // 无角色标签、行内动作只在助手行。与上面的全量重放用例互补（那条走完整会话链路，
  // 这两条只钉渲染结构本身，断言更精确）。
  it('P0-1 消息行结构（ChatItemView）：用户右对齐气泡 + 助手无气泡，且两者都无角色标签', async () => {
    const api = makeFakeApi();
    await bootApp(api);
    const { ChatItemView } = (await import('../src/renderer/App')) as unknown as {
      ChatItemView: (p: {
        item: ChatItem;
        sessionId?: string;
        store: AppStore;
        controller: ReturnType<typeof createController>;
      }) => React.ReactElement | null;
    };
    const store = new AppStore();
    const controller = createController(store, api as never);

    render(
      <div className="messages">
        <ChatItemView
          item={{ kind: 'user', seq: 1, turnId: 't1', text: '用户问题' }}
          store={store}
          controller={controller}
        />
        <ChatItemView
          item={{ kind: 'assistant', seq: 2, turnId: 't1', text: '助手回答', model: 'loomy/qwen3.8-flash' }}
          store={store}
          controller={controller}
        />
      </div>,
    );

    const user = document.querySelector('.bubble-user');
    const assistant = document.querySelector('.bubble-assistant');
    if (user === null || assistant === null) throw new Error('消息行未渲染');
    expect(user.textContent).toBe('用户问题'); // 只有正文，无「你」标签
    expect(assistant.textContent).toBe('助手回答'); // provider 名不进正文
    expect(assistant.querySelector('.message-actions')).not.toBeNull(); // 助手行有动作行
    expect(user.querySelector('.message-actions')).toBeNull(); // 用户行无动作行（ZCode 口径）
  });

  // P0-1（装配级）：ChatTranscript 真渲染 → 动作行走既有 fork 通道；
  // 会话运行中（store.running=true）分叉禁用并提示「任务结束后可分叉」，turn-end 后恢复可用。
  it('P0-1 分叉通道可用性两态（ChatTranscript）：运行中禁用 + 提示，空闲可用并调 fork', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as unknown as {
      ChatTranscript: (p: {
        streamId: string;
        store: AppStore;
        controller: ReturnType<typeof createController>;
      }) => React.ReactElement | null;
    };
    const store = new AppStore();
    const controller = createController(store, api as never);
    store.applyStatus('connected');
    store.applyReplay({
      id: 's1',
      dir: 'd',
      header: { sessionId: 's1', cwd: 'D:/proj' },
      events: [
        ev('user/message', { text: '问题', turnId: 't1' }),
        ev('assistant/message', { text: '回答', turnId: 't1' }),
      ],
      warnings: [],
      lastSeq: 2,
    });

    render(<App.ChatTranscript streamId="s1" store={store} controller={controller} />);
    const fork = (): HTMLButtonElement => screen.getByTestId('message-action-fork') as HTMLButtonElement;

    // 重放后本会话空闲（running=false）→ 分叉可用
    expect(store.peekStream('s1')?.running).toBe(false);
    await waitFor(() => expect(fork().disabled).toBe(false));

    // 新的 user/message 落盘 → running=true（store.absorbEvent）→ 分叉禁用 + ZCode 文案
    store.applyFrame({ type: 'event', sessionId: 's1', event: ev('user/message', { text: '再来一句', turnId: 't2' }) });
    expect(store.peekStream('s1')?.running).toBe(true);
    await waitFor(() => expect(fork().disabled).toBe(true));
    expect(fork().getAttribute('title')).toBe('任务结束后可分叉');

    // 本轮结束 → 分叉恢复可用，点击走既有 controller/api fork 通道（目标 = 助手行的真实 seq）
    store.applyFrame({ type: 'turn-end', sessionId: 's1', stopReason: 'end_turn' });
    await waitFor(() => expect(fork().disabled).toBe(false));
    const assistantSeq = store.chatItems('s1').find((i) => i.kind === 'assistant')?.seq;
    fireEvent.click(fork());
    await waitFor(() => expect(api.fork).toHaveBeenCalledWith('s1', assistantSeq));
  });

  // 迁移依据（P4-A）：旧的 components/PaneArea.tsx 六页签/多分屏已按计划③拆除，
  // 会话页改占 main 的 conversation key（D-10）；原「分屏拖拽 + 分栏数切换」两条用例随落点消失，
  // 这里改为断言新的三栅骨架（席位装配 / 右栏开关 / 几何不持久化）。
  it('三栅骨架（D-10 / D-13）：点击会话 → 会话页占 main 的 conversation key；顶栏可开关右栏', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);

    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    const bubble = await screen.findByText('第一句回复');
    expect(bubble.closest('[data-slot-key]')?.getAttribute('data-slot-key')).toBe('conversation');
    expect(document.querySelector('[data-seat="sidebar"]')).not.toBeNull();

    // 右栏关闭时隐藏（hidden）；顶栏右栏开关可打开/收起
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false);
    // 打开右栏**不动**侧栏（Z-15 自动收起改由 resize idle 判定，不由开右栏触发）
    const sidebar = document.querySelector('[data-seat="sidebar"]');
    expect(sidebar?.getAttribute('data-collapsed')).toBe('false');
    expect(sidebar?.getAttribute('data-width')).toBe('264');

    // 宽屏手动收起侧栏：只剩 4px（Z-06，无图标轨道）
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebar?.getAttribute('data-collapsed')).toBe('true');
    expect(sidebar?.getAttribute('data-width')).toBe('4');

    // Z-06：折叠态没有任何图标轨道；展开内容只隐藏不卸载（仍在 DOM）
    expect(document.querySelectorAll('.app-frame-rail').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="sidebar-region-rail"]').length).toBe(0);
    const collapsedRoot = document.querySelector('[data-testid="sidebar-root"]') as HTMLElement;
    expect(collapsedRoot.classList.contains('opacity-0')).toBe(true);
    expect(collapsedRoot.classList.contains('pointer-events-none')).toBe(true);
    expect(screen.getByTestId('sidebar-session-list')).toBeTruthy();
    // 侧栏内的 toggle 可把侧栏展开回 264
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    await waitFor(() => expect(sidebar?.getAttribute('data-width')).toBe('264'));
    expect(sidebar?.getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('面板几何不持久化（D-14）：拖宽/开合不落盘，重挂载回到默认', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    const view = render(<App.App />);
    // Z2-01b：右栏开关已迁到会话列头（ZCode WorkspaceHeader 位置）→ 先选中会话再开右栏
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByRole('button', { name: '右栏开关' });

    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false);
    // 几何状态不进持久化通道（saveLayout 是旧分屏引擎的通道；几何只在 React state 里）
    expect(api.saveLayout).not.toHaveBeenCalled();
    // Z1-05：主题偏好会镜像到 localStorage['harness2-theme']（首屏防闪）；几何仍不落盘 —— 断言无其它键
    expect(Object.keys(window.localStorage).filter((k) => k !== 'harness2-theme')).toEqual([]);

    // 重挂载（等价刷新/切会话）：回到默认 —— 侧栏 264 展开、右栏关闭
    view.unmount();
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('264');
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-collapsed')).toBe('false');
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);
  });

  // P5-C 迁移：内建 textarea 已被常驻 Composer 取代（contentEditable + 主指针按钮）。
  // 输入模拟用粘贴分支（jsdom 无 beforeinput 合成路径，见 conversation/assembly.test.tsx 文件头）。
  // P5 修复（P0-1）：这里**必须**输入带首尾空白的文本并断言 trim 后的载荷 ——
  // 旧写法直接粘贴已 trim 的数据再断言同值，等于把「提交边界丢 trim」这个回归测不出来
  // （去掉 trim 也照样绿）。输入 '  你好  ' → 断言 rawText '你好' 才能真正钉住 trim。
  it('composer：Enter 提交（提交边界 trim）→ 转运行中（停止）→ 停止发 cancel；Shift+Enter 换行不提交', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));

    const editor = await screen.findByTestId('composer-editor');
    await waitFor(() => expect(editor.getAttribute('aria-disabled')).toBeNull()); // 连接建立后才可输入
    fireEvent.paste(editor, { clipboardData: { getData: () => '  你好  ' } });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true }); // 换行：不提交
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false }); // 提交
    // D1/P5-C：发送走 submit（幂等 clientMessageId + queue 语义），仍不碰无 ack 的 user-message
    // P0-1：载荷已 trim（上游 ui-conversation/src/client/input/facade.ts:736,760 defaultSink(draft.trim(), …)）
    // 提交边界含 @引用 解析（可能 await），故用 waitFor 等落定
    await waitFor(() =>
      expect(api.submit).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', rawText: '你好', intent: 'queue' }),
      ),
    );
    expect(editor.textContent).toBe(''); // D-34：提交即清（同一事务）

    // 乐观 running → 同一主指针位置变成 Stop
    const stop = await screen.findByRole('button', { name: '停止' });
    fireEvent.click(stop);
    // D3/D4：停止走 cancel（三态 ack），目标 = 当前 turn
    expect(api.cancel).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'turn', id: 't1' } }));
  });

  it('审批 dock：approval-request 帧 → 底部 dock 选项 + 确认 → respondApproval 带决策', async () => {
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
    // Z-20：审批不再出现在转录流里，而是会话底部 dock（numbered listbox + 确认）
    expect(await screen.findByTestId('approval-dock')).toBeTruthy();
    expect(screen.queryByText(/允许执行/)).toBeNull(); // 转录内联审批条已移除
    fireEvent.click(screen.getByRole('option', { name: /允许/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
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

  // 迁移依据（P4-C 裁决 3）：后台判定原为「非选中且未绑定任何分栏」；分栏状态已无渲染出口，
  // 点过多个会话（旧实现把它们绑定成分栏）后切走，未读就不再累计。现口径 = 非选中即后台。
  it('多会话切换后未读徽标累计（P4-C：后台判定 = 非当前选中）', async () => {
    const api = makeFakeApi();
    api.listSessions = vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 3 },
      { id: 's2', dir: 'd', mtimeMs: 5, firstUserText: '第二句', messageCount: 1, lastSeq: 1 },
    ]);
    const App = (await bootApp(api)) as {
      App: () => React.ReactNode;
      store: { isBackground(id: string): boolean; peekStream(id: string): { unread: number } };
    };
    render(<App.App />);

    // 先看过 s2（缺陷路径正是「s2 曾被绑到某个分栏」），再切回 s1
    fireEvent.click(await screen.findByRole('button', { name: /第二句/ }));
    await waitFor(() => expect(App.store.peekStream('s2')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复');

    expect(App.store.isBackground('s2')).toBe(true);
    api.emit({ type: 'event', sessionId: 's2', event: ev('assistant/message', { text: '后台产出', turnId: 'k' }) });
    api.emit({ type: 'turn-end', sessionId: 's2', stopReason: 'end_turn' });
    expect(App.store.peekStream('s2').unread).toBe(2);
    // 侧栏徽标如实显示累计值（不是恒 0）
    await waitFor(() => expect(document.querySelector('.h2-sidebar-unread')?.textContent).toBe('2'));
  });

  it('覆层走 shell.overlay 席位（D-10）：Ctrl+K 命令面板与 Ctrl+, 设置都在四席位装配内', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByPlaceholderText('输入命令…');
    expect(palette.closest('[data-slot="shell.overlay"]')).not.toBeNull();
    fireEvent.keyDown(palette, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText('输入命令…')).toBeNull());

    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('[data-slot="shell.overlay"]')).not.toBeNull();
  });

  it('主题呈现（D-15）：偏好为深色时四处呈现值一次写全', async () => {
    const api = makeFakeApi();
    vi.mocked(api.settingsGetPreferences).mockResolvedValue({
      theme: 'zai-dark',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    });
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);

    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('dark'));
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--dsh-content-font-size')).toBe('14px');
    expect(document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#161616');

    // 清理：避免污染同文件其它用例（主题是全局 DOM 呈现）
    document.documentElement.style.cssText = '';
    document.body.removeAttribute('data-ds-dark-theme');
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  });

  // Z2-01b（Z-01 / Z-07）：无 topbar —— 折叠入口进左上浮层；设置/状态进侧栏 Footer。
  it('窗口外壳（Z-01）：无 topbar，左上浮层可折叠侧栏；设置与状态角标迁到侧栏 Footer', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    // 旧顶栏已拆除（不占布局高度）
    expect(document.querySelector('header.topbar')).toBeNull();
    expect(document.querySelector('.topbar')).toBeNull();
    // 左上浮层在 DOM，含侧栏折叠入口
    expect(screen.getByTestId('desktop-top-overlay')).toBeTruthy();
    expect(screen.getByRole('button', { name: '侧栏开关' })).toBeTruthy();
    // 设置入口迁到侧栏 Footer（原顶栏设置按钮不再存在）
    expect(screen.getByTestId('sidebar-settings')).toBeTruthy();
    // StatusBadge 二选一取 Footer（.badge 落在 .h2-sidebar-foot 内）
    expect(document.querySelector('.h2-sidebar-foot .badge')).not.toBeNull();

    // 浮层入口可收起侧栏（4px，Z-06）
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-collapsed')).toBe('true');
  });
});

// —————— P4-② 装配级补缺：真渲染 App + 真缩窗事件（Z-05 / Z-06 / Z-12 / Z-15 / D-16 / D-21 / D-25） ——————
// 目的：把计划②点名的四项（让步链 / 4px 折叠 / 降动效禁过渡 / 新会话作用域四级降级）
// 从纯函数、组件级证据升到装配级证据。视口宽不再靠 prop 注入：改 window.innerWidth 后
// 派发 resize，走 useViewportWidth 在真实 App 里的那条监听通路（等价于人拖窗口边界）。
// 注意 Z-15：自动收起只在**窗口 resize 之后 idle 300ms** 判定，且按**会话列宽**（不是视口宽）。
const JSDOM_INNER_WIDTH = window.innerWidth;
const DSH_BUILD_KEYS = ['DSH_CLIENT_VERSION', 'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_GIT_DIRTY'] as const;

/** 缩窗/放大：改 window.innerWidth 并派发 resize 事件 */
function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

/** matchMedia 桩（jsdom 无原生实现）：只让 prefers-reduced-motion: reduce 命中 */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** 席位容器（data-seat） */
const seatOf = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-seat="${name}"]`);
/** 席位容器属性（data-width / data-shrunk / data-collapsed…） */
const seatAttr = (name: string, attr: string): string | null => seatOf(name)?.getAttribute(attr) ?? null;
/** 侧栏列本身（SidebarRoot 的根元素） */
const sidebarColumn = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-testid="sidebar-root"]') as HTMLElement;
/** 右栏拖宽手柄 */
const rightbarHandle = (): HTMLElement => screen.getByRole('separator', { name: '拖宽右栏' });

describe('P4-② 装配级补缺（真渲染 App + 缩窗事件）', () => {
  beforeEach(() => {
    cleanup();
    seq = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    for (const key of DSH_BUILD_KEYS) delete process.env[key];
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: JSDOM_INNER_WIDTH });
  });

  it('让步链端到端（D-12）：右栏偏好超过 available 时先缩到 available；偏好宽度不被改写', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    // 挂载即 1200（挂载不算 resize → 不触发 Z-15 自动收起，专注让步链）
    resizeTo(1200);
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    // Z2-01b：右栏开关在会话列头；等会话装载落定（含 header 挂载）再继续
    await screen.findByRole('button', { name: '右栏开关' });

    // 侧栏拖到 420（1200 × 0.5 = 600 上限内）
    const sidebarHandle = screen.getByRole('separator', { name: '拖宽侧栏' });
    act(() => {
      fireEvent.pointerDown(sidebarHandle, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 456 }); // +156 → 420
      fireEvent.pointerUp(window, {});
    });
    expect(seatAttr('sidebar', 'data-width')).toBe('420');

    // 打开右栏：首开取**内容区宽** 45%（1200−420=780 → 351），available 460 内放得下 → 无让步
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatAttr('rightbar', 'data-width')).toBe('351');
    expect(seatAttr('rightbar', 'data-shrunk')).toBe('false');
    expect(seatAttr('rightbar', 'data-can-show')).toBe('true');
    expect(rightbarHandle().getAttribute('aria-valuenow')).toBe('351');
    // 中栏没有任何「空间不足」提示条（D-12 报告落占用方，不落中栏）
    expect(document.querySelector('[data-shortage]')).toBeNull();
    expect(document.querySelector('.app-frame-shortage')).toBeNull();
    expect(document.querySelector('[data-seat="main"]')?.textContent ?? '').not.toContain('空间不足');

    // 把右栏偏好拉过 available（351 → 463 > 460）：渲染被让步链压到 available 460
    for (let i = 0; i < 7; i += 1) fireEvent.keyDown(rightbarHandle(), { key: 'ArrowLeft' }); // 每步 +16 → 463
    expect(seatAttr('rightbar', 'data-width')).toBe('460');
    expect(seatAttr('rightbar', 'data-shrunk')).toBe('true');
    expect(rightbarHandle().getAttribute('aria-valuenow')).toBe('460');

    // 偏好宽度原样保留：关掉再打开仍是 463（不是 45% 重算、也不是渲染宽度 460）
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatOf('rightbar')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatAttr('rightbar', 'data-width')).toBe('460');
    expect(rightbarHandle().getAttribute('aria-valuenow')).toBe('460');
    // 变宽（不改偏好）→ 右栏回到用户偏好 463，而不是按 45% 重算
    resizeTo(1400);
    expect(seatAttr('rightbar', 'data-width')).toBe('463');
  });

  it('打开右栏不动侧栏（Z-15：自动收起改由 resize idle 判定，不由开右栏触发）', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    // Z2-01b：右栏开关在会话列头（需先选中会话）
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByRole('button', { name: '右栏开关' });

    expect(seatAttr('sidebar', 'data-width')).toBe('264');
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatOf('rightbar')?.hasAttribute('hidden')).toBe(false);
    // 侧栏保持展开（旧「窄屏开右栏清手动展开」的 narrowExpanded 概念已移除）
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('false');
    expect(seatAttr('sidebar', 'data-width')).toBe('264');
    // 右栏首开 511（内容区 1400−264=1136 × 45%），available 816 内放得下
    expect(seatAttr('rightbar', 'data-width')).toBe('511');
    expect(seatAttr('rightbar', 'data-can-show')).toBe('true');
  });

  it('自动收起装配级（Z-15）：resize idle 300ms 后按会话列宽先收右栏、后收左栏；变宽不自动展开', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    // Z2-01b：右栏开关在会话列头（需先选中会话）
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByRole('button', { name: '右栏开关' });

    // 打开右栏并拖窄（首开 511，内容区 1136 × 45%；拖到偏好 383）
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(rightbarHandle(), { key: 'ArrowRight' }); // 511 → 383
    expect(seatAttr('rightbar', 'data-width')).toBe('383');

    // 缩窗到 900：available = 900−264−320 = 316 → 右栏 316，会话列 320 < 480
    resizeTo(900);
    expect(seatAttr('rightbar', 'data-width')).toBe('316'); // 未到 idle：状态未变
    // idle 后：右栏先自动收起（占用方自关 → hidden）
    await waitFor(() => expect(seatOf('rightbar')?.hasAttribute('hidden')).toBe(true), { timeout: 1_200 });
    expect(seatAttr('rightbar', 'data-can-show')).toBe('false');
    // 左栏保持展开（收右栏后会话列 900−264=636 ≥ 360）
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('false');
    expect(seatAttr('sidebar', 'data-width')).toBe('264');

    // 继续缩到 600：会话列 = 600−264 = 336 < 360 → idle 后收左栏到 4px
    resizeTo(600);
    await waitFor(() => expect(seatAttr('sidebar', 'data-collapsed')).toBe('true'), { timeout: 1_200 });
    expect(seatAttr('sidebar', 'data-width')).toBe('4');
    // Z-06：折叠无图标轨道，内容只隐藏不卸载
    expect(sidebarColumn().classList.contains('opacity-0')).toBe(true);
    expect(document.querySelectorAll('.h2-sidebar-rail').length).toBe(0);
    expect(document.querySelectorAll('.app-frame-rail').length).toBe(0);
    expect(document.querySelectorAll('[data-seat="sidebar"]').length).toBe(1);

    // 变宽不自动展开（Z-15 只有自动收起，没有自动展开）
    resizeTo(1400);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('true');
    expect(seatAttr('sidebar', 'data-width')).toBe('4');
    // 用户手动展开仍可用
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('false');
    expect(seatAttr('sidebar', 'data-width')).toBe('264');
  });

  it('降动效（D-16）装配级·命中：帧根属性/类 + 侧栏降动效类同时到位，折叠仍可用', async () => {
    stubReducedMotion(true);
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    // 属性路（CSS 路见 test/layout/frame-styles.test.ts 与 test/sidebar/sidebar-styles.test.ts 的媒体查询断言）
    const frameRoot = document.querySelector('.app-frame');
    expect(frameRoot?.getAttribute('data-reduced-motion')).toBe('true');
    expect(frameRoot?.className).toContain('app-frame-reduced-motion');
    expect(sidebarColumn().classList.contains('h2-sidebar-reduced-motion')).toBe(true);

    // 折叠到 4px（Z-06）；禁用过渡不等于禁用功能
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebarColumn().getAttribute('data-collapsed')).toBe('true');
    expect(seatAttr('sidebar', 'data-width')).toBe('4');
    expect(sidebarColumn().classList.contains('opacity-0')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebarColumn().getAttribute('data-collapsed')).toBe('false');
  });

  it('降动效（D-16）装配级·未命中：不写帧根属性、不加降动效类（不制造假的降动效状态）', async () => {
    stubReducedMotion(false);
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    const frameRoot = document.querySelector('.app-frame');
    expect(frameRoot?.hasAttribute('data-reduced-motion')).toBe(false);
    expect(frameRoot?.className).not.toContain('app-frame-reduced-motion');
    expect(sidebarColumn().classList.contains('h2-sidebar-reduced-motion')).toBe(false);
  });

  it('新会话作用域（D-21）装配级：侧栏新会话按钮 → controller.newSession（当前只有空白档数据源，如实落空白）', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as {
      App: () => React.ReactNode;
      store: {
        getState(): { selectedId: string | null; layout: { panes: Array<{ sessionId: string | null }> } };
      };
    };
    resizeTo(1400);
    render(<App.App />);

    // 连接就绪后按钮可用（未就绪时 newSessionEnabled=false，见 test/sidebar/d21… 组件级用例）
    const button = await screen.findByTestId('sidebar-new-session');
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith('s2'));
    expect(App.store.getState().selectedId).toBe('s2');
    // 分栏绑定不再被写（P4-C）：新建会话不落任何 pane 绑定，视图由三栅的 conversation key 承担
    expect(App.store.getState().layout.panes.every((p) => p.sessionId === null)).toBe(true);
  });

  it('版本徐标（D-25）装配级·无元数据：渲染进程拿不到 DSH_CLIENT_* → 只显示本地构建名，不摆占位徐标', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    expect(screen.queryByTestId('sidebar-version-badge')).toBeNull();
    expect(document.querySelector('.h2-sidebar-brand-local')).not.toBeNull();
  });

  it('版本徐标（D-25）装配级·宿主注入：DSH_CLIENT_VERSION/COMMIT_HASH(7 位)/GIT_DIRTY → version-commit-dirty', async () => {
    process.env.DSH_CLIENT_VERSION = '1.2.3';
    process.env.DSH_CLIENT_COMMIT_HASH = 'abcdef1234567890';
    process.env.DSH_CLIENT_GIT_DIRTY = 'true';
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    expect(screen.getByTestId('sidebar-version-badge').textContent).toBe('1.2.3-abcdef1-dirty');
  });

  it('功能包填席归属（D-02 / D-10）：四席位 owner = 能力包名，main 带会话保留 key，overlay 按 order 叠加', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    const ownerOf = (slot: string): string | null =>
      document.querySelector(`[data-slot="${slot}"]`)?.getAttribute('data-slot-owner') ?? null;
    expect(document.querySelectorAll('[data-slot="sidebar"]').length).toBe(1);
    expect(ownerOf('sidebar')).toBe('ui-sidebar');
    expect(ownerOf('rightbar')).toBe('ui-workspace');
    // main 是 keyed：会话界面占保留 key（内容归 ui-conversation）
    const main = document.querySelector('[data-slot="main"]');
    expect(main?.getAttribute('data-slot-key')).toBe('conversation');
    expect(main?.getAttribute('data-slot-owner')).toBe('ui-conversation');
    // shell.overlay 是 list 席位：settings(0) 在下、commands(1) 在上（顺序即装配顺序）
    const overlays = [...document.querySelectorAll('[data-slot="shell.overlay"]')].map((n) =>
      n.getAttribute('data-slot-owner'),
    );
    expect(overlays).toEqual(['ui-settings', 'ui-commands']);
    // 一席位一份内容（不并存第二套）：页签/面板不会以「第二个贡献者」的形式偷偷挂上
    expect(document.querySelectorAll('[data-seat="main"] [data-slot="main"]').length).toBe(1);
    expect(document.querySelectorAll('[data-seat="rightbar"] [data-slot="rightbar"]').length).toBe(1);
  });
});
