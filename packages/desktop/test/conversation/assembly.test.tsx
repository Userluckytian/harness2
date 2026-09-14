// @vitest-environment jsdom
// 对话席位装配测试（P5-C）：把视图环（D-30～D-32）与 composer（D-33～D-38）接进桌面对话席位的端到端验收。
//
// 手法：**真渲染 ConversationSeat + 真 AppStore + 真 createController(store, 假 bridge)** ——
// 只有 bridge（window.harness2）是桩，其余全真：store 收敛、controller 投递、composer 状态机、
// FileUploadQueue、视图环选择规则都是生产代码本身。
//
// 输入模拟说明：jsdom 下 React 的 onBeforeInput 走的是 keypress/composition 回退路径
// （react-dom 的 getFallbackBeforeInputChars 对 'beforeinput' 返回 null），无法用合成事件驱动；
// 因此这里用**粘贴事件**（Composer 的真实分支：`onPaste → store.dispatch insert-text`）走同一条
// 状态转移，避免手改 contentEditable DOM 与 React 托管节点打架。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import type {
  ConnectionStatus,
  Harness2Api,
  SessionEventsPayloadShape,
  SettingsPreferencesShape,
  StatusDetail,
  WsFrame,
} from '../../src/shared/protocol.js';
import { createController, type Controller } from '../../src/renderer/app-controller.js';
import { AppStore } from '../../src/renderer/store.js';
import {
  ConversationSeat,
  conversationImageUrls,
  conversationViewRegistry,
  createConversationComposerPort,
  createDesktopConversationViewRegistry,
  createInMemoryViewSelectionPersistence,
  desktopConversationImageRead,
  desktopUploadTransport,
  type ConversationComposerPort,
  type ConversationSession,
} from '../../src/renderer/conversation/assembly.js';
import {
  createConversationViewRegistry,
  type ConversationImageAttachment,
  type ConversationViewProps,
  type ConversationViewRegistry,
} from '../../src/renderer/conversation/views/index.js';
import { createImageUrlCache, type ImageUrlCache } from '../../src/renderer/conversation/views/image-url-cache.js';
import type { ViewSelectionPersistence } from '../../src/renderer/conversation/views/view-ring.js';
import type { FileRefReader } from '../../src/shared/file-ref.js';
import type {
  FileReaderLike,
  ImageReadIO,
  UploadTransport,
} from '../../src/renderer/conversation/composer/attachments.js';
import { ComposerChain } from '../../src/renderer/conversation/composer/composer-chain.js';
import type { PendingSubmission } from '../../src/renderer/conversation/composer/composer-state.js';
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR,
  type BusyEnterBehavior,
} from '../../src/renderer/conversation/composer/submit-policy.js';

afterEach(cleanup);

// —— 夹具 ——

let seq = 0;
function event(type: string, payload: Record<string, unknown>): SessionEventsPayloadShape['events'][number] {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-14T00:00:00Z', type, payload, active: true };
}

/** s1 的默认重放：一条用户消息（→ store.running=true）+ 一条助手回复 */
function replayFor(id: string): SessionEventsPayloadShape {
  return {
    id,
    dir: 'd',
    header: { sessionId: id, cwd: 'D:/proj' },
    events: [
      event('user/message', { text: '第一句', turnId: 't1' }),
      event('assistant/message', { text: '第一句回复', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 2,
  };
}

function makeApi(overrides: Partial<Harness2Api> = {}): Harness2Api {
  const base: Harness2Api = {
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 2 },
      { id: 's2', dir: 'd', mtimeMs: 5, firstUserText: '第二句', messageCount: 1, lastSeq: 1 },
    ]),
    createSession: vi.fn(async () => ({ id: 's-new' })),
    events: vi.fn(async (id: string) => (id === 's1' ? replayFor('s1') : { ...replayFor(id), events: [], lastSeq: 0 })),
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
      roles: { main: { channel: 'c', model: 'mock/m' } },
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 1, maxConcurrent: 1 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 1 },
      sources: { global: false, project: false },
      warnings: [],
      errors: [],
    })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetPreferences: vi.fn(async (): Promise<SettingsPreferencesShape> => ({
      theme: 'warmPaper',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    })),
    settingsSetPreferences: vi.fn(async (): Promise<SettingsPreferencesShape> => ({
      theme: 'warmPaper',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    })),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
    listDir: vi.fn(async () => ({ ok: true as const, path: '', entries: [], truncated: false })),
    notify: vi.fn(async () => undefined),
    metadataGet: vi.fn(async () => ({})),
    metadataSet: vi.fn(async () => ({})),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (drafts: Record<string, string>) => drafts),
    runConfig: vi.fn(async () => ({}) as never),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({}) as never),
    fork: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ probedAt: '', entries: [] })),
    setBusy: vi.fn(async () => undefined),
    onEvent: vi.fn((_listener: (frame: WsFrame) => void) => () => {}),
    onConnectionStatus: vi.fn((_listener: (status: ConnectionStatus, detail?: StatusDetail) => void) => () => {}),
    onStopAll: vi.fn((_listener: () => void) => () => {}),
  };
  return { ...base, ...overrides };
}

interface BootOptions {
  readonly api?: Harness2Api;
  readonly select?: string | null;
}

function boot(options: BootOptions = {}): { store: AppStore; api: Harness2Api; controller: Controller } {
  const api = options.api ?? makeApi();
  const store = new AppStore();
  // 渲染端读 window.harness2（preload 桥）；这里只放桩
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  store.applyStatus('connected');
  store.setSessions([
    // cwd 来自会话 header（真实 serve 的 SessionSummary.cwd）；@path 解析用它
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 2 },
    { id: 's2', dir: 'd', cwd: 'D:/proj', mtimeMs: 5, firstUserText: '第二句', messageCount: 1, lastSeq: 1 },
  ]);
  const select = options.select === undefined ? 's1' : options.select;
  store.select(select);
  if (select !== null) store.applyReplay(replayFor(select));
  return { store, api, controller: createController(store, api) };
}

