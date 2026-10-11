// web 壳装配级测试（Z7）：四席位骨架与桌面同构 ——
//   1. 四席位（sidebar / main / rightbar / shell.overlay）按序渲染，骨架来自 ui-shared；
//   2. 侧栏 264 展开 / 4px 折叠（内容只隐藏不卸载）+ 左上浮层 New Task 随折叠出现；
//   3. 右栏开关 + 零 tab 启器 + 与桌面同一套启动器清单（8 项 tab 打开与关闭）；
//   4. 下沉面板在 web 真能取数渲染：计划 / 任务 / 变更 / 工作区 / 配置 / 模型轨迹的
//      打开 / 空态 / 数据到达；「文件」不在启动器清单（web 无 openFile 通道，如实不列）。
// 数据来自假端口（HarnessClient），不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { sidePaneStore } from '@harness2/ui-shared/renderer/side-pane/index.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type {
  ConnectionStatus,
  EffectiveRunConfigShape,
  PlanStateShape,
  SessionEventShape,
  SessionSummaryShape,
  WsFrame,
} from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';

afterEach(() => {
  cleanup();
  // 右栏 tab 状态是**模块级单例**（Z-13：内存 Map，D-14 不落盘）——测试间显式清桶，
  // 否则上一用例留在桶里的 tab 会让下一用例没有「零 tab 启动器」。
  sidePaneStore.closeAll('s1');
  sidePaneStore.closeAll('(no-session)');
});

const SESSION: SessionSummaryShape = {
  id: 's1',
  dir: '/tmp/s1',
  cwd: '/work',
  mtimeMs: 1000,
  firstUserText: '第一个会话',
  messageCount: 2,
  lastSeq: 0,
};

const frameListeners = new Set<(frame: WsFrame) => void>();
function emitFrame(frame: WsFrame): void {
  for (const listener of [...frameListeners]) listener(frame);
}

function fakeClient(sessions: SessionSummaryShape[] = [SESSION]): HarnessClient {
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  return {
    listSessions: async () => sessions,
    createSession: async () => ({ id: 's2' }),
    events: async (id) => ({
      id,
      dir: `/tmp/${id}`,
      header: { sessionId: id, cwd: '/work' },
      events: [],
      warnings: [],
      lastSeq: 0,
    }),
    subscribe: async () => undefined,
    sendMessage: async () => undefined,
    abort: async () => undefined,
    respondApproval: async () => undefined,
    getStatus: async () => ({ status: 'connected' }),
    onEvent: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onConnectionStatus: (listener) => {
      statusListeners.add(listener);
      listener('connected');
      return () => statusListeners.delete(listener);
    },
    submit: async () => undefined,
    cancel: async () => undefined,
    resumeSubscription: async () => undefined,
    fork: async () => undefined,
    undo: async () => ({ results: [] }),
    redo: async () => ({ results: [] }),
    runConfig: async () => {
      throw new Error('未提供');
    },
    planState: async () => null,
    executionViews: async () => [],
    changeReview: async () => ({ sourceDir: '/work', files: [], changedFiles: 0, dirtyFiles: 0, readOnly: true }),
  };
}

async function mount(options: { client?: HarnessClient } = {}) {
  const shell = createAppShell(options.client ?? fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(React.createElement(WebApp, { shell, onNewSession: () => undefined }));
  return { shell, stop };
}

/** 选中会话（会话列头/右栏开关随后才渲染，与桌面同一时序） */
async function selectSession(shell: Awaited<ReturnType<typeof mount>>['shell']): Promise<void> {
  fireEvent.click(screen.getByText('第一个会话'));
  await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
}

/** 经启动器加号打开一个 tab（Radix 菜单：Enter 开 → 点条目） */
function openTabFromLauncher(id: string): void {
  const trigger = document.querySelector('[data-testid="side-pane-launcher-trigger"]') as Element;
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(document.querySelector(`[data-side-menu-item="${id}"]`) as Element);
}

describe('Z7 四席位骨架（与桌面同构）', () => {
  it('内建 root 槽按序装配 sidebar → main → rightbar → shell.overlay，骨架来自 ui-shared', async () => {
    const { stop } = await mount();
    const seats = [...document.querySelectorAll('[data-seat]')].map((n) => n.getAttribute('data-seat'));
    expect(seats).toEqual(['sidebar', 'main', 'rightbar', 'shell.overlay']);
    // 侧栏席位内容 = 共享 SidebarRoot
    expect(document.querySelector('[data-seat="sidebar"] [data-testid="sidebar-root"]')).not.toBeNull();
    // 中栏席位内容 = 共享会话席位
    expect(document.querySelector('[data-seat="main"] [data-testid="conversation-seat"]')).not.toBeNull();
    // 右栏默认收起（hidden 不占布局）
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true);
    // 覆层席位零注入（web 无设置页 / 命令面板通道）→ 无任何 slot 内容（不摆假入口）
    expect(document.querySelectorAll('[data-seat="shell.overlay"] .slot-entry').length).toBe(0);
    stop();
  });

  it('左上浮层（FrameTopOverlay）在场：展开时不显示 New Task', async () => {
    const { stop } = await mount();
    const overlay = screen.getByTestId('web-top-overlay');
    expect(overlay.getAttribute('data-height')).toBe('48');
    expect(overlay.getAttribute('data-collapsed')).toBe('false');
    expect(screen.queryByRole('button', { name: 'New Task' })).toBeNull();
    stop();
  });
});

