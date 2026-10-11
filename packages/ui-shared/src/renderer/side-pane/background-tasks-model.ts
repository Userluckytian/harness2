// 右栏「后台任务」tab 的纯逻辑（Z2-08）。
//
// 依据修正（台账 B04）：refs-grok-build.md 全文无 TasksPane 条目（G-4x 区是「阻塞卡片」不是
// 任务面板）——真实依据 = ZCode 自身做法（refs-zcode-layout.md Z-14 表）：后台任务作为
// side pane tab 按需出现，无常驻计数面板。数据面 = `stream.tasks`（resume-snapshot 同步的
// TaskContractShape，ui-shared/shared/protocol.ts:250）。
//
// 契约边界（红线⑩ / D-14）：
//   - TaskContractShape 只有 taskId / parentTaskId / background / state / expectedTurnId /
//     updatedAt —— 没有的字段（标题、摘要、耗时、进度）一律不显示，行标题即 taskId
//     （与状态面板 Agents 子块同口径）；
//   - 任务契约**没有 childSessionId 字段**。唯一真实关联通道 = 父会话事件流里 subagent_* 工具
//     result 的 output JSON（core agent/subagent.ts：subagent_start 后台模式返回
//     `{ taskId, childSessionId, state }`，subagent_continue 按 taskId 查询也返回同形 JSON）。
//     `taskChildSessionIndex` 只从这份真实线数据建立 taskId → childSessionId 关联，
//     不依赖 core 的 `bg-<childId>` 命名约定（那是实现细节，不是契约）；
//     关联不到的任务 = 只读行，不渲染跳转（不摆假按钮）。
//
// 本模块是纯函数集合（无 React / 无副作用），与 side-pane-model.ts 同级同风格。
import type { TaskContractShape, TaskStateShape } from '../../shared/protocol.js';
import type { ActiveEvent } from '../chat-model.js';

/** 任务状态中文标签（本 tab 的权威长标签；状态面板 Agents 子块的短标签是另一张表，不动） */
export function backgroundTaskStateLabel(state: TaskStateShape): string {
  switch (state) {
    case 'registered':
      return '已注册';
    case 'queued':
      return '排队';
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'waiting-approval':
      return '待审批';
    case 'stopping':
      return '停止中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'unknown':
      return '未知';
  }
}

/** 终态（与 status-panel-model.TASK_TERMINAL_STATES / 桌面 plan-model 同一套契约口径） */
const TERMINAL_STATES: ReadonlySet<TaskStateShape> = new Set(['completed', 'failed', 'cancelled', 'unknown']);

export function isBackgroundTaskTerminal(state: TaskStateShape): boolean {
  return TERMINAL_STATES.has(state);
}

/** 状态 chip 的语义色调（组件映射为 Tailwind 语义 token；模型层不写类名） */
export type BackgroundTaskTone = 'neutral' | 'active' | 'attention' | 'done' | 'failed';

/** state → 色调：进行中=active、等审批/停止中=attention、完成=done、失败=failed、其余 neutral */
export function backgroundTaskTone(state: TaskStateShape): BackgroundTaskTone {
  switch (state) {
    case 'starting':
    case 'running':
      return 'active';
    case 'waiting-approval':
    case 'stopping':
      return 'attention';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'neutral';
  }
}

// —— taskId → childSessionId 关联（唯一真实通道：subagent_* 工具 result 的 output JSON） ——

/** 从事件流提取 subagent_* 工具 result 输出里的 `{ taskId, childSessionId }` 关联表。
 *  只认**同时带两个字符串字段**的 JSON；非 JSON / 缺字段 / 非 subagent 工具一律忽略（不猜）。 */
export function taskChildSessionIndex(events: readonly ActiveEvent[]): ReadonlyMap<string, string> {
  // callId → 工具名（tool/call 事件是权威；孤立 result 回落 payload.tool）
  const callTools = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'tool/call') continue;
    const p = e.payload as Record<string, unknown>;
    const callId = p['callId'];
    const tool = p['tool'];
    if (typeof callId === 'string' && typeof tool === 'string') callTools.set(callId, tool);
  }
  const index = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'tool/result') continue;
    const p = e.payload as Record<string, unknown>;
    const callId = typeof p['callId'] === 'string' ? p['callId'] : '';
    const tool = callTools.get(callId) ?? (typeof p['tool'] === 'string' ? p['tool'] : undefined);
    if (tool === undefined || !tool.startsWith('subagent_')) continue;
    const output = p['output'];
    if (typeof output !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed === null || typeof parsed !== 'object') continue;
      const taskId = (parsed as Record<string, unknown>)['taskId'];
      const childSessionId = (parsed as Record<string, unknown>)['childSessionId'];
      if (typeof taskId === 'string' && typeof childSessionId === 'string') index.set(taskId, childSessionId);
    } catch {
      // 非 JSON 输出 → 无关联
    }
  }
  return index;
}

// —— 行模型（跨会话聚合 + 排序） ——

export interface BackgroundTaskRow {
  readonly taskId: string;
  /** 会话归属（任务所在会话流；跨会话聚合展示用） */
  readonly sessionId: string;
  readonly state: TaskStateShape;
  readonly stateLabel: string;
  readonly tone: BackgroundTaskTone;
  readonly terminal: boolean;
  readonly background: boolean;
  readonly updatedAt?: string;
  readonly parentTaskId?: string;
  /** 能定位到子会话时才有（真实线数据关联，见 taskChildSessionId）；没有就没有跳转（红线⑩） */
  readonly childSessionId?: string;
}

/** 单会话数据源（store 投影用；测试可直接造） */
export interface BackgroundTasksSource {
  readonly sessionId: string;
  readonly tasks: readonly TaskContractShape[];
  readonly events: readonly ActiveEvent[];
}

/**
 * 聚合各会话任务为行列表并排序：非终态在前，组内按 updatedAt 新→旧（缺 updatedAt 视为最旧）；
 * 排序稳定（同键保持原序）。防御：tasks 缺失/非数组按空处理（不因半份投影崩溃）。
 */
export function backgroundTaskRows(sources: readonly BackgroundTasksSource[]): BackgroundTaskRow[] {
  const rows: BackgroundTaskRow[] = [];
  for (const source of sources) {
    const tasks = Array.isArray(source.tasks) ? source.tasks : [];
    if (tasks.length === 0) continue;
    const childIndex = taskChildSessionIndex(source.events ?? []);
    for (const task of tasks) {
      if (task === null || typeof task !== 'object' || typeof task.taskId !== 'string') continue;
      rows.push({
        taskId: task.taskId,
        sessionId: source.sessionId,
        state: task.state,
        stateLabel: backgroundTaskStateLabel(task.state),
        tone: backgroundTaskTone(task.state),
        terminal: isBackgroundTaskTerminal(task.state),
        background: task.background === true,
        ...(typeof task.updatedAt === 'string' ? { updatedAt: task.updatedAt } : {}),
        ...(typeof task.parentTaskId === 'string' ? { parentTaskId: task.parentTaskId } : {}),
        ...(childIndex.get(task.taskId) !== undefined ? { childSessionId: childIndex.get(task.taskId) } : {}),
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.terminal !== b.terminal) return a.terminal ? 1 : -1; // 非终态在前
    const at = a.updatedAt ?? '';
    const bt = b.updatedAt ?? '';
    if (at !== bt) return at > bt ? -1 : 1; // 新→旧；缺失（''）自然落最后
    return 0; // 稳定：保持原序
  });
}