/** 让 store 进入「运行中」：增量 user/message 帧（与真实 WS 帧同一路径，running 由 store 真实维护） */
function markRunning(store: AppStore, id = 's1'): void {
  store.applyFrame({ type: 'event', sessionId: id, event: event('user/message', { text: '继续', turnId: 't1' }) });
}

interface SeatOptions {
  readonly store: AppStore;
  readonly controller: Controller;
  readonly createClientMessageId?: () => string;
  readonly imageIO?: ImageReadIO;
  readonly imageUrls?: ImageUrlCache;
  readonly registry?: ConversationViewRegistry<ConversationSession>;
  readonly persistence?: ViewSelectionPersistence;
  readonly port?: ConversationComposerPort;
  readonly busyEnter?: BusyEnterBehavior;
  readonly chain?: ComposerChain;
  readonly transport?: UploadTransport;
  readonly maxConcurrentFileUploads?: number;
  /** `@path` 读取缝（注入则完全绕开 window.harness2.readFileForRef） */
  readonly readRef?: FileRefReader;
}

function renderSeat(options: SeatOptions): ReturnType<typeof render> {
  return render(
    <ConversationSeat
      store={options.store}
      controller={options.controller}
      {...(options.createClientMessageId !== undefined ? { createClientMessageId: options.createClientMessageId } : {})}
      {...(options.imageIO !== undefined ? { imageIO: options.imageIO } : {})}
      {...(options.imageUrls !== undefined ? { imageUrls: options.imageUrls } : {})}
      {...(options.registry !== undefined ? { registry: options.registry } : {})}
      {...(options.persistence !== undefined ? { persistence: options.persistence } : {})}
      {...(options.port !== undefined ? { port: options.port } : {})}
      {...(options.busyEnter !== undefined ? { busyEnter: options.busyEnter } : {})}
      {...(options.chain !== undefined ? { chain: options.chain } : {})}
      {...(options.transport !== undefined ? { transport: options.transport } : {})}
      {...(options.readRef !== undefined ? { readRef: options.readRef } : {})}
      {...(options.maxConcurrentFileUploads !== undefined
        ? { maxConcurrentFileUploads: options.maxConcurrentFileUploads }
        : {})}
    />,
  );
}

const editor = (): HTMLElement => screen.getByTestId('composer-editor');
const primary = (): HTMLButtonElement => screen.getByTestId('composer-primary') as HTMLButtonElement;

/** 走 Composer 的真实粘贴分支把文本送进草稿（jsdom 无 beforeinput 合成路径，见文件头） */
function inputText(text: string): void {
  fireEvent.paste(editor(), { clipboardData: { getData: () => text } });
}

const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  seq = 0;
});

// —— 用例 ——

describe('视图环装配（D-30 / D-31 / D-32）', () => {
  it('只注册真实存在的视图：唯一标签是 chat（无 Trajectory 空标签），内容 = 既有转录', async () => {
    const { store, controller } = boot();
    renderSeat({ store, controller });

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('data-view-key'))).toEqual(['chat']);
    expect(tabs[0]?.getAttribute('data-view-owner')).toBe('ui-chat');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Trajectory' })).toBeNull();
    // 转录渲染是 chat 视图内容（真会话数据）
    expect(await screen.findByText('第一句回复')).toBeTruthy();
    expect(screen.getByTestId('view-ring-session')).toBeTruthy();
  });

  it('选择规则接线（D-31）：无效持久值回落 chat；点击写注入缝；不落浏览器存储（D-14）', () => {
    const { store, controller } = boot();
    const persistence = createInMemoryViewSelectionPersistence();
    persistence.write('s1', 'ghost'); // 未注册的持久值 → 按规则回落 chat（绝不取首个注册项）
    renderSeat({ store, controller, persistence });

    const chatTab = screen.getByRole('tab', { name: 'Chat' });
    expect(chatTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(chatTab);
    expect(persistence.read('s1')).toBe('chat');
    expect(window.localStorage.length).toBe(0);
  });

  it('无会话：composer 常驻挂载但 inert，视图环不渲染', () => {
    const { store, controller } = boot({ select: null });
    renderSeat({ store, controller });
    expect(screen.getByTestId('composer-editor')).toBeTruthy();
    expect(editor().getAttribute('aria-disabled')).toBe('true');
    expect(primary().disabled).toBe(true);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText(/选择左侧会话开始对话/)).toBeTruthy();
  });
});

