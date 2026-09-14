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
    expect(await screen.findByText('第一句回复')).toBeTruthy(); // 分栏内 assistant 气泡
    expect(screen.getByText('思考过程')).toBeTruthy(); // reasoning 折叠块
    expect(screen.getByText('── turn')).toBeTruthy(); // turn 标头
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
    // P0-2（上游 stores.ts:131）：jsdom innerWidth=1024 是宽屏 → 打开右栏**不动**侧栏（仍 280 展开）
    const sidebar = document.querySelector('[data-seat="sidebar"]');
    expect(sidebar?.getAttribute('data-collapsed')).toBe('false');
    expect(sidebar?.getAttribute('data-width')).toBe('280');

    // 宽屏手动收起侧栏：56px 轨道（不是消失）
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebar?.getAttribute('data-collapsed')).toBe('true');
    expect(sidebar?.getAttribute('data-width')).toBe('56');

    // P4-C 轨道归属裁决（单轨道断言）：收起态只有一条 56px 轨道 ——
    // 帧只提供容器宽度（.app-frame-rail 已删除），轨道内容由 SidebarRoot 渲染；
    // 落定后 sidebar-root 带 h2-sidebar-rail 且内联宽度正是 56。
    await waitFor(() =>
      expect(document.querySelector('[data-testid="sidebar-root"]')?.classList.contains('h2-sidebar-rail')).toBe(true),
    );
    expect(document.querySelectorAll('.app-frame-rail').length).toBe(0);
    const railRoot = document.querySelector('[data-testid="sidebar-root"]') as HTMLElement;
    expect(railRoot.style.width).toBe('56px');
    // 轨道控件（SidebarRoot 的 toggle）可把侧栏展开回 280
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    await waitFor(() => expect(sidebar?.getAttribute('data-width')).toBe('280'));
    expect(sidebar?.getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('面板几何不持久化（D-14）：拖宽/开合不落盘，重挂载回到默认', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    const view = render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false);
    // 几何状态不进持久化通道（saveLayout 是旧分屏引擎的通道；几何只在 React state 里）
    expect(api.saveLayout).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);

    // 重挂载（等价刷新/切会话）：回到默认 —— 侧栏 280 展开、右栏关闭
    view.unmount();
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('280');
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
      theme: 'dark',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    });
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);

    await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('dark'));
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--dsh-content-font-size')).toBe('14px');
    expect(document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1b1d21');

    // 清理：避免污染同文件其它用例（主题是全局 DOM 呈现）
    document.documentElement.style.cssText = '';
    document.body.removeAttribute('data-ds-dark-theme');
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  });
});

