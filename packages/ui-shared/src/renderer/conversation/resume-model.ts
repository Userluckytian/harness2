// 恢复条纯模型（Z2-09b / Z-17「配额 / Banner / 恢复条：按需」）：
// 断线重连 / 重订阅成功（resume-snapshot 到达）后，「已恢复在途状态」横条的计数与文案。
//
// 计数口径（ResumeSnapshotShape 的真实字段，shared/protocol.ts:280-297——没有的字段不编）：
//   - activeAttempt：断线时仍在跑的 attempt → 计 1 条在途任务；
//   - tasks：非终态（registered/queued/starting/running/waiting-approval/stopping）逐条计；
//   - pendingApprovals：逐条计（在途审批）。
// queue 不计入：排队消息不是「任务/审批」口径，且队列面板（QueuePanel）常驻可见，不重复计数。
import type { ResumeSnapshotShape, TaskStateShape } from '../../shared/protocol.js';

/** 任务终态（与 controller.stopAll / store.runtimeCounts 的非终态判定同口径） */
const TERMINAL_TASK_STATES: ReadonlySet<TaskStateShape> = new Set(['completed', 'failed', 'cancelled', 'unknown']);

/** 恢复条自动消失时长（ms；Z2-09b 交付口径：8s） */
export const RESUME_BAR_AUTO_DISMISS_MS = 8_000;

/**
 * 快照携带的在途任务/审批计数（恢复条「N 条在途任务/审批」的数据源）。
 * 纯函数：只读 snapshot 形状内真实存在的字段。
 */
export function resumeInflightCount(snapshot: ResumeSnapshotShape): number {
  let count = snapshot.activeAttempt !== undefined ? 1 : 0;
  for (const task of snapshot.tasks) {
    if (!TERMINAL_TASK_STATES.has(task.state)) count += 1;
  }
  return count + snapshot.pendingApprovals.length;
}

/** 恢复条文案（count=0 时如实说「无」，不显示 0 条假数字） */
export function resumeRecoveryText(count: number): string {
  return count > 0 ? `已恢复在途状态（${count} 条在途任务/审批）` : '已恢复在途状态（无在途任务/审批）';
}