describe('Z7 侧栏折叠 264 → 4px', () => {
  it('折叠后容器 4px、内容只隐藏不卸载；左上浮层出现 New Task 且可再展开', async () => {
    const { stop } = await mount();
    const sidebar = document.querySelector('[data-seat="sidebar"]');
    expect(sidebar?.getAttribute('data-width')).toBe('264');
    expect(sidebar?.getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    expect(sidebar?.getAttribute('data-width')).toBe('4');
    expect(sidebar?.getAttribute('data-collapsed')).toBe('true');
    // 只隐藏不卸载：SidebarRoot 仍在 DOM
    expect(document.querySelector('[data-testid="sidebar-root"]')).not.toBeNull();
    // 浮层折叠态：New Task 出现，宽度转 w-fit（不写内联宽）
    const overlay = screen.getByTestId('web-top-overlay');
    expect(overlay.getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByRole('button', { name: 'New Task' })).toBeTruthy();

    // 经浮层折叠按钮再展开回 264
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(sidebar?.getAttribute('data-width')).toBe('264');
    stop();
  });
});

describe('Z7 右栏开关与 tab 启器（web 白名单）', () => {
  it('打开右栏零 tab → 启动器（无标签条）；启动器与桌面同清单（8 项 web 都能取数）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();

    // Z7-a：面板下沉 ui-shared 后，web 与桌面列同一套启动器清单：
    // 计划 / 任务 / 后台任务 / 审批 / 变更 / 工作区 / 配置 / 模型轨迹。
    fireEvent.keyDown(document.querySelector('[data-testid="side-pane-launcher-trigger"]') as Element, {
      key: 'Enter',
    });
    const ids = [...document.querySelectorAll('[data-side-menu-item]')].map((n) =>
      n.getAttribute('data-side-menu-item'),
    );
    expect(ids).toEqual([
      'plan',
      'tasks',
      'background-tasks',
      'approvals',
      'changes',
      'workspace',
      'config',
      'model-trajectory',
    ]);
    // 「文件」靠 D-86 openFile 路由按需打开（不在启动器清单；web 无该通道）——如实不列。
    expect(ids).not.toContain('file');
    stop();
  });

  it('打开审批 tab → 标签条出现并激活；无待批 → 如实空态；关闭 → 回启动器', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    openTabFromLauncher('approvals');
    expect(screen.queryByTestId('side-pane-launcher')).toBeNull();
    expect(document.querySelector('[data-side-tab="approvals"]')?.getAttribute('data-side-tab-active')).toBe('true');
    // 共享 ApprovalCenter（与桌面同一实现）——空态文案一致
    expect(screen.getByText(/无待批事项/)).toBeTruthy();
    expect(document.querySelector('.approval-center')).not.toBeNull();

    fireEvent.click(document.querySelector('[data-side-tab-close="approvals"]') as Element);
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
    stop();
  });

  it('审批数据到达 → 标签徽标显示计数 + 卡片可响应（与桌面同一 store 口径）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    emitFrame({
      v: 1,
      seq: 99,
      ts: '2026-10-11T00:00:01Z',
      type: 'approval-request',
      sessionId: 's1',
      requestId: 'r1',
      tool: 'bash',
      args: { cmd: 'ls' },
      active: true,
    } as unknown as WsFrame);
    openTabFromLauncher('approvals');
    await waitFor(() => expect(screen.getAllByText('允许').length).toBeGreaterThan(0));
    expect(document.querySelector('[data-side-badge="approvals"]')?.textContent).toBe('1');
    stop();
  });

  it('右栏可再收起（aria-pressed 反映开合）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    const toggle = screen.getByTestId('web-rightbar-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true));
    stop();
  });
});

// —— Z7-a：下沉 ui-shared 的面板在 web 真能取数渲染（每 tab 打开 / 空态 / 数据到达） ——

/** 完整 run-config（config / workspace tab 的数据到达用；形状与 S7 /run-config 一致） */
const RUN_CONFIG: EffectiveRunConfigShape = {
  session: { sessionId: 's1', root: '/work', cwd: '/work/s1', perSessionCwd: true },
  provider: { role: 'main', channel: 'openai', model: 'gpt-mock', protocol: 'openai', name: 'mock' },
  approval: { mode: 'default', tools: {} },
  modes: { memory: 'off' },
  tools: ['bash', 'read'],
  connection: { status: 'connected' as EffectiveRunConfigShape['connection']['status'] },
  instructions: { skills: [] },
  context: {
    contextWindow: 128_000,
    retry: { maxExtraAttempts: 0, backoffSeconds: [], maxExtraPerTurn: 0, maxTotalWaitSeconds: 0 },
  },
  snapshot: { revision: 1, capturedAt: '2026-10-11T00:00:00Z', effectiveAt: '2026-10-11T00:00:00Z' },
  redacted: true,
};