// —————— P4-② 装配级补缺：真渲染 App + 真缩窗事件（D-12 / D-13 / D-16 / D-21 / D-25） ——————
// 目的：把计划②点名的四项（让步链 / 56px 轨道 / 降动效禁过渡 / 新会话作用域四级降级）
// 从纯函数、组件级证据升到装配级证据。视口宽不再靠 prop 注入：改 window.innerWidth 后
// 派发 resize，走 useViewportWidth 在真实 App 里的那条监听通路（等价于人拖窗口边界）。
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

  it('让步链端到端（D-12）：缩窗后先缩右栏 → 空间不足则轨道摘除（占用方自关）→ 才压中栏；偏好宽度不被改写', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));

    // 打开右栏：首开取视口 45% = 630；用户把它拖窄到 502（这就是「用户偏好宽度」）
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatAttr('rightbar', 'data-width')).toBe('630');
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(rightbarHandle(), { key: 'ArrowRight' }); // 630 → 502
    expect(rightbarHandle().getAttribute('aria-valuenow')).toBe('502');
    expect(seatAttr('rightbar', 'data-width')).toBe('502');

    // 缩窗到 900（真 resize）：< 1024 自动收起侧栏（56px 轨道）→ available = 900−56−400 = 444
    // ① 有轨道时先缩右栏：502 → 444（不多留），中栏恰好保住 400
    resizeTo(900);
    await waitFor(() => expect(seatAttr('sidebar', 'data-width')).toBe('56'));
    expect(seatAttr('rightbar', 'data-width')).toBe('444');
    expect(seatAttr('rightbar', 'data-shrunk')).toBe('true');
    expect(seatAttr('rightbar', 'data-can-show')).toBe('true');
    // ② 用户手动展开侧栏（窄屏 override）→ available = 900−280−400 = 220 < 300
    //    → 右栏轨道摘除（宽度归零、canShow=false），占用方收到 props 后自行关闭（壳不代关）
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(seatAttr('sidebar', 'data-width')).toBe('280');
    await waitFor(() => expect(seatOf('rightbar')?.hasAttribute('hidden')).toBe(true));
    expect(seatAttr('rightbar', 'data-width')).toBe('0');
    expect(seatAttr('rightbar', 'data-can-show')).toBe('false');
    // ③ 中栏拿到全部剩余 620，不是被压到 320；中栏不得出现任何「空间不足」提示条
    expect(seatAttr('main', 'data-seat')).toBe('main');
    expect(document.querySelector('[data-shortage]')).toBeNull();
    expect(document.querySelector('.app-frame-shortage')).toBeNull();
    expect(document.querySelector('[data-seat="main"]')?.textContent ?? '').not.toContain('空间不足');
    expect(sidebarColumn().style.width).toBe('280px'); // 侧栏不被右栏关闭连带收起

    // ④ 用户偏好宽度原样保留：变宽回 1400 再开右栏 → 仍是 502（不是 45% 的 630）；
    //    且变宽不自动重新展开右栏（D-12）
    resizeTo(1400);
    expect(seatOf('rightbar')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatAttr('rightbar', 'data-width')).toBe('502');
    expect(rightbarHandle().getAttribute('aria-valuenow')).toBe('502');
  });

  it('窄屏打开右栏收起手动展开的侧栏（P0-2 上游 stores.ts:131）；宽屏不动侧栏', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(900);
    render(<App.App />);

    // 窄屏默认自动收起（56px 轨道）→ 手动展开（rail 态不渲染会话行，故本用例不依赖选会话）
    await waitFor(() => expect(seatAttr('sidebar', 'data-width')).toBe('56'));
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(seatAttr('sidebar', 'data-width')).toBe('280');

    // 窄屏打开右栏：清掉「窄屏手动展开」override → 侧栏回轨道 56，右栏拿到 available
    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    expect(seatAttr('sidebar', 'data-width')).toBe('56');
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('true');
    expect(seatOf('rightbar')?.hasAttribute('hidden')).toBe(false);
    expect(seatAttr('rightbar', 'data-width')).toBe('405'); // 900 × 45%，available 444 内放得下
    expect(seatAttr('rightbar', 'data-can-show')).toBe('true');
  });

  it('56px 轨道装配级（D-13/P1-1）：缩窗后轨道仍在且只有一条（容器与内容同宽 56）；变宽跨阈值回宽态、右栏回到用户偏好而非 45%', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    resizeTo(1400);
    render(<App.App />);
    await screen.findByRole('button', { name: /第一句/ });

    fireEvent.click(screen.getByRole('button', { name: '右栏开关' }));
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(rightbarHandle(), { key: 'ArrowRight' }); // 偏好 502
    expect(seatAttr('rightbar', 'data-width')).toBe('502');

    // 缩窗 → 侧栏自动收起：轨道存在（不是消失），容器 56px，轨道内容同样是 56px
    resizeTo(900);
    await waitFor(() => expect(seatAttr('sidebar', 'data-width')).toBe('56'));
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('true');
    await waitFor(() => expect(sidebarColumn().classList.contains('h2-sidebar-rail')).toBe(true));
    expect(sidebarColumn().style.width).toBe('56px');
    expect(sidebarColumn().closest('[data-seat="sidebar"]')).not.toBeNull();
    // 让步链（D-12）：右栏被压到 available = 900−56−400 = 444（有轨道，canShow 仍 true）
    expect(seatAttr('rightbar', 'data-width')).toBe('444');
    expect(seatAttr('rightbar', 'data-can-show')).toBe('true');
    // 单轨道（P4-C 归属裁决）：没有帧自带的第二条 56px 轨道，轨道内容只此一条
    expect(document.querySelectorAll('.app-frame-rail').length).toBe(0);
    expect(document.querySelectorAll('.h2-sidebar-rail').length).toBe(1);
    expect(document.querySelectorAll('[data-seat="sidebar"]').length).toBe(1);
    // 轨道控件仍可用（不是死轨道）
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('打开侧边栏');

    // 变宽跨阈值（P1-1 上游 setViewportWidth 双向重置）：侧栏回到宽态偏好（展开 280），
    // 右栏回到用户偏好 502（不按 45% 重算成 630）
    resizeTo(1400);
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('false');
    expect(seatAttr('sidebar', 'data-width')).toBe('280');
    expect(seatAttr('rightbar', 'data-width')).toBe('502');
    expect(rightbarHandle().getAttribute('aria-valuenow')).toBe('502');
    // 宽屏下手动收起才回 56px 轨道
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(seatAttr('sidebar', 'data-width')).toBe('56');
    expect(seatAttr('sidebar', 'data-collapsed')).toBe('true');
  });

  it('降动效（D-16）装配级·命中：帧根属性/类 + 侧栏降动效类同时到位，收起即时落定不等过渡', async () => {
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

    // 降动效下收起不排队等 150ms：同一批渲染里直接落到轨道相位（56px）
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebarColumn().getAttribute('data-phase')).toBe('rail');
    expect(sidebarColumn().classList.contains('h2-sidebar-fading')).toBe(false);
    expect(sidebarColumn().style.width).toBe('56px');
    // 禁用过渡不等于禁用功能：还能再展开
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebarColumn().getAttribute('data-phase')).toBe('expanded');
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
    // 收起仍走两段过渡：先进入淡出相位（不会即时落定）
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebarColumn().getAttribute('data-phase')).toBe('collapsing');
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
