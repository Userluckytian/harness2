// D5 工作区切换测试（F1）：A/B 项目 root/cwd 不串、草稿不串、分叉不改原会话。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import type { EffectiveRunConfigShape, Harness2Api, SessionEventsPayloadShape } from '../src/shared/protocol.js';

function runConfig(sessionId: string, root: string, cwd: string): EffectiveRunConfigShape {
  return {
    session: { sessionId, root, cwd, perSessionCwd: true },
    provider: {
      role: 'main',
      channel: 'local-oai',
      model: 'big-pickle',
      protocol: 'openai',
      name: 'local-oai/big-pickle',
    },
    approval: { mode: 'default', tools: {} },
    modes: { memory: 'off' },
    tools: ['bash', 'write'],
    connection: { status: 'unknown' },
    instructions: { skills: [] },
    context: {
      retry: { maxExtraAttempts: 3, backoffSeconds: [2, 10, 30], maxExtraPerTurn: 6, maxTotalWaitSeconds: 120 },
    },
    snapshot: { revision: 0, capturedAt: 't', effectiveAt: 't' },
    redacted: true,
  };
}

const events = (id: string): SessionEventsPayloadShape => ({
  id,
  dir: 'd',
  header: { sessionId: id },
  events: [{ v: 1, seq: 1, ts: 't', type: 'session/header', payload: { sessionId: id }, active: true }],
  warnings: [],
  lastSeq: 1,
});

