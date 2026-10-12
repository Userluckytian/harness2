// P0「自动化」**主区视图**（壳无关；ZCode 官方实测面复刻，2026-10-11 真浏览器 :5173）。
//
// 结构（自上而下，逐字对齐实测）：
//   1. 顶部子 tab：`自动化 | 工作流`（role=tablist/tab）；
//   2. 自动化页：无任务时落空态（文案逐字），有任务时复用 automation-model 的展示函数与
//      AutomationRow 徽标行（**不复制第二套口径**）；
//   3. 「ZCode 运行会话时保持电脑唤醒。」提示行（纯文案——本仓无 wake-lock 实现，如实展示，
//      **不假装已实现电源管理**）；
//   4. 分区「定时任务模板」四张卡（文案逐字，见 template-model）；卡片动作 = 用模板创建任务。
//
// 通道判定（红色线⑩：无通道 = disabled + title + data-placeholder；不摆可点的假按钮）：
//   - 模板卡：`onCreateFromTemplate` 缺省（web 无 cron 通道）→ 每张卡 disabled + 说明；
//   - 「创建定时任务」钮：`onCreate` 缺省 → disabled + 说明；
//   - 有通道（桌面）：卡片/按钮可点，创建走注入回调（桌面真：IPC cron:add）。
// 数据源经壳注入（jobs/nowMs 均 props），本组件不抓全局、不 fetch、不自行计时。
import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { AutomationRow } from '../side-pane/AutomationsPane.js';
import type { CronJobShape } from '../side-pane/automation-model.js';
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from './template-model.js';

/** 顶部子 tab */
type AutomationTab = 'automations' | 'workflows';

export interface AutomationsMainViewProps {
  /** cron 任务列表（桌面壳拉 cron:list 注入；web 无通道 → 空表，落空态） */
  readonly jobs: readonly CronJobShape[];
  /** 当前时刻（epoch ms；相对时间计算用，测试注入固定值） */
  readonly nowMs: number;
  /** 用模板创建任务（桌面真通道 = IPC cron:add）；缺省 = 无通道 → 模板卡 disabled */
  readonly onCreateFromTemplate?: ((template: AutomationTemplate) => void) | undefined;
  /** 创建自定义定时任务（instruction + schedule）；缺省 = 无通道 → 创建钮 disabled */
  readonly onCreate?: ((instruction: string, schedule: string) => void) | undefined;
}

/** 无通道占位说明（title；红色线⑩不说空话，明确告知为何不可点） */
const NO_CHANNEL_TITLE = '当前环境无定时任务通道（桌面端可用）';

/** 「工作流」页：无通道 → 如实空态（**不摆假工作流列表**）。 */
function WorkflowsEmpty(): ReactNode {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="automation-workflows-empty"
    >
      <p className="text-ui-sm text-foreground-subtle">工作流尚无可用通道</p>
      <p className="text-ui-xs text-foreground-subtlest">harness2 目前未接入工作流数据源，此页暂不可用。</p>
    </div>
  );
}

/** 「创建定时任务」内联表单（有通道时才出现；最小可用创建面，避免摆一个点不动的死钮） */
function CreateForm({
  onCreate,
  onClose,
}: {
  onCreate: (instruction: string, schedule: string) => void;
  onClose: () => void;
}): ReactNode {
  const [instruction, setInstruction] = useState('');
  const [schedule, setSchedule] = useState('');
  const canSubmit = instruction.trim().length > 0 && schedule.trim().length > 0;
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid="automation-create-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onCreate(instruction.trim(), schedule.trim());
        onClose();
      }}
    >
      <label className="flex flex-col gap-1 text-ui-xs text-foreground-subtle">
        <span>指令</span>
        <textarea
          data-testid="automation-create-instruction"
          className="min-h-16 rounded border border-border bg-surface px-2 py-1 text-ui-xs text-foreground"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-ui-xs text-foreground-subtle">
        <span>调度（如 5m / daily 09:00 / weekly 1,2,3,4,5 09:00）</span>
        <input
          data-testid="automation-create-schedule"
          className="rounded border border-border bg-surface px-2 py-1 font-mono text-ui-xs text-foreground"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          data-testid="automation-create-submit"
          disabled={!canSubmit}
          className={cn(
            'rounded px-2 py-0.5 text-ui-xs',
            canSubmit ? 'bg-accent text-accent-foreground cursor-pointer' : 'text-foreground-subtle',
          )}
        >
          创建
        </button>
        <button
          type="button"
          data-testid="automation-create-cancel"
          className="text-ui-xs text-foreground-subtle hover:text-foreground cursor-pointer"
          onClick={onClose}
        >
          取消
        </button>
      </div>
    </form>
  );
}

