// A14 工作流步进引擎（core 全新建设）。
//
// 设计要点（对齐 ZCode 调研结论，见报告）：
//   - 步骤状态机：pending → running →（ok | failed | skipped | blocked）；重试时 running 可多次。
//   - 依赖门控：步骤 dependsOn 全为 ok 才 ready；任一依赖 failed/blocked/skipped → 本步 blocked。
//   - 并发：ready 步骤经**既有 TaskCoordinator 的只读并行闸**调度（有界、排队、不超限），
//     不另起无界并行；maxConcurrency 缺省 4、天花板 8（定义解析期就已夹住）。
//   - 失败策略：stop（首败即停、余下 skipped）/ continue（分支各自推进，依赖中断链 blocked）/
//     retry（单步有界重试后再按 stop 收口）。
//   - 人工审批闸：直接消费既有 ApprovalHandler（tools/types.ts），不新造审批；无 handler 或
//     ask 无确认回调 → fail-closed 落 blocked。
//   - 断点续跑：落盘走 `workflow/run` 扩展事件；传入上一次投影（resume）时，已 ok 的步骤跳过，
//     running/pending 步骤重新执行（对齐 ZCode resume 的 active→pending 重置）。
//   - 失控保护：步数上限（解析期）、单步超时、并发上限、重试上限、递归深度（启动期断言）。
//
// 本模块只动内存与「经 writer 落一条扩展事件」；不写第二套对话正文（正文归注入的 runner）。
import { TaskCoordinator } from '../agent/task-coordinator.js';
import type { ApprovalHandler } from '../tools/types.js';
import type { SessionAppender } from '../session/writer.js';
import { appendWorkflowRunEvent, workflowRunEventPayload, type WorkflowRunEventPayload } from './extension.js';
import {
  WORKFLOW_MAX_CONCURRENCY_CEILING,
  WORKFLOW_MAX_DEPTH,
  type WorkflowDefinition,
  type WorkflowFailurePolicy,
  type WorkflowRunState,
  type WorkflowRunStatus,
  type WorkflowStepDefinition,
  type WorkflowStepOutcome,
  type WorkflowStepRunners,
  type WorkflowStepState,
  type WorkflowStepStatus,
} from './types.js';

/** 递归深度断言：深度 > WORKFLOW_MAX_DEPTH 即拒（「工作流里起工作流」当前一律拒绝） */
export function assertWorkflowDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`workflow depth must be a non-negative integer: ${String(depth)}`);
  }
  if (depth > WORKFLOW_MAX_DEPTH) {
    throw new Error(
      `workflow recursion rejected: depth ${depth} exceeds limit ${WORKFLOW_MAX_DEPTH}（工作流内不得再起工作流）`,
    );
  }
}

export interface WorkflowEngineOptions {
  runId: string;
  definition: WorkflowDefinition;
  cwd: string;
  /** 步骤执行器缝（宿主注入；测试用 fake，不真起模型/进程） */
  steps: WorkflowStepRunners;
  /** 人工审批闸复用既有 ApprovalHandler（缺省 = 审批步骤 fail-closed 落 blocked） */
  approval?: ApprovalHandler;
  /** 落账 sink（SessionWriter 或观察包裹器；缺省 = 不落盘，只返回内存态） */
  writer?: Pick<SessionAppender, 'appendExtension'>;
  /** 运行取消信号（用户中断） */
  signal?: AbortSignal;
  /** 并发覆盖（会夹到 1..天花板；缺省取定义 maxConcurrency） */
  concurrency?: number;
  /** 递归深度（缺省 0；> WORKFLOW_MAX_DEPTH 启动即抛） */
  depth?: number;
  /** 断点续跑：上一次投影的 { ok } 步骤跳过、running/pending 重跑 */
  resume?: WorkflowRunState;
  /** 时钟（测试可注入确定性时间） */
  now?: () => string;
}

interface ActiveEntry {
  taskId: string;
  settled: boolean;
  settle: () => void;
}

