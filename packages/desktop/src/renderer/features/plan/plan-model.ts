// 计划 / 任务 / 审批 面板纯逻辑（D3）。
//
// 契约红线：
//   - 计划状态**有证据**：每步指回 journal task/transition seq（planId/stepId/evidence 全部来自
//     S7 `/plan-state` 投影，不臆造计划、不造第二份状态机）；
//   - **展示计划不放宽权限**：渲染计划/切换面板绝不自动改审批模式；提权必须是用户显式动作；
//   - 父子归属清楚：任务树按 parentTaskId 归组，孤儿任务如实单列（不丢弃）；
//   - 审批过期 fail-closed（ISO 解析失败也视为过期），缺席/过期卡片不假装可响应。
import type { TaskContractShape, TaskStateShape, ApprovalScopeShape } from '../../../shared/protocol.js';
import type { PlanStateShape } from '../../../shared/protocol.js';

/** 终态集合（与 core TASK_TERMINAL_STATES 同口径） */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskStateShape> = new Set([
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);

export function isTerminalTaskState(state: TaskStateShape): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function taskStateLabel(state: TaskStateShape): string {
  switch (state) {
    case 'registered':
      return '已注册';
    case 'queued':
      return '排队中';
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'waiting-approval':
      return '等待审批';
    case 'stopping':
      return '停止中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'unknown':
      return '状态未知';
  }
}

// —— 模式边界（F2：切权限是显式动作，不自动提权） ——

export interface ModeSwitchResult {
  /** 生效模式（未获显式授权时 = 原模式，不变） */
  mode: string;
  changed: boolean;
  /** 未改变时的可读原因 */
  reason?: string;
}

/**
 * 模式切换：**只有显式动作才会生效**。
 * - requested === current → 无变化；
 * - explicit=false（例如「打开了计划面板」「计划里有危险步骤」）→ 拒绝切换并说明；
 * - explicit=true → 切换。
 * 这条规则把 F2 的「切权限是显式动作/plan 阶段无写副作用」变成可测的纯逻辑。
 */
export function resolveModeSwitch(current: string, requested: string, explicit: boolean): ModeSwitchResult {
  if (requested === current) return { mode: current, changed: false };
  if (!explicit) {
    return { mode: current, changed: false, reason: '切换审批模式需要用户显式确认' };
  }
  return { mode: requested, changed: true };
}

// —— 计划视图（有证据，非状态卡） ——

export interface PlanStepView {
  stepId: string;
  state: TaskStateShape;
  stateLabel: string;
  /** 证据：journal seq 列表（可为空 = 该步尚无账本记录，如实呈现） */
  journalSeqs: number[];
  evidenceSource: string;
}

export interface PlanView {
  /** 无账本 → null（不臆造空计划） */
  plan: null;
  reason: string;
}

export interface PlanPresent {
  planId: string;
  goal: string;
  /** 目标证据（指回 user/message 事件；缺省 = 无可重建来源） */
  goalEvidence?: PlanStateShape['goalEvidence'];
  steps: PlanStepView[];
  /** 完成度（仅按状态统计，不做语义推断） */
  completed: number;
  total: number;
  readOnly: true;
}

export type PlanDisplay = PlanPresent | PlanView;

/** 由 S7 plan-state 投影构造展示模型（null → 明确空态原因，不臆造） */
export function buildPlanDisplay(plan: PlanStateShape | null | undefined): PlanDisplay {
  if (plan === null || plan === undefined) {
    return { plan: null, reason: '该会话暂无计划账本（尚无子任务/计划迁移记录）' };
  }
  const steps: PlanStepView[] = plan.steps.map((s) => ({
    stepId: s.stepId,
    state: s.state,
    stateLabel: taskStateLabel(s.state),
    journalSeqs: [...s.evidence.journalSeqs],
    evidenceSource: s.evidence.source,
  }));
  return {
    planId: plan.planId,
    goal: plan.goal,
    ...(plan.goalEvidence !== undefined ? { goalEvidence: plan.goalEvidence } : {}),
    steps,
    completed: steps.filter((s) => s.state === 'completed').length,
    total: steps.length,
    readOnly: true,
  };
}

// —— 任务树（父子归属清楚；孤儿不丢） ——

export interface TaskNode {
  task: TaskContractShape;
  stateLabel: string;
  terminal: boolean;
  children: TaskNode[];
}

/** 按 parentTaskId 组树：根 = 无父；父不存在（账本不全）的孤儿按根处理并标记 orphan */
export function buildTaskTree(tasks: readonly TaskContractShape[]): Array<TaskNode & { orphan: boolean }> {
  const nodes = new Map<string, TaskNode & { orphan: boolean }>();
  for (const t of tasks) {
    nodes.set(t.taskId, {
      task: t,
      stateLabel: taskStateLabel(t.state),
      terminal: isTerminalTaskState(t.state),
      children: [],
      orphan: false,
    });
  }
  const roots: Array<TaskNode & { orphan: boolean }> = [];
  for (const node of nodes.values()) {
    const parentId = node.task.parentTaskId;
    const parent = parentId !== undefined ? nodes.get(parentId) : undefined;
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      if (parentId !== undefined) node.orphan = true; // 父不在快照里：如实标记，不静默丢弃
      roots.push(node);
    }
  }
  // 稳定排序（taskId 字典序），便于断言与展示
  const sortRec = (list: Array<TaskNode & { orphan: boolean }>): void => {
    list.sort((a, b) => a.task.taskId.localeCompare(b.task.taskId));
    for (const n of list) sortRec(n.children as Array<TaskNode & { orphan: boolean }>);
  };
  sortRec(roots);
  return roots;
}

