// 会话状态面板纯逻辑（Z-95 / Z-17）：子块注册表 + mini 胶囊兜底链。
//
// 数据源核实结论（Z3-03 交底，缺什么数据就不做什么子块——不画空壳、不造假计数）：
//   * Git 子块      = S7 changeReview（ChangeSetShape：拟议 before/after + changedFiles/dirtyFiles）。
//                     本仓没有 git 进程通道；+/− 行数由拟议快照 diffLines 现算（与 DiffCard 同源），
//                     语义是「会话内变更」，不是仓库 git status——如实命名「变更」。
//   * Plan 子块     = S7 planState（PlanStateShape：goal + steps[stepId/state/evidence]）。
//                     core 没有 todo_write 工具（packages/core/src/tools/predefined/index.ts 仅
//                     bash/read/write/edit/glob/grep），也没有独立 goalSet/goalVerify 事件——
//                     「Todo / Goal / SessionPlans」三个子块的数据源都不存在，goal 只作为
//                     planState 的字段随 Plan 子块展示。Z-95 的胶囊链前两级（当前 Todo →
//                     活跃 Goal）由此降级为「当前计划 goal」一级，缺位如实登记。
//   * Agents 子块   = stream.tasks（resume-snapshot 同步的任务表）。当前唯一注册后台任务的
//                     是后台子代理（core/src/agent/subagent.ts:233 起，taskId = `bg-<childId>`，
//                     background:true），bash 无后台模式 → 非终态后台任务数 = 运行中的子代理数。
//   * Terminals / Workflows 子块 = 数据源不存在（B02 未做、无工作流引擎）→ 不做。
//
// 扩展缝（硬性约束 4）：新增子块 = 在 STATUS_SECTIONS 追加一条元数据 + hasData/summaryOf 加一个
// 分支 + 组件里加一个 body 渲染 case；数据源到位前绝不注册。
import { diffLines } from 'diff';
import type { ChangeSetShape, PlanStateShape, TaskStateShape } from '../../../shared/protocol.js';
import type { SessionStream, SessionViews } from '../../store.js';

// —— 任务态短标签（右栏任务面板的权威长标签在桌面 plan-model.taskStateLabel；这里只取短形） ——
export function taskStateShortLabel(state: TaskStateShape): string {
  switch (state) {
    case 'registered':
      return '已注册';
    case 'queued':
      return '排队';
    case 'starting':
      return '启动';
    case 'running':
      return '运行';
    case 'waiting-approval':
      return '等审批';
    case 'stopping':
      return '停止中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'unknown':
      return '未知';
  }
}

export const TASK_TERMINAL_STATES: ReadonlySet<TaskStateShape> = new Set([
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);

export function isTerminalTaskState(state: TaskStateShape): boolean {
  return TASK_TERMINAL_STATES.has(state);
}

// —— 子块汇总（全部来自真实数据；无数据返回 null，组件据此不渲染该子块） ——

/** Git（会话变更）子块汇总：+A/−D 行数由拟议 before/after 现算 */
export interface StatusGitSummary {
  changedFiles: number;
  dirtyFiles: number;
  added: number;
  deleted: number;
  /** 前 N 个变更文件（面板 body 展示用；截断数由 UI 定） */
  files: Array<{ file: string; dirty: boolean; added: number; deleted: number }>;
}

/** 行数统计：diffLines 的每个 Change 可能含多行，拆行计数（末尾空行丢弃，与 DiffCard 同口径） */
export function countDiffLines(before: string | null, after: string | null): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const ch of diffLines(before ?? '', after ?? '')) {
    const lines = ch.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (ch.added) added += lines.length;
    else if (ch.removed) deleted += lines.length;
  }
  return { added, deleted };
}

export function gitSummaryOf(set: ChangeSetShape | null | undefined): StatusGitSummary | null {
  if (set === null || set === undefined) return null;
  // P1-1 同款连带防御：旧 serve/异常数据可能缺字段（如桥桩返回 {}）——读缺时按空处理，不崩溃。
  const rawFiles = Array.isArray(set.files) ? set.files : [];
  const changedFiles = typeof set.changedFiles === 'number' ? set.changedFiles : rawFiles.length;
  const dirtyFiles = typeof set.dirtyFiles === 'number' ? set.dirtyFiles : 0;
  if (changedFiles === 0 && dirtyFiles === 0 && rawFiles.length === 0) return null; // 无变更 → 无子块（不摆空壳）
  const files = rawFiles.map((f) => {
    const planned = f.planned ?? { before: null, after: null };
    const { added, deleted } = countDiffLines(planned.before, planned.after);
    return { file: f.file, dirty: f.dirty === true, added, deleted };
  });
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    added += f.added;
    deleted += f.deleted;
  }
  return { changedFiles, dirtyFiles, added, deleted, files };
}