/** 引擎内部可变步骤记录（与 WorkflowStepState 同形，就地更新） */
type MutableStep = WorkflowStepState;

export class WorkflowEngine {
  private readonly options: WorkflowEngineOptions;
  private readonly def: WorkflowDefinition;
  private readonly writer: Pick<SessionAppender, 'appendExtension'> | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly now: () => string;
  private readonly steps = new Map<string, MutableStep>();

  constructor(options: WorkflowEngineOptions) {
    assertWorkflowDepth(options.depth ?? 0);
    if (options.runId.length === 0) throw new Error('workflow runId must be non-empty');
    this.options = options;
    this.def = options.definition;
    this.writer = options.writer;
    this.signal = options.signal;
    this.now = options.now ?? (() => new Date().toISOString());
    const resumedById = new Map((options.resume?.steps ?? []).map((s) => [s.stepId, s]));
    for (const step of this.def.steps) {
      const resumed = resumedById.get(step.id);
      const keepTerminal =
        resumed !== undefined &&
        (resumed.status === 'ok' ||
          resumed.status === 'failed' ||
          resumed.status === 'skipped' ||
          resumed.status === 'blocked');
      const record: MutableStep = {
        stepId: step.id,
        type: step.type,
        title: step.title,
        status: keepTerminal ? (resumed as MutableStep).status : 'pending',
        attempts: resumed?.attempts ?? 0,
      };
      if (resumed?.outputPreview !== undefined) record.outputPreview = resumed.outputPreview;
      if (resumed?.error !== undefined) record.error = resumed.error;
      this.steps.set(step.id, record);
    }
  }

  /** 执行到终态并返回运行态（失败策略 / 取消 / 依赖中断都已收敛）。 */
  async run(): Promise<WorkflowRunState> {
    const cap = Math.min(
      Math.max(1, this.options.concurrency ?? this.def.maxConcurrency),
      WORKFLOW_MAX_CONCURRENCY_CEILING,
    );
    const gate = new TaskCoordinator({ maxReadonlyConcurrency: cap });
    const active = new Map<string, { entry: ActiveEntry; promise: Promise<string> }>();
    const onAbort = (): void => gate.abortAll();
    this.signal?.addEventListener('abort', onAbort);

    this.emit({ phase: 'started', status: 'running' });
    let cancelled = false;
    let stopDispatch = false;

    try {
      while (true) {
        if (this.signal?.aborted === true) {
          cancelled = true;
          await this.abortActive(gate, active);
          this.markRemainingSkipped('运行已取消');
          break;
        }

        // stop/retry 收口优先于依赖中断标记：停止后余下 pending 一律 skipped（而非 blocked）
        if (stopDispatch) {
          this.markRemainingSkipped('上游步骤失败，按 stop 策略停止');
          break;
        }

        this.blockStepsWithDeadDeps();

        const ready = this.def.steps.filter(
          (step) => this.steps.get(step.id)!.status === 'pending' && this.depsSatisfied(step),
        );
        for (const step of ready) {
          if (active.size >= cap) break;
          this.dispatch(step, gate, active);
        }

        if (active.size === 0) {
          if (this.allTerminal()) break;
          // 有 pending 但无 ready 且无在跑：依赖中断已在上一步标 blocked；仍无进展 = 死锁兜底
          this.markRemainingSkipped('无可推进步骤（依赖不可满足）');
          break;
        }

        const settledId = await Promise.race([...active.values()].map((v) => v.promise));
        active.delete(settledId);
        const settled = this.steps.get(settledId)!;
        if (this.def.failurePolicy !== 'continue' && (settled.status === 'failed' || settled.status === 'blocked')) {
          stopDispatch = true;
        }
      }
    } finally {
      this.signal?.removeEventListener('abort', onAbort);
    }

    const status: WorkflowRunStatus = cancelled ? 'cancelled' : this.anyStepFailed() ? 'failed' : 'ok';
    this.emit({ phase: 'settled', status });
    return this.stateSnapshot(status);
  }

