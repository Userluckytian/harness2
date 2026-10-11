// web 分屏工作台测试（Z7，Z-19）：web 主区改为共享 WorkbenchHost（二叉分割树 ≤4 格）——
//   1. 单格时与旧结构等价（无分隔条 / 关闭按钮 / 分屏痕迹）；
//   2. 侧栏会话行可拖进主区：边缘投放生成第二格（非主格带浮动关闭按钮）；
//   3. 关闭格 ≠ 停止会话（会话仍在 store、未触发 abort）；
//   4. 上限 4 格：第 5 格投放被拒并给出可见提示；
//   5. 已在分屏中的会话在侧栏禁用拖拽（拖拽源可用性）。
// 真渲染 WebApp（含真 controller + workbenchStore 单例）；只有 HarnessClient 是假端口。
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { workbenchDrag } from '@harness2/ui-shared/renderer/layout/workbench/drag.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';

const IDS = ['a', 'b', 'c', 'd', 'e'] as const;
const LABELS: Record<string, string> = { a: '会话A', b: '会话B', c: '会话C', d: '会话D', e: '会话E' };

const SESSIONS: SessionSummaryShape[] = IDS.map((id, index) => ({
  id,
  dir: `/tmp/${id}`,
  cwd: '/work',
  mtimeMs: IDS.length - index,
  firstUserText: LABELS[id]!,
  messageCount: 1,
  lastSeq: 0,
}));

function fakeClient(): HarnessClient {
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  return {
    listSessions: async () => SESSIONS,
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
    abort: vi.fn(async () => undefined),
    respondApproval: async () => undefined,
    getStatus: async () => ({ status: 'connected' }),
    onEvent: () => () => undefined,
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

async function mount(): Promise<{
  shell: Awaited<ReturnType<typeof createAppShell>>;
  stop: () => void;
  client: HarnessClient;
}> {
  const client = fakeClient();
  const shell = createAppShell(client);
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(React.createElement(WebApp, { shell, onNewSession: () => undefined }));
  return { shell, stop, client };
}

function stubRect(element: HTMLElement, width = 200, height = 100): void {
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function panes(): number {
  return Number(screen.getByTestId('workbench-root').getAttribute('data-panes'));
}

/** 选中会话 A（工作台主格绑定它，与桌面同一绑定口径） */
async function selectA(shell: Awaited<ReturnType<typeof createAppShell>>): Promise<void> {
  fireEvent.click(screen.getByText('会话A'));
  await waitFor(() => expect(shell.store.getState().selectedId).toBe('a'));
}

/** 从侧栏行拖入主区某格边缘（走真实 dragstart 置位在途载荷 + dragover/drop 坐标定落点） */
function dragRowToEdge(sessionId: string, pane: HTMLElement, x: number, y: number): void {
  const row = document.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement;
  fireEvent.dragStart(row);
  act(() => {
    pane.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
  act(() => {
    pane.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

beforeEach(() => {
  workbenchDrag.end();
  workbenchStore.reset();
});

afterEach(() => {
  cleanup();
  workbenchDrag.end();
  workbenchStore.reset();
});

describe('web 分屏：单格无痕迹（与旧结构等价）', () => {
  it('单格：无分隔条 / 无关闭按钮 / 无落点预览，主格渲染完整 web 会话头', async () => {
    const { shell, stop } = await mount();
    await selectA(shell);
    expect(panes()).toBe(1);
    expect(screen.getAllByTestId('workbench-pane')).toHaveLength(1);
    expect(screen.queryByTestId('workbench-splitter')).toBeNull();
    expect(screen.queryByTestId('pane-close')).toBeNull();
    expect(screen.queryByTestId('workbench-pane-header')).toBeNull();
    // 主格用 web 完整会话头（标题 + 右栏开关）
    expect(document.querySelector('.web-conversation-header')).not.toBeNull();
    expect(screen.getByTestId('web-rightbar-toggle')).toBeTruthy();
    stop();
  });
});

describe('web 分屏：侧栏拖入生成第二格', () => {
  it('拖会话B落在右边缘 → 第二格（row 分割）；B 行在侧栏禁用拖拽', async () => {
    const { shell, stop } = await mount();
    await selectA(shell);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    // 拖拽源可用：会话B 行可拖
    const rowB = document.querySelector('[data-session-id="b"]') as HTMLElement;
    expect(rowB.getAttribute('draggable')).toBe('true');
    expect(rowB.getAttribute('data-drag-disabled')).toBeNull();

    dragRowToEdge('b', pane, 196, 50); // 右边缘

    expect(panes()).toBe(2);
    expect(screen.getAllByTestId('workbench-pane')).toHaveLength(2);
    expect(screen.getByTestId('workbench-split').getAttribute('data-dir')).toBe('row');
    expect(screen.getAllByTestId('pane-close')).toHaveLength(1); // 只有非主格有
    expect(screen.getAllByTestId('workbench-pane-header')).toHaveLength(1); // 非主格轻量头
    expect(workbenchStore.getSnapshot().bindings).toEqual({ 'pane-0': 'a', 'pane-1': 'b' });

    // Z-19：已在分屏内的会话在侧栏禁用拖拽
    const rowBAfter = document.querySelector('[data-session-id="b"]') as HTMLElement;
    expect(rowBAfter.getAttribute('data-drag-disabled')).toBe('true');
    expect(rowBAfter.getAttribute('draggable')).toBeNull();
    stop();
  });

  it('中间区域（非边缘）投放不分屏，给出可见提示（不静默）', async () => {
    const { shell, stop } = await mount();
    await selectA(shell);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragRowToEdge('b', pane, 100, 50); // 正中：到四边距离均 0.5 > 0.32
    expect(panes()).toBe(1);
    expect(screen.getByTestId('workbench-hint').textContent).toContain('边缘');
    stop();
  });
});

describe('web 分屏：关闭格 ≠ 停止会话', () => {
  it('关闭非主格 → 回单格、焦点回主格、会话 B 仍在 store 且未触发 abort', async () => {
    const { shell, stop, client } = await mount();
    await selectA(shell);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragRowToEdge('b', pane, 196, 50);
    expect(panes()).toBe(2);

    act(() => {
      fireEvent.click(screen.getByTestId('pane-close'));
    });
    expect(panes()).toBe(1);
    expect(workbenchStore.getSnapshot().root).toEqual({ t: 'leaf', id: 'pane-0' });
    expect(shell.store.getState().sessions.some((s) => s.id === 'b')).toBe(true);
    expect(client.abort).not.toHaveBeenCalled();
    expect(screen.getByTestId('workbench-hint').textContent).toContain('仍在后台运行');
    stop();
  });
});

describe('web 分屏：上限 4 格', () => {
  it('已达 4 格再投放 → 拒绝并提示，树保持 4 格', async () => {
    const { shell, stop } = await mount();
    await selectA(shell);
    // 直接经仓库铺满 4 格（A 主格 + B/C/D）
    act(() => {
      workbenchStore.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' });
      workbenchStore.dropSession({ sessionId: 'c', targetLeafId: 'pane-0', side: 'down' });
      workbenchStore.dropSession({ sessionId: 'd', targetLeafId: 'pane-0', side: 'up' });
    });
    expect(panes()).toBe(4);

    const target = screen.getAllByTestId('workbench-pane')[0] as HTMLElement;
    stubRect(target, 200, 100);
    dragRowToEdge('e', target, 5, 50); // 左边缘
    expect(panes()).toBe(4);
    expect(screen.getByTestId('workbench-hint').textContent).toContain('最多 4 格');
    stop();
  });
});