describe('composer 装配（D-34～D-37）', () => {
  it('Enter 经 app-controller 投递到 bridge op:"submit"（同一 clientMessageId 进本地在途队列）', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, api, controller } = boot({ api: makeApi({ submit }) });
    renderSeat({ store, controller, createClientMessageId: () => 'cm-1' });

    inputText('你好');
    fireEvent.keyDown(editor(), { key: 'Enter' });

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'cm-1', sessionId: 's1', rawText: '你好', intent: 'queue' }),
    );
    // D-34/D-35：本地在途队列与提交同键（可见队列据此收敛）
    expect(Object.keys(store.peekStream('s1')?.pendingSubmits ?? {})).toEqual(['cm-1']);
  });

  it('running 来自 store 真实运行态：主按钮切 Stop；点击走既有取消（目标 = 当前 turn）', async () => {
    const { store, api, controller } = boot();
    markRunning(store); // store 真实运行态（增量 user/message 帧）
    renderSeat({ store, controller });

    // 空草稿 + 运行中 → Stop（同一主指针位置，不并列两个按钮）
    expect(primary().getAttribute('data-kind')).toBe('stop');
    fireEvent.click(primary());
    await waitFor(() =>
      expect(api.cancel).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'turn', id: 't1' } })),
    );
  });

  it('D-34 端到端：Enter 后草稿同一事务清空；pendingSubmissions 与本地在途队列保序', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, api, controller } = boot({ api: makeApi({ submit }) });
    const ids = ['cm-1', 'cm-2', 'cm-3'];
    let cursor = 0;
    const port = createConversationComposerPort({
      store,
      controller,
      createClientMessageId: () => ids[cursor++] ?? 'cm-x',
    });
    renderSeat({ store, controller, port });

    for (const text of ['一', '二', '三']) {
      inputText(text);
      fireEvent.keyDown(editor(), { key: 'Enter' });
      expect(editor().textContent).toBe(''); // 提交即清（同事务，不等 ack）
    }

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3));
    expect(submit.mock.calls.map((call) => call[0]?.rawText)).toEqual(['一', '二', '三']);
    // 保序：投递台账顺序 = 提交顺序；本地在途队列同样保序（store 插入序）
    expect(port.pendingSubmissions()).toEqual(['cm-1', 'cm-2', 'cm-3']);
    expect(Object.keys(store.peekStream('s1')?.pendingSubmits ?? {})).toEqual(['cm-1', 'cm-2', 'cm-3']);
  });

  it('D-34 失败重提：提交 reject → 草稿与附件按原顺序恢复、不自动重发，并如实记 unknown', async () => {
    const failing = makeApi({
      submit: vi.fn(async () => {
        throw new Error('提交未送达');
      }),
    });
    const { store, controller } = boot({ api: failing });
    const imageIO: ImageReadIO = {
      createReader: () => {
        const reader: FileReaderLike = {
          result: 'data:image/png;base64,AAA',
          error: null,
          onload: null,
          onerror: null,
          readAsDataURL: () => {
            queueMicrotask(() => reader.onload?.());
          },
        };
        return reader;
      },
    };
    renderSeat({ store, controller, imageIO, createClientMessageId: () => 'cm-fail' });

    inputText('重提我');
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'p.png', type: 'image/png', size: 12 }] },
    });
    await flush(); // 图片 FileReader 落定（ready）
    expect(screen.getByTestId('composer-attachments').textContent).toContain('p.png');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await flush();

    expect(failing.submit).toHaveBeenCalledTimes(1); // 不自动重发
    expect(editor().textContent).toBe('重提我'); // 草稿恢复
    const restored = screen.getByTestId('composer-attachments'); // 附件一条不丢
    expect(restored.querySelectorAll('[data-attachment-id]')).toHaveLength(1);
    expect(restored.textContent).toContain('p.png');
    // F7 与 D-34 并存：本地如实记 unknown（不假报成功）
    expect(store.peekStream('s1')?.submitAcks['cm-fail']?.state).toBe('unknown');
  });

  it('D-35/D-36 缺省繁忙态（无配置通道 → queue）：主按钮「排队发送」，Ctrl+Enter 恒用另一模式（steer）', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    markRunning(store); // 繁忙态由 store 真实运行态驱动
    renderSeat({ store, controller });

    inputText('追问');
    expect(primary().textContent).toBe('排队发送');
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('steer');
  });

  it('D-33 草稿隔离与持久草稿播种：切会话换 store（不串味），切回原会话草稿还在', () => {
    const { store, controller } = boot();
    store.setDraft('s2', '磁盘草稿'); // 持久草稿（D1）→ 进入 s2 时播种
    renderSeat({ store, controller });

    inputText('A 的草稿');
    expect(editor().textContent).toBe('A 的草稿');
    expect(store.draftFor('s1')).toBe('A 的草稿'); // 变更写回持久草稿（经 controller 去抖）

    act(() => store.select('s2'));
    expect(editor().textContent).toBe('磁盘草稿');

    act(() => store.select('s1'));
    expect(editor().textContent).toBe('A 的草稿');
  });
});

describe('图片 URL 缓存接入（D-39）', () => {
  interface Probe {
    imageUrl: ((attachment: ConversationImageAttachment) => string | null) | null;
  }
  const probe: Probe = { imageUrl: null };
  const ProbeView: ComponentType<ConversationViewProps<ConversationSession>> = (ctx) => {
    probe.imageUrl = ctx.imageUrl;
    return <span data-testid="probe-view">probe</span>;
  };

  it('视图环拿到的 imageUrl = 注入缓存的已缓存入口（Chat 与未来 Trajectory 共用同一引用）', async () => {
    const cache = createImageUrlCache({ read: (_sessionId, attachment) => `data:image/png;base64,${attachment.id}` });
    await cache.imageUrl('s1', { id: 'a1' });
    const registry = createConversationViewRegistry<ConversationSession>();
    registry.register({ key: 'chat', title: 'Chat', owner: 'ui-chat', component: ProbeView });

    const { store, controller } = boot();
    renderSeat({ store, controller, imageUrls: cache, registry });

    expect(screen.getByTestId('probe-view')).toBeTruthy();
    expect(probe.imageUrl?.({ id: 'a1' })).toBe('data:image/png;base64,a1');
    expect(probe.imageUrl?.({ id: 'uncached' })).toBeNull(); // 无缓存 → null（不伪造 URL）
  });

  it('桌面桥暂无图片授权读取通道（缺口登记）：read 恒 null，缓存不伪造 URL', async () => {
    expect(desktopConversationImageRead('s1', { id: 'a1' })).toBeNull();
    expect(await conversationImageUrls.imageUrl('s1', { id: 'a1' })).toBeNull();
    expect(conversationImageUrls.peekUrl('s1', { id: 'a1' })).toBeNull();
  });
});

