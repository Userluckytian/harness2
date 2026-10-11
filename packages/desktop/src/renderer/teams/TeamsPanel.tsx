// 桌面 Teams 只读面板（A11 批次6-B，最小 GUI）。
//
// 承载选择（登记）：接 **Z3-03 状态面板注册缝**——`conversation/assembly.tsx` 的
// `desktopStatusPanel` 桌面缺省实现里与 `ConversationStatusPanel` 并列渲染本面板
// （Z2-04 side-pane 的 tab 目录在 ui-shared、按本批次「只动 core/desktop」的边界不改，
// 故不走右栏 tab；登记选型理由见交付报告）。
//
// 只读语义（红线⑩）：无团队 → 空态（`teams-empty`，绝不摆假条目）；数据源 = teamsViewStore
// 里**已被 core 落盘投影**的快照（缺口登记：桌面暂无 Teams 数据通道，见 teams-view-store.ts）。
// 样式只复用语义 token 与 text-ui-*，不引新依赖。
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { teamsViewStore } from './teams-view-store.js';
import type { TeamsViewMember, TeamsViewTask, TeamsViewTeam } from './types.js';

export interface TeamsPanelProps {
  /** 显式团队快照（测试注入）；缺省订阅应用单例 teamsViewStore */
  readonly teams?: readonly TeamsViewTeam[];
  /** 单个团队最多展示的成员行数（超出收进「其余 N」） */
  readonly maxMembers?: number;
  /** 单个团队最多展示的任务行数 */
  readonly maxTasks?: number;
}

/** 成员相位词 → 语义色（未知值不造色，回落 subtle） */
function memberStatusClass(status: string): string {
  switch (status) {
    case 'running':
      return 'text-warning';
    case 'done':
      return 'text-success';
    case 'failed':
      return 'text-destructive';
    case 'stopped':
      return 'text-foreground-subtle';
    default:
      return 'text-foreground-subtlest';
  }
}

/** 任务状态标记（纯展示；未知值回落空方框） */
function taskMark(status: string): string {
  switch (status) {
    case 'claimed':
      return '[>]';
    case 'done':
      return '[✓]';
    case 'failed':
      return '[✗]';
    case 'blocked':
      return '[!]';
    default:
      return '[ ]';
  }
}

function taskStatusClass(status: string): string {
  switch (status) {
    case 'claimed':
      return 'text-warning';
    case 'done':
      return 'text-success';
    case 'failed':
      return 'text-destructive';
    default:
      return 'text-foreground-subtlest';
  }
}

/** 运行计数（与 core teamRunCounts 同口径；从只读形状现算） */
function countsOf(team: TeamsViewTeam): { membersRunning: number; tasks: number; tasksClaimed: number } {
  return {
    membersRunning: team.members.filter((m) => m.status === 'running').length,
    tasks: team.tasks.length,
    tasksClaimed: team.tasks.filter((t) => t.status === 'claimed').length,
  };
}

