// web 页面（结构）测试：证明页面**复用共享组件**装配出「会话列表 + 对话页 + 停止」，
// 而不是自己写一份 UI。数据来自假端口（HarnessClient），不启动 serve。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import { sessionNavHistory } from '@harness2/ui-shared/renderer/layout/session-nav-history.js';
import { setShellTheme } from '@harness2/ui-shared/renderer/theme/index.js';
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape, WsFrame } from '@harness2/ui-shared/shared/protocol.js';
import { WebApp } from '../src/app.js';
import type { WebSettingsDataPorts } from '../src/web-settings.js';
import { _resetWebComposerConfigForTest } from '../src/web-composer-controls.js';

const TABBED_PLACEHOLDER = '搜索操作、任务或文件';

afterEach(() => {
  cleanup();
  frameListeners.clear();
  // Z10-2b：web composer 控件 config 缓存是模块级单例 —— 测试间复位，避免跨用例串味。
  _resetWebComposerConfigForTest();
  // 分屏布局是**模块级单例**（Z2-06：内存态、D-14 不落盘）——测试间显式复位，
  // 否则上一用例的主格绑定会带进下一用例（主格头部会把会话标题再渲染一遍）。
  workbenchStore.reset();
  // Z10-3：会话导航历史同为模块级单例 —— 测试间复位，避免上一用例的栈污染 disabled 态断言。
  sessionNavHistory.reset();
  // 主题是模块级单例 + 全局 DOM 呈现：测试间复位，避免快捷键用例的切换污染其它用例。
  setShellTheme('system');
  globalThis.localStorage?.removeItem('harness2-theme');
  document.documentElement.removeAttribute('data-theme');
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

async function mount(
  options: {
    client?: HarnessClient;
    onNewSession?: () => void;
    settingsDataPorts?: WebSettingsDataPorts;
  } = {},
) {
  const shell = createAppShell(options.client ?? fakeClient());
  const stop = shell.controller.start();
  await shell.controller.refreshSessions();
  render(
    React.createElement(WebApp, {
      shell,
      onNewSession: options.onNewSession ?? (() => undefined),
      ...(options.settingsDataPorts !== undefined ? { settingsDataPorts: options.settingsDataPorts } : {}),
    }),
  );
  return { shell, stop };
}

describe('web 页面装配', () => {
  it('左栏渲染会话列表（共享 SessionBrowser），没有假会话', async () => {
    const { stop } = await mount();
    expect(screen.getByText('第一个会话')).toBeTruthy();
    expect(screen.queryByText('不存在的会话')).toBeNull();
    stop();
  });

  it('Z-07 #1：Ctrl+N 触发新建会话（与侧栏 New Task 同一动作）', async () => {
    const onNewSession = vi.fn();
    const { stop } = await mount({ onNewSession });
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(onNewSession).toHaveBeenCalledTimes(1);
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
      // Z3-04：主按钮图标化（Z-94 Square 图标 + tooltip Esc）→ 文案在 aria-label（tooltip 悬停才渲染）
      expect(document.querySelector('[data-testid="composer-primary"]')?.getAttribute('aria-label')).toContain('停止'),
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
      // Z3-04：主按钮图标化 → 文案在 aria-label（tooltip 悬停才渲染）
      expect(document.querySelector('[data-testid="composer-primary"]')?.getAttribute('aria-label')).toContain('停止'),
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
    await waitFor(() =>
      expect(document.querySelector('[data-testid="composer-primary"]')?.getAttribute('aria-label')).toBe('发送'),
    );
    expect(screen.queryByText('停止')).toBeNull();
    expect(shell.store.peekStream('s1')?.turnEnds['t1']).toMatchObject({
      stopReason: 'cancelled',
      textOutcome: 'partial',
    });
    stop();
  });

  it('能力面如实：设置入口在场（Z7 覆层），轨迹视图不注册（web 无通道不摆假入口）', async () => {
    const { shell, stop } = await mount();
    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    expect(screen.queryByText('Trajectory')).toBeNull();
    // Z7：设置入口（齿轮）在场；点击打开覆层（真实设置页），不再是零覆层
    expect(screen.getByTestId('sidebar-settings')).toBeTruthy();
    stop();
  });

  it('Z10-1 空态：会话已选中且无消息 → Logo mark + 问候 + 4 建议 chip；点击 chip 预填 composer', async () => {
    const { shell, stop } = await mount();
    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));

    // 空态新组件（会话已加载、0 条目）
    await waitFor(() => expect(screen.getByTestId('conversation-empty')).toBeTruthy());
    expect(screen.getByTestId('conversation-empty-mark').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('conversation-empty-greeting').textContent).toMatch(/，有什么想让我帮忙的吗$/);
    expect(screen.getAllByTestId('conversation-empty-suggestion').map((c) => c.textContent)).toEqual([
      '周报总结',
      '报错修复',
      'PPT 制作',
      '闲时任务',
    ]);

    // 点击 chip → 经壳注入的 composerPrefill 通道把文案预填进 composer 输入框（非直接发送）
    fireEvent.click(screen.getAllByTestId('conversation-empty-suggestion')[3]!);
    await waitFor(() => expect(screen.getByTestId('composer-editor').textContent).toBe('闲时任务'));
    expect(shell.store.peekStream('s1')?.pendingSubmits ?? {}).toEqual({}); // 未发送
    stop();
  });
});

