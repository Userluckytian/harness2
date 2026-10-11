// web 命令面板测试（Z7）：共享 CommandPalette 经 web 覆层席位接入 ——
//   1. Ctrl/Cmd+K 唤出；侧栏命令中心入口同一链路唤出；
//   2. 搜索过滤实时生效；无匹配显示空态（如实，不摆假条目）；
//   3. 跳转会话：进入会话态 → 过滤 → 选中触发 controller.selectSession；
//   4. 命令来源真实性：命令表只列 web 真能执行的动作；无可用 cwd（新建必失败）时**不列**「新建会话」。
// 数据来自假端口（HarnessClient），不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { workbenchDrag } from '@harness2/ui-shared/renderer/layout/workbench/drag.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';

afterEach(() => {
  cleanup();
  // 分屏布局是模块级单例（内存态）：跳转用例会绑定主格，测试间复位避免跨用例残留。
  workbenchStore.reset();
  workbenchDrag.end();
});

const SESSIONS: SessionSummaryShape[] = [
  {
    id: 'a',
    dir: '/tmp/a',
    cwd: '/work',
    mtimeMs: 2000,
    firstUserText: '会话A',
    messageCount: 1,
    lastSeq: 0,
  },
  {
    id: 'b',
    dir: '/tmp/b',
    cwd: '/work',
    mtimeMs: 1000,
    firstUserText: '会话B',
    messageCount: 1,
    lastSeq: 0,
  },
];

function fakeClient(sessions: SessionSummaryShape[] = SESSIONS): HarnessClient {
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

async function mount(options: { client?: HarnessClient } = {}) {
  const shell = createAppShell(options.client ?? fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(React.createElement(WebApp, { shell, onNewSession: () => undefined }));
  return { shell, stop };
}

// 面板输入框（`输入命令…` / 会话态 `搜索会话…` 共用一个 input 元素；按容器类取，避免与侧栏搜索框同 placeholder 冲突）
const input = (): HTMLInputElement => document.querySelector('.command-palette-input') as HTMLInputElement;

describe('web 命令面板：唤出链路', () => {
  it('Ctrl+K 唤出共享命令面板；Esc 关闭', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByPlaceholderText('输入命令…')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText('输入命令…')).toBeNull());
    stop();
  });

  it('侧栏命令中心入口点击唤出（与 Ctrl+K 同一真源）', async () => {
    const { stop } = await mount();
    const entry = await screen.findByTestId('sidebar-command-center');
    expect(entry.textContent).toContain('Ctrl+K');
    fireEvent.click(entry);
    expect(await screen.findByPlaceholderText('输入命令…')).toBeTruthy();
    stop();
  });
});

describe('web 命令面板：过滤 / 空态 / 命令来源', () => {
  it('输入实时过滤；无匹配显示空态（不摆假条目）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const el = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(el, { target: { value: '设置' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('打开设置');

    fireEvent.change(el, { target: { value: '根本不存在的命令' } });
    expect(screen.getByText('无匹配项')).toBeTruthy();
    stop();
  });

  it('命令表只列 web 真能执行的动作（含会话导航 / 主题 / 面板开关 / 跳转会话）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText('输入命令…');
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((t) => t.includes('新建会话'))).toBe(true);
    expect(labels.some((t) => t.includes('下一个会话'))).toBe(true);
    expect(labels.some((t) => t.includes('打开设置'))).toBe(true);
    expect(labels.some((t) => t.includes('切换主题'))).toBe(true);
    expect(labels.some((t) => t.includes('侧栏'))).toBe(true);
    expect(labels.some((t) => t.includes('右栏'))).toBe(true);
    expect(labels.some((t) => t.includes('复位面板'))).toBe(true);
    expect(labels.some((t) => t.includes('归档当前会话'))).toBe(true);
    expect(labels.some((t) => t.includes('跳转到会话'))).toBe(true);
    // 如实省略：web 设置页无「快捷键说明」分区 → 不列「帮助 / 快捷键」（不摆空目标入口）
    expect(labels.some((t) => t.includes('帮助'))).toBe(false);
    stop();
  });

  it('无可用 cwd（新建必失败）→ 命令表不含「新建会话」', async () => {
    const noCwd = SESSIONS.map((s) => ({ ...s, cwd: undefined }));
    const { stop } = await mount({ client: fakeClient(noCwd) });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText('输入命令…');
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((t) => t.includes('新建会话'))).toBe(false);
    stop();
  });
});

describe('web 命令面板：跳转会话', () => {
  it('选中「跳转到会话…」→ 进入会话态 → 按标题过滤 → Enter 选中并关面板', async () => {
    const { shell, stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input(), { target: { value: '跳转' } });
    fireEvent.keyDown(input(), { key: 'Enter' }); // 执行跳转命令 → 会话态
    // 会话态：同一输入框 placeholder 变为「搜索会话…」（侧栏搜索框同 placeholder，故按容器类定位）
    expect(input().placeholder).toBe('搜索会话…');

    fireEvent.change(input(), { target: { value: '会话B' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(shell.store.getState().selectedId).toBe('b'));
    await waitFor(() => expect(document.querySelector('.command-palette')).toBeNull());
    stop();
  });
});