// —— P5-② 补缺：D-30～D-39 装配级覆盖（只加测试，生产代码不动）——

/** 只渲染标记的会话视图组件（观察「视图环吃哪份注册表」） */
function markerView(testId: string): ComponentType<ConversationViewProps<ConversationSession>> {
  return () => <span data-testid={testId}>{testId}</span>;
}

/** 等真实定时器推进（上传并发/落定用） */
function wait(ms: number): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

interface CapturingPort extends ConversationComposerPort {
  /** 交给 Composer 的 detached 提交载荷（含 placement/attachments —— 桥 op:'submit' 看不到的部分） */
  readonly submissions: readonly PendingSubmission[];
}

/** 在真 port 外层套一层捕获：桥照旧投递，测试额外拿到内部载荷做断言 */
function capturingPort(deps: {
  readonly store: AppStore;
  readonly controller: Controller;
  readonly ids?: readonly string[];
  readonly transport?: UploadTransport;
  readonly maxConcurrentFileUploads?: number;
}): CapturingPort {
  let cursor = 0;
  const real = createConversationComposerPort({
    store: deps.store,
    controller: deps.controller,
    ...(deps.ids !== undefined ? { createClientMessageId: () => deps.ids?.[cursor++] ?? 'cm-x' } : {}),
    ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
    ...(deps.maxConcurrentFileUploads !== undefined ? { maxConcurrentFileUploads: deps.maxConcurrentFileUploads } : {}),
  });
  const submissions: PendingSubmission[] = [];
  const io: ConversationComposerPort['io'] = {
    ...real.io,
    submit: (submission) => {
      submissions.push(submission);
      return real.io.submit(submission);
    },
  };
  return { io, pendingSubmissions: real.pendingSubmissions, submissions };
}

describe('D-30 装配级：视图唯一注册表 / 与渲染目标无关', () => {
  it('视图集合完全来自注入注册表（自定义 key/title/owner 即刻上签）——装配层不绑定具体渲染目标', () => {
    const { store, controller } = boot();
    const registry = createConversationViewRegistry<ConversationSession>();
    registry.register({ key: 'chat', title: '会话', owner: 'ui-custom-owner', component: markerView('custom-chat') });
    renderSeat({ store, controller, registry, persistence: createInMemoryViewSelectionPersistence() });

    const tab = screen.getByRole('tab', { name: '会话' });
    expect(tab.getAttribute('data-view-owner')).toBe('ui-custom-owner');
    expect(screen.getByTestId('custom-chat')).toBeTruthy();
  });

  it('默认注册表只注册真实存在的视图：keys()=[chat]、owner=ui-chat；Trajectory 未注册（P6 前不画空标签）', () => {
    expect(createDesktopConversationViewRegistry().keys()).toEqual(['chat']);
    expect(conversationViewRegistry.get('chat')?.owner).toBe('ui-chat');
    expect(conversationViewRegistry.has('trajectory')).toBe(false);
  });
});

describe('D-31 分支装配级（真 seat + 真 store/controller，注入注册表与持久缝）', () => {
  it('分支 1：有效持久选择优先 —— chat 先注册，persisted=trajectory 仍选 trajectory', () => {
    const { store, controller } = boot();
    const registry = createConversationViewRegistry<ConversationSession>();
    registry.register({ key: 'chat', title: 'Chat', owner: 'ui-chat', component: markerView('chat-view') });
    registry.register({
      key: 'trajectory',
      title: 'Trajectory',
      owner: 'ui-trajectory',
      component: markerView('trj-view'),
    });
    const persistence = createInMemoryViewSelectionPersistence();
    persistence.write('s1', 'trajectory');
    renderSeat({ store, controller, registry, persistence });

    expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('false');
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('data-view-key')).toBe('trajectory');
    expect(screen.getByTestId('trj-view')).toBeTruthy();
    expect(screen.queryByTestId('chat-view')).toBeNull();
  });

  it('分支 2：无效持久值 → 回落已注册 chat（trajectory 先注册也不被选中），DOM 无意外标签', () => {
    const { store, controller } = boot();
    const registry = createConversationViewRegistry<ConversationSession>();
    // 先注册 trajectory：若实现取「第一个注册的」，这里就会错误选中它
    registry.register({
      key: 'trajectory',
      title: 'Trajectory',
      owner: 'ui-trajectory',
      component: markerView('trj-view'),
    });
    registry.register({ key: 'chat', title: 'Chat', owner: 'ui-chat', component: markerView('chat-view') });
    const persistence = createInMemoryViewSelectionPersistence();
    persistence.write('s1', 'ghost');
    renderSeat({ store, controller, registry, persistence });

    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('false');
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('data-view-key')).toBe('chat');
    expect(screen.getByTestId('chat-view')).toBeTruthy();
    expect(screen.queryByTestId('trj-view')).toBeNull();
    expect(document.querySelector('[data-view-key="ghost"]')).toBeNull();
  });

  it('分支 3：无有效持久选择且未注册 chat → 不渲染任何视图（空兜底），绝不落首个注册项', () => {
    const { store, controller } = boot();
    const registry = createConversationViewRegistry<ConversationSession>();
    registry.register({
      key: 'trajectory',
      title: 'Trajectory',
      owner: 'ui-trajectory',
      component: markerView('trj-view'),
    });
    const persistence = createInMemoryViewSelectionPersistence();
    persistence.write('s1', 'ghost');
    renderSeat({ store, controller, registry, persistence });

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getAllByRole('tab')[0]?.getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByTestId('view-ring-empty')).toBeTruthy();
    expect(screen.queryByTestId('trj-view')).toBeNull(); // 首个注册项没有被当默认视图
    expect(screen.getByText(/当前没有可渲染的会话视图/)).toBeTruthy();
  });
});

