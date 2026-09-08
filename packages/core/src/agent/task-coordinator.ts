// 任务协调器（S5）：子代理后台任务的生命周期 + 并发调度 + 资源锁。
// 中立控制器（不 import server/tools/agent loop；run 由装配层注入，通常执行子会话 runTurn）。
//
// 生命周期：registered→queued→starting→running→completed/failed/cancelled（终态单调）。
//   - 注册（background:true）立返 handle（status/wait/continue/cancel 分离，不阻塞调用方）；
//   - 每段迁移写入 runtime journal（task/transition，带 clientMessageId 溯源——S3a 交接）。
//
// 并发（K=2 只读并行 + 共享写全局串行）：
//   - readonly 任务可多开，默认同时至多 K=2（真实重叠）；
//   - write（改动工作区/文件）任务同一时刻至多一个在跑（资源锁）——只读不因写阻塞，
//     写只被其它写串行（至多一个写型）；
//   - 终态单调：状态只允许沿 TASK_TRANSITIONS 迁移，绝不倒退；终态无出边。
//
// cancel（含 expectedId 并发防护——S3c2 carry-over）：
//   - target 不存在 → unknown；
//   - 已终态 → cancelled（确认语义，不冒充）；
//   - expectedId 以「期望当前状态」作陈旧目标校验：传入且 ≠ 当前状态 → unknown（被拒），
//     不误伤已前进/完成的任务。
//
// 事件溯源红线：任务状态只进 runtime journal（操作状态账本），不伪造 session 日志事件；
// 进度帧是展示投影（onState 回调），不进模型上下文。queue/approval 第一套正文仍归
// delivery/approval，本协调器不存第二套正文。
import { randomUUID } from 'node:crypto';
import {
  canTaskTransition,
  isTerminalTaskState,
  TASK_STATES,
} from '../interaction/types.js';
import type {
  CancelAck,
  ClientMessageId,
  SessionId,
  TaskContract,
  TaskId,
  TaskState,
} from '../interaction/types.js';

/** 任务是否改动工作区/文件：write 走全局写锁（同一时刻至多一个），readonly 走 K=2 并行 */
export type TaskWriteMode = 'readonly' | 'write';

/** 任务实际执行的返回（run 内部已把取消/异常收敛为 ok/error） */
export interface TaskRunResult {
  ok: boolean;
  error?: string;
  /** S5：跨 turn 可取的后台任务结果正文（subagent_start 的 finish output JSON；协调器跨 turn 持久） */
  output?: string;
}

/** 注册一个后台任务所需的最小信息 */
export interface TaskSpec {
  taskId: TaskId;
  sessionId: SessionId;
  /** background:true → 注册立返 handle（status/wait/cancel 分离） */
  background: boolean;
  /** readonly / write（资源锁分派依据） */
  writeMode: TaskWriteMode;
  /** S3a 交接：task/transition 打 clientMessageId 溯源（judge 判 outcome 依据） */
  clientMessageId?: ClientMessageId;
  parentTaskId?: TaskId;
  /** 任务描述（展示用；不入 journal 正文账本） */
  prompt: string;
  /** 实际工作：装配层注入（子会话 runTurn 等） */
  run: (signal: AbortSignal) => Promise<TaskRunResult>;
}

/** runtime journal 适配缝：task/transition 落账（S3a 账本单写） */
export interface TaskTransitionRecorder {
  appendTaskTransition(input: {
    taskId: TaskId;
    parentTaskId?: TaskId;
    clientMessageId?: ClientMessageId;
    background?: boolean;
    from: TaskState;
    to: TaskState;
  }): void;
}

export interface TaskCoordinatorOptions {
  /** task/transition durable 落账（缺省 = 内存账本：仍校验单调，但不持久化） */
  recorder?: TaskTransitionRecorder;
  /** 只读任务最大并行度（默认 2） */
  maxReadonlyConcurrency?: number;
}

interface TaskRuntime {
  spec: TaskSpec;
  state: TaskState;
  controller: AbortController;
  updatedAt: string;
  terminalAt?: string;
  result?: TaskRunResult;
  /** 已取消请求置位（stopping 待收敛） */
  stopping?: boolean;
}

/** 默认只读并行度 K=2（契约行 S5） */
export const DEFAULT_READONLY_CONCURRENCY = 2;

/**
 * TaskCoordinator：每进程一个（装配层注入；跨会话共享写锁即全局串行）。
 * 单写者：record() 是唯一状态落账出口（runtime journal 单写）。
 */
export class TaskCoordinator {
  private readonly tasks = new Map<TaskId, TaskRuntime>();
  private readonly runQueue: TaskRuntime[] = [];
  private running = { readonly: 0, write: 0 };
  private readonly maxReadonly: number;
  private readonly recorder?: TaskTransitionRecorder;
  private drainScheduled = false;
  /** 终态唤醒回调集（wait 用） */
  private readonly wakeups = new Set<() => void>();

