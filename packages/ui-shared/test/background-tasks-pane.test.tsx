// @vitest-environment jsdom
// 右栏「后台任务」tab（Z2-08）：纯模型（状态映射/色调/终态/子会话关联/聚合排序）+
// 组件（列表渲染、空态、跳转显隐——红线⑩：无 childSessionId 关联就没有跳转按钮）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import type { TaskContractShape, WsFrame } from '../src/shared/protocol.js';
import type { ActiveEvent } from '../src/renderer/chat-model.js';
import {
  backgroundTaskRows,
  backgroundTaskStateLabel,
  backgroundTaskTone,
  isBackgroundTaskTerminal,
  taskChildSessionIndex,
  type BackgroundTasksSource,
} from '../src/renderer/side-pane/background-tasks-model.js';
import { BackgroundTasksPane } from '../src/renderer/side-pane/BackgroundTasksPane.js';

afterEach(cleanup);

// —— 夹具 ——

function task(partial: Partial<TaskContractShape> & { taskId: string }): TaskContractShape {
  return { background: true, state: 'running', ...partial };
}

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): ActiveEvent {
  seq += 1;
  return { v: 1, seq, ts: '2026-10-11T00:00:00Z', type, payload, active: true };
}

function eventFrame(sessionId: string, event: ActiveEvent): WsFrame {
  return { type: 'event', sessionId, event };
}

/** 造一个带任务 + subagent result 事件流的 store（resume-snapshot 是任务表的唯一同步方） */
function storeWith(sessionId: string, tasks: TaskContractShape[], events: ActiveEvent[] = []): AppStore {
  const store = new AppStore();
  store.applyFrame({
    type: 'resume-snapshot',
    sessionId,
    epoch: 1,
    snapshot: { epoch: 1, replay: { fromSeq: 0, toSeq: 0 }, tasks, pendingApprovals: [], queue: [] },
  });
  for (const e of events) store.applyFrame(eventFrame(sessionId, e));
  return store;
}

const SUBAGENT_RESULT = JSON.stringify({ taskId: 'bg-c1', childSessionId: 'child-1', state: 'running' });
const SUBAGENT_EVENTS: ActiveEvent[] = [
  ev('tool/call', { callId: 'c1', tool: 'subagent_start', turnId: 't1', args: {} }),
  ev('tool/result', { callId: 'c1', ok: true, output: SUBAGENT_RESULT }),
];

// —— 纯模型：状态映射（Z2-08 验收表口径） ——

describe('backgroundTaskStateLabel / backgroundTaskTone / isBackgroundTaskTerminal', () => {
  it('状态 → 中文（非终态：registered=已注册/queued=排队/starting=启动中/running=运行中/waiting-approval=待审批/stopping=停止中）', () => {
    expect(backgroundTaskStateLabel('registered')).toBe('已注册');
    expect(backgroundTaskStateLabel('queued')).toBe('排队');
    expect(backgroundTaskStateLabel('starting')).toBe('启动中');
    expect(backgroundTaskStateLabel('running')).toBe('运行中');
    expect(backgroundTaskStateLabel('waiting-approval')).toBe('待审批');
    expect(backgroundTaskStateLabel('stopping')).toBe('停止中');
  });
  it('终态如实映射：completed=已完成/failed=失败/cancelled=已取消/unknown=未知', () => {
    expect(backgroundTaskStateLabel('completed')).toBe('已完成');
    expect(backgroundTaskStateLabel('failed')).toBe('失败');
    expect(backgroundTaskStateLabel('cancelled')).toBe('已取消');
    expect(backgroundTaskStateLabel('unknown')).toBe('未知');
  });
  it('终态集合 = completed/failed/cancelled/unknown（与状态面板/桌面 plan-model 同一套契约口径）', () => {
    expect(isBackgroundTaskTerminal('completed')).toBe(true);
    expect(isBackgroundTaskTerminal('failed')).toBe(true);
    expect(isBackgroundTaskTerminal('cancelled')).toBe(true);
    expect(isBackgroundTaskTerminal('unknown')).toBe(true);
    expect(isBackgroundTaskTerminal('running')).toBe(false);
    expect(isBackgroundTaskTerminal('queued')).toBe(false);
    expect(isBackgroundTaskTerminal('waiting-approval')).toBe(false);
  });
  it('色调：进行中=active、等审批/停止中=attention、完成=done、失败=failed、其余 neutral', () => {
    expect(backgroundTaskTone('running')).toBe('active');
    expect(backgroundTaskTone('starting')).toBe('active');
    expect(backgroundTaskTone('waiting-approval')).toBe('attention');
    expect(backgroundTaskTone('stopping')).toBe('attention');
    expect(backgroundTaskTone('completed')).toBe('done');
    expect(backgroundTaskTone('failed')).toBe('failed');
    expect(backgroundTaskTone('queued')).toBe('neutral');
    expect(backgroundTaskTone('registered')).toBe('neutral');
    expect(backgroundTaskTone('cancelled')).toBe('neutral');
    expect(backgroundTaskTone('unknown')).toBe('neutral');
  });
});

