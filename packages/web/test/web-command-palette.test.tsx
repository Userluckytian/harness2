// web 命令面板测试（Z7 接入 / Z8 §7 Z-17 tabbed 命令表）：共享 CommandPalette（layout="tabbed"）经 web 覆层席位接入 ——
//   1. Ctrl/Cmd+K 唤出；侧栏命令中心入口同一链路唤出；
//   2. 搜索过滤实时生效；无匹配显示空态（如实，不摆假条目）；
//   3. 任务 tab：切换 → 按标题过滤 → 选中触发 controller.selectSession（会话跳转由任务 tab 承载）；
//   4. 命令来源真实性：命令表按 §7 分组补全，无通道项 disabled+disabledHint；无可用 cwd（新建必失败）时**不列**「新任务」。
// 数据来自假端口（HarnessClient），不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { workbenchDrag } from '@harness2/ui-shared/renderer/layout/workbench/drag.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import { sidePaneStore, SIDE_PANE_NO_SESSION_KEY } from '@harness2/ui-shared/renderer/side-pane/index.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';

afterEach(() => {
  cleanup();
  // 分屏布局是模块级单例（内存态）：跳转用例会绑定主格，测试间复位避免跨用例残留。
  workbenchStore.reset();
  workbenchDrag.end();
  // 右栏标签也是模块级单例：审查标签用例会开 changes，复位全部桶避免跨用例残留。
  for (const key of [...sidePaneStore.getSnapshot().keys()]) sidePaneStore.closeAll(key);
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

// 面板输入框（tabbed 统一 placeholder `搜索操作、任务或文件`；按容器类取，避免与侧栏搜索框同 placeholder 冲突）
const input = (): HTMLInputElement => document.querySelector('.command-palette-input') as HTMLInputElement;
const TABBED_PLACEHOLDER = '搜索操作、任务或文件';

describe('web 命令面板：唤出链路', () => {
  it('Ctrl+K 唤出共享命令面板；Esc 关闭', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByPlaceholderText(TABBED_PLACEHOLDER)).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText(TABBED_PLACEHOLDER)).toBeNull());
    stop();
  });

  it('侧栏命令中心入口点击唤出（与 Ctrl+K 同一真源）', async () => {
    const { stop } = await mount();
    const entry = await screen.findByTestId('sidebar-command-center');
    expect(entry.textContent).toContain('Ctrl+K');
    fireEvent.click(entry);
    expect(await screen.findByPlaceholderText(TABBED_PLACEHOLDER)).toBeTruthy();
    stop();
  });
});