  constructor(options: TaskCoordinatorOptions = {}) {
    this.maxReadonly = options.maxReadonlyConcurrency ?? DEFAULT_READONLY_CONCURRENCY;
    this.recorder = options.recorder;
  }

  /** 注册任务并立即入队调度（background:true 立返 handle）。重复 taskId → 抛错（幂等由调用方判） */
  register(spec: TaskSpec): TaskContract {
    if (this.tasks.has(spec.taskId)) {
      throw new Error(`task already registered: ${spec.taskId}`);
    }
    const rt: TaskRuntime = {
      spec,
      state: 'registered',
      controller: new AbortController(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(spec.taskId, rt);
    this.record(rt, 'queued'); // registered → queued（注册即调度；background 立返 handle）
    this.enqueue(rt);
    return this.contract(rt);
  }

  /** 查询任务当前契约；不存在 → undefined */
  status(taskId: TaskId): TaskContract | undefined {
    const rt = this.tasks.get(taskId);
    return rt === undefined ? undefined : this.contract(rt);
  }

  /** S5：查询任务终态结果正文（run 返回的 output；subagent_continue 跨 turn 取后台任务最终文本用） */
  resultOf(taskId: TaskId): TaskRunResult | undefined {
    return this.tasks.get(taskId)?.result;
  }

  /** 阻塞等待任务进入终态；timeoutMs 缺省不超时必须到终态。返回终态契约。 */
  async wait(taskId: TaskId, opts: { timeoutMs?: number } = {}): Promise<TaskContract> {
    const rt = this.tasks.get(taskId);
    if (rt === undefined) throw new Error(`task not found: ${taskId}`);
    if (isTerminalTaskState(rt.state)) return this.contract(rt);
    return new Promise<TaskContract>((resolve, reject) => {
      const timer =
        opts.timeoutMs !== undefined
          ? setTimeout(() => {
              cleanup();
              reject(new Error(`wait timed out after ${opts.timeoutMs}ms: ${taskId}`));
            }, opts.timeoutMs)
          : undefined;
      const check = (): void => {
        if (isTerminalTaskState(rt.state)) {
          cleanup();
          resolve(this.contract(rt));
        }
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.wakeups.delete(check);
      };
      this.wakeups.add(check);
      check();
    });
  }

  /**
   * 取消任务。expectedId 以期型当前状态做陈旧校验（S3c2 carry-over）：
   *   - 任务不存在 → unknown；
   *   - 已终态 → cancelled（确认语义）；
   *   - expectedId 传入且 ≠ 当前状态（如期望 running 但已 starting/completed）→ unknown（被拒）；
   *   - 否则运行中 → stopping（abort），排队未启动 → cancelled。
   */
  cancel(taskId: TaskId, opts: { expectedId?: TaskState } = {}): CancelAck {
    const rt = this.tasks.get(taskId);
    if (rt === undefined) return { requestId: randomUUID(), state: 'unknown' };
    if (isTerminalTaskState(rt.state)) return { requestId: randomUUID(), state: 'cancelled' };
    if (opts.expectedId !== undefined && opts.expectedId !== rt.state) {
      return { requestId: randomUUID(), state: 'unknown' };
    }
    if (rt.state === 'queued' || rt.state === 'registered') {
      // 未启动：直接从队列/调度移除，落 cancelled（不 abort 已运行的 run）
      rt.controller.abort();
      this.transitionTo(rt, 'cancelled');
      this.removeFromQueue(rt);
      return { requestId: randomUUID(), state: 'cancelled' };
    }
    // running/starting/waiting-approval：置 stopping → abort → 终态收敛
    if (!rt.stopping) {
      rt.stopping = true;
      this.transitionTo(rt, 'stopping');
      rt.controller.abort();
    }
    return { requestId: randomUUID(), state: 'stopping' };
  }

  /** 关闭/收尾：取消全部非终态任务（运行中→stopping+abort；排队→cancelled） */
  abortAll(): void {
    for (const rt of [...this.tasks.values()]) {
      if (!isTerminalTaskState(rt.state)) this.cancel(rt.spec.taskId);
    }
  }

  /** close 等待：全部非终态任务收敛到终态（运行中 abort 落定；排队直接 cancelled）后才返回。
   *  调用方须在关闭/清理 journal 前调用，确保 task/transition 在账本关闭前全部落定
   *  （否则仍在收尾的任务 onFinish 会向已关闭的 journal append——收尾竞态）。 */
  async settleAll(): Promise<void> {
    this.abortAll();
    const pending = [...this.tasks.values()].filter((rt) => !isTerminalTaskState(rt.state));
    await Promise.all(pending.map((rt) => this.wait(rt.spec.taskId)));
  }

  // —— 内部调度 ——

  private enqueue(rt: TaskRuntime): void {
    this.runQueue.push(rt);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.tryDispatch();
    });
  }