function MemberRow({ member }: { readonly member: TeamsViewMember }): ReactNode {
  const detail = member.error ?? member.outputPreview ?? '';
  return (
    <div className="flex items-center gap-2 text-ui-xs" data-testid="teams-member" data-member={member.name}>
      <span
        className={`size-1.5 flex-none rounded-full ${member.status === 'running' ? 'bg-warning' : 'bg-idle-task'}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={member.name}>
        {member.name}
      </span>
      <span className="flex-none text-ui-2xs text-foreground-subtlest">{member.writeMode}</span>
      <span className={`flex-none text-ui-2xs ${memberStatusClass(member.status)}`}>{member.status}</span>
      {member.rounds > 0 && (
        <span className="flex-none font-mono text-ui-2xs text-foreground-subtlest">×{member.rounds}</span>
      )}
      {detail.length > 0 && (
        <span className="min-w-0 flex-1 truncate text-ui-2xs text-foreground-subtlest" title={detail}>
          {detail}
        </span>
      )}
    </div>
  );
}

function TaskRow({ task }: { readonly task: TeamsViewTask }): ReactNode {
  return (
    <div className="flex items-center gap-2 text-ui-xs">
      <span className={`flex-none font-mono text-ui-2xs ${taskStatusClass(task.status)}`} aria-hidden>
        {taskMark(task.status)}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={task.title}>
        {task.title}
      </span>
      {task.owner !== undefined && (
        <span className="flex-none text-ui-2xs text-foreground-subtlest">@{task.owner}</span>
      )}
    </div>
  );
}

function TeamBlock({
  team,
  maxMembers,
  maxTasks,
}: {
  readonly team: TeamsViewTeam;
  readonly maxMembers: number;
  readonly maxTasks: number;
}): ReactNode {
  const counts = countsOf(team);
  const members = team.members.slice(0, maxMembers);
  const tasks = team.tasks.slice(0, maxTasks);
  return (
    <div data-testid="teams-team" data-team-id={team.teamId} className="border-b border-border py-1.5 last:border-b-0">
      <div className="flex items-center gap-2 text-ui-sm text-foreground">
        <span className="min-w-0 flex-1 truncate" title={team.name}>
          {team.name}
        </span>
        <span
          className={`flex-none text-ui-2xs ${team.status === 'running' ? 'text-warning' : 'text-foreground-subtlest'}`}
        >
          {team.status}
        </span>
      </div>
      {/* 运行计数（只读摘要） */}
      <div className="mt-0.5 font-mono text-ui-2xs text-foreground-subtlest" data-testid="teams-counts">
        成员 {team.members.length} · 运行 {counts.membersRunning} · 任务 {counts.tasks} · 领取 {counts.tasksClaimed} ·
        消息 {team.messages.length}
      </div>
      <div className="mt-1 flex flex-col gap-0.5" data-testid="teams-members">
        {members.map((m) => (
          <MemberRow key={m.name} member={m} />
        ))}
        {team.members.length > members.length && (
          <div className="text-ui-2xs text-foreground-subtlest">
            其余 {team.members.length - members.length} 名成员…
          </div>
        )}
      </div>
      {tasks.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5" data-testid="teams-tasks">
          {tasks.map((t) => (
            <TaskRow key={t.taskId} task={t} />
          ))}
          {team.tasks.length > tasks.length && (
            <div className="text-ui-2xs text-foreground-subtlest">其余 {team.tasks.length - tasks.length} 条任务…</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Teams 只读视图。有团队才渲染（无数据 = 空态文本；壳侧 `teamsViewHasContent` 进一步保证
 * 空态不占席位高度）。
 */
export function TeamsPanel({ teams, maxMembers = 8, maxTasks = 8 }: TeamsPanelProps): ReactNode {
  const snapshot = useSyncExternalStore(
    teamsViewStore.subscribe,
    teamsViewStore.getSnapshot,
    teamsViewStore.getSnapshot,
  );
  const list = teams ?? snapshot.teams;
  if (list.length === 0) {
    return (
      <div
        data-testid="teams-empty"
        className="rounded-xl border border-border bg-popover px-2.5 py-2 text-ui-xs text-foreground-subtlest"
      >
        暂无团队
      </div>
    );
  }
  return (
    <section
      data-testid="teams-panel"
      aria-label="Agent Teams"
      className="w-80 overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-md"
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border px-2.5 text-ui-sm text-foreground-subtle">
        <span>团队</span>
        <span className="ml-auto text-ui-2xs text-foreground-subtlest">{list.length}</span>
      </div>
      <div className="max-h-[min(48dvh,24rem)] overflow-y-auto px-2.5">
        {list.map((team) => (
          <TeamBlock key={team.teamId} team={team} maxMembers={maxMembers} maxTasks={maxTasks} />
        ))}
      </div>
    </section>
  );
}
