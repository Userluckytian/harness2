// @vitest-environment jsdom
// 右栏标签宿主测试（Z2-04 / Z-13 / Z-14）：零 tab 启动器、按需开 tab、关闭回落、
// 审批徽章、D-86 openFile 路由（开「文件」tab + 自动开右栏）、新会话强制收起右栏。
// 装配级用例走 app.test.tsx 同款 bootApp 模式（真 App + fake window.harness2）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import type {
  ChangeSetShape,
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
    settingsGetSkills: vi.fn(async () => ({ skills: [], warnings: [], roots: { project: '', global: '' } })),
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: true, content: 'line1\nline2' })),
    listDir: vi.fn(async () => ({ ok: true as const, path: '', entries: [], truncated: false })),
    runConfig: vi.fn(async () => ({ redacted: true }) as never),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async (): Promise<ChangeSetShape> => ({
      sourceDir: '',
      files: [],
      changedFiles: 0,
      dirtyFiles: 0,
      readOnly: true,
    })),
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

  it('Z10-6：零 tab 启动器 = 标题 + 3 张 156×88 卡片（审查/终端/计划）；审查→changes tab、终端→底部 dock', async () => {
    await openRightbarExpectLauncher(makeFakeApi());
    const cards = [...document.querySelectorAll('[data-testid="side-pane-launcher-card"]')];
    expect(cards.map((c) => c.getAttribute('data-launcher-card'))).toEqual(['review', 'terminal', 'plan']);
    for (const c of cards) {
      expect((c as HTMLElement).style.width).toBe('156px');
      expect((c as HTMLElement).style.height).toBe('88px');
    }
    // 「终端」卡 = 跨 surface 真动作（底部 dock，Ctrl+J 同一真源）：开 dock 但不占右栏 tab
    expect(screen.getByTestId('terminal-toggle').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(document.querySelector('[data-launcher-card="terminal"]') as Element);
    await waitFor(() => expect(screen.getByTestId('terminal-toggle').getAttribute('aria-pressed')).toBe('true'));
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(0);
    // 「审查」卡 → 我们已有的变更 pane（changes），与 + 菜单同一打开入口
    fireEvent.click(document.querySelector('[data-launcher-card="review"]') as Element);
    expect(document.querySelector('[data-side-tab="changes"]')?.getAttribute('data-side-tab-active')).toBe('true');
    expect(screen.queryByTestId('side-pane-launcher')).toBeNull();
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

  it('Z4-02：文件 tab 行「评论」→ 引用块预填当前会话 composer（活草稿可见 + 经 setDraft 落盘）', async () => {
    const api = makeFakeApi();
    const App = (await bootApp(api)) as {
      App: () => React.ReactNode;
      store: { draftFor(id: string): string };
    };
    render(<App.App />);
    fireEvent.click(await screen.findByRole('button', { name: /第一句/ }));
    await screen.findByText('第一句回复');

    const { toolNavigation } = await import('@harness2/ui-shared/renderer/tool/index.js');
    act(() => {
      toolNavigation.openFile({ path: 'src/a.ts' });
    });
    // 文件 tab 行评论入口（fake readFileForRef 返回 line1/line2）
    // 注意：DTL v10 的 waitFor 对「同步返回 null」会立即以 null resolve —— 未就绪必须抛错
    const entry = await waitFor(() => {
      const el = document.querySelector('[data-file-preview-quote="1"]');
      if (el === null) throw new Error('行评论入口未渲染');
      return el;
    });
    fireEvent.click(entry);

    const editor = await waitFor(() => {
      const el = document.querySelector('[data-testid="composer-editor"]');
      if (el === null || (el.textContent ?? '').length === 0) throw new Error('composer 尚未收到引用块');
      return el;
    });
    expect(editor.textContent).toBe('`src/a.ts:1`\n> line1'); // 引用块真实写进 composer 草稿
    expect(App.store.draftFor('s1')).toBe('`src/a.ts:1`\n> line1'); // 既有订阅经 controller.setDraft 落盘
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

// —— Z2-08：右栏「后台任务」tab（启动器项按需可用 / 内容 / 跳转 / 空态 / 激活回落） ——

/** 一条会话事件（seq 手工指定：fake 重放占 seq 1..3，增量须更大才不被判重丢弃） */
function rawEvent(seq: number, type: string, payload: Record<string, unknown>): SessionEventShape {
  return { v: 1, seq, ts: '2026-10-11T00:00:00Z', type, payload };
}

/** 服务端权威任务快照帧（stream.tasks 的唯一同步方，resume-snapshot） */
function snapshotFrame(sessionId: string, tasks: unknown[]): WsFrame {
  return {
    type: 'resume-snapshot',
    sessionId,
    epoch: 1,
    snapshot: { epoch: 1, replay: { fromSeq: 0, toSeq: 0 }, tasks, pendingApprovals: [], queue: [] },
  } as unknown as WsFrame;
}

describe('右栏「后台任务」tab（Z2-08）', () => {
  it('启动器项按需可用：无后台任务 → 禁用 + title 说明（对齐 ZCode bash-output 语义，项常列保可发现）', async () => {
    await openRightbarExpectLauncher(makeFakeApi());
    fireEvent.keyDown(document.querySelector('[data-testid="side-pane-launcher-trigger"]') as Element, {
      key: 'Enter',
    });
    const item = document.querySelector('[data-side-menu-item="background-tasks"]') as Element;
    expect(item).not.toBeNull();
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toContain('暂无后台任务');
  });

  it('有后台任务 → 项可用；开 tab 渲染任务列表（taskId / 状态中文 chip / 会话归属），关 tab 回启动器', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    act(() => {
      api.emit(
        snapshotFrame('s1', [
          { taskId: 'bg-t1', background: true, state: 'running' },
          { taskId: 'bg-t2', background: true, state: 'waiting-approval', updatedAt: '2026-10-11T00:00:00Z' },
        ]),
      );
    });
    openTabFromLauncher('background-tasks');
    expect(document.querySelector('[data-side-tab="background-tasks"]')?.getAttribute('data-side-tab-active')).toBe(
      'true',
    );
    // 列表内容：非终态在前；中文 chip；会话归属
    await waitFor(() => expect(screen.getAllByTestId('bg-task-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('bg-task-row');
    expect(rows[0]?.getAttribute('data-bg-task-state')).toBe('waiting-approval');
    expect(rows[0]?.textContent).toContain('bg-t2');
    expect(rows[0]?.textContent).toContain('待审批');
    expect(rows[0]?.getAttribute('data-bg-task-session')).toBe('s1');
    expect(rows[1]?.textContent).toContain('运行中');
    // 关 tab → 回启动器
    fireEvent.click(document.querySelector('[data-side-tab-close="background-tasks"]') as Element);
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
  });

  it('任务可定位子会话 → 行可点，点击走 ToolCard 同款下钻（selectSession → 拉取子会话重放）；定位不了 → 只读行', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    act(() => {
      // 父会话事件流：subagent_start 的 result 输出 JSON 真实带 { taskId, childSessionId }
      api.emit({
        type: 'event',
        sessionId: 's1',
        event: rawEvent(10, 'tool/call', { callId: 'c1', tool: 'subagent_start', turnId: 't1' }),
      } as unknown as WsFrame);
      api.emit({
        type: 'event',
        sessionId: 's1',
        event: rawEvent(11, 'tool/result', {
          callId: 'c1',
          ok: true,
          output: JSON.stringify({ taskId: 'bg-c1', childSessionId: 'child-9', state: 'running' }),
        }),
      } as unknown as WsFrame);
      api.emit(
        snapshotFrame('s1', [
          { taskId: 'bg-c1', background: true, state: 'running' },
          { taskId: 'bg-lonely', background: true, state: 'queued' },
        ]),
      );
    });
    openTabFromLauncher('background-tasks');
    await waitFor(() => expect(screen.getAllByTestId('bg-task-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('bg-task-row');
    const jumpRow = rows.find((r) => r.textContent?.includes('bg-c1')) as HTMLElement;
    const readonlyRow = rows.find((r) => r.textContent?.includes('bg-lonely')) as HTMLElement;
    // 可定位 → 整行按钮 + 跳转标记；定位不了 → div 只读行（红线⑩：不摆假按钮）
    expect(jumpRow.tagName).toBe('BUTTON');
    expect(jumpRow.getAttribute('data-bg-task-jump')).toBe('child-9');
    expect(jumpRow.getAttribute('title')).toBe('打开子会话 child-9 轨迹');
    expect(readonlyRow.tagName).toBe('DIV');
    expect(readonlyRow.hasAttribute('data-bg-task-jump')).toBe(false);
    // 点击 → 既有下钻通道（selectSession：subscribe + events 重放子会话）
    fireEvent.click(jumpRow);
    await waitFor(() => expect(api.events).toHaveBeenCalledWith('child-9'));
  });

  it('任务清空（resume-snapshot 权威空表）→ 已开的 tab 如实显示「暂无后台任务」空态', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    act(() => {
      api.emit(snapshotFrame('s1', [{ taskId: 'bg-t1', background: true, state: 'running' }]));
    });
    openTabFromLauncher('background-tasks');
    await waitFor(() => expect(screen.getByTestId('bg-tasks-list')).toBeTruthy());
    act(() => {
      api.emit(snapshotFrame('s1', []));
    });
    await waitFor(() => expect(screen.getByTestId('bg-tasks-empty').textContent).toContain('暂无后台任务'));
  });

  it('激活回落：background-tasks 与 plan 同开，关 background-tasks → 回落左邻 plan', async () => {
    const api = makeFakeApi();
    await openRightbarExpectLauncher(api);
    act(() => {
      api.emit(snapshotFrame('s1', [{ taskId: 'bg-t1', background: true, state: 'running' }]));
    });
    openTabFromLauncher('plan');
    openTabFromLauncher('background-tasks');
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(2);
    fireEvent.click(document.querySelector('[data-side-tab-close="background-tasks"]') as Element);
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(1);
    expect(document.querySelector('[data-side-tab="plan"]')?.getAttribute('data-side-tab-active')).toBe('true');
  });
});