describe('D-32 装配级：切换视图不重建会话', () => {
  it('切标签只换渲染内容：会话对象引用稳定、会话容器 DOM 引用不变', () => {
    const { store, controller } = boot();
    const seen: unknown[] = [];
    const spyView =
      (testId: string): ComponentType<ConversationViewProps<ConversationSession>> =>
      (ctx) => {
        seen.push(ctx.session);
        return <span data-testid={testId}>{testId}</span>;
      };
    const registry = createConversationViewRegistry<ConversationSession>();
    registry.register({ key: 'chat', title: 'Chat', owner: 'ui-chat', component: spyView('v-chat') });
    registry.register({ key: 'trajectory', title: 'Trajectory', owner: 'ui-trajectory', component: spyView('v-trj') });
    renderSeat({ store, controller, registry, persistence: createInMemoryViewSelectionPersistence() });

    const sessionNode = screen.getByTestId('view-ring-session');
    const firstSession = seen[0];
    expect(firstSession).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));
    expect(screen.getByTestId('v-trj')).toBeTruthy();
    expect(screen.getByTestId('view-ring-session')).toBe(sessionNode); // 会话容器没被重建
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((bound) => bound === firstSession)).toBe(true); // 同一会话对象引用
  });
});

describe('D-34 装配级：乐观提交「同一事务」的可观测证据', () => {
  it('一次 Enter：草稿空 + 撤销历史同批清空（Ctrl+Z 不复活）+ 订阅回调恰一次 + store 在途队列保序', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, api, controller } = boot({ api: makeApi({ submit }) });
    const ids = ['cm-1', 'cm-2'];
    let cursor = 0;
    const port = createConversationComposerPort({
      store,
      controller,
      createClientMessageId: () => ids[cursor++] ?? 'cm-x',
    });
    const setDraft = vi.spyOn(controller, 'setDraft');
    renderSeat({ store, controller, port });

    inputText('甲乙丙');
    setDraft.mockClear(); // 输入阶段的写回不算：只看 Enter 这一批

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));

    expect(editor().textContent).toBe(''); // 草稿同事务清空
    fireEvent.keyDown(editor(), { key: 'z', ctrlKey: true }); // 撤销历史同事务清空
    expect(editor().textContent).toBe(''); // 已发送文本拉不回来
    expect(setDraft).toHaveBeenCalledTimes(1); // 一批状态变更 → 一次订阅回调
    expect(setDraft).toHaveBeenCalledWith('s1', '');
    expect(Object.keys(store.peekStream('s1')?.pendingSubmits ?? {})).toEqual(['cm-1']);
    expect(port.pendingSubmissions()).toEqual(['cm-1']);

    inputText('第二');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(Object.keys(store.peekStream('s1')?.pendingSubmits ?? {})).toEqual(['cm-1', 'cm-2']);
  });
});

describe('D-35 / D-36 装配级矩阵：繁忙设置 × 主按钮标签 × 组合键反向', () => {
  it('繁忙 + 偏好 queue：标签「排队发送」，Enter → queue-dock，Ctrl+Enter 反向用 steer', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    markRunning(store);
    const port = capturingPort({ store, controller, ids: ['cm-queue', 'cm-steer'] });
    renderSeat({ store, controller, busyEnter: 'queue', port });

    inputText('追问');
    expect(primary().getAttribute('data-kind')).toBe('send');
    expect(primary().textContent).toBe('排队发送');
    expect(primary().getAttribute('data-label-kind')).toBe('input.send.queue');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('queue');
    expect(port.submissions[0]?.placement).toBe('queue-dock');

    inputText('插话');
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[0]?.intent).toBe('steer');
    expect(port.submissions[1]?.placement).toBe('pending-steering');
  });

  it('繁忙 + 偏好 steer：标签「插话发送」，Enter → pending-steering，Ctrl+Enter 反向用 queue', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    markRunning(store);
    const port = capturingPort({ store, controller, ids: ['cm-steer', 'cm-queue'] });
    renderSeat({ store, controller, busyEnter: 'steer', port });

    inputText('改方向');
    expect(primary().textContent).toBe('插话发送');
    expect(primary().getAttribute('data-label-kind')).toBe('input.send.steer');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('steer');
    expect(port.submissions[0]?.placement).toBe('pending-steering');

    inputText('排队');
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[0]?.intent).toBe('queue');
    expect(port.submissions[1]?.placement).toBe('queue-dock');
  });

  it('空闲：标签普通「发送」，Enter → transcript；繁忙空草稿 → 同一位置切 Stop（不并列两按钮）', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    const port = capturingPort({ store, controller, ids: ['cm-1'] });
    renderSeat({ store, controller, port });

    inputText('你好');
    expect(primary().textContent).toBe('发送');
    expect(primary().getAttribute('data-label-kind')).toBe('input.send');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('queue');
    expect(port.submissions[0]?.placement).toBe('transcript');

    act(() => markRunning(store));
    expect(screen.getAllByTestId('composer-primary')).toHaveLength(1); // 主指针只此一颗
    expect(primary().getAttribute('data-kind')).toBe('stop');
    expect(primary().textContent).toBe('■ 停止');
  });

  it('繁忙 + `/` 命令行：保留普通「发送」标签（点击走命令裁定，不是插话/排队）', () => {
    const { store, controller } = boot();
    markRunning(store);
    renderSeat({ store, controller, busyEnter: 'steer' });
    inputText('/plan 做');
    expect(primary().textContent).toBe('发送');
    expect(primary().getAttribute('data-label-kind')).toBe('input.send');
  });
});