describe('web 命令面板：过滤 / 空态 / 命令来源', () => {
  it('输入实时过滤；无匹配显示空态（不摆假条目）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const el = await screen.findByPlaceholderText(TABBED_PLACEHOLDER);
    // 「设置」在建议/配置两组各一条（§7 规格）→ 命中 2 条，均含「设置」
    fireEvent.change(el, { target: { value: '设置' } });
    const hit = screen.getAllByRole('option');
    expect(hit).toHaveLength(2);
    expect(hit.every((o) => (o.textContent ?? '').includes('设置'))).toBe(true);

    fireEvent.change(el, { target: { value: '根本不存在的命令' } });
    expect(screen.getByText('无匹配项')).toBeTruthy();
    stop();
  });

  it('命令表按 Z-20 六组补全：真通道命令 + 无通道项 disabled 占位', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText(TABBED_PLACEHOLDER);
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    // 真通道
    expect(labels.some((t) => t.includes('新任务'))).toBe(true);
    expect(labels.some((t) => t.includes('设置'))).toBe(true);
    expect(labels.some((t) => t.includes('切换侧边栏'))).toBe(true);
    expect(labels.some((t) => t.includes('下一个会话'))).toBe(true);
    expect(labels.some((t) => t.includes('复位面板'))).toBe(true);
    expect(labels.some((t) => t.includes('归档当前会话'))).toBe(true);
    // 视图：恢复的 toggleRightbar（默认右栏关闭 → 「打开右栏」）
    expect(labels.some((t) => t.includes('打开右栏') || t.includes('收起右栏'))).toBe(true);
    // 补齐条目（无通道占位 disabled 也如实渲染）
    expect(labels.some((t) => t.includes('打开工作区'))).toBe(true);
    expect(labels.some((t) => t.includes('切换终端'))).toBe(true);
    expect(labels.some((t) => t.includes('添加终端标签'))).toBe(true);
    expect(labels.some((t) => t.includes('添加审查标签'))).toBe(true);
    expect(labels.some((t) => t.includes('技能'))).toBe(true);
    expect(labels.some((t) => t.includes('MCP 服务器'))).toBe(true);
    expect(labels.some((t) => t.includes('问题上报'))).toBe(true);
    expect(labels.some((t) => t.includes('用户社群'))).toBe(true);
    expect(labels.some((t) => t.includes('产品文档'))).toBe(true);
    expect(labels.some((t) => t.includes('断开连接'))).toBe(true);
    // 组标题（Z-20 六组）
    for (const g of ['建议', '会话', '面板', '视图', '配置', '应用']) {
      expect(screen.getByText(g)).toBeTruthy();
    }
    // classic 会话跳转命令已移除（tabbed 任务 tab 承载）
    expect(labels.some((t) => t.includes('跳转到会话'))).toBe(false);
    expect(labels.some((t) => t.includes('搜索会话'))).toBe(false);
    // 无通道项：disabled 占位（aria-disabled + data-placeholder）
    const workspace = screen.getByText('打开工作区').closest('[role="option"]');
    expect(workspace?.getAttribute('aria-disabled')).toBe('true');
    expect(workspace?.hasAttribute('data-placeholder')).toBe(true);
    // web 无技能/MCP 分区 → 仍为 disable 占位（与桌面真有通道不同）
    for (const label of ['技能', 'MCP 服务器']) {
      const option = screen.getByText(label).closest('[role="option"]');
      expect(option?.getAttribute('aria-disabled')).toBe('true');
      expect(option?.hasAttribute('data-placeholder')).toBe(true);
    }
    // 「添加审查标签」升级为真：非占位
    const review = screen.getByText('添加审查标签').closest('[role="option"]');
    expect(review?.getAttribute('aria-disabled')).not.toBe('true');
    expect(review?.hasAttribute('data-placeholder')).toBe(false);
    // 如实省略：web 无「快捷键说明」分区 → 不列「帮助」
    expect(labels.some((t) => t.includes('帮助'))).toBe(false);
    stop();
  });

  it('「添加审查标签」为真：执行后打开右栏 changes pane（sidePaneStore + rightbar/open）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText(TABBED_PLACEHOLDER);
    fireEvent.change(input(), { target: { value: '添加审查标签' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    // 初始未选会话 → 无会话桶激活 changes（证明 run 真调用了 sidePaneStore.open）
    await waitFor(() => {
      const tabs = sidePaneStore.getSnapshot().get(SIDE_PANE_NO_SESSION_KEY);
      expect(tabs?.activeTab).toBe('changes');
    });
    stop();
  });

  it('无可用 cwd（新建必失败）→ 命令表不含「新任务」', async () => {
    const noCwd = SESSIONS.map((s) => ({ ...s, cwd: undefined }));
    const { stop } = await mount({ client: fakeClient(noCwd) });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText(TABBED_PLACEHOLDER);
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((t) => t.includes('新任务'))).toBe(false);
    stop();
  });
});

describe('web 命令面板：任务 tab 会话跳转', () => {
  it('切到任务 tab → 按标题过滤 → Enter 选中并关面板', async () => {
    const { shell, stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText(TABBED_PLACEHOLDER);
    fireEvent.click(screen.getByRole('tab', { name: '任务' }));
    fireEvent.change(input(), { target: { value: '会话B' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input(), { key: 'Enter' });

    await waitFor(() => expect(shell.store.getState().selectedId).toBe('b'));
    await waitFor(() => expect(document.querySelector('.command-palette')).toBeNull());
    stop();
  });
});