/** 自动化页（空态 / 任务列表 + 提示行 + 模板分区） */
function ScheduledPanel(props: AutomationsMainViewProps): ReactNode {
  const { jobs, nowMs, onCreateFromTemplate, onCreate } = props;
  const [formOpen, setFormOpen] = useState(false);
  const hasCreateChannel = onCreate !== undefined;
  const hasTemplateChannel = onCreateFromTemplate !== undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      {jobs.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center gap-2 py-6 text-center"
          data-testid="automation-empty"
        >
          <p className="text-ui-sm text-foreground-subtle">创建定时任务，或排队在闲时算力空闲时后台执行。</p>
          <p className="text-ui-xs text-foreground-subtlest">还没有定时任务</p>
          <button
            type="button"
            data-testid="automation-create"
            className={cn(
              'rounded-md px-3 py-1 text-ui-sm',
              hasCreateChannel
                ? 'bg-accent text-accent-foreground cursor-pointer'
                : 'text-foreground-subtle cursor-not-allowed',
            )}
            disabled={!hasCreateChannel}
            {...(hasCreateChannel ? {} : { 'data-placeholder': 'true', title: NO_CHANNEL_TITLE })}
            onClick={() => setFormOpen(true)}
          >
            创建定时任务
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5" data-testid="automation-job-list">
          {jobs.map((job) => (
            <AutomationRow key={job.id} job={job} nowMs={nowMs} />
          ))}
        </div>
      )}

      {/* 提示行：如实展示（本仓无 wake-lock 实现，不做电源管理，仅文案）。
          品牌按本仓替换（ZCode 原文为「ZCode 运行会话时保持电脑唤醒。」，我们壳内不显示他方品牌）。 */}
      <p className="text-center text-ui-2xs text-foreground-subtlest" data-testid="automation-wake-hint">
        harness2 运行会话时保持电脑唤醒。
      </p>

      {formOpen && onCreate !== undefined && <CreateForm onCreate={onCreate} onClose={() => setFormOpen(false)} />}

      {/* 分区「定时任务模板」：四张卡逐字实测；无通道（web）→ 全部 disabled + 说明 */}
      <section className="flex flex-col gap-2" data-testid="automation-templates">
        <h3 className="text-ui-xs font-medium text-foreground-subtle">定时任务模板</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {AUTOMATION_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              data-testid={`automation-template-${template.id}`}
              data-template-schedule={template.schedule}
              className={cn(
                'flex flex-col gap-1 rounded-md border border-border p-3 text-left',
                hasTemplateChannel ? 'hover:bg-surface-hover cursor-pointer' : 'cursor-not-allowed opacity-70',
              )}
              disabled={!hasTemplateChannel}
              {...(hasTemplateChannel
                ? { title: `用模板创建：${template.title}` }
                : { 'data-placeholder': 'true', title: NO_CHANNEL_TITLE })}
              onClick={() => onCreateFromTemplate?.(template)}
            >
              <span className="text-ui-sm text-foreground">{template.title}</span>
              <span className="text-ui-2xs text-foreground-subtlest">{template.instruction}</span>
              <span className="font-mono text-ui-2xs text-foreground-subtle">{template.scheduleLabel}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * 渲染「自动化」主区视图。
 * @param props - 任务表 + 当前时刻 + 两个可选创建回调（缺省 = 无通道 → 对应入口 disabled）。
 * @returns 子 tab + 当前页内容。
 */
export function AutomationsMainView(props: AutomationsMainViewProps): ReactNode {
  const [tab, setTab] = useState<AutomationTab>('automations');
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="automations-main">
      <div
        role="tablist"
        aria-label="自动化"
        className="flex flex-none items-center gap-1 border-b border-border px-2 py-1"
        data-testid="automation-tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'automations'}
          data-testid="automation-tab-scheduled"
          className={cn(
            'rounded px-2 py-0.5 text-ui-sm cursor-pointer',
            tab === 'automations' ? 'text-foreground bg-surface-hover' : 'text-foreground-subtle hover:text-foreground',
          )}
          onClick={() => setTab('automations')}
        >
          自动化
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'workflows'}
          data-testid="automation-tab-workflows"
          className={cn(
            'rounded px-2 py-0.5 text-ui-sm cursor-pointer',
            tab === 'workflows' ? 'text-foreground bg-surface-hover' : 'text-foreground-subtle hover:text-foreground',
          )}
          onClick={() => setTab('workflows')}
        >
          工作流
        </button>
      </div>
      {tab === 'workflows' ? <WorkflowsEmpty /> : <ScheduledPanel {...props} />}
    </div>
  );
}