describe('D-37 装配级：上传并发 2 与失败不变序', () => {
  const files = (): { name: string; type: string; size: number }[] => [
    { name: 'a.bin', type: 'application/octet-stream', size: 1 },
    { name: 'b.bin', type: 'application/octet-stream', size: 1 },
    { name: 'c.bin', type: 'application/octet-stream', size: 1 },
  ];
  const attachmentIds = (): (string | null)[] =>
    [...screen.getByTestId('composer-attachments').querySelectorAll('[data-attachment-id]')].map((n) =>
      n.getAttribute('data-attachment-id'),
    );

  it('3 个文件同时选择：并发峰值 2（D-37 默认），附件顺序 = 选择顺序并随提交保序', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const transport: UploadTransport = {
      upload: async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(task.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { token: `tok-${task.id}` };
      },
    };
    const port = capturingPort({ store, controller, ids: ['cm-1'], transport });
    renderSeat({ store, controller, port });

    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: files() } });
    await wait(40);

    expect(peak).toBe(2); // maxConcurrentFileUploads 默认 2
    expect(started).toEqual(['att-s1-1', 'att-s1-2', 'att-s1-3']); // FIFO
    expect(attachmentIds()).toEqual(['att-s1-1', 'att-s1-2', 'att-s1-3']);
    expect(screen.getByTestId('composer-attachments').querySelectorAll('.att-queued, .att-uploading')).toHaveLength(0);

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const submission = port.submissions[0];
    expect(submission?.placement).toBe('transcript');
    expect(submission?.attachments.map((a) => a.name)).toEqual(['a.bin', 'b.bin', 'c.bin']);
    expect(submission?.attachments.map((a) => a.token)).toEqual(['tok-att-s1-1', 'tok-att-s1-2', 'tok-att-s1-3']);
    // 桥侧 references = chip 引用 + 已就绪附件引用（顺序 = 选择顺序）
    expect(submit.mock.calls[0]?.[0]?.references?.map((r) => r.id)).toEqual(['att-s1-1', 'att-s1-2', 'att-s1-3']);
  });

  it('一条上传失败：不阻塞其余、不丢附件、顺序不变；失败项不进 references（不伪造成功）', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    const transport: UploadTransport = {
      upload: async (task) => {
        if (task.name === 'b.bin') throw new Error('上传被拒');
        return { token: `tok-${task.id}` };
      },
    };
    const port = capturingPort({ store, controller, ids: ['cm-1'], transport });
    renderSeat({ store, controller, port });

    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: files() } });
    await wait(40);

    expect(attachmentIds()).toEqual(['att-s1-1', 'att-s1-2', 'att-s1-3']); // 顺序不变
    const failed = screen.getByTestId('composer-attachments').querySelector('.att-failed');
    expect(failed?.textContent).toContain('b.bin');
    expect(failed?.textContent).toContain('上传被拒');
    expect(screen.getByTestId('composer-attachments').querySelectorAll('.att-ready')).toHaveLength(2); // 其余照常完成

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const submission = port.submissions[0];
    expect(submission?.attachments.map((a) => a.name)).toEqual(['a.bin', 'b.bin', 'c.bin']); // 不丢、不错序
    // references 只取 ready：失败项不进上下文，也不伪造 token
    expect(submit.mock.calls[0]?.[0]?.references?.map((r) => r.id)).toEqual(['att-s1-1', 'att-s1-3']);
  });
});

describe('D-38 装配级：takeover 命中时默认 composer 保持挂载（hidden）', () => {
  it('命中 selector：渲染 takeover，默认 composer 未卸载（hidden）；切到非命中会话恢复可用且节点复用', () => {
    const chain = new ComposerChain();
    chain.register({
      owner: 'ui-business',
      select: (owner) => (owner.sessionId === 's1' ? { tag: 'request-1' } : null),
      component: (props) => <div data-testid="takeover-body">{(props.matched as { tag: string }).tag}</div>,
    });
    const { store, controller } = boot();
    renderSeat({ store, controller, chain });

    expect(screen.getByTestId('takeover-body').textContent).toBe('request-1');
    expect(screen.getByTestId('composer-default').hasAttribute('hidden')).toBe(true);
    const before = editor();
    expect(before).toBeTruthy(); // 默认 composer 仍在 DOM（未卸载）

    act(() => store.select('s2'));
    expect(screen.queryByTestId('composer-takeover')).toBeNull();
    expect(screen.getByTestId('composer-default').hasAttribute('hidden')).toBe(false);
    expect(editor()).toBe(before); // 常驻：未因 takeover 消失而重建
  });
});

// —— P5 修复棒（P0-1 trim / P0-2 还原 / P1-1 @引用 / P1-2 steer+拒绝 / P1-3 图片）——

describe('P0-1 提交边界 trim（上游 facade.ts:736,760 `defaultSink(draft.trim(), …)`）', () => {
  it('草稿含首尾空白：发出去的 rawText 已 trim；草稿内容本身不被改写', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    const port = createConversationComposerPort({ store, controller, createClientMessageId: () => 'cm-1' });
    renderSeat({ store, controller, port });

    inputText('  你好  ');
    expect(editor().textContent).toBe('  你好  '); // 草稿原样（不受 trim 影响）
    fireEvent.keyDown(editor(), { key: 'Enter' });

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]?.rawText).toBe('你好'); // 提交边界 trim
  });

  it('只有空白 + 无附件：不可提交（isDraftEmpty 判据不受 trim 影响）', () => {
    const { store, controller } = boot();
    renderSeat({ store, controller });
    inputText('   ');
    expect(primary().disabled).toBe(true);
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(primary().getAttribute('data-kind')).toBe('send');
    expect(screen.queryByTestId('composer-status')).toBeNull();
  });
});

