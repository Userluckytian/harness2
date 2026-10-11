// A14 工作流落账：以 D02「扩展事件类型」机制落 `workflow/run` 事件（opaque 投影）。
// 走**已交付机制**（extensionEventTypes 注册表 + writer.appendExtension），不新造通道：
// 注册 → writer 接受（validator 校验）→ reader 解析 → 投影 opaque 通道（不进模型上下文、
// 参与 rewind 遮蔽窗口）。红线①「不落盘的就不显示」：UI 查询面只读这条已落盘通道；
// 红线② append-only 单写者：写入仍经唯一 SessionWriter。
//
// 事件形状（对齐 ZCode WorkflowEvent 的最小裁剪）：
//   phase='started'  → run 开工；
//   phase='step'     → 单个步骤状态迁移（running/ok/failed/skipped/blocked；attempt 记重试）；
//   phase='settled'  → run 终态（ok/failed/cancelled）。
// 输出只落**摘要**（截断 + 脱敏预览），不落完整正文——正文归宿主 runner 自己的落点。
import { redactSecrets } from '../config/redact.js';
import type { SessionAppender } from '../session/writer.js';
import { extensionEventTypes, type LoadedExtensionEvent } from '../session/extension-events.js';
import {
  WORKFLOW_OUTPUT_PREVIEW_CHARS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STEP_TYPES,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
  type WorkflowStepType,
} from './types.js';

/** 扩展事件类型名（ZCode workflow 卡片/状态子块的对应物） */
export const WORKFLOW_RUN_EVENT_TYPE = 'workflow/run';

/** 事件相位 */
export const WORKFLOW_RUN_PHASES = ['started', 'step', 'settled'] as const;
export type WorkflowRunPhase = (typeof WORKFLOW_RUN_PHASES)[number];

/** `workflow/run` 扩展事件 payload 形状 */
export interface WorkflowRunEventPayload {
  runId: string;
  workflow: string;
  phase: WorkflowRunPhase;
  /** phase='started'/'settled' → run 状态；phase='step' → 步骤状态 */
  status: WorkflowRunStatus | WorkflowStepStatus;
  stepId?: string;
  /** 步骤类型（phase='step' 必填；读侧据此渲染步骤图标/分组） */
  stepType?: WorkflowStepType;
  /** 步骤展示标题（phase='step' 可缺省；缺省读侧回落为 stepId） */
  stepTitle?: string;
  /** 步骤第几次尝试（1 起；重试递增） */
  attempt?: number;
  /** 输出摘要（截断 + 脱敏；仅非空时有） */
  outputPreview?: string;
  error?: string;
}

const ALL_STATUSES: readonly string[] = [...WORKFLOW_RUN_STATUSES, ...WORKFLOW_STEP_STATUSES];

/**
 * 注册 `workflow/run` 扩展事件类型（幂等；进程级单例注册表的 fail-closed 前置）。
 * validator = 最低形状校验：runId/workflow/phase/status 为合法字符串；phase='step' 时
 * stepId 必填；attempt 若在场须为正整数；outputPreview/error 若在场须为字符串。
 */
export function registerWorkflowRunEventType(): void {
  if (extensionEventTypes.has(WORKFLOW_RUN_EVENT_TYPE)) return;
  extensionEventTypes.register({
    type: WORKFLOW_RUN_EVENT_TYPE,
    projection: 'opaque',
    validator: (p) =>
      typeof p.runId === 'string' &&
      p.runId.length > 0 &&
      typeof p.workflow === 'string' &&
      p.workflow.length > 0 &&
      typeof p.phase === 'string' &&
      (WORKFLOW_RUN_PHASES as readonly string[]).includes(p.phase) &&
      typeof p.status === 'string' &&
      ALL_STATUSES.includes(p.status) &&
      (p.phase !== 'step' || (typeof p.stepId === 'string' && p.stepId.length > 0)) &&
      (p.phase !== 'step' ||
        (typeof p.stepType === 'string' && (WORKFLOW_STEP_TYPES as readonly string[]).includes(p.stepType))) &&
      (p.stepTitle === undefined || typeof p.stepTitle === 'string') &&
      (p.attempt === undefined || (typeof p.attempt === 'number' && Number.isInteger(p.attempt) && p.attempt > 0)) &&
      (p.outputPreview === undefined || typeof p.outputPreview === 'string') &&
      (p.error === undefined || typeof p.error === 'string'),
  });
}

/** 输出预览：截断 + 脱敏（空白清理后；空串/undefined → 省略） */
export function workflowOutputPreview(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  const clipped =
    trimmed.length > WORKFLOW_OUTPUT_PREVIEW_CHARS ? trimmed.slice(0, WORKFLOW_OUTPUT_PREVIEW_CHARS) : trimmed;
  return redactSecrets(clipped);
}

/** payload → 落账形状（丢掉空预览；其余字段原样） */
export function workflowRunEventPayload(payload: WorkflowRunEventPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {
    runId: payload.runId,
    workflow: payload.workflow,
    phase: payload.phase,
    status: payload.status,
  };
  if (payload.stepId !== undefined) out.stepId = payload.stepId;
  if (payload.stepType !== undefined) out.stepType = payload.stepType;
  if (payload.stepTitle !== undefined) out.stepTitle = payload.stepTitle;
  if (payload.attempt !== undefined) out.attempt = payload.attempt;
  const preview = workflowOutputPreview(payload.outputPreview);
  if (preview !== undefined) out.outputPreview = preview;
  if (payload.error !== undefined) out.error = payload.error;
  return out;
}

/**
 * 落一条 `workflow/run` 扩展事件。writer 无 appendExtension（镜像/观察包裹器）时静默跳过——
 * 扩展事件是观测面，缺省不阻断运行（与 hooks 落账同口径）。
 */
export function appendWorkflowRunEvent(
  writer: Pick<SessionAppender, 'appendExtension'> | undefined,
  payload: WorkflowRunEventPayload,
): void {
  if (writer === undefined || typeof writer.appendExtension !== 'function') return;
  registerWorkflowRunEventType();
  writer.appendExtension(WORKFLOW_RUN_EVENT_TYPE, workflowRunEventPayload(payload));
}

/** 读侧：从已加载会话的扩展事件里取 `workflow/run` 行（顺序即落盘顺序） */
export function readWorkflowRunEvents(
  extensionEvents: readonly LoadedExtensionEvent[],
): Array<{ seq: number; ts: string; payload: WorkflowRunEventPayload }> {
  const out: Array<{ seq: number; ts: string; payload: WorkflowRunEventPayload }> = [];
  for (const { event } of extensionEvents) {
    if (event.type !== WORKFLOW_RUN_EVENT_TYPE) continue;
    out.push({ seq: event.seq, ts: event.ts, payload: event.payload as unknown as WorkflowRunEventPayload });
  }
  return out;
}
