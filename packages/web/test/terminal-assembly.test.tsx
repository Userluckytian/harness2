// Z9-5：web 终端装配级测试（席位条目 + Ctrl+J 开合 + 命令面板「切换终端」转真）。
//
// jsdom 无法运行真实 @xterm/xterm（需 canvas / 元素测量），且 ui-shared 以 dist 形式被外部化，
// 测试侧无法拦截其内部 xterm 导入 → 渲染级用例走 **available=false** 的如实降级路径（不创建 xterm，
// 面板显示「终端不可用」，红线⑩）。`createWebTerminalPort` 的 available 两态在 web-terminal-port.test.ts
// 用假 WS 通道单独断言（connected→true / 离线→false）。
// 数据来自假端口（HarnessClient）+ 假 WS 通道，不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape } from '@harness2/ui-shared/shared/protocol.js';
import type { TerminalPort } from '@harness2/ui-shared/renderer/terminal/port.js';
import { WebApp } from '../src/app.js';
import { UNAVAILABLE_WEB_TERMINAL_PORT } from '../src/terminal/web-port.js';

afterEach(() => {
  cleanup();
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

function fakeClient(): HarnessClient {
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  return {
    listSessions: async () => [SESSION],
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

async function mount(options: { terminalPort?: TerminalPort } = {}) {
  const shell = createAppShell(fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(
    React.createElement(WebApp, {
      shell,
      onNewSession: () => undefined,
      ...(options.terminalPort !== undefined ? { terminalPort: options.terminalPort } : {}),
    }),
  );
  return { shell, stop };
}

const terminalToggle = (): HTMLElement => screen.getByTestId('terminal-toggle');
const terminalPanel = (): HTMLElement => document.querySelector('[data-panel="terminal"]') as HTMLElement;

describe('web 终端席位装配（Z9-5）', () => {
  it('席位条目存在：中栏出现 terminal 面板与开关（注册缝被注入）', async () => {
    const { stop } = await mount();
    expect(terminalPanel()).not.toBeNull();
    expect(terminalToggle().getAttribute('aria-pressed')).toBe('false'); // 默认收起
    stop();
  });

  it('port.available=false（未接入 serve WS）→ 面板如实不可用，不摆假终端', async () => {
    const { stop } = await mount();
    // 默认端口 = UNAVAILABLE_WEB_TERMINAL_PORT
    expect(screen.getByTestId('terminal-panel').getAttribute('data-terminal-available')).toBe('false');
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(screen.getByTestId('terminal-unavailable')).toBeTruthy();
    stop();
  });

  it('注入的端口即被装配（可用性取端口自身）：显式不可用端口 → 面板仍如实不可用', async () => {
    const { stop } = await mount({ terminalPort: UNAVAILABLE_WEB_TERMINAL_PORT });
    expect(screen.getByTestId('terminal-panel').getAttribute('data-terminal-available')).toBe('false');
    stop();
  });
});

describe('web Ctrl+J 切换终端面板开合（Z9-5）', () => {
  it('Ctrl+J 展开 → 再按收起（aria-pressed / data-open 同步）', async () => {
    const { stop } = await mount();
    expect(terminalPanel().getAttribute('data-open')).toBe('false');

    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(terminalToggle().getAttribute('aria-pressed')).toBe('true');
    expect(terminalPanel().getAttribute('data-open')).toBe('true');

    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(terminalToggle().getAttribute('aria-pressed')).toBe('false');
    expect(terminalPanel().getAttribute('data-open')).toBe('false');
    stop();
  });
});

describe('web 命令面板「切换终端」转真（Z9-5）', () => {
  it('命令非占位（未 disabled）；执行后切换终端面板（与 Ctrl+J 同款动作）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('搜索操作、任务或文件');
    fireEvent.change(input, { target: { value: '切换终端' } });
    const option = screen.getByText('切换终端').closest('[role="option"]');
    expect(option?.getAttribute('aria-disabled')).not.toBe('true');
    expect(option?.hasAttribute('data-placeholder')).toBe(false);

    expect(terminalPanel().getAttribute('data-open')).toBe('false');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(terminalPanel().getAttribute('data-open')).toBe('true'));
    stop();
  });

  it('「添加终端标签」保留占位（disabled + disabledHint）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('搜索操作、任务或文件');
    fireEvent.change(input, { target: { value: '添加终端标签' } });
    const option = screen.getByText('添加终端标签').closest('[role="option"]');
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(option?.hasAttribute('data-placeholder')).toBe(true);
    stop();
  });
});
