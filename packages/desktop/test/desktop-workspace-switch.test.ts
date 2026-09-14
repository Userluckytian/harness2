// D5 工作区切换测试（F1）：A/B 项目 root/cwd 不串、草稿不串、分叉不改原会话。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import { createController } from '@harness2/ui-shared/renderer/app-controller.js';
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

  it('P1-3 裁决：pane 状态无写出口（无 setPaneCount/assignToPane/persistLayout）；旧布局文件只读兼容', async () => {
    // 背景：分栏（pane）状态自 P4-C 起已无渲染出口，但 P1-3 前仍留着写出口
    //（controller.setPaneCount/assignToPane → store.applyPaneCount/assignToPane → persistLayout → IPC saveLayout）。
    // 裁决：保留旧 desktop-layout.json 的**读取**兼容，删掉全部**写入**路径（option b）。
    const store = new AppStore();
    const saveLayout = vi.fn(async () => undefined);
    const loadLayout = vi.fn(async () => ({ panes: [{ sessionId: 'legacy' }] }));
    const api = {
      loadLayout,
      saveLayout,
      listSessions: vi.fn(async () => []),
      subscribe: vi.fn(async () => undefined),
      events: vi.fn(async () => events('legacy')),
    } as unknown as Harness2Api;

    const controller = createController(store, api);

    // ① 读取兼容：旧文件被读入并按 normalizeLayout 校验（历史绑定原样保留在 store 里）
    await controller.initLayout();
    expect(loadLayout).toHaveBeenCalledTimes(1);
    expect(store.getState().layout.panes).toEqual([{ sessionId: 'legacy' }]);

    // ② 写出口已删除：controller/store 都不再有 pane 写入方法
    expect('setPaneCount' in controller).toBe(false);
    expect('assignToPane' in controller).toBe(false);
    expect('applyPaneCount' in store).toBe(false);
    expect('assignToPane' in store).toBe(false);

    // ③ 打开会话的唯一路径是 selectSession：不写 pane 绑定，也不触发任何布局持久化
    await controller.selectSession('legacy');
    expect(store.getState().selectedId).toBe('legacy');
    expect(store.getState().layout.panes).toEqual([{ sessionId: 'legacy' }]); // 未被改写
    expect(saveLayout).not.toHaveBeenCalled();
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
