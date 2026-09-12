// 运行态推导 / 错误与重试可读化 / 能力门控（D4）。
//
// 目的（F4/F6/F7/F8）：
//   - **不永久 loading**：连「断流/状态未知」都要能说出来，而不是一直转圈；
//   - **不假报停止**：cancel 三态里 unknown 不得显示为已停止；
//   - 能力门控：后端缺能力（或当前无活动 turn）时把动作如实 disabled 并解释。
import { capabilityEnabled, capabilityReason } from '../../../shared/capabilities.js';
import type { CapabilityIdShape, CapabilityReportShape } from '../../../shared/protocol.js';

/** 会话运行态（含「断流疑似」——绝不把未知当空闲或完成） */
export type RuntimeState = 'idle' | 'running' | 'awaiting-approval' | 'stalled' | 'unknown';

export interface RuntimeStatusInput {
  running: boolean;
  approvals: number;
  /** 最近一次收到帧的时间（ms epoch；undefined = 从未收到） */
  lastFrameAt?: number;
  /** 是否有服务端确认的在途 attempt（重订阅快照给出） */
  hasActiveAttempt: boolean;
  /** 当前连接状态 */
  connection: 'connecting' | 'connected' | 'reconnecting' | 'offline';
}

export interface RuntimeStatus {
  state: RuntimeState;
  label: string;
  /** 可行动提示（stalled/unknown 必带） */
  hint?: string;
}

/** 判定「疑似断流」的静默阈值（ms） */
export const STALL_THRESHOLD_MS = 30_000;

/**
 * 推导运行态：
 *   - 连接非 connected 且未在跑 → unknown（不假装空闲）；
 *   - 有待批 → awaiting-approval（明确「在等你」）；
 *   - 在跑但有服务端在途 attempt → running（重连后也不假报停止）；
 *   - 在跑且长时间无帧且无在途 attempt → stalled（提示可重订阅/取消，而不是一直转圈）。
 */
export function deriveRuntimeStatus(
  input: RuntimeStatusInput,
  now: number = Date.now(),
  stallThresholdMs: number = STALL_THRESHOLD_MS,
): RuntimeStatus {
  if (input.connection !== 'connected') {
    return {
      state: input.running ? 'stalled' : 'unknown',
      label: input.running ? '连接中断（任务状态未知）' : '未连接',
      hint: '等待 serve 重连；重连后可重订阅恢复在途状态',
    };
  }
  if (input.approvals > 0) {
    return { state: 'awaiting-approval', label: '等待审批', hint: '请在审批中心处理（超时会被服务端拒收）' };
  }
  if (!input.running) return { state: 'idle', label: '空闲' };
  if (input.hasActiveAttempt) return { state: 'running', label: '运行中' };
  if (input.lastFrameAt !== undefined && now - input.lastFrameAt > stallThresholdMs) {
    return {
      state: 'stalled',
      label: '疑似断流',
      hint: '长时间无事件且无在途 attempt：可「重订阅」确认状态，或取消',
    };
  }
  return { state: 'running', label: '运行中' };
}

/** 取消三态的可读文案（unknown 绝不显示为「已停止」） */
export function cancelStateLabel(state: 'stopping' | 'cancelled' | 'unknown'): string {
  switch (state) {
    case 'stopping':
      return '停止中（已受理，尚未确认）';
    case 'cancelled':
      return '已取消（服务端确认）';
    case 'unknown':
      return '取消失败/状态未知（不能当作已停止）';
  }
}

/** 重试预算可读文案（预算耗尽必须说明停因，不静默） */
export function describeRetryBudget(
  budget:
    | {
        usedAttempts: number;
        remainingAttempts: number;
        waitMs: number;
        remainingWaitMs: number;
        stopReason: string;
      }
    | undefined,
): string {
  if (budget === undefined) return '本 turn 未发生重试';
  return `已重试 ${budget.usedAttempts} 次（剩 ${budget.remainingAttempts}）· 已等待 ${Math.round(
    budget.waitMs / 1000,
  )}s（剩 ${Math.round(budget.remainingWaitMs / 1000)}s）· 停因：${budget.stopReason}`;
}

/** turn 停因可读文案（P3 语义：partial 要标注未完成） */
export function describeTurnEnd(info: {
  stopReason: string;
  textOutcome?: 'final' | 'partial' | 'empty';
  error?: string;
}): { label: string; isAbnormal: boolean } {
  const abnormal =
    info.stopReason === 'error' ||
    info.stopReason === 'cancelled' ||
    info.stopReason === 'tool_failures' ||
    info.stopReason === 'max_tokens' ||
    info.stopReason === 'content_filter' ||
    info.textOutcome === 'partial';
  const base =
    info.textOutcome === 'partial' ? '未完成 / 已中断' : info.textOutcome === 'empty' ? '无最终文本' : info.stopReason;
  return { label: info.error !== undefined ? `${base}（${info.error}）` : base, isAbnormal: abnormal };
}

// —— 能力门控（无能力如实 disabled + 解释） ——

export interface ActionGate {
  enabled: boolean;
  reason?: string;
}

export interface GatingInput {
  /** 能力盘点结果（undefined = 尚未探测 → fail-closed 禁用并说明） */
  report?: CapabilityReportShape;
  /** 当前是否有可取消的 turn/task */
  hasCancellable: boolean;
  /** 是否有可排队/引导的活动 turn（steer 依赖 expectedTurnId） */
  hasActiveTurn: boolean;
  /** 当前会话是否有计划数据 */
  hasPlan: boolean;
}

export interface ActionGating {
  submitQueue: ActionGate;
  submitSteer: ActionGate;
  cancel: ActionGate;
  fork: ActionGate;
  viewPlan: ActionGate;
  resumeSubscription: ActionGate;
}

function gateCap(report: CapabilityReportShape | undefined, id: CapabilityIdShape): ActionGate {
  if (report === undefined) return { enabled: false, reason: '能力尚未探测（等待 serve 就绪）' };
  if (capabilityEnabled(report, id)) return { enabled: true };
  return { enabled: false, reason: capabilityReason(report, id) ?? '当前后端不提供该能力' };
}

/** 计算各动作可用性（能力 × 上下文条件）；不可用一律带可读原因 */
export function deriveActionGating(input: GatingInput): ActionGating {
  const queue = gateCap(input.report, 'queue');
  const steer = gateCap(input.report, 'steer');
  const cancel = gateCap(input.report, 'cancel');
  const fork = gateCap(input.report, 'fork');
  const plan = gateCap(input.report, 'plan-state');
  const resume = gateCap(input.report, 'resume-subscription');
  return {
    submitQueue: queue,
    submitSteer: steer.enabled && !input.hasActiveTurn ? { enabled: false, reason: 'steer 需要活动中的 turn' } : steer,
    cancel:
      cancel.enabled && !input.hasCancellable ? { enabled: false, reason: '当前没有可取消的 turn / 任务' } : cancel,
    fork,
    viewPlan: plan.enabled && !input.hasPlan ? { enabled: false, reason: '该会话暂无计划账本' } : plan,
    resumeSubscription: resume,
  };
}