  private tryDispatch(): void {
    // 先收集本次可启动的任务，再逐一 start（start 会 removeFromQueue，避免迭代中修改数组）
    const toStart: TaskRuntime[] = [];
    let batchReadonly = 0;
    let batchWrite = 0;
    for (const rt of this.runQueue) {
      if (rt.state !== 'queued') continue;
      if (rt.stopping) continue; // 已请求取消的排队任务不再启动
      const isWrite = rt.spec.writeMode === 'write';
      if (isWrite) {
        if (this.running.write + batchWrite > 0) continue;
        batchWrite += 1;
        toStart.push(rt);
      } else {
        if (this.running.readonly + batchReadonly >= this.maxReadonly) continue;
        batchReadonly += 1;
        toStart.push(rt);
      }
    }
    for (const rt of toStart) this.start(rt);
  }

  private start(rt: TaskRuntime): void {
    this.removeFromQueue(rt);
    this.transitionTo(rt, 'starting');
    if (rt.spec.writeMode === 'write') this.running.write += 1;
    else this.running.readonly += 1;
    this.transitionTo(rt, 'running');
    void this.runToCompletion(rt);
  }

  private async runToCompletion(rt: TaskRuntime): Promise<void> {
    let result: TaskRunResult;
    try {
      result = await rt.spec.run(rt.controller.signal);
    } catch (e) {
      result = { ok: false, error: (e as Error)?.message ?? String(e) };
    }
    this.onFinish(rt, result);
  }

  private onFinish(rt: TaskRuntime, result: TaskRunResult): void {
    if (rt.spec.writeMode === 'write') this.running.write = Math.max(0, this.running.write - 1);
    else this.running.readonly = Math.max(0, this.running.readonly - 1);
    rt.result = result;
    const ok = result?.ok === true && !rt.stopping && !rt.controller.signal.aborted;
    const toState: TaskState = rt.stopping || rt.controller.signal.aborted ? 'cancelled' : ok ? 'completed' : 'failed';
    this.transitionTo(rt, toState);
    this.scheduleDrain();
  }

  private removeFromQueue(rt: TaskRuntime): void {
    const idx = this.runQueue.indexOf(rt);
    if (idx >= 0) this.runQueue.splice(idx, 1);
  }

  // —— 状态迁移（唯一出口：单调 + 落账） ——

  private record(rt: TaskRuntime, to: TaskState): void {
    const from = rt.state;
    if (from === to) return;
    if (!canTaskTransition(from, to)) {
      throw new Error(`illegal task transition ${from} → ${to} for ${rt.spec.taskId}`);
    }
    rt.state = to;
    rt.updatedAt = new Date().toISOString();
    if (isTerminalTaskState(to)) rt.terminalAt = rt.updatedAt;
    this.recorder?.appendTaskTransition({
      taskId: rt.spec.taskId,
      parentTaskId: rt.spec.parentTaskId,
      clientMessageId: rt.spec.clientMessageId,
      background: rt.spec.background,
      from,
      to,
    });
    for (const cb of this.wakeups) cb();
  }

  private transitionTo(rt: TaskRuntime, to: TaskState): void {
    this.record(rt, to);
  }

  private contract(rt: TaskRuntime): TaskContract {
    const c: TaskContract = {
      taskId: rt.spec.taskId,
      background: rt.spec.background,
      state: rt.state,
      updatedAt: rt.updatedAt,
    };
    if (rt.spec.parentTaskId !== undefined) c.parentTaskId = rt.spec.parentTaskId;
    return c;
  }
}

/** 从 journal task/transition 重建 TaskContract 列表（重启后 status/resume 用；最后一条迁移 = 当前态） */
export function reconstructTasks(transitions: Array<{ taskId: TaskId; parentTaskId?: TaskId; background?: boolean; from: TaskState; to: TaskState; ts?: string }>): TaskContract[] {
  const byTask = new Map<TaskId, { parentTaskId?: TaskId; background?: boolean; state: TaskState; ts?: string }>();
  for (const t of transitions) {
    byTask.set(t.taskId, { parentTaskId: t.parentTaskId, background: t.background, state: t.to, ts: t.ts });
  }
  return [...byTask.entries()].map(([taskId, t]) => {
    const c: TaskContract = {
      taskId,
      background: t.background ?? false,
      state: t.state,
      ...(t.ts !== undefined ? { updatedAt: t.ts } : {}),
    };
    if (t.parentTaskId !== undefined) c.parentTaskId = t.parentTaskId;
    return c;
  });
}

export { TASK_STATES };
