// 计划状态只读投影（S7a）：把 runtime journal 的 task/transition 账本重建为「计划状态」视图。
// 契约（计划 S7 / 验收 #7b）：
//   - 输出：planId / 目标 / 步骤列表 / 每步状态 / 证据 ID——须可重建（从磁盘投影/账本，
//     非内存猜测），每一步都可指回来源 task id 与 journal seq；
//   - 计划不放宽权限：本模块只读，不触碰 approval-queue、不自动放行任何审批；
//     计划状态与任务状态一致（复用 reconstructTasks，不再造一份状态）。
// 红线：不写任何文件（readEntries/loadSession 均只读）、不伪造 session 日志事件、
//       不新增 plan/… 事件类型（任务即计划的磁盘投影来源）。
import type { RuntimeJournalEntry, TaskTransitionEntry } from './runtime-journal.js';
import { readEntries } from './runtime-journal.js';
import type { TaskContract, TaskId, TaskState } from './types.js';
import { reconstructTasks } from '../agent/task-coordinator.js';
import { computeProjection, loadSession } from '../session/reader.js';

export interface PlanStepEvidence {
  /** 证据来源：runtime journal 的 task/transition 账本 */
  source: 'runtime-journal';
  /** 来源任务 id（与 task-coordinator 同 key） */
  taskId: string;
  /** 该任务全部 task/transition 的 journal seq（可逐条回放） */
  journalSeqs: number[];
}

export interface PlanStep {
  /** 步骤 id = 任务 id（任务即计划步骤的磁盘投影来源，不另造 id） */
  stepId: string;
  /** 与任务状态一致（复用 TaskState；无独立计划状态机） */
  state: TaskState;
  evidence: PlanStepEvidence;
}

export interface PlanGoalEvidence {
  /** 目标来源：会话日志 user/message 事件 */
  source: 'user-message';
  /** 会话日志事件 seq（Disk projection 可指回） */
  seq: number;
  ts: string;
  /**
   * FixC E1：目标锚定依据（明确非时间戳优先）：
   * - session-log-seq：journal task/transition 携带的 session.log lastSeq 水位，目标 = seq <= 水位的最后 user/message
   *   （同一时间线内单调、不依赖跨文件时钟；两会话并发不歧义）；
   * - journal-ts：旧账本无水位时的兼容回退（Date.parse ts <= 首个 transition.ts）。
   */
  anchor: { kind: 'session-log-seq'; seq: number } | { kind: 'journal-ts'; ts: string };
}

export interface PlanState {
  /** 计划 id（显式指定优先；缺省 = 最早的无父根任务 id） */
  planId: string;
  /** 目标文本（可重建来源见 goalEvidence；无可重建来源时为空串） */
  goal: string;
  /** 目标证据：指到 user/message 事件（非猜测） */
  goalEvidence?: PlanGoalEvidence;
  steps: readonly PlanStep[];
  /** 契约钉：计划状态只读投影，不放宽权限（不自动放行审批） */
  readOnly: true;
  sourceDir: string;
}

export interface ReconstructPlanStateOptions {
  sourceDir?: string;
  planId?: string;
  goal?: string;
  goalEvidence?: PlanGoalEvidence;
  /** 显式任务状态（缺省从 transitions 经 reconstructTasks 重建——同源，不另造） */
  tasks?: readonly TaskContract[];
}

/** 重建任务列表（复用 task-coordinator 的 reconstructTasks：计划状态 = 任务状态） */
function buildTasks(transitions: readonly TaskTransitionEntry[]): TaskContract[] {
  return reconstructTasks(
    transitions.map((e) => ({
      taskId: e.taskId,
      ...(e.parentTaskId !== undefined ? { parentTaskId: e.parentTaskId } : {}),
      background: e.payload.background,
      from: e.payload.from,
      to: e.payload.to,
    })),
  );
}

function resolvePlanId(transitions: readonly TaskTransitionEntry[], tasks: readonly TaskContract[]): string {
  if (transitions.length === 0) return tasks[0]?.taskId ?? '';
  const first = transitions.reduce((a, b) => (a.seq < b.seq ? a : b));
  // 计划 = 最早出现的根任务（无父）；该任务同时是提交链的根
  const root = tasks.find((t) => t.parentTaskId === undefined);
  if (root !== undefined) return root.taskId;
  return first.taskId;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const k of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return Object.freeze(value);
}