/** 带计划账本的 plan-state（证据齐全） */
const PLAN_STATE: PlanStateShape = {
  planId: 'p1',
  goal: '做一个东西',
  steps: [
    {
      stepId: 'st1',
      state: 'running',
      evidence: { source: 'runtime-journal', taskId: 't1', journalSeqs: [1] },
    },
  ],
  readOnly: true,
  sourceDir: '/work/s1',
};

/** 假客户端：提供真实只读端点数据（反证 web 面板走真数据通道，不是摆假入口） */
function dataClient(overrides: Partial<HarnessClient> = {}): HarnessClient {
  return {
    ...fakeClient(),
    runConfig: async () => RUN_CONFIG,
    planState: async () => PLAN_STATE,
    ...overrides,
  };
}

describe('Z7-a 下沉面板在 web 渲染（打开 / 空态 / 数据到达）', () => {
  it('计划 tab：数据到达 → 渲染目标与步骤证据（共享 PlanPanel）', async () => {
    const { shell, stop } = await mount({ client: dataClient() });
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(shell.store.peekViews('s1')?.planState).toBeDefined());
    openTabFromLauncher('plan');
    expect(document.querySelector('[data-side-tab="plan"]')?.getAttribute('data-side-tab-active')).toBe('true');
    expect(screen.getByText(/做一个东西/)).toBeTruthy();
    expect(document.querySelector('.plan-panel')).not.toBeNull();
    stop();
  });

  it('任务 tab：无任务快照 → 如实空态（不显示占位任务）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    openTabFromLauncher('tasks');
    expect(screen.getByText(/本会话暂无任务快照/)).toBeTruthy();
    stop();
  });

  it('变更 tab：空变更集 → 如实空态（本会话暂无可审查的文件变更）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(shell.store.peekViews('s1')?.changeReview).toBeDefined());
    openTabFromLauncher('changes');
    expect(screen.getByText(/本会话暂无可审查的文件变更/)).toBeTruthy();
    stop();
  });

  it('工作区 tab：run-config 到达 → 显示会话 cwd（真数据）', async () => {
    const { shell, stop } = await mount({ client: dataClient() });
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(shell.store.peekViews('s1')?.runConfig).toBeDefined());
    openTabFromLauncher('workspace');
    expect(document.querySelector('.workspace-panel')).not.toBeNull();
    expect(screen.getByText(/\/work\/s1/)).toBeTruthy();
    stop();
  });

  it('配置 tab：run-config 到达 → 显示有效配置；无 getContextUsage 通道则不显示占用', async () => {
    const { shell, stop } = await mount({ client: dataClient() });
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(shell.store.peekViews('s1')?.runConfig).toBeDefined());
    openTabFromLauncher('config');
    expect(document.querySelector('.config-panel')).not.toBeNull();
    expect(screen.getByText(/openai/)).toBeTruthy();
    // web 无上下文占用读通道 → 不显示「当前占用」注记（不摆假数据）
    expect(screen.queryByText(/当前占用/)).toBeNull();
    stop();
  });

  it('配置 tab：run-config 缺失 → 如实空态（不摆占位配置）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    openTabFromLauncher('config');
    expect(document.querySelector('.config-panel')).not.toBeNull();
    // run-config 拉取失败 → 如实呈现失败原因（或尚未载入），绝不摆占位配置
    expect(screen.getByText(/未提供|尚未载入有效配置/)).toBeTruthy();
    stop();
  });

  it('模型轨迹 tab：无事件 → 如实空态（需要至少一条记录）', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    openTabFromLauncher('model-trajectory');
    expect(document.querySelector('[data-side-tab="model-trajectory:s1"]')).not.toBeNull();
    expect(screen.getByText(/还没有可投影的事件/)).toBeTruthy();
    stop();
  });

  it('模型轨迹 tab：事件到达 → 记录表非空渲染（与桌面同源投影）', async () => {
    const events: Array<SessionEventShape & { active: boolean }> = [
      {
        v: 1,
        seq: 1,
        ts: '2026-10-11T00:00:00Z',
        type: 'user/message',
        payload: { text: '你好', turnId: 't1' },
        active: true,
      },
      {
        v: 1,
        seq: 2,
        ts: '2026-10-11T00:00:01Z',
        type: 'assistant/message',
        payload: { text: '回复', model: 'mock/m', turnId: 't1' },
        active: true,
      },
    ];
    const client = dataClient({
      events: async (id) => ({
        id,
        dir: `/tmp/${id}`,
        header: { sessionId: id, cwd: '/work' },
        events,
        warnings: [],
        lastSeq: 2,
      }),
    });
    const { shell, stop } = await mount({ client });
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    openTabFromLauncher('model-trajectory');
    await waitFor(() => {
      const panel = document.querySelector('[data-testid="trajectory-panel"]');
      expect(panel?.getAttribute('data-empty')).toBe('false');
    });
    stop();
  });
});