// —— 纯模型：taskId → childSessionId 关联（唯一真实通道 = subagent_* result 的 output JSON） ——

describe('taskChildSessionIndex（红线⑩：只认真实线数据，不猜）', () => {
  it('subagent_start / 查询路径（subagent_* 前缀）result 输出 JSON 同时含 taskId+childSessionId → 关联', () => {
    const events: ActiveEvent[] = [
      ...SUBAGENT_EVENTS,
      ev('tool/call', { callId: 'c2', tool: 'subagent_continue', turnId: 't1', args: {} }),
      ev('tool/result', {
        callId: 'c2',
        ok: true,
        output: JSON.stringify({ taskId: 'bg-c9', childSessionId: 'child-9', state: 'completed' }),
      }),
    ];
    const index = taskChildSessionIndex(events);
    expect(index.get('bg-c1')).toBe('child-1');
    expect(index.get('bg-c9')).toBe('child-9');
  });
  it('非 subagent 工具同形 JSON → 忽略（不扩大关联面）', () => {
    const events: ActiveEvent[] = [
      ev('tool/call', { callId: 'c1', tool: 'bash', turnId: 't1', args: {} }),
      ev('tool/result', { callId: 'c1', ok: true, output: SUBAGENT_RESULT }),
    ];
    expect(taskChildSessionIndex(events).size).toBe(0);
  });
  it('非 JSON / 缺 childSessionId / 缺 taskId / 无 output → 忽略', () => {
    const events: ActiveEvent[] = [
      ev('tool/call', { callId: 'c1', tool: 'subagent_start', turnId: 't1', args: {} }),
      ev('tool/result', { callId: 'c1', ok: false, output: 'boom: not json' }),
      ev('tool/result', { callId: 'c1', ok: true, output: JSON.stringify({ taskId: 'bg-x', state: 'running' }) }),
      ev('tool/result', { callId: 'c1', ok: true, output: JSON.stringify({ childSessionId: 'child-x' }) }),
      ev('tool/result', { callId: 'c1', ok: true }),
    ];
    expect(taskChildSessionIndex(events).size).toBe(0);
  });
  it('孤立 result（无 tool/call 宿主）回落 payload.tool 识别 subagent 工具', () => {
    const events: ActiveEvent[] = [
      ev('tool/result', { callId: 'c7', tool: 'subagent_start', ok: true, output: SUBAGENT_RESULT }),
    ];
    expect(taskChildSessionIndex(events).get('bg-c1')).toBe('child-1');
  });
});

// —— 纯模型：聚合与排序 ——

describe('backgroundTaskRows（跨会话聚合 + 排序）', () => {
  const source = (
    sessionId: string,
    tasks: TaskContractShape[],
    events: ActiveEvent[] = [],
  ): BackgroundTasksSource => ({
    sessionId,
    tasks,
    events,
  });

  it('行字段：会话归属 / 中文标签 / 终态 / background / updatedAt / parentTaskId / childSessionId', () => {
    const rows = backgroundTaskRows([
      source(
        's1',
        [task({ taskId: 'bg-c1', state: 'running', updatedAt: '2026-10-11T01:00:00Z', parentTaskId: 'p1' })],
        SUBAGENT_EVENTS,
      ),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: 'bg-c1',
      sessionId: 's1',
      state: 'running',
      stateLabel: '运行中',
      tone: 'active',
      terminal: false,
      background: true,
      updatedAt: '2026-10-11T01:00:00Z',
      parentTaskId: 'p1',
      childSessionId: 'child-1',
    });
  });

  it('关联不到子会话 → 无 childSessionId 字段（只读行，红线⑩）', () => {
    const rows = backgroundTaskRows([source('s1', [task({ taskId: 'bg-lonely' })])]);
    expect(rows[0]?.childSessionId).toBeUndefined();
  });

  it('排序：非终态在前 → updatedAt 新→旧 → 缺 updatedAt 落最后；同键稳定', () => {
    const rows = backgroundTaskRows([
      source('s1', [
        task({ taskId: 'old-done', state: 'completed', updatedAt: '2026-10-10T00:00:00Z' }),
        task({ taskId: 'newer-running', state: 'running', updatedAt: '2026-10-11T02:00:00Z' }),
        task({ taskId: 'older-running', state: 'running', updatedAt: '2026-10-11T01:00:00Z' }),
        task({ taskId: 'no-time-done', state: 'failed' }),
      ]),
    ]);
    expect(rows.map((r) => r.taskId)).toEqual(['newer-running', 'older-running', 'old-done', 'no-time-done']);
  });

  it('防御：tasks 缺失/非数组、坏条目不崩溃', () => {
    expect(backgroundTaskRows([])).toEqual([]);
    expect(backgroundTaskRows([source('s1', [])])).toEqual([]);
    expect(backgroundTaskRows([source('s1', undefined as unknown as TaskContractShape[])])).toEqual([]);
    const rows = backgroundTaskRows([source('s1', [null as unknown as TaskContractShape, task({ taskId: 'ok' })])]);
    expect(rows.map((r) => r.taskId)).toEqual(['ok']);
  });

  it('前台任务（background:false）如实带 background=false 标记', () => {
    const rows = backgroundTaskRows([source('s1', [task({ taskId: 'fg-1', background: false })])]);
    expect(rows[0]?.background).toBe(false);
  });
});