describe('P2-9 新建会话：无可用 cwd 时置灰并给可行动原因（不摆必失败入口）', () => {
  it('列表有 cwd → 按钮可点、无阻断提示、点击触发动作', async () => {
    const onNewSession = vi.fn();
    const { stop } = await mount({ onNewSession });
    const button = screen.getByTestId('sidebar-new-session') as HTMLButtonElement;
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
    const button = screen.getByTestId('sidebar-new-session') as HTMLButtonElement;
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

describe('P0「自动化」主区视图（web 无 cron 通道 → 视图内降级）', () => {
  it('侧栏入口可点 → 打开主区视图；模板卡/创建钮无通道 disabled + data-placeholder', async () => {
    const { stop } = await mount();
    const entry = screen.getByTestId('sidebar-automation-entry') as HTMLButtonElement;
    // 入口本身是真导航（不再是无通道占位），降级发生在视图内部
    expect(entry.disabled).toBe(false);
    expect(entry.textContent).toContain('自动化');
    fireEvent.click(entry);
    expect(await screen.findByTestId('automations-main')).toBeTruthy();
    // 空态文案（逐字）
    expect(screen.getByTestId('automation-empty').textContent).toContain('还没有定时任务');
    // 无通道：创建钮 + 模板卡全部 disabled 占位
    const create = screen.getByTestId('automation-create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute('data-placeholder')).toBe('true');
    const template = screen.getByTestId('automation-template-morning-digest') as HTMLButtonElement;
    expect(template.disabled).toBe(true);
    expect(template.getAttribute('data-placeholder')).toBe('true');
    stop();
  });

  it('footer 固定账号槽（用户拍板：写死「本地用户」，不是「未登录」）', async () => {
    const { stop } = await mount();
    const account = screen.getByTestId('sidebar-account-slot') as HTMLButtonElement;
    expect(account.textContent).toContain('本地用户');
    expect(account.textContent).not.toContain('未登录');
    expect(account.disabled).toBe(true);
    expect(account.getAttribute('data-placeholder')).toBe('true');
    expect(account.getAttribute('title')).toBe('本地构建 · 无账号体系');
    stop();
  });
});

// —————— Z10-4 快捷键扩展（ZCode 源码权威键表 @zcode/shared/shortcutCommands.ts）——————
describe('Z10-4 快捷键扩展（源码权威键表）', () => {
  const seat = (name: string): Element | null => document.querySelector(`[data-seat="${name}"]`);

  it('Ctrl+Shift+P：命令面板别名（同 Ctrl+K）', async () => {
    const { stop } = await mount();
    fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(await screen.findByPlaceholderText(TABBED_PLACEHOLDER)).toBeTruthy();
    stop();
  });

  it('Ctrl+,：打开共享设置覆层（桌面同键、web 本批补齐）', async () => {
    const { stop } = await mount();
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull();
    fireEvent.keyDown(window, { key: ',', code: 'Comma', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy();
    stop();
  });

  it('Ctrl+B 切侧栏；Ctrl+Alt+B 切右栏（共享帧动作真生效）', async () => {
    const { stop } = await mount();
    expect(seat('sidebar')?.getAttribute('data-collapsed')).toBe('false');
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(seat('sidebar')?.getAttribute('data-collapsed')).toBe('true');
    const hiddenBefore = seat('rightbar')?.hasAttribute('hidden');
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
    expect(seat('rightbar')?.hasAttribute('hidden')).toBe(!hiddenBefore);
    stop();
  });

  it('Ctrl+Shift+L：切换主题并镜像浏览器存储（D-14 例外 #1）', async () => {
    const { stop } = await mount();
    setShellTheme('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('zai-light');
    fireEvent.keyDown(window, { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('zai-dark');
    expect(globalThis.localStorage?.getItem('harness2-theme')).toBe('zai-dark');
    stop();
  });

  it('Ctrl+Shift+] / Ctrl+Shift+[：下一个 / 上一个会话（webAdjacentSessionId 同源）', async () => {
    const s1: SessionSummaryShape = { ...SESSION, id: 's1', mtimeMs: 20, firstUserText: '第一个会话' };
    const s2: SessionSummaryShape = { ...SESSION, id: 's2', mtimeMs: 10, firstUserText: '第二个会话' };
    const { shell, stop } = await mount({ client: fakeClient([s1, s2]) });
    await waitFor(() => expect(screen.getByText('第二个会话')).toBeTruthy());
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s2'));
    fireEvent.keyDown(window, { key: '[', code: 'BracketLeft', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    stop();
  });

  // —— Z10-3 顶部「后退/前进」会话导航（会话历史栈 + Ctrl+[ / ]） ——
  it('Z10-3 顶部 后退/前进：两次选中后可退可进，边界按钮 disabled', async () => {
    const s1: SessionSummaryShape = { ...SESSION, id: 's1', mtimeMs: 20, firstUserText: '第一个会话' };
    const s2: SessionSummaryShape = { ...SESSION, id: 's2', mtimeMs: 10, firstUserText: '第二个会话' };
    const { shell, stop } = await mount({ client: fakeClient([s1, s2]) });
    await waitFor(() => expect(screen.getByText('第二个会话')).toBeTruthy());
    const back = (): HTMLButtonElement => screen.getByRole('button', { name: '后退' }) as HTMLButtonElement;
    const forward = (): HTMLButtonElement => screen.getByRole('button', { name: '前进' }) as HTMLButtonElement;

    expect(back().disabled).toBe(true); // 空历史

    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    expect(back().disabled).toBe(true); // 只有一条

    fireEvent.click(screen.getByText('第二个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s2'));
    await waitFor(() => expect(back().disabled).toBe(false));

    fireEvent.click(back());
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(false);

    fireEvent.click(forward());
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s2'));
    expect(forward().disabled).toBe(true);
    stop();
  });

  it('Z10-3 Ctrl+[ / Ctrl+]：真触发会话历史后退/前进；无历史时按下不报错不误动', async () => {
    const s1: SessionSummaryShape = { ...SESSION, id: 's1', mtimeMs: 20, firstUserText: '第一个会话' };
    const s2: SessionSummaryShape = { ...SESSION, id: 's2', mtimeMs: 10, firstUserText: '第二个会话' };
    const { shell, stop } = await mount({ client: fakeClient([s1, s2]) });
    await waitFor(() => expect(screen.getByText('第二个会话')).toBeTruthy());

    // 无历史：Ctrl+[ 无路可走 → 不动作、不抛错
    fireEvent.keyDown(window, { key: '[', code: 'BracketLeft', ctrlKey: true });
    expect(shell.store.getState().selectedId).toBeNull();

    fireEvent.click(screen.getByText('第一个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1'));
    fireEvent.click(screen.getByText('第二个会话'));
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s2'));

    fireEvent.keyDown(window, { key: '[', code: 'BracketLeft', ctrlKey: true });
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s1')); // navigateBack
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', ctrlKey: true });
    await waitFor(() => expect(shell.store.getState().selectedId).toBe('s2')); // navigateForward
    stop();
  });

  it('反向钉：仍未兑现的键不触发任何动作（Ctrl+F / Ctrl+T / Ctrl+W / Ctrl+O）', async () => {
    const { stop } = await mount();
    const collapsedBefore = seat('sidebar')?.getAttribute('data-collapsed');
    for (const combo of [
      { key: 'f', code: 'KeyF' },
      { key: 't', code: 'KeyT' }, // Ctrl+T：思考档位 —— web 无数据面，如实不绑
      { key: 'w', code: 'KeyW' },
      { key: 'o', code: 'KeyO' },
    ]) {
      fireEvent.keyDown(window, { ctrlKey: true, ...combo });
    }
    expect(screen.queryByPlaceholderText(TABBED_PLACEHOLDER)).toBeNull();
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull();
    expect(seat('sidebar')?.getAttribute('data-collapsed')).toBe(collapsedBefore);
    stop();
  });

  it('Z10-2b Ctrl+Shift+M：权限模式循环经 PUT /api/settings/config 写回（与控件同一写路径）', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true as const, warnings: [] }));
    const getConfig = vi.fn(async () => ({
      providers: {},
      roles: {},
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 1, maxConcurrent: 1 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 1 },
      sources: { global: false, project: false },
      warnings: [],
      errors: [],
    }));
    const settingsDataPorts = { getConfig, updateConfig } as unknown as WebSettingsDataPorts;
    const { stop } = await mount({ settingsDataPorts });
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ approval: { mode: 'acceptEdits' } }));
    stop();
  });
});
