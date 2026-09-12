// T4 task-panel：用冻结的状态机渲染 TaskContract 列表（引用 interaction/types.ts，不复制定义）。
// - 纯 helper 提供格式化/排序/非法迁移拒绝；
// - 数据为注入式：in-process CLI 路径尚未把 task-coordinator 数据源接进 ChatRuntime（已登记缺口），
//   面板不伪造任务，空列表渲染 null；真实接线完成后只需把数据源传进来。
import React, { type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { canTaskTransition, isTerminalTaskState, type TaskContract, type TaskState } from '@harness2/core';

const STATE_LABEL: Record<TaskState, string> = {
  registered: '已登记',
  queued: '排队中',
  starting: '启动中',
  running: '运行中',
  'waiting-approval': '等待审批',
  stopping: '停止中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
};

/** 状态可读标签；终态显式标注（引用冻结的终态判定，不自带集合） */
export function formatTaskState(state: TaskState): string {
  return isTerminalTaskState(state) ? `${STATE_LABEL[state]}[终态]` : STATE_LABEL[state];
}

/**
 * UI 模型内的状态迁移：非法转移（冻结 canTaskTransition=false，含终态出边/自转移/回归）返回 null，
 * 调用方必须保留原状态（拒绝而非静默改写）。
 */
export function applyTaskTransition(task: TaskContract, to: TaskState, updatedAt?: string): TaskContract | null {
  if (!canTaskTransition(task.state, to)) return null;
  return { ...task, state: to, ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

/** 排序：进行中在前、终态在后；同组按 taskId 稳定排序（不改原数组） */
export function sortTasks(tasks: readonly TaskContract[]): TaskContract[] {
  return [...tasks].sort((a, b) => {
    const at = isTerminalTaskState(a.state) ? 1 : 0;
    const bt = isTerminalTaskState(b.state) ? 1 : 0;
    if (at !== bt) return at - bt;
    return a.taskId.localeCompare(b.taskId);
  });
}

export interface TaskCounts {
  total: number;
  active: number;
  terminal: number;
}

/** 计数（纯函数） */
export function taskPanelCounts(tasks: readonly TaskContract[]): TaskCounts {
  let terminal = 0;
  for (const t of tasks) if (isTerminalTaskState(t.state)) terminal += 1;
  return { total: tasks.length, active: tasks.length - terminal, terminal };
}

function stateIcon(state: TaskState): string {
  if (state === 'completed') return '✓';
  if (state === 'failed') return '✗';
  if (state === 'cancelled') return '⊘';
  if (state === 'unknown') return '?';
  return '◐';
}

export interface TaskPanelProps {
  tasks: readonly TaskContract[];
  /** 渲染条数上限（超出省略提示） */
  maxRows?: number;
}

export function TaskPanel({ tasks, maxRows = 8 }: TaskPanelProps): ReactElement | null {
  if (tasks.length === 0) return null;
  const counts = taskPanelCounts(tasks);
  const rows = sortTasks(tasks).slice(0, Math.max(0, maxRows));
  const hidden = tasks.length - rows.length;
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="cyan">
        任务 {counts.total}（进行中 {counts.active} / 终态 {counts.terminal}）
      </Text>
      {rows.map((task) => (
        <Text key={task.taskId} color={isTerminalTaskState(task.state) ? 'gray' : 'yellow'}>
          {stateIcon(task.state)} {task.taskId} · {formatTaskState(task.state)}
          {task.parentTaskId !== undefined ? ` · ↳ ${task.parentTaskId}` : ''}
          {task.background ? ' · 后台' : ''}
        </Text>
      ))}
      {hidden > 0 && <Text color="gray">… 还有 {hidden} 个任务</Text>}
    </Box>
  );
}