describe('P0-2 装配级失败还原（上游 facade.ts:793-868）', () => {
  it('失败还原期间用户已输入新内容 → 不覆盖；附件仍然还给用户', async () => {
    let reject!: (error: unknown) => void;
    const failing = makeApi({
      submit: vi.fn(
        () =>
          new Promise<undefined>((_resolve, rej) => {
            reject = rej;
          }),
      ),
    });
    const transport: UploadTransport = { upload: async (task) => ({ token: `tok-${task.id}` }) };
    const { store, controller } = boot({ api: failing, select: 's1' });
    const port = createConversationComposerPort({ store, controller, createClientMessageId: () => 'cm-1' });
    renderSeat({ store, controller, port, transport });

    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'a.bin', type: 'application/octet-stream', size: 1 }] },
    });
    await wait(20);
    inputText('原提交内容');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(failing.submit).toHaveBeenCalledTimes(1));
    expect(editor().textContent).toBe(''); // 乐观清空

    inputText('用户新输入'); // 失败回来前用户继续输入
    expect(editor().textContent).toBe('用户新输入');

    await act(async () => {
      reject(new Error('提交未送达'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editor().textContent).toBe('用户新输入'); // 不被「原提交内容」覆盖
    expect(screen.getByTestId('composer-status').textContent).toContain('未被覆盖');
    // 附件仍还给用户（失败项可重提）
    expect(screen.getByTestId('composer-attachments').textContent).toContain('a.bin');
  });

  it('并发两个失败按提交顺序合并还原（同一会话两条 detached 提交）', async () => {
    const settle: Array<(error: unknown) => void> = [];
    const failing = makeApi({
      submit: vi.fn(
        () =>
          new Promise<undefined>((_resolve, rej) => {
            settle.push(rej);
          }),
      ),
    });
    const { store, controller } = boot({ api: failing });
    const ids = ['cm-1', 'cm-2'];
    let cursor = 0;
    const port = createConversationComposerPort({
      store,
      controller,
      createClientMessageId: () => ids[cursor++] ?? 'cm-x',
    });
    renderSeat({ store, controller, port });

    inputText('第一条');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    inputText('第二条');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(failing.submit).toHaveBeenCalledTimes(2));
    expect(settle).toHaveLength(2);

    // 倒序落定：仍按提交顺序合并
    await act(async () => {
      settle[1]?.(new Error('第二条失败'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      settle[0]?.(new Error('第一条失败'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editor().textContent).toBe('第一条\n\n第二条');
  });
});

describe('P1-1 @path 引用：真实入口 + 真实效果 + 如实提示（不静默）', () => {
  const files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' };

  it('点击「引用」按钮 → 输入路径 → 提交：references 含该文件，且前插入代码块进载荷', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const readRef = vi.fn<FileRefReader>(async (path: string) =>
      files[path] !== undefined
        ? { ok: true, content: files[path]!, truncated: false }
        : { ok: false, error: '未找到' },
    );
    const { store, api, controller } = boot({ api: makeApi({ submit }) });
    // 不注入 port：走 seat 内部组装的 port（读 props.readRef / createClientMessageId）
    renderSeat({ store, controller, createClientMessageId: () => 'cm-1', readRef });

    // 鼠标可达入口（P1-1：零入口 → 有入口）
    fireEvent.click(screen.getByTestId('composer-reference'));
    expect(editor().textContent).toBe('@');
    inputText('src/a.ts 看一下');
    expect(editor().textContent).toBe('@src/a.ts 看一下');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0]?.[0];
    expect(sent?.rawText).toContain('```');
    expect(sent?.rawText).toContain('export const a = 1;');
    expect(sent?.rawText).toContain('@src/a.ts 看一下');
    // 解析到的文件作为结构化引用（kind:'file' + 原 token），不是伪造的 clipboard 引用
    expect(sent?.references).toEqual([{ id: 'file-ref:src/a.ts', kind: 'file', path: 'src/a.ts' }]);
    expect(readRef).toHaveBeenCalledWith('src/a.ts', 'D:/proj'); // cwd 来自会话 header
    expect(api.readFileForRef).not.toHaveBeenCalled(); // 注入缝生效：没走 window.harness2
    // 引用来源可见（D1）：转录里显示「引用：src/a.ts(20B)」
    const report = await screen.findByLabelText('引用来源');
    expect(report.textContent).toContain('src/a.ts');
  });

  it('路径不存在：不静默 —— 载荷尾部带「未找到，已忽略」，UI 显示未找到且不产引用', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, api, controller } = boot({ api: makeApi({ submit }) }); // 默认 readRef = window.harness2 桩（ok:false）
    // 不注入 port：走 seat 内部组装的 port（默认 readRef = window.harness2.readFileForRef）
    renderSeat({ store, controller, createClientMessageId: () => 'cm-1' });

    inputText('@missing.ts 在吗');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0]?.[0];
    expect(api.readFileForRef).toHaveBeenCalledWith('missing.ts', 'D:/proj');
    expect(sent?.rawText).toBe('@missing.ts 在吗[missing.ts 未找到，已忽略]');
    expect(sent?.references).toEqual([]); // 未解析成功 → 不产引用（不假装引用成功）
    const report = await screen.findByLabelText('引用来源');
    expect(report.textContent).toContain('missing.ts 未找到');
  });
});

