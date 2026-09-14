// @vitest-environment jsdom
// P6 接线棒验收（D-40 / D-46 / D-86②）——A 棒只写了模块、没接线，本文件证明三处装配真的生效：
//   ① D-40：Trajectory 作为 `conversation.view` 视图环的**标签页**（不是弹窗），内容来自真实事件投影；
//   ② D-86②：工具卡 `inspect` 经 `toolNavigation` 注册的消费者真实切到轨迹标签（环外改写也会切）；
//   ③ D-46：composer 是**浮层**（`.composer-overlay`），实测高度写进 CSS 变量并透传到记录表预留。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  ConnectionStatus,
  Harness2Api,
  SessionEventsPayloadShape,
  StatusDetail,
  WsFrame,
} from '../../src/shared/protocol.js';
import { createController, type Controller } from '@harness2/ui-shared/renderer/app-controller.js';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import {
  ConversationSeat,
  conversationTrajectoryFocus,
  conversationViewPersistence,
  createDesktopConversationViewRegistry,
  disposeTrajectoryInspect,
} from '../../src/renderer/conversation/assembly.js';
import { toolNavigation } from '@harness2/ui-shared/renderer/tool/index.js';
import {
  TRAJECTORY_COMPOSER_INSET_VAR,
  TRAJECTORY_VIEW_KEY,
  createComposerOverlayHost,
} from '../../src/renderer/trajectory/index.js';

afterEach(() => cleanup());

// —— 夹具：真 AppStore + 真 controller（只有 bridge 是桩） ——

let seq = 0;
function event(type: string, payload: Record<string, unknown>): SessionEventsPayloadShape['events'][number] {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-14T00:00:00Z', type, payload, active: true };
}