  // —— 调度 ——

  private dispatch(
    step: WorkflowStepDefinition,
    gate: TaskCoordinator,
    active: Map<string, { entry: ActiveEntry; promise: Promise<string> }>,
  ): void {
    const taskId = `${this.options.runId}::${step.id}`;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: ActiveEntry = { taskId, settled: false, settle };
    active.set(step.id, { entry, promise: done.then(() => step.id) });
    gate.register({
      taskId,
      sessionId: this.options.runId,
      background: true,
      writeMode: step.writeMode,
      prompt: step.title,
      run: async (gateSignal) => {
        try {
          await this.runStep(step, gateSignal);
        } finally {
          if (!entry.settled) {
            entry.settled = true;
            settle();
          }
        }
        return { ok: true };
      },
    });
  }

  /** 取消时的收敛：已启动的 abort 让其自行落定；排队未启动的直接落 skipped 并手动解锁。 */
  private async abortActive(
    gate: TaskCoordinator,
    active: Map<string, { entry: ActiveEntry; promise: Promise<string> }>,
  ): Promise<void> {
    for (const [stepId, { entry }] of active) {
      const taskState = gate.status(entry.taskId)?.state;
      gate.cancel(entry.taskId);
      if (taskState === 'registered' || taskState === 'queued') {
        this.markStep(this.steps.get(stepId)!, 'skipped', undefined, '运行已取消（未启动）');
        if (!entry.settled) {
          entry.settled = true;
          entry.settle();
        }
      }
    }
    await Promise.all([...active.values()].map((v) => v.promise));
    active.clear();
  }

  private async runStep(step: WorkflowStepDefinition, gateSignal: AbortSignal): Promise<void> {
    const policy: WorkflowFailurePolicy = this.def.failurePolicy;
    const maxRetries = step.maxRetries ?? this.def.maxRetries;
    let attempt = 1;
    while (true) {
      this.markStepRunning(step, attempt);
      const outcome = await this.executeStep(step, gateSignal);
      if (outcome.ok === true) {
        this.markStep(this.steps.get(step.id)!, 'ok', outcome.output, outcome.error);
        return;
      }
      if (outcome.blocked === true) {
        this.markStep(this.steps.get(step.id)!, 'blocked', outcome.output, outcome.error ?? '审批未通过');
        return;
      }
      if (policy === 'retry' && attempt <= maxRetries) {
        attempt += 1;
        continue;
      }
      this.markStep(this.steps.get(step.id)!, 'failed', outcome.output, outcome.error);
      return;
    }
  }

