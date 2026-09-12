// T4 task-panel 测试：引用冻结状态机（canTaskTransition/终态），渲染多状态 TaskContract。
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'ink';
import type { TaskContract } from '@harness2/core';
import {
  TaskPanel,
  applyTaskTransition,
  formatTaskState,
  sortTasks,
  taskPanelCounts,
} from '../../src/tui/panels/task-panel.js';

function task(taskId: string, state: TaskContract['state'], over: Partial<TaskContract> = {}): TaskContract {
  return { taskId, background: false, state, ...over };
}

describe('task-panel：纯 helper（引用冻结状态机）', () => {
  it('非法迁移被拒绝返回 null（queued 不能直接 running；终态无出边）', () => {
    const queued = task('t1', 'queued');
    expect(applyTaskTransition(queued, 'running')).toBeNull(); // 冻结表：queued → starting/cancelled
    expect(applyTaskTransition(queued, 'starting')?.state).toBe('starting');

    const running = task('t2', 'running');
    expect(applyTaskTransition(running, 'waiting-approval')?.state).toBe('waiting-approval');

    const done = task('t3', 'completed');
    expect(applyTaskTransition(done, 'running')).toBeNull(); // 终态单调，禁止回归
    expect(applyTaskTransition(running, 'running')).toBeNull(); // 自转移非法
  });

  it('合法迁移写入 updatedAt，不改原对象', () => {
    const running = task('t4', 'running');
    const next = applyTaskTransition(running, 'stopping', '2026-09-11T00:00:00.000Z');
    expect(next?.state).toBe('stopping');
    expect(next?.updatedAt).toBe('2026-09-11T00:00:00.000Z');
    expect(running.state).toBe('running');
  });

  it('formatTaskState：终态显式标注', () => {
    expect(formatTaskState('running')).toBe('运行中');
    expect(formatTaskState('completed')).toBe('已完成[终态]');
    expect(formatTaskState('failed')).toBe('失败[终态]');
    expect(formatTaskState('cancelled')).toBe('已取消[终态]');
    expect(formatTaskState('waiting-approval')).toBe('等待审批');
  });

  it('sortTasks：进行中在前、终态在后，同组按 id 稳定；不改原数组', () => {
    const input = [task('c', 'completed'), task('a', 'running'), task('b', 'failed')];
    expect(sortTasks(input).map((t) => t.taskId)).toEqual(['a', 'b', 'c']);
    expect(input.map((t) => t.taskId)).toEqual(['c', 'a', 'b']);
  });

  it('taskPanelCounts：区分进行中/终态', () => {
    const tasks = [task('a', 'running'), task('b', 'waiting-approval'), task('c', 'completed'), task('d', 'unknown')];
    expect(taskPanelCounts(tasks)).toEqual({ total: 4, active: 2, terminal: 2 });
  });
});

describe('task-panel：渲染', () => {
  it('空列表渲染 null', () => {
    expect(renderToString(<TaskPanel tasks={[]} />)).toBe('');
  });

  it('渲染多个状态（含终态标注、父任务、后台标记）', () => {
    const tasks = [
      task('parent', 'running'),
      task('child', 'waiting-approval', { parentTaskId: 'parent', background: true }),
      task('old', 'failed'),
    ];
    const out = renderToString(<TaskPanel tasks={tasks} />);
    expect(out).toContain('任务 3（进行中 2 / 终态 1）');
    expect(out).toContain('parent · 运行中');
    expect(out).toContain('child · 等待审批 · ↳ parent · 后台');
    expect(out).toContain('old · 失败[终态]');
  });

  it('超过 maxRows 时提示省略数量', () => {
    const tasks = [task('t1', 'running'), task('t2', 'running'), task('t3', 'running')];
    const out = renderToString(<TaskPanel tasks={tasks} maxRows={2} />);
    expect(out).toContain('… 还有 1 个任务');
  });
});