/** Plan 子块汇总：goal + 步骤进度（步骤只有 stepId/state，无文本——如实按 id 展示） */
export interface StatusPlanSummary {
  planId: string;
  goal: string;
  completed: number;
  total: number;
  /** 首个非终态步骤（当前进行中；全终态或缺省 = undefined） */
  activeStepId?: string;
  steps: Array<{ stepId: string; state: TaskStateShape; label: string }>;
}

export function planSummaryOf(plan: PlanStateShape | null | undefined): StatusPlanSummary | null {
  if (plan === null || plan === undefined) return null;
  // 连带防御：steps 缺失/非数组按空处理；goal 非字符串按空（不因半份投影崩溃）
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  const goal = typeof plan.goal === 'string' ? plan.goal : '';
  const steps = rawSteps.map((s) => ({
    stepId: s.stepId,
    state: s.state,
    label: taskStateShortLabel(s.state),
  }));
  if (steps.length === 0 && goal.length === 0) return null; // 无 goal 也无步骤 → 无子块
  const active = steps.find((s) => !isTerminalTaskState(s.state));
  return {
    planId: plan.planId,
    goal,
    completed: steps.filter((s) => s.state === 'completed').length,
    total: steps.length,
    ...(active !== undefined ? { activeStepId: active.stepId } : {}),
    steps,
  };
}

/** Agents（后台任务/子代理）子块汇总 */
export interface StatusAgentsSummary {
  running: number;
  waitingApproval: number;
  total: number;
  /** 非终态任务（面板 body 展示用） */
  active: Array<{ taskId: string; state: TaskStateShape; label: string; background: boolean }>;
}

export function agentsSummaryOf(stream: SessionStream | undefined): StatusAgentsSummary | null {
  const tasks = Array.isArray(stream?.tasks) ? stream.tasks : [];
  if (tasks.length === 0) return null;
  const active = tasks
    .filter((t) => !isTerminalTaskState(t.state))
    .map((t) => ({ taskId: t.taskId, state: t.state, label: taskStateShortLabel(t.state), background: t.background }));
  return {
    running: active.filter((t) => t.state === 'running' || t.state === 'starting').length,
    waitingApproval: active.filter((t) => t.state === 'waiting-approval').length,
    total: tasks.length,
    active,
  };
}

/** 状态面板聚合数据（子块数据一次性收集，组件与胶囊链共用同一份） */
export interface StatusData {
  git: StatusGitSummary | null;
  plan: StatusPlanSummary | null;
  agents: StatusAgentsSummary | null;
  /** 本会话运行中的 turn 数（0/1；胶囊链「运行计数」的 turn 位） */
  runningTurns: number;
}

export function collectStatusData(stream: SessionStream | undefined, views: SessionViews | undefined): StatusData {
  return {
    git: gitSummaryOf(views?.changeReview),
    plan: planSummaryOf(views?.planState),
    agents: agentsSummaryOf(stream),
    runningTurns: stream?.running === true ? 1 : 0,
  };
}

// —— 子块注册表（扩展缝：后续补数据源时在此加一行注册） ——

export type StatusSectionKey = 'git' | 'plan' | 'agents';

export interface StatusSectionMeta {
  readonly key: StatusSectionKey;
  readonly title: string;
  /** Z-17：Git / Plan 默认展开；Agents 默认收起（无数据的子块根本不注册数据，默认值不生效） */
  readonly defaultExpanded: boolean;
}

/** 未做的子块在此登记（数据源核实结论见文件头）：todo / goal / terminals / workflows */
export const STATUS_SECTIONS: readonly StatusSectionMeta[] = [
  { key: 'git', title: '变更', defaultExpanded: true },
  { key: 'plan', title: '计划', defaultExpanded: true },
  { key: 'agents', title: '任务', defaultExpanded: false },
];

/** 有数据的子块（按注册表顺序；空面板 = 无子块 → 整个面板返回 null） */
export function activeSections(data: StatusData): StatusSectionMeta[] {
  return STATUS_SECTIONS.filter((s) => hasSectionData(data, s.key));
}