  private async executeStep(step: WorkflowStepDefinition, gateSignal: AbortSignal): Promise<WorkflowStepOutcome> {
    if (step.type === 'approval') return this.executeApproval(step);
    const runner = this.options.steps[step.type];
    if (runner === undefined) {
      return { ok: false, error: `步骤执行器未装配：${step.type}（宿主未注入 runner）` };
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, step.timeoutMs);
    const parts: AbortSignal[] = [controller.signal, gateSignal];
    if (this.signal !== undefined) parts.push(this.signal);
    const signal = AbortSignal.any(parts);
    try {
      return await runner({ runId: this.options.runId, cwd: this.options.cwd, step, signal });
    } catch (e) {
      if (timedOut) return { ok: false, error: `步骤超时（${step.timeoutMs}ms）` };
      if (this.signal?.aborted === true || gateSignal.aborted) return { ok: false, error: '运行已取消' };
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeApproval(step: WorkflowStepDefinition): Promise<WorkflowStepOutcome> {
    const handler = this.options.approval;
    const tool = step.tool ?? 'workflow';
    const args = step.args ?? {};
    if (handler === undefined) {
      return { ok: false, blocked: true, error: `未注入审批处理器（fail-closed）：${tool}` };
    }
    try {
      const decision = await handler.decide({ tool, args });
      if (decision === 'allow') return { ok: true, output: `审批放行：${tool}` };
      if (decision === 'deny') return { ok: false, blocked: true, error: `审批拒绝：${tool}` };
      if (handler.onAsk === undefined) {
        return { ok: false, blocked: true, error: `需要人工确认但未提供确认回调（fail-closed）：${tool}` };
      }
      const approved = await handler.onAsk({ tool, args });
      return approved
        ? { ok: true, output: `人工审批放行：${tool}` }
        : { ok: false, blocked: true, error: `人工审批未通过：${tool}` };
    } catch (e) {
      return {
        ok: false,
        blocked: true,
        error: `审批处理器异常（fail-closed）：${(e as Error)?.message ?? String(e)}`,
      };
    }
  }

  // —— 依赖与状态 ——

  private depsSatisfied(step: WorkflowStepDefinition): boolean {
    return step.dependsOn.every((depId) => this.steps.get(depId)?.status === 'ok');
  }

  /** 依赖已终结且非 ok → 本步 blocked（不可运行，落账） */
  private blockStepsWithDeadDeps(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of this.def.steps) {
        const record = this.steps.get(step.id)!;
        if (record.status !== 'pending') continue;
        const deadDep = step.dependsOn.find((depId) => {
          const dep = this.steps.get(depId);
          return dep !== undefined && (dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'skipped');
        });
        if (deadDep !== undefined) {
          this.markStep(record, 'blocked', undefined, `依赖步骤未成功：${deadDep}`);
          changed = true;
        }
      }
    }
  }

  private allTerminal(): boolean {
    return [...this.steps.values()].every((s) => s.status !== 'pending' && s.status !== 'running');
  }

  private anyStepFailed(): boolean {
    return [...this.steps.values()].some((s) => s.status === 'failed' || s.status === 'blocked');
  }

  private markRemainingSkipped(reason: string): void {
    for (const step of this.def.steps) {
      const record = this.steps.get(step.id)!;
      if (record.status === 'pending') this.markStep(record, 'skipped', undefined, reason);
    }
  }

  // —— 落账（状态与事件一致更新） ——

  private markStepRunning(step: WorkflowStepDefinition, attempt: number): void {
    const record = this.steps.get(step.id)!;
    record.status = 'running';
    record.attempts = Math.max(record.attempts, attempt);
    this.emit({
      phase: 'step',
      status: 'running',
      stepId: step.id,
      stepType: step.type,
      stepTitle: step.title,
      attempt,
    });
  }

  private markStep(
    record: MutableStep,
    status: WorkflowStepStatus,
    output: string | undefined,
    error: string | undefined,
  ): void {
    record.status = status;
    const landed = this.emit({
      phase: 'step',
      status,
      stepId: record.stepId,
      stepType: record.type,
      stepTitle: record.title,
      outputPreview: output,
      error,
    });
    // 内存态取落账后的同值（截断 + 脱敏），保证「显示 == 落盘」（红线①）
    if (typeof landed['outputPreview'] === 'string') record.outputPreview = landed['outputPreview'];
    if (error !== undefined) record.error = error;
  }

  /** 落一条事件并返回归一后的落账形状（预览截断/脱敏），供内存态与落盘一致。 */
  private emit(payload: Omit<WorkflowRunEventPayload, 'runId' | 'workflow'>): Record<string, unknown> {
    const full: WorkflowRunEventPayload = {
      runId: this.options.runId,
      workflow: this.def.name,
      ...payload,
    };
    appendWorkflowRunEvent(this.writer, full);
    return workflowRunEventPayload(full);
  }

  private stateSnapshot(status: WorkflowRunStatus): WorkflowRunState {
    return {
      runId: this.options.runId,
      workflow: this.def.name,
      status,
      steps: this.def.steps.map((step) => ({ ...this.steps.get(step.id)! })),
      startedAt: this.now(),
      updatedAt: this.now(),
    };
  }
}