/** 一轮真实事件：user/message + assistant/message（同 turnId） */
function replay(): SessionEventsPayloadShape {
  return {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1', cwd: 'D:/proj' },
    events: [
      event('user/message', { text: '第一句', turnId: 't1' }),
      event('assistant/message', { text: '第一句回复', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 2,
  };
}

/** P2-5：带真实工具调用的一轮（callId=call-9），供 inspect 定位断言 */
function replayWithTool(): SessionEventsPayloadShape {
  return {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1', cwd: 'D:/proj' },
    events: [
      event('user/message', { text: '第一句', turnId: 't1' }),
      event('tool/call', { callId: 'call-9', tool: 'bash', args: { command: 'ls' }, turnId: 't1' }),
      event('tool/result', { callId: 'call-9', ok: true, output: 'file.txt', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 3,
  };
}

function makeApi(): Harness2Api {
  const base = {
    getStatus: vi.fn(async () => ({ status: 'connected' as ConnectionStatus })),
    onEvent: vi.fn((_l: (f: WsFrame) => void) => () => {}),
    onConnectionStatus: vi.fn((_l: (s: ConnectionStatus, d?: StatusDetail) => void) => () => {}),
    onStopAll: vi.fn((_l: () => void) => () => {}),
    cancel: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    setBusy: vi.fn(async () => undefined),
    events: vi.fn(async () => replay()),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    // 会话头部会读分支 / 模型 / 上下文占用（真实通道；桩值不影响本文件断言）
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
    settingsGetConfig: vi.fn(async () => ({
      providers: {},
      roles: { main: { channel: 'c', model: 'mock/m' } },
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 1, maxConcurrent: 1 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 1 },
      sources: { global: false, project: false },
      warnings: [],
      errors: [],
    })),
  };
  return base as unknown as Harness2Api;
}

function boot(): { store: AppStore; controller: Controller } {
  const api = makeApi();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions([
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 2 },
  ]);
  store.select('s1');
  store.applyReplay(replay());
  return { store, controller: createController(store, api) };
}

beforeEach(() => {
  seq = 0;
  // 应用级持久缝是模块单例：逐用例复位，避免上一用例的跳转泄漏成默认视图
  conversationViewPersistence.write('s1', null);
  conversationTrajectoryFocus.clear();
});

describe('D-40：Trajectory 是视图环的标签页（真装配，不是弹窗）', () => {
  it('标签顺序 [Chat, Trajectory]；点击后渲染真实投影（轮次/行数来自事件，非假数据）', () => {
    const { store, controller } = boot();
    render(<ConversationSeat store={store} controller={controller} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('data-view-key'))).toEqual(['chat', 'trajectory']);
    expect(tabs[1]?.getAttribute('data-view-owner')).toBe('ui-trajectory');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));

    const panel = screen.getByTestId('trajectory-panel');
    expect(panel.getAttribute('data-turns')).toBe('1');
    expect(Number(panel.getAttribute('data-rows'))).toBeGreaterThanOrEqual(2);
    // 不是弹窗：标签页在视图环内（`role=tabpanel`），且没有 dialog 形态的轨迹表面
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('data-view-key')).toBe(TRAJECTORY_VIEW_KEY);
    expect(document.querySelector('[role="dialog"][aria-label*="轨迹"]')).toBeNull();
    // 切标签不重建会话（D-32）：会话订阅仍是同一份 store 视图环
    expect(screen.getByTestId('view-ring-session')).toBeTruthy();
  });

  it('停留 Chat 时轨迹不占位；再切回 Chat 内容仍在（会话未被重建）', () => {
    const { store, controller } = boot();
    render(<ConversationSeat store={store} controller={controller} />);
    expect(screen.queryByTestId('trajectory-panel')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));
    expect(screen.getByTestId('trajectory-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.queryByTestId('trajectory-panel')).toBeNull();
    expect(screen.getByText('第一句回复')).toBeTruthy();
  });
});

describe('D-86②：工具卡 inspect → 轨迹标签真跳转', () => {
  it('已注册消费者 → canInspect()=true、inspectViewKey=轨迹 key（工具卡据此渲染入口）', () => {
    // 模块导入即完成注册（disposer 导出仅为回收）
    expect(typeof disposeTrajectoryInspect).toBe('function');
    expect(toolNavigation.canInspect()).toBe(true);
    expect(toolNavigation.inspectViewKey()).toBe(TRAJECTORY_VIEW_KEY);
  });

  it('点击工具卡入口的效果：环外写选择 → 视图环订阅后即时切到轨迹（不用手点标签）', () => {
    const { store, controller } = boot();
    render(<ConversationSeat store={store} controller={controller} />);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');

    let result: unknown;
    act(() => {
      result = toolNavigation.inspect({ sessionId: 's1', callId: 'call-1', seq: 3 });
    });

    expect(result).toEqual({ ok: true, target: 'trajectory' });
    expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('trajectory-panel')).toBeTruthy();
    // Chat 视图（气泡转录）已让位：切的是视图，不是弹了第二个详情层
    expect(document.querySelector('.bubble-assistant')).toBeNull();
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('data-view-key')).toBe(TRAJECTORY_VIEW_KEY);
  });

  it('缺会话上下文 → 如实失败（不假冒跳到别的会话）', () => {
    expect(toolNavigation.inspect({ sessionId: '' })).toEqual({
      ok: false,
      target: 'trajectory',
      reason: 'missing-session',
    });
  });

  it('P2-5 inspect 带 callId/seq：切到轨迹并**定位**到对应记录（选中 + 检查器就位）', () => {
    const { store, controller } = boot();
    store.applyReplay(replayWithTool());
    render(<ConversationSeat store={store} controller={controller} />);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');

    act(() => {
      toolNavigation.inspect({ sessionId: 's1', callId: 'call-9', seq: 2 });
    });

    expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true');
    const toolRow = document.querySelector('[data-row-kind="step"][data-role="tool"]') as HTMLElement;
    expect(toolRow).not.toBeNull();
    expect(toolRow.getAttribute('data-selected')).toBe('true'); // 定位到 callId=call-9 的那一行
    const inspector = screen.getByTestId('trajectory-inspector');
    expect(inspector.getAttribute('data-empty')).toBe('false');
    expect(inspector.getAttribute('data-inspector-key')).toBe(toolRow.getAttribute('data-row-key'));
  });
});

describe('D-46：壳把 composer 作为浮层并预留实测高度', () => {
  it('浮层结构 + 实测高度写 CSS 变量 + 轨迹记录表拿到同一预留值', () => {
    const { store, controller } = boot();
    const host = createComposerOverlayHost();
    const registry = createDesktopConversationViewRegistry({ composerHost: host });
    render(<ConversationSeat store={store} controller={controller} registry={registry} composerOverlayHost={host} />);

    // 浮层：composer 在 `.composer-overlay` 里（不是占文档流的普通子块）
    const overlay = screen.getByTestId('composer-overlay');
    expect(overlay.className).toBe('composer-overlay');
    expect(overlay.querySelector('[data-testid="composer-editor"]')).not.toBeNull();

    // 未测量 → 不写变量（不虚构预留）
    const seat = screen.getByTestId('conversation-seat');
    expect(seat.style.getPropertyValue(TRAJECTORY_COMPOSER_INSET_VAR)).toBe('');

    // 壳测得 88px → 预留 88+12（间距常量）写进 CSS 变量
    act(() => host.setHeightPx(88));
    expect(seat.style.getPropertyValue(TRAJECTORY_COMPOSER_INSET_VAR)).toBe('100px');

    // 轨迹视图读同一宿主：记录表拿到同值（壳一处测量、两处消费）
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));
    const panel = screen.getByTestId('trajectory-panel');
    expect(panel.getAttribute('data-composer-inset-px')).toBe('100');
    expect(panel.getAttribute('class')).toContain('trajectory-panel');
  });
});
