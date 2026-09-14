// web 页面（结构）测试：证明页面**复用共享组件**装配出「会话列表 + 对话页 + 停止」，
// 而不是自己写一份 UI。数据来自假端口（HarnessClient），不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape, WsFrame } from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';

afterEach(() => {
  cleanup();
  frameListeners.clear();
});

/** 假端口的事件帧注入（onEvent 订阅进这里；测试据此驱动流式/终态，走真实 controller 分发） */
const frameListeners = new Set<(frame: WsFrame) => void>();
function emitFrame(frame: WsFrame): void {
  for (const listener of [...frameListeners]) listener(frame);
}

const SESSION: SessionSummaryShape = {
  id: 's1',
  dir: '/tmp/s1',
  cwd: '/work',
  mtimeMs: 1000,
  firstUserText: '第一个会话',
  messageCount: 2,
  lastSeq: 0,
};

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

async function mount(options: { client?: HarnessClient; onNewSession?: () => void } = {}) {
  const shell = createAppShell(options.client ?? fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(React.createElement(WebApp, { shell, onNewSession: options.onNewSession ?? (() => undefined) }));
  return { shell, stop };
}

describe('web 页面装配', () => {
  it('左栏渲染会话列表（共享 SessionBrowser），没有假会话', async () => {
    const { stop } = await mount();
    expect(screen.getByText('第一个会话')).toBeTruthy();
    expect(screen.queryByText('不存在的会话')).toBeNull();
    stop();
  });

  it('点击会话 → 中栏挂载共享会话席位（视图环 + 常驻 composer）', async () => {
    const { shell, stop } = await mount();
    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    expect(document.querySelector('[data-testid="conversation-seat"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="composer-overlay"]')).not.toBeNull();
    stop();
  });

  it('运行中主按钮变「停止」（D-36 同一位置切换，不并列两个按钮）', async () => {
    const { shell, stop } = await mount();
    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    shell.store.markSending('s1');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="composer-primary"]')?.textContent).toContain('停止'),
    );
    // 同一位置切换：此时不存在并列的 Send 按钮
    expect(screen.queryByText('发送')).toBeNull();
    stop();
  });

  it('停止后回到可发送终态：turn-end 帧到达 → 在途流停止、主按钮从「停止」回到「发送」', async () => {
    const { shell, stop } = await mount();
    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));

    // 流式进行中：在途文本可见 + 主按钮为「停止」
    emitFrame({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'at1',
      chunkOffset: 0,
      text: '写到一半',
    });
    await waitFor(() => shell.store.peekStream('s1')?.running === true);
    expect(shell.store.peekStream('s1')?.live.text).toBe('写到一半');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="composer-primary"]')?.textContent).toContain('停止'),
    );

    // 终态帧（用户停止 = cancelled/partial）：流式停止、在途清空、按钮回到发送
    emitFrame({
      type: 'event',
      sessionId: 's1',
      event: { v: 1, seq: 1, ts: '2026-09-14T00:00:00.000Z', type: 'user/message', payload: { turnId: 't1' } },
    });
    emitFrame({
      type: 'turn-end',
      sessionId: 's1',
      stopReason: 'cancelled',
      textOutcome: 'partial',
      partialText: '写到一半',
    });
    await waitFor(() => shell.store.peekStream('s1')?.running === false);
    expect(shell.store.peekStream('s1')?.live.text).toBe(''); // 在途增量清空（流式已停）
    await waitFor(() => expect(screen.getByText('发送')).toBeTruthy());
    expect(screen.queryByText('停止')).toBeNull();
    expect(shell.store.peekStream('s1')?.turnEnds['t1']).toMatchObject({
      stopReason: 'cancelled',
      textOutcome: 'partial',
    });
    stop();
  });

  it('未实现的能力不摆假入口：web 不注册轨迹/设置等视图，视图环只渲染 chat', async () => {
    const { shell, stop } = await mount();
    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    expect(screen.queryByText('Trajectory')).toBeNull();
    expect(screen.queryByText('设置')).toBeNull();
    stop();
  });
});

describe('P2-9 新建会话：无可用 cwd 时置灰并给可行动原因（不摆必失败入口）', () => {
  it('列表有 cwd → 按钮可点、无阻断提示、点击触发动作', async () => {
    const onNewSession = vi.fn();
    const { stop } = await mount({ onNewSession });
    const button = screen.getByRole('button', { name: '新会话' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByTestId('web-new-session-blocked')).toBeNull();
    fireEvent.click(button);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    stop();
  });

  it('列表里没有可用 cwd（新建必失败）→ 按钮置灰 + 可行动原因可见；点击不触发动作', async () => {
    const onNewSession = vi.fn();
    const noCwd: SessionSummaryShape = { ...SESSION, cwd: undefined };
    const { stop } = await mount({ client: fakeClient([noCwd]), onNewSession });
    const button = screen.getByRole('button', { name: '新会话' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const blocked = screen.getByTestId('web-new-session-blocked');
    expect(blocked.textContent).toContain('cwd');
    expect(blocked.textContent).toContain('目录选择通道');
    fireEvent.click(button);
    expect(onNewSession).not.toHaveBeenCalled();
    stop();
  });
});

describe('P2-4 草稿卸载护栏：web 无落盘通道时不静默丢草稿', () => {
  function fireBeforeUnload(): Event {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('结构性证据：web 客户端无 draftsGet/draftsSet → controller 能力如实为 memory-only', async () => {
    const { shell, stop } = await mount();
    expect(shell.controller.draftsPersistence).toBe('memory-only');
    stop();
  });

  it('有未发送草稿 → 刷新/关闭被护栏拦下（preventDefault）', async () => {
    const { shell, stop } = await mount();
    shell.store.setDraft('s1', '写到一半');
    await waitFor(() => expect(shell.store.getState().drafts['s1']).toBe('写到一半'));
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    stop();
  });

  it('无草稿 → 不打扰（不 preventDefault）', async () => {
    const { stop } = await mount();
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
    stop();
  });
});
