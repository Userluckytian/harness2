// A14 工作流运行态投影（UI 契约留缝）：从**已落盘的** `workflow/run` 扩展事件重放出运行态。
//
// 红线①「不落盘的就不显示」：本模块唯一输入是 `loadSession` 返回的扩展事件——任何未经
// 落盘的引擎内存态都不出现在这里。重放语义：
//   - 按落盘顺序扫描，同 (runId, stepId) 后来者覆盖（状态机单调前进）；
//   - 只认活动事件（被 rewind 遮蔽的影子事件不参与——与 opaque 投影同口径）；
//   - phase='started' 置 running，phase='settled' 置终态，phase='step' 更新步骤。
// 消费方：CLI/桌面的 `/workflow status`、右栏 tab、状态面板 Workflow 子块（本批只留函数缝）。
import { WORKFLOW_RUN_EVENT_TYPE, type WorkflowRunEventPayload, type WorkflowRunPhase } from './extension.js';
import type { LoadedExtensionEvent } from '../session/extension-events.js';
import type { WorkflowRunState, WorkflowRunStatus, WorkflowStepState, WorkflowStepStatus } from './types.js';

function asPayload(event: LoadedExtensionEvent): WorkflowRunEventPayload | undefined {
  if (event.event.type !== WORKFLOW_RUN_EVENT_TYPE) return undefined;
  return event.event.payload as unknown as WorkflowRunEventPayload;
}

/**
 * 重放全部运行（按首次出现顺序）。每次调用都从零重放，无隐藏缓存——投影是纯函数。
 */
export function projectWorkflowRuns(extensionEvents: readonly LoadedExtensionEvent[]): WorkflowRunState[] {
  const runs = new Map<string, WorkflowRunState>();
  const stepIndex = new Map<string, Map<string, number>>();

  for (const item of extensionEvents) {
    if (!item.active) continue;
    const payload = asPayload(item);
    if (payload === undefined) continue;
    const ts = item.event.ts;

    let run = runs.get(payload.runId);
    if (run === undefined) {
      run = { runId: payload.runId, workflow: payload.workflow, status: 'pending', steps: [] };
      runs.set(payload.runId, run);
      stepIndex.set(payload.runId, new Map());
    }
    run.updatedAt = ts;

    const phase: WorkflowRunPhase = payload.phase;
    if (phase === 'started') {
      run.status = 'running';
      run.startedAt ??= ts;
      continue;
    }
    if (phase === 'settled') {
      run.status = payload.status as WorkflowRunStatus;
      continue;
    }
    applyStepEvent(run, stepIndex.get(payload.runId)!, payload);
  }

  return [...runs.values()];
}

function applyStepEvent(run: WorkflowRunState, index: Map<string, number>, payload: WorkflowRunEventPayload): void {
  const stepId = payload.stepId;
  if (stepId === undefined) return;
  const existingAt = index.get(stepId);
  let step: WorkflowStepState;
  if (existingAt === undefined) {
    step = {
      stepId,
      type: payload.stepType ?? 'prompt',
      title: payload.stepTitle ?? stepId,
      status: 'pending',
      attempts: 0,
    };
    index.set(stepId, run.steps.length);
    run.steps.push(step);
  } else {
    step = run.steps[existingAt]!;
  }

  step.status = payload.status as WorkflowStepStatus;
  if (payload.status === 'running') {
    step.attempts = Math.max(step.attempts, payload.attempt ?? step.attempts + 1);
  } else if (payload.attempt !== undefined) {
    step.attempts = Math.max(step.attempts, payload.attempt);
  }
  if (payload.outputPreview !== undefined) step.outputPreview = payload.outputPreview;
  if (payload.error !== undefined) step.error = payload.error;
}

/** 按 runId 取一次运行（不存在返回 undefined） */
export function findWorkflowRun(
  extensionEvents: readonly LoadedExtensionEvent[],
  runId: string,
): WorkflowRunState | undefined {
  return projectWorkflowRuns(extensionEvents).find((run) => run.runId === runId);
}

/** 最近一次运行（按 startedAt/updatedAt 最新；空则 undefined）——状态面板 Workflow 子块缺省目标 */
export function latestWorkflowRun(extensionEvents: readonly LoadedExtensionEvent[]): WorkflowRunState | undefined {
  const runs = projectWorkflowRuns(extensionEvents);
  let best: WorkflowRunState | undefined;
  for (const run of runs) {
    const ts = run.updatedAt ?? run.startedAt ?? '';
    const bestTs = best?.updatedAt ?? best?.startedAt ?? '';
    if (best === undefined || ts > bestTs) best = run;
  }
  return best;
}