describe('A/B 项目不串（F1）', () => {
  it('两会话各自 run-config cwd 独立；草稿隔离；切换不覆盖对方', async () => {
    const store = new AppStore();
    const configs: Record<string, EffectiveRunConfigShape> = {
      A: runConfig('A', 'C:\\projA', 'C:\\projA'),
      B: runConfig('B', 'C:\\projB', 'C:\\projB'),
    };
    const api = {
      listSessions: vi.fn(async () => [
        { id: 'A', dir: 'd', mtimeMs: 2, firstUserText: 'A 问题', messageCount: 1, lastSeq: 1 },
        { id: 'B', dir: 'd', mtimeMs: 1, firstUserText: 'B 问题', messageCount: 1, lastSeq: 1 },
      ]),
      runConfig: vi.fn(async (id: string) => configs[id]!),
      planState: vi.fn(async () => null),
      executionViews: vi.fn(async () => []),
      changeReview: vi.fn(async () => ({
        sourceDir: 'd',
        files: [],
        changedFiles: 0,
        dirtyFiles: 0,
        readOnly: true as const,
      })),
      events: vi.fn(async (id: string) => events(id)),
      subscribe: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => {}),
      onConnectionStatus: vi.fn(() => () => {}),
      getStatus: vi.fn(async () => ({ status: 'connected' as const })),
      capabilities: vi.fn(async () => ({ probedAt: 't', entries: [] })),
      draftsGet: vi.fn(async () => ({})),
      draftsSet: vi.fn(async (d: Record<string, string>) => d),
      metadataGet: vi.fn(async () => ({})),
      loadLayout: vi.fn(async () => ({ panes: [{ sessionId: null }] })),
    } as unknown as Harness2Api;

    const controller = createController(store, api);
    await controller.refreshSessions();

    // A：载入配置 + 写草稿
    await controller.selectSession('A');
    await controller.refreshRunConfig('A');
    store.setDraft('A', 'A 的草稿：读 README 讲结构');

    // 切 B
    await controller.selectSession('B');
    await controller.refreshRunConfig('B');
    store.setDraft('B', 'B 的草稿：另一个项目');

    // 回 A：配置与草稿各自保留，不串
    await controller.selectSession('A');
    expect(store.peekViews('A')!.runConfig!.session.cwd).toBe('C:\\projA');
    expect(store.peekViews('B')!.runConfig!.session.cwd).toBe('C:\\projB');
    expect(store.draftFor('A')).toContain('README');
    expect(store.draftFor('B')).toContain('另一个项目');
    expect(store.draftFor('A')).not.toContain('另一个项目');
  });

  it('P1-1 接线：assignToPane 指派会话到分栏 = 同步选中 + 拉齐六页签数据源 + 权威重订阅', async () => {
    // SidePanel 六个页签全部以 state.selectedId 取数（SidePanel.tsx:26）；
    // 拖拽入栏 / 分叉入栏（SessionList.tsx:95、ChatView.tsx:37、PaneArea.tsx:52）的主路径是
    // controller.assignToPane —— 它必须与 selectSession 同口径：select + refreshAllViews +
    // refreshAuthoritativeState，否则分屏右侧数据源永不写入（恒为空）。
    const store = new AppStore();
    const resumeCalls: Array<{ id: string; lastSeq: number; epoch: number }> = [];
    const saveLayout = vi.fn(async () => undefined);
    const api = {
      listSessions: vi.fn(async () => [
        { id: 'A', dir: 'd', mtimeMs: 2, firstUserText: 'A 问题', messageCount: 1, lastSeq: 1 },
        { id: 'B', dir: 'd', mtimeMs: 1, firstUserText: 'B 问题', messageCount: 1, lastSeq: 1 },
      ]),
      runConfig: vi.fn(async (id: string) => runConfig(id, `C:\\proj${id}`, `C:\\proj${id}`)),
      planState: vi.fn(async () => null),
      executionViews: vi.fn(async () => []),
      changeReview: vi.fn(async () => ({
        sourceDir: 'd',
        files: [],
        changedFiles: 0,
        dirtyFiles: 0,
        readOnly: true as const,
      })),
      events: vi.fn(async (id: string) => events(id)),
      subscribe: vi.fn(async () => undefined),
      resumeSubscription: vi.fn(async (id: string, lastSeq: number, epoch: number) => {
        resumeCalls.push({ id, lastSeq, epoch });
      }),
      saveLayout,
      getStatus: vi.fn(async () => ({ status: 'connected' as const })),
    } as unknown as Harness2Api;

    const controller = createController(store, api);
    store.applyStatus('connected'); // 视图拉齐/权威重订阅只在 connected 下发生（与 selectSession 同口径）
    await controller.refreshSessions();
    await controller.selectSession('A');
    expect(store.getState().selectedId).toBe('A');
    store.applyPaneCount(2); // 用户先开双栏（UI 的 setPaneCount），再拖 B 入第 2 栏

    // 用户把 B 拖入第 2 分栏（未经 selectSession('B')——这正是缺陷路径）
    await controller.assignToPane(1, 'B');

    // ① 选中同步：SidePanel 的数据源切到 B
    expect(store.getState().selectedId).toBe('B');
    // ② 六页签数据源已为 B 写入（run-config 视图非空且归属正确）
    expect(store.peekViews('B')?.runConfig?.session.cwd).toBe('C:\\projB');
    // ③ 权威在途状态重订阅：selectSession('A') 一次 + assignToPane('B') 一次（replay 后 lastSeq=1，epoch 0→1）
    expect(resumeCalls.map((c) => c.id)).toEqual(['A', 'B']);
    expect(resumeCalls[1]).toEqual({ id: 'B', lastSeq: 1, epoch: 1 });
    // ④ 分栏绑定与布局持久化保持原有行为
    expect(store.getState().layout.panes[1]?.sessionId).toBe('B');
    expect(saveLayout).toHaveBeenCalledTimes(1);
  });

  it('分叉：调用 fork 原会话 id，不修改原会话（无本地状态改写）', async () => {
    const store = new AppStore();
    const fork = vi.fn(async () => undefined);
    const api = {
      fork,
      listSessions: vi.fn(async () => []),
    } as unknown as Harness2Api;
    const controller = createController(store, api);
    await controller.forkSession('A', 7);
    expect(fork).toHaveBeenCalledWith('A', 7);
    // 原会话草稿/选择不受影响
    expect(store.getState().selectedId).toBeNull();
  });
});
