// 右栏「后台任务」tab 内容（Z2-08）：`stream.tasks` 的任务列表（跨会话聚合，行带会话归属）。
// 依据与契约边界见 ./background-tasks-model.ts 文件头（ZCode Z-14 side pane 按需 tab；
// 契约没有的字段不显示；无 childSessionId 关联就没有跳转——红线⑩）。
// 数据源经壳注入（不抓全局单例，测试可注入假 store —— 与 ConversationStatusPanel 同口径）；
// 任务表在流缓冲里（不在 AppState），但每次写入都会 bump rev 产生新 state 引用，
// 订阅 getState 即可在任务到达时重渲（状态面板同一手法）。
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { TaskContractShape } from '../../shared/protocol.js';
import type { AppStore } from '../store.js';
import { cn } from '../../lib/utils.js';
import {
  backgroundTaskRows,
  type BackgroundTaskRow,
  type BackgroundTaskTone,
  type BackgroundTasksSource,
} from './background-tasks-model.js';

/** 状态 chip 色调 → 语义 token（模型层只出色调，类名集中在这里） */
const TONE_CLASS: Record<BackgroundTaskTone, string> = {
  neutral: 'text-foreground-subtle',
  active: 'text-success',
  attention: 'text-warning',
  done: 'text-success',
  failed: 'text-destructive',
};

export interface BackgroundTasksPaneProps {
  /** 会话数据源（壳注入；不抓全局单例） */
  readonly store: AppStore;
  /** 子会话跳转（复用 ToolCard 既有下钻机制的等价通道：选中 + 重放）。缺省 = 不渲染跳转 */
  readonly onOpenChildSession?: (childSessionId: string) => void;
}

/** 由 store 投影出各会话数据源（跨会话聚合：后台任务不随选中会话切换消失） */
function sourcesOf(store: AppStore): BackgroundTasksSource[] {
  const tasksBySession = new Map<string, TaskContractShape[]>();
  for (const { sessionId, task } of store.allTasks()) {
    const bucket = tasksBySession.get(sessionId);
    if (bucket === undefined) tasksBySession.set(sessionId, [task]);
    else bucket.push(task);
  }
  return [...tasksBySession.entries()].map(([sessionId, tasks]) => ({
    sessionId,
    tasks,
    events: store.peekStream(sessionId)?.events ?? [],
  }));
}

export function BackgroundTasksPane(props: BackgroundTasksPaneProps): ReactNode {
  const { store, onOpenChildSession } = props;
  useSyncExternalStore(store.subscribe, store.getState);
  const rows = backgroundTaskRows(sourcesOf(store));

  if (rows.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
        data-testid="bg-tasks-empty"
      >
        <p className="text-ui-sm text-foreground-subtle">暂无后台任务</p>
        <p className="text-ui-xs text-foreground-subtlest">后台子代理任务注册后在此展示</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 p-1.5" data-testid="bg-tasks-list">
      {rows.map((row) => (
        <BackgroundTaskRowItem
          key={`${row.sessionId}:${row.taskId}`}
          row={row}
          onOpenChildSession={onOpenChildSession}
        />
      ))}
    </div>
  );
}

function BackgroundTaskRowItem({
  row,
  onOpenChildSession,
}: {
  readonly row: BackgroundTaskRow;
  readonly onOpenChildSession?: (childSessionId: string) => void;
}): ReactNode {
  // 跳转只在两条件齐备时出现：真实关联到子会话 + 宿主给了跳转通道（红线⑩：不摆假按钮）
  const jumpable = row.childSessionId !== undefined && onOpenChildSession !== undefined;
  const rowTitle = jumpable
    ? `打开子会话 ${row.childSessionId as string} 轨迹`
    : [row.taskId, row.updatedAt !== undefined ? `更新于 ${row.updatedAt}` : undefined]
        .filter((part) => part !== undefined)
        .join(' · ');
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={row.taskId}>
        {row.taskId}
      </span>
      {!row.background && (
        <span className="flex-none text-ui-2xs text-foreground-subtlest" title="非后台注册的任务契约">
          前台
        </span>
      )}
      <span
        className="max-w-28 flex-none truncate font-mono text-ui-2xs text-foreground-subtlest"
        title={`会话 ${row.sessionId}`}
      >
        {row.sessionId}
      </span>
      <span
        data-bg-task-chip={row.state}
        className={cn('flex-none rounded-full px-1.5 text-ui-2xs leading-4', TONE_CLASS[row.tone])}
      >
        {row.stateLabel}
      </span>
      {jumpable && (
        <span aria-hidden className="flex-none text-foreground-subtlest">
          ↗
        </span>
      )}
    </>
  );

  if (jumpable) {
    return (
      <button
        type="button"
        data-testid="bg-task-row"
        data-bg-task-state={row.state}
        data-bg-task-session={row.sessionId}
        data-bg-task-jump={row.childSessionId}
        title={rowTitle}
        onClick={() => onOpenChildSession?.(row.childSessionId as string)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-xs hover:bg-surface-hover"
      >
        {body}
      </button>
    );
  }
  return (
    <div
      data-testid="bg-task-row"
      data-bg-task-state={row.state}
      data-bg-task-session={row.sessionId}
      title={rowTitle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-ui-xs"
    >
      {body}
    </div>
  );
}