describe('P1-2 steer 的 expectedTurnId 与 rejected 可见（不静默）', () => {
  it('事件驱动进入繁忙（activeAttempt 为空）时 Ctrl+Enter steer 仍带正确 turnId', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    markRunning(store); // 事件路径：只置 running，不置 activeAttempt
    expect(store.peekStream('s1')?.activeAttempt).toBeUndefined();
    const port = createConversationComposerPort({ store, controller, createClientMessageId: () => 'cm-1' });
    renderSeat({ store, controller, port });

    inputText('改方向');
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]?.intent).toBe('steer');
    expect(submit.mock.calls[0]?.[0]?.expectedTurnId).toBe('t1'); // 与控制层同一推导（lastTurnIdOf）
  });

  it('core 返回 rejected：UI 显示原因且草稿恢复（消息不静默消失）', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    markRunning(store);
    const port = createConversationComposerPort({ store, controller, createClientMessageId: () => 'cm-1' });
    renderSeat({ store, controller, port });

    inputText('插话内容');
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(editor().textContent).toBe(''); // 乐观清空

    act(() => {
      store.applyFrame({
        type: 'submit-ack',
        sessionId: 's1',
        clientMessageId: 'cm-1',
        state: 'rejected',
        reason: 'intent=steer 需要 expectedTurnId（仅在该 turn 仍存在时接受）',
      });
    });

    await waitFor(() => expect(editor().textContent).toBe('插话内容')); // 内容还给用户
    const status = screen.getByTestId('composer-status');
    expect(status.getAttribute('data-kind')).toBe('error');
    expect(status.textContent).toContain('intent=steer 需要 expectedTurnId');
    // 可见队列里不再有这条（store 已移除），但用户看得到原因 + 内容，不是静默
    expect(store.peekStream('s1')?.submitAcks['cm-1']?.state).toBe('rejected');
  });

  it('accepted：不还原草稿（提交成功），状态行显示落点', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    const port = createConversationComposerPort({ store, controller, createClientMessageId: () => 'cm-1' });
    renderSeat({ store, controller, port });

    inputText('你好');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    act(() => {
      store.applyFrame({
        type: 'submit-ack',
        sessionId: 's1',
        clientMessageId: 'cm-1',
        state: 'accepted',
        queueSeq: 1,
      });
    });
    await wait(10);
    expect(editor().textContent).toBe('');
    expect(screen.getByTestId('composer-status').textContent).toContain('已发送（transcript）');
  });
});

describe('P1-3 图片不伪造 clipboard 引用（无图片通道 → 如实不可提交）', () => {
  it('图片附件：不产 references（尤其不产 kind:clipboard），列表如实标失败并说明', async () => {
    const submit = vi.fn<Harness2Api['submit']>(async () => undefined);
    const { store, controller } = boot({ api: makeApi({ submit }) });
    const imageIO: ImageReadIO = {
      createReader: () => {
        const reader: FileReaderLike = {
          result: 'data:image/png;base64,AAA',
          error: null,
          onload: null,
          onerror: null,
          readAsDataURL: () => {
            queueMicrotask(() => reader.onload?.());
          },
        };
        return reader;
      },
    };
    const port = createConversationComposerPort({ store, controller, createClientMessageId: () => 'cm-1' });
    renderSeat({ store, controller, port, imageIO });

    inputText('看这张图');
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'shot.png', type: 'image/png', size: 4 }] },
    });
    await wait(20);
    expect(screen.getByTestId('composer-attachments').querySelector('.att-failed')).not.toBeNull();
    expect(screen.getByTestId('composer-attachments').textContent).toContain('图片通道未实现');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0]?.[0];
    expect(sent?.references).toEqual([]); // 图片不产任何引用（旧实现伪造成 clipboard+文件名）
    expect(sent?.references?.some((r) => r.kind === 'clipboard')).toBe(false);
    expect(sent?.rawText).toBe('看这张图'); // 图片名不混进正文
  });
});

describe('P5-C 诚实性复核：缺口是显式事实，不是假实现/假数据', () => {
  it('上传通道缺失：默认 transport 如实 reject、文件附件显式标失败（不静默丢弃、不伪造 token）', async () => {
    await expect(
      desktopUploadTransport.upload({
        id: 't1',
        name: 'x.bin',
        mimeType: 'application/octet-stream',
        bytes: 1,
        file: null,
      }),
    ).rejects.toThrow(/未配置文件上传通道/);

    const { store, controller } = boot();
    renderSeat({ store, controller }); // 不注入 transport → 走 desktopUploadTransport
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [{ name: 'x.bin', type: 'application/octet-stream', size: 1 }] },
    });
    await wait(10);

    const list = screen.getByTestId('composer-attachments');
    expect(list.textContent).toContain('x.bin');
    expect(list.querySelector('.att-failed')).not.toBeNull();
    expect(list.textContent).toContain('未配置文件上传通道（主进程未暴露上传 IPC）');
  });

  it('繁忙态 Enter 无配置通道：缺省常量 = queue（装配层不伪造配置读取）', () => {
    expect(DEFAULT_BUSY_ENTER_BEHAVIOR).toBe('queue');
  });

  it('引用入口只有真实存在的两颗：附件 + 引用（不做点了没反应的 chip 选择器）', () => {
    const { store, controller } = boot();
    renderSeat({ store, controller });
    expect(
      [...document.querySelectorAll('.composer-actions button')].map((b) => b.getAttribute('data-testid')),
    ).toEqual(['composer-reference', 'composer-attach', 'composer-primary']);
    // 无 chip 原子节点：chip 只可能由业务 takeover 插入（当前无人插入，UI 不虚构 chip 入口）
    expect(document.querySelectorAll('[data-atom="chip"]')).toHaveLength(0);
  });
});
