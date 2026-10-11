// web 壳装配级测试（Z7）：四席位骨架与桌面同构 ——
//   1. 四席位（sidebar / main / rightbar / shell.overlay）按序渲染，骨架来自 ui-shared；
//   2. 侧栏 264 展开 / 4px 折叠（内容只隐藏不卸载）+ 左上浮层 New Task 随折叠出现；
//   3. 右栏开关 + 零 tab 启器 + web 白名单 tab（审批 / 后台任务）打开与关闭；
//   4. 数据缺失/无通道时如实空态与省略（覆层零注入、启动器只列 web 真能取数的 tab）。
// 数据来自假端口（HarnessClient），不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape, WsFrame } from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';

afterEach(cleanup);

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
  it('打开右栏零 tab → 启动器（无标签条）；启动器只列 web 真能取数的 tab', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    await waitFor(() => expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(false));
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();

    // 展开启动器菜单：只有 web 真实具备的 approvals / background-tasks（其余 = 无通道，如实不列）
    fireEvent.keyDown(document.querySelector('[data-testid="side-pane-launcher-trigger"]') as Element, {
      key: 'Enter',
    });
    const ids = [...document.querySelectorAll('[data-side-menu-item]')].map((n) =>
      n.getAttribute('data-side-menu-item'),
    );
    expect(ids).toEqual(['approvals', 'background-tasks']);
    // 明确断言被省略的 tab 不在列表（红线⑩：不摆假入口）
    for (const omitted of ['plan', 'tasks', 'changes', 'workspace', 'config', 'file', 'model-trajectory']) {
      expect(ids).not.toContain(omitted);
    }
    stop();
  });

  it('打开审批 tab → 标签条出现并激活；无待批 → 如实空态；关闭 → 回启动器', async () => {
    const { shell, stop } = await mount();
    await selectSession(shell);
    fireEvent.click(screen.getByTestId('web-rightbar-toggle'));
    openTabFromLauncher('approvals');
    expect(screen.queryByTestId('side-pane-launcher')).toBeNull();
    expect(document.querySelector('[data-side-tab="approvals"]')?.getAttribute('data-side-tab-active')).toBe('true');
    expect(screen.getByTestId('web-approvals-empty')).toBeTruthy();

    fireEvent.click(document.querySelector('[data-side-tab-close="approvals"]') as Element);
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    expect(screen.getByTestId('side-pane-launcher-trigger')).toBeTruthy();
    stop();
  });

  it('审批数据到达 → tab 标签徽标显示计数（与桌面同一 store 口径）', async () => {
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
    await waitFor(() => expect(screen.getByTestId('web-approvals-list')).toBeTruthy());
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