export function hasSectionData(data: StatusData, key: StatusSectionKey): boolean {
  switch (key) {
    case 'git':
      return data.git !== null;
    case 'plan':
      return data.plan !== null;
    case 'agents':
      return data.agents !== null;
  }
}

/** 子块头部右侧的计数/状态文案（Z-95：h-8 头部右侧） */
export function sectionBadge(data: StatusData, key: StatusSectionKey): string | null {
  switch (key) {
    case 'git': {
      const g = data.git;
      if (g === null) return null;
      const dirty = g.dirtyFiles > 0 ? ` · 外部改动 ${g.dirtyFiles}` : '';
      return `${g.changedFiles} 文件 · +${g.added} −${g.deleted}${dirty}`;
    }
    case 'plan': {
      const p = data.plan;
      if (p === null) return null;
      return p.total > 0 ? `${p.completed}/${p.total}` : p.goal.length > 0 ? '有目标' : null;
    }
    case 'agents': {
      const a = data.agents;
      if (a === null) return null;
      const bits: string[] = [];
      if (a.running > 0) bits.push(`运行 ${a.running}`);
      if (a.waitingApproval > 0) bits.push(`等审批 ${a.waitingApproval}`);
      return bits.length > 0 ? bits.join(' · ') : `${a.total} 任务`;
    }
  }
}

// —— mini 胶囊兜底链（Z-95 重点）——
//
// ZCode 的链：当前 Todo → 活跃 Goal → Git 更改(+/−) → 已完成 Goal → 已完成 Todo → Todo 计数
//             → 最近 SessionPlan → 运行计数 → 已结束工作流。
// 本仓数据源映射（缺位如实登记，见文件头）：
//   当前 Todo / 最近 SessionPlan → 无独立 todo 数据 → 并入「计划 goal」（链 1）
//   活跃 Goal                    → planState.goal（链 1）
//   Git 更改(+/−)                → changeReview（链 2）
//   已完成 Goal / 已完成 Todo    → 计划步骤完成数（链 3）
//   Todo 计数                    → 计划步骤总数（链 3）
//   运行计数                     → 运行中 turn + 非终态后台任务（链 4）
//   已结束工作流                 → 无工作流数据 → 不做
export type CapsuleEntry =
  | { readonly kind: 'plan-goal'; readonly text: string }
  | { readonly kind: 'git-changes'; readonly added: number; readonly deleted: number }
  | { readonly kind: 'plan-progress'; readonly completed: number; readonly total: number }
  | { readonly kind: 'running'; readonly runningTurns: number; readonly runningTasks: number };

/** 胶囊兜底链：按优先级取第一个有值的条目；全空 → null（胶囊随面板一起不渲染） */
export function capsuleEntryOf(data: StatusData): CapsuleEntry | null {
  // 链 1：计划 goal（当前 Todo → 活跃 Goal 的降级位；计划步骤只有 id 无文本，故不取步骤）
  if (data.plan !== null && data.plan.goal.length > 0) {
    return { kind: 'plan-goal', text: data.plan.goal };
  }
  // 链 2：Git 更改 +/−
  if (data.git !== null) {
    return { kind: 'git-changes', added: data.git.added, deleted: data.git.deleted };
  }
  // 链 3：已完成计划步骤 / 计划步骤总数（已完成 Todo → Todo 计数的降级位）
  if (data.plan !== null && data.plan.total > 0) {
    return { kind: 'plan-progress', completed: data.plan.completed, total: data.plan.total };
  }
  // 链 4：运行计数（运行中 turn + 非终态后台任务；全 0 → 链到底）
  if (data.runningTurns > 0 || (data.agents !== null && data.agents.running > 0)) {
    return {
      kind: 'running',
      runningTurns: data.runningTurns,
      runningTasks: data.agents?.running ?? 0,
    };
  }
  return null;
}

/** 胶囊图标归类（Z-95）：恰好一类有数据 → 取对应图标；混合 → Activity */
export type CapsuleIconKind = 'plan' | 'git' | 'agents' | 'activity';

export function capsuleIconKindOf(data: StatusData): CapsuleIconKind {
  const present: CapsuleIconKind[] = [];
  if (data.plan !== null) present.push('plan');
  if (data.git !== null) present.push('git');
  if (data.agents !== null) present.push('agents');
  return present.length === 1 ? present[0]! : 'activity';
}

/** 面板变体（Z-17）：auto = 断点自适配（<1280 mini 胶囊 / ≥1280 面板）；capsule = 用户收起为胶囊 */
export type StatusVariant = 'auto' | 'capsule';