/** 并发概览（**来自真实任务状态**，不做本地模拟）：运行中/等审批/终态计数 */
export interface TaskSummary {
  total: number;
  running: number;
  waitingApproval: number;
  terminal: number;
  /** 当前处于 waiting-approval 的任务 id（审批中心据此把卡片挂到任务上） */
  waitingTaskIds: string[];
}

export function summarizeTasks(tasks: readonly TaskContractShape[]): TaskSummary {
  return {
    total: tasks.length,
    running: tasks.filter((t) => t.state === 'running').length,
    waitingApproval: tasks.filter((t) => t.state === 'waiting-approval').length,
    terminal: tasks.filter((t) => isTerminalTaskState(t.state)).length,
    waitingTaskIds: tasks.filter((t) => t.state === 'waiting-approval').map((t) => t.taskId),
  };
}

// —— 审批中心（主子归属 + fail-closed 过期） ——

export interface ApprovalCard {
  requestId: string;
  tool: string;
  args: unknown;
  scope?: ApprovalScopeShape['mode'];
  expiresAt?: string;
  cwd?: string;
  taskId?: string;
  parentTaskId?: string;
}

export interface ApprovalGroup<T extends ApprovalCard = ApprovalCard> {
  /** 归属任务 id（无归属 → null，归入「会话级」组） */
  taskId: string | null;
  parentTaskId?: string;
  /** 是否为子任务审批（有 taskId 且有 parentTaskId） */
  isChild: boolean;
  cards: T[];
}

/**
 * 过期判定：ISO 已过 / 非法（无法解析）→ 过期（fail-closed，与 core isApprovalExpired 同口径）。
 * 缺失 expiresAt 视为未过期（旧 serve 不发该字段时不误杀）。
 */
export function isApprovalExpired(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t <= now;
}

/** 过滤出可响应卡片（未过期）；过期卡片保留但标记 expired，由 UI 提示而非静默消失 */
export interface ApprovalDisplayCard extends ApprovalCard {
  expired: boolean;
  /** 归属任务当前状态（可读；无归属 → undefined） */
  taskState?: TaskStateShape;
  taskStateLabel?: string;
}

export function decorateApprovals(
  approvals: readonly ApprovalCard[],
  tasks: readonly TaskContractShape[],
  now: number = Date.now(),
): ApprovalDisplayCard[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  return approvals.map((a) => {
    const task = a.taskId !== undefined ? byId.get(a.taskId) : undefined;
    return {
      ...a,
      expired: isApprovalExpired(a.expiresAt, now),
      ...(task !== undefined ? { taskState: task.state, taskStateLabel: taskStateLabel(task.state) } : {}),
    };
  });
}

/**
 * 按任务归属分组：父任务组在前，子任务组紧随其父（主子审批归属清楚）；
 * 无 taskId 的卡片归入会话级组（taskId=null）。
 */
export function groupApprovals<T extends ApprovalCard>(
  approvals: readonly T[],
  tasks: readonly TaskContractShape[],
): Array<ApprovalGroup<T>> {
  const groups = new Map<string, ApprovalGroup<T>>();
  for (const a of approvals) {
    const key = a.taskId ?? '';
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        taskId: a.taskId ?? null,
        ...(a.parentTaskId !== undefined ? { parentTaskId: a.parentTaskId } : {}),
        isChild: a.taskId !== undefined && a.parentTaskId !== undefined,
        cards: [],
      };
      groups.set(key, g);
    }
    g.cards.push(a);
  }
  const list = [...groups.values()];
  const order = new Map(tasks.map((t, i) => [t.taskId, i]));
  list.sort((a, b) => {
    if (a.taskId === null) return 1; // 会话级组置后
    if (b.taskId === null) return -1;
    return (order.get(a.taskId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.taskId) ?? Number.MAX_SAFE_INTEGER);
  });
  return list;
}
