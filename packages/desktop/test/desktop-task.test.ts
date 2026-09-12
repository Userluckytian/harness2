// D3 任务面板测试（F6）：父子归属、孤儿不丢、状态可读、单任务停止不误伤兄弟。
import { describe, expect, it, vi } from 'vitest';
import {
  buildTaskTree,
  isTerminalTaskState,
  summarizeTasks,
  taskStateLabel,
} from '../src/renderer/features/plan/plan-model.js';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import type { Harness2Api, TaskContractShape } from '../src/shared/protocol.js';

const t = (over: Partial<TaskContractShape> & { taskId: string }): TaskContractShape => ({
  background: true,
  state: 'running',
  ...over,
});

describe('buildTaskTree', () => {
  it('按 parentTaskId 归组；兄弟并行都保留', () => {
    const roots = buildTaskTree([
      t({ taskId: 'root', state: 'running' }),
      t({ taskId: 'child-a', parentTaskId: 'root', state: 'running' }),
      t({ taskId: 'child-b', parentTaskId: 'root', state: 'running' }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.task.taskId).toBe('root');
    expect(roots[0]!.children.map((c) => c.task.taskId)).toEqual(['child-a', 'child-b']);
  });

  it('父不在快照（账本不全）→ 作为根并标记 orphan，不静默丢弃', () => {
    const roots = buildTaskTree([t({ taskId: 'child-x', parentTaskId: 'gone' })]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.orphan).toBe(true);
    expect(roots[0]!.task.taskId).toBe('child-x');
  });

  it('终态标记 + 状态标签（失败不冒充完成）', () => {
    const roots = buildTaskTree([t({ taskId: 'a', state: 'failed' }), t({ taskId: 'b', state: 'completed' })]);
    const byId = new Map(roots.map((r) => [r.task.taskId, r]));
    expect(byId.get('a')!.terminal).toBe(true);
    expect(byId.get('a')!.stateLabel).toBe('失败');
    expect(byId.get('b')!.stateLabel).toBe('已完成');
    expect(isTerminalTaskState('unknown')).toBe(true);
    expect(isTerminalTaskState('running')).toBe(false);
    expect(taskStateLabel('waiting-approval')).toBe('等待审批');
  });
});

describe('summarizeTasks（并发概览来自真实状态）', () => {
  it('计数与等审批任务 id 列表', () => {
    const s = summarizeTasks([
      t({ taskId: 'a', state: 'running' }),
      t({ taskId: 'b', state: 'running' }),
      t({ taskId: 'c', state: 'waiting-approval' }),
      t({ taskId: 'd', state: 'completed' }),
    ]);
    expect(s).toMatchObject({ total: 4, running: 2, waitingApproval: 1, terminal: 1 });
    expect(s.waitingTaskIds).toEqual(['c']);
  });
});

describe('单任务停止不误伤兄弟（真实 cancel op）', () => {
  it('cancelTask 只发目标 task id，且 target.kind=task', async () => {
    const store = new AppStore();
    const cancel = vi.fn(async (_op: { requestId: string; target: { kind: string; id: string } }) => undefined);
    const api = { cancel } as unknown as Harness2Api;
    const controller = createController(store, api);
    await controller.cancelTask('child-a');
    expect(cancel).toHaveBeenCalledTimes(1);
    const arg = cancel.mock.calls[0]![0];
    expect(arg.target).toEqual({ kind: 'task', id: 'child-a' });
    expect(arg.requestId.length).toBeGreaterThan(0);
  });

  it('cancelTurn 无运行中 turn 时回退 abort（如实，不伪造 cancel-ack）', async () => {
    const store = new AppStore();
    store.applyReplay({
      id: 's1',
      dir: 'd',
      header: { sessionId: 's1' },
      events: [{ v: 1, seq: 1, ts: 't', type: 'session/header', payload: {}, active: true }],
      warnings: [],
      lastSeq: 1,
    });
    const abort = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const controller = createController(store, { abort, cancel } as unknown as Harness2Api);
    await controller.cancelTurn('s1');
    expect(abort).toHaveBeenCalledWith('s1');
    expect(cancel).not.toHaveBeenCalled();
  });
});
