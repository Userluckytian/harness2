// 右栏「自动化」tab 内容（P0-3a）：本地 cron 任务（jobs.json）的**只读**列表。
// 依据 automation-model（形状与 core CronJob 同形 / 调度展示 / 状态徽标 / nextRun 相对时间）。
//
// 红线⑩（不摆假入口）：cron 的启停 / 新增 / 删除**都没有 IPC 通道**（只有 core CronJobStore.add /
// CLI `harness2 cron` 能改），所以本面板**没有任何启停按钮、没有增删入口**——它只是如实展示磁盘上
// 真实的任务表；改任务走 CLI。空态文案直接指向 CLI。
// 数据源经壳注入（不抓全局单例、不自行 fetch：桌面在 SidePanel 拉一次 cron:list 注入，web 无此通道
// → web 白名单不列本 tab，见 web-seat-contents）。`nowMs` 由调用方注入便于单测钉相对时间边界（D-14）。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import {
  automationStatusOf,
  describeScheduleDisplay,
  nextRunDisplay,
  type AutomationStatusTone,
  type CronJobShape,
} from './automation-model.js';

/** 状态徽标色调 → 语义 token（模型层只出色调，类名集中在这里；与 BackgroundTasksPane 同族） */
const TONE_CLASS: Record<AutomationStatusTone, string> = {
  active: 'text-success',
  failing: 'text-warning',
  disabled: 'text-foreground-subtle',
  fused: 'text-destructive',
};

export interface AutomationsPaneProps {
  /** cron 任务列表（桌面壳拉 cron:list 一次注入；只读） */
  readonly jobs: readonly CronJobShape[];
  /** 当前时刻（epoch ms；相对时间计算用，测试注入固定值） */
  readonly nowMs: number;
}

/** 单条任务行（instruction 主行 + 调度人话 + nextRun 相对时间 + 状态徽标；无任何操作按钮）。
 *  导出供「自动化」主区视图复用——两处任务列表共用同一行口径与徽标类名（不复制第二套展示）。 */
export function AutomationRow({ job, nowMs }: { job: CronJobShape; nowMs: number }): ReactNode {
  const status = automationStatusOf(job);
  return (
    <div
      data-testid="automation-row"
      data-automation-id={job.id}
      data-automation-enabled={job.enabled ? 'true' : 'false'}
      className="flex flex-col gap-1 rounded-md px-2.5 py-2 text-ui-xs hover:bg-surface-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-words text-foreground" title={job.instruction}>
          {job.instruction}
        </span>
        <span
          data-testid="automation-status"
          data-automation-tone={status.tone}
          className={cn('flex-none rounded-full px-1.5 text-ui-2xs leading-4', TONE_CLASS[status.tone])}
        >
          {status.label}
        </span>
      </div>
      <div className="flex items-center gap-2 font-mono text-ui-2xs text-foreground-subtlest">
        <span title={job.schedule}>{describeScheduleDisplay(job.schedule)}</span>
        <span aria-hidden="true">·</span>
        <span title={`nextRun=${job.nextRun}`}>下次 {nextRunDisplay(job.nextRun, nowMs)}</span>
        {job.failCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span title={job.lastError ?? `连续失败 ${job.failCount} 次`}>失败 {job.failCount}</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 渲染自动化面板。
 * @param props - 只读任务列表与当前时刻。
 * @returns 列表或空态；**始终不含启停/增删按钮**（红线⑩）。
 */
export function AutomationsPane({ jobs, nowMs }: AutomationsPaneProps): ReactNode {
  if (jobs.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
        data-testid="automations-empty"
      >
        <p className="text-ui-sm text-foreground-subtle">暂无定时任务</p>
        <p className="text-ui-xs text-foreground-subtlest">
          用 CLI 添加：<span className="font-mono">harness2 cron add …</span>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 p-1.5" data-testid="automations-list">
      {jobs.map((job) => (
        <AutomationRow key={job.id} job={job} nowMs={nowMs} />
      ))}
    </div>
  );
}