// —— 组件 ——

describe('BackgroundTasksPane（右栏「后台任务」tab 内容）', () => {
  it('无任务 → 真实空态「暂无后台任务」（不摆假列表）', () => {
    render(<BackgroundTasksPane store={new AppStore()} />);
    expect(screen.getByTestId('bg-tasks-empty').textContent).toContain('暂无后台任务');
    expect(screen.queryByTestId('bg-tasks-list')).toBeNull();
  });

  it('任务到达 → 列表渲染：taskId / 会话归属 / 中文状态 chip；非终态排在前面', () => {
    const store = storeWith('s1', [
      task({ taskId: 'bg-done', state: 'completed', updatedAt: '2026-10-10T00:00:00Z' }),
      task({ taskId: 'bg-run', state: 'running', updatedAt: '2026-10-11T00:00:00Z' }),
      task({ taskId: 'bg-wait', state: 'waiting-approval' }),
    ]);
    render(<BackgroundTasksPane store={store} />);
    const rows = screen.getAllByTestId('bg-task-row');
    expect(rows).toHaveLength(3);
    // 排序：bg-run（新）→ bg-wait（非终态、缺 updatedAt）→ bg-done（终态）
    expect(rows.map((r) => r.getAttribute('data-bg-task-state'))).toEqual(['running', 'waiting-approval', 'completed']);
    expect(rows[0]?.getAttribute('data-bg-task-session')).toBe('s1');
    expect(rows[0]?.textContent).toContain('bg-run');
    expect(rows[0]?.textContent).toContain('s1');
    expect(rows[0]?.textContent).toContain('运行中');
    expect(rows[2]?.textContent).toContain('已完成');
    // chip 带状态标记（色调由语义 token 渲染，这里验结构与状态映射）
    expect(rows[1]?.querySelector('[data-bg-task-chip="waiting-approval"]')?.textContent).toBe('待审批');
  });

  it('有关联 + 有跳转通道 → 整行可点（按钮 + ↗），点击跳子会话', () => {
    const onOpenChildSession = vi.fn();
    const store = storeWith('s1', [task({ taskId: 'bg-c1' })], SUBAGENT_EVENTS);
    render(<BackgroundTasksPane store={store} onOpenChildSession={onOpenChildSession} />);
    const row = screen.getByTestId('bg-task-row');
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('data-bg-task-jump')).toBe('child-1');
    expect(row.getAttribute('title')).toBe('打开子会话 child-1 轨迹');
    fireEvent.click(row);
    expect(onOpenChildSession).toHaveBeenCalledWith('child-1');
  });

  it('无关联 → 只读行（div，无跳转标记），红线⑩：不摆假按钮', () => {
    const store = storeWith('s1', [task({ taskId: 'bg-lonely' })]);
    render(<BackgroundTasksPane store={store} onOpenChildSession={vi.fn()} />);
    const row = screen.getByTestId('bg-task-row');
    expect(row.tagName).toBe('DIV');
    expect(row.hasAttribute('data-bg-task-jump')).toBe(false);
  });

  it('有关联但宿主未给跳转通道 → 不渲染跳转（不摆死按钮）', () => {
    const store = storeWith('s1', [task({ taskId: 'bg-c1' })], SUBAGENT_EVENTS);
    render(<BackgroundTasksPane store={store} />);
    expect(screen.getByTestId('bg-task-row').tagName).toBe('DIV');
    expect(screen.getByTestId('bg-task-row').hasAttribute('data-bg-task-jump')).toBe(false);
  });

  it('前台任务行显示「前台」标记；跨会话聚合（两会话的任务同列表）', () => {
    const store = new AppStore();
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 1,
      snapshot: {
        epoch: 1,
        replay: { fromSeq: 0, toSeq: 0 },
        tasks: [task({ taskId: 'fg-1', background: false })],
        pendingApprovals: [],
        queue: [],
      },
    });
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's2',
      epoch: 1,
      snapshot: {
        epoch: 1,
        replay: { fromSeq: 0, toSeq: 0 },
        tasks: [task({ taskId: 'bg-2' })],
        pendingApprovals: [],
        queue: [],
      },
    });
    render(<BackgroundTasksPane store={store} />);
    const rows = screen.getAllByTestId('bg-task-row');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute('data-bg-task-session'))).toEqual(['s1', 's2']);
    expect(rows[0]?.textContent).toContain('前台');
  });
});