/**
 * 纯投影：从账本事件重建计划状态。无 task/transition → null（不臆造计划）。
 * 只读：不写文件；输出深度冻结。
 */
export function reconstructPlanState(
  entries: readonly RuntimeJournalEntry[],
  opts: ReconstructPlanStateOptions = {},
): PlanState | null {
  const transitions = entries.filter((e): e is TaskTransitionEntry => e.kind === 'task/transition');
  if (transitions.length === 0) return null;
  const tasks = opts.tasks ?? buildTasks(transitions);
  if (tasks.length === 0) return null;

  const journalSeqs = new Map<TaskId, number[]>();
  for (const e of transitions) {
    const list = journalSeqs.get(e.taskId) ?? [];
    list.push(e.seq);
    journalSeqs.set(e.taskId, list);
  }

  const steps: PlanStep[] = tasks.map((t) => ({
    stepId: t.taskId,
    state: t.state,
    evidence: {
      source: 'runtime-journal',
      taskId: t.taskId,
      journalSeqs: journalSeqs.get(t.taskId) ?? [],
    },
  }));

  const plan: PlanState = {
    planId: opts.planId ?? resolvePlanId(transitions, tasks),
    goal: opts.goal ?? '',
    ...(opts.goalEvidence !== undefined ? { goalEvidence: opts.goalEvidence } : {}),
    steps,
    readOnly: true,
    sourceDir: opts.sourceDir ?? '',
  };
  return deepFreeze(plan);
}

export interface LoadPlanStateOptions {
  planId?: string;
  /** 显式目标（调用方已知时提供；缺省从会话日志投影按时间序重建） */
  goal?: string;
}

/**
 * 从磁盘重建计划状态：runtime.v1.jsonl（task/transition 账本）+ 会话日志（目标来源）。
 * 目标锚定（FixC E1）：
 *   - 首选 seq/水位：首个 task/transition 若携带 sessionLogSeq（写入时 session.log lastSeq），
 *     目标 = 该会话日志内 seq <= 水位的最后活动 user/message 事件（同一时间线单调，不依赖时钟）；
 *   - 缺省回退：旧账本无水位 → 保持 ts 锚定（Date.parse <= 首个 transition.ts），兼容不改行为。
 * goalEvidence 指回该事件 seq + ts + anchor 依据；会话日志缺失/损坏 → 目标为空串且不提供证据（不猜测）。
 * 只读：均走只读 API（readEntries / loadSession），不取锁、不写盘。
 */
export function loadPlanState(sessionDir: string, opts: LoadPlanStateOptions = {}): PlanState | null {
  const { entries } = readEntries(sessionDir);
  const transitions = entries.filter((e): e is TaskTransitionEntry => e.kind === 'task/transition');
  if (transitions.length === 0) return null;

  const firstTransition = transitions.reduce((a, b) => (a.seq < b.seq ? a : b));
  const anchorSeq = firstTransition.sessionLogSeq;
  let goal = opts.goal ?? '';
  let goalEvidence: PlanGoalEvidence | undefined;
  if (goal === '') {
    try {
      const session = loadSession(sessionDir);
      computeProjection(session);
      const users = session.events.filter(({ event, active }) => {
        if (!active || event.type !== 'user/message') return false;
        // seq/水位锚定优先（同一时间线单调，不依赖时钟）；旧账本回退 ts 锚定
        if (anchorSeq !== undefined) return event.seq <= anchorSeq;
        const ts = Date.parse(event.ts);
        if (Number.isNaN(ts)) return false;
        return ts <= Date.parse(firstTransition.ts);
      });
      const latest = users.at(-1);
      if (latest !== undefined && latest.event.type === 'user/message') {
        goal = latest.event.payload.text;
        goalEvidence = {
          source: 'user-message',
          seq: latest.event.seq,
          ts: latest.event.ts,
          anchor:
            anchorSeq !== undefined
              ? { kind: 'session-log-seq', seq: anchorSeq }
              : { kind: 'journal-ts', ts: firstTransition.ts },
        };
      }
    } catch {
      // 会话日志缺失/损坏：目标保持空串，不提供证据（不猜测）
    }
  }

  return reconstructPlanState(entries, {
    ...(opts.planId !== undefined ? { planId: opts.planId } : {}),
    ...(goal !== '' ? { goal } : {}),
    ...(goalEvidence !== undefined ? { goalEvidence } : {}),
    sourceDir: sessionDir,
  });
}