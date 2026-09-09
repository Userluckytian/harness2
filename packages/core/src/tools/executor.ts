// 工具执行器：审批管线 → 超时组合 → 统一结果。
// 注意：执行器不写会话日志事件（单一写者是 agent loop），只返回结果供 loop 落盘。
// 并发波次（runWave）：按提交顺序分组——unsafe（默认）调用独占执行；
// 连续的 safe 调用并行；批内 lockKey 相同的调用按键串行。
//
// S1 取消语义（审计 executor.ts:96-101,123-180「取消后后续工具仍可能先 execute」）：
//   - 取消前置门：执行点（审批后）前 env.signal 已取消 → 不启动工具，结果 error='cancelled'，
//     副作用计数 0（裸门在 raceAbort 之前，先求值 execute 的窗口被关闭）；
//   - 审批后竞态：allow 到达同时取消 —— 未启动则该 callId 不再执行；已启动（信号前）只记录一次；
//   - 取消归一：执行中被取消时，声明了 cancelGuaranteed 的工具（保证及时停止）归一为
//     'cancelled'；未声明（第三方/黑盒，无法保证立即停止）归一为 'unknown'（≠ cancelled）。
// 执行生命周期观察（S3/S7 消费；纯观察，不加第二套日志）：observer.onExecuteStart 在工具
// 真正启动前回调，onExecuteEnd 对每个提交调用的终态结果回调一次（含未启动的取消/拒绝/未知工具）。
import type { ToolRegistry } from './registry.js';
import type { ApprovalHandler, ToolOutput, ToolResult } from './types.js';

export interface ToolExecutionRequest {
  callId: string;
  tool: string;
  args: unknown;
}

export interface ExecutedToolResult extends ToolResult {
  callId: string;
}

/** 取消结果归一常量（S1；UI/交互层据此区分「已取消」与「取消未知」，见 interaction/types.ts） */
export const CANCELLED_RESULT = 'cancelled';
export const UNKNOWN_RESULT = 'unknown';

/**
 * 执行生命周期观察（S1，供 S3 delivery 的 callId 终态 / S7 toolExecutionView 使用）。
 * 纯观察缝：不落日志、不参与结果构造；回调抛错不影响执行器。
 *   - onExecuteStart：工具真正启动前调用（通过审批与取消前置门后）；
 *   - onExecuteEnd：每次提交调用产生终态结果后调用一次（成功/失败/拒绝/取消/未知工具都算）。
 */
export interface ExecutionLifecycleObserver {
  onExecuteStart?(req: ToolExecutionRequest): void;
  onExecuteEnd?(req: ToolExecutionRequest, result: ToolResult): void;
}

export interface ExecutionEnv {
  signal: AbortSignal;
  cwd: string;
  /**
   * 可选：单次执行前回调（agent loop 注入快照捕获，见 session/snapshots.ts）。
   * 抛出异常 → 该调用以 ok:false 失败（捕获不到 before 就不允许修改文件，保 undo 完整性）。
   */
  onBeforeExecute?(req: ToolExecutionRequest): void;
  /** 可选：单次执行后回调（ok = 工具是否成功；失败/取消路径 loop 不记 after）。异常 → 该调用转 ok:false */
  onAfterExecute?(req: ToolExecutionRequest, ok: boolean): void;
  /** 可选：执行生命周期观察（S1/S3/S7；纯观察，抛错不回写执行结果） */
  observer?: ExecutionLifecycleObserver;
}

export const DENIED_MESSAGE = 'denied by approval policy';

/** 任意抛出值归一为可读错误串 */
function errorMessage(e: unknown): string {
  return (e as Error | undefined)?.message ?? String(e);
}

/**
 * 与 signal 竞速：即使工具实现不观察 signal，超时/取消也能短路（不遗漏其后续 rejection）。
 * S1：改为惰性求值 —— 拿到 run 回调后才检查 signal，且工具同步抛错同样走统一取消/超时归一，
 * 修复「raceAbort(signal, Promise.resolve(def.execute(...))) 先求值 execute 再检查取消」的窗口。
 */
function raceAbort<T>(signal: AbortSignal, run: () => T | Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  let p: Promise<T>;
  try {
    p = Promise.resolve(run());
  } catch (e) {
    return Promise.reject(e); // 工具同步抛错 → 与异步 rejected 同路径归一（取消/超时优先）
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approval?: ApprovalHandler,
  ) {}

  /**
   * 单次执行：取消前置门 → 审批决策 → deny 短路 → 超时组合 → 执行 → 统一 {ok, output?, error?, durationMs}。
   * S1：未启动的取消一律 error='cancelled' 且不触发工具；执行中取消按下述规则归一
   * （工具 cancelGuaranteed → 'cancelled'，否则 → 'unknown'）。
   */
  async execute(req: ToolExecutionRequest, env: ExecutionEnv): Promise<ToolResult> {
    const result = await this.executeInner(req, env);
    this.emitEnd(env, req, result);
    return result;
  }

  private async executeInner(req: ToolExecutionRequest, env: ExecutionEnv): Promise<ToolResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const def = this.registry.get(req.tool);
    if (!def) return { ok: false, error: `unknown tool: ${req.tool}`, durationMs: elapsed() };

    // 取消前置门（入口）：已取消的 execute 不启动任何工具（副作用计数 0，也不再问审批）
    if (env.signal.aborted) return { ok: false, error: CANCELLED_RESULT, durationMs: elapsed() };

    // 审批管线：allow / deny / ask（ask 无 onAsk 回调时按拒绝处理）。
    // 回调异常不击穿 turn（P2-2）：转为该调用的失败结果。
    let decision: 'allow' | 'deny' | 'ask';
    try {
      decision = (await this.approval?.decide({ tool: req.tool, args: req.args })) ?? 'allow';
    } catch (e) {
      return { ok: false, error: `approval callback threw: ${errorMessage(e)}`, durationMs: elapsed() };
    }
    if (decision === 'deny') return { ok: false, error: DENIED_MESSAGE, durationMs: elapsed() };
    if (decision === 'ask') {
      let allowed: boolean;
      try {
        allowed = this.approval?.onAsk ? await this.approval.onAsk({ tool: req.tool, args: req.args }) : false;
      } catch (e) {
        return { ok: false, error: `approval callback threw: ${errorMessage(e)}`, durationMs: elapsed() };
      }
      if (!allowed) return { ok: false, error: DENIED_MESSAGE, durationMs: elapsed() };
    }

    // 取消前置门（审批后）：allow 到达同时取消的竞态——信号先到则本 callId 不再执行，
    // 不启动第二个 write；已启动（信号前完成启动）的 execute 只记录其结果一次。
    if (env.signal.aborted) return { ok: false, error: CANCELLED_RESULT, durationMs: elapsed() };

    // 超时信号与外部取消信号组合（AbortSignal.timeout 的定时器不阻塞事件循环退出）
    const signal =
      def.timeoutMs !== undefined ? AbortSignal.any([env.signal, AbortSignal.timeout(def.timeoutMs)]) : env.signal;

    // 快照捕获（执行前）：异常转失败——没有 before 就不允许修改文件（undo 完整性优先）
    try {
      env.onBeforeExecute?.(req);
    } catch (e) {
      return { ok: false, error: `snapshot capture failed: ${errorMessage(e)}`, durationMs: elapsed() };
    }

    // 生命周期观察：工具真正启动前回调（已过取消门；观察者异常不回写结果）
    try {
      env.observer?.onExecuteStart?.(req);
    } catch {
      // 纯观察缝：回调抛错不影响执行器
    }

    let out: ToolOutput;
    try {
      out = await raceAbort(signal, () => def.execute(req.args, { signal, cwd: env.cwd }));
    } catch (e) {
      const err = e as Error;
      let error = err?.message ?? String(err);
      if (env.signal.aborted) {
        // S1：取消归一——声明保证及时停止的工具归 'cancelled'；无法保证（不合作）归 'unknown'
        error = def.cancelGuaranteed === true ? CANCELLED_RESULT : UNKNOWN_RESULT;
      } else if (signal.aborted) {
        error = `tool timeout after ${def.timeoutMs}ms`;
      }
      return { ok: false, error, durationMs: elapsed() };
    }
    const ok = out.error === undefined;
    // 快照补记（成功后）：失败/取消路径由调用方跳过；异常转失败（文件虽已改动，如实报告）
    try {
      env.onAfterExecute?.(req, ok);
    } catch (e) {
      return { ok: false, error: `snapshot commit failed: ${errorMessage(e)}`, durationMs: elapsed() };
    }
    return { ok, output: out.output, error: out.error, durationMs: elapsed() };
  }

  /** 生命周期 end 观察分发（每次提交调用恰好回调一次；观察者异常吞掉不回写） */
  private emitEnd(env: ExecutionEnv, req: ToolExecutionRequest, result: ToolResult): void {
    try {
      env.observer?.onExecuteEnd?.(req, result);
    } catch {
      // 纯观察缝：回调抛错不影响执行器
    }
  }

  /**
   * 并发波次：按提交顺序处理——
   *   - unsafe（concurrencySafe !== true）调用独占执行（前序全部完成后再开始）；
   *   - 连续的 safe 调用合成一批并行；批内 lockKey 相同的调用按键串行；
   *   - 结果数组与请求顺序一一对应。
   */
  async runWave(reqs: readonly ToolExecutionRequest[], env: ExecutionEnv): Promise<ExecutedToolResult[]> {
    const results: ExecutedToolResult[] = new Array(reqs.length);
    let i = 0;
    while (i < reqs.length) {
      const head = reqs[i];
      if (head === undefined) break; // 循环条件已保证，仅满足索引安全
      const headDef = this.registry.get(head.tool);
      if (headDef?.concurrencySafe !== true) {
        // unsafe：独占执行
        results[i] = { ...(await this.execute(head, env)), callId: head.callId };
        i += 1;
        continue;
      }
      // 连续 safe 调用并行批
      let j = i;
      while (j < reqs.length) {
        const r = reqs[j];
        if (r === undefined || this.registry.get(r.tool)?.concurrencySafe !== true) break;
        j += 1;
      }
      const batch = reqs.slice(i, j);
      const lockChains = new Map<string, Promise<void>>();
      const settled = await Promise.all(
        batch.map(async (item): Promise<ExecutedToolResult> => {
          const def = this.registry.get(item.tool);
          // lockKey 回调异常同样不击穿波次（P2-2）：转为该调用的失败结果，不执行工具
          let key: string | undefined;
          try {
            key = def?.lockKey?.(item.args);
          } catch (e) {
            // lockKey 异常同样按终态结果分发 end 观察（该 callId 确实已提交、未执行）
            const failed: ExecutedToolResult = {
              callId: item.callId,
              ok: false,
              error: `lockKey callback threw: ${errorMessage(e)}`,
              durationMs: 0,
            };
            this.emitEnd(env, item, failed);
            return failed;
          }
          const run = async (): Promise<ExecutedToolResult> => ({
            ...(await this.execute(item, env)),
            callId: item.callId,
          });
          if (key === undefined) return run();
          const prev = lockChains.get(key) ?? Promise.resolve();
          const next = prev.then(run);
          lockChains.set(
            key,
            next.then(
              () => undefined,
              () => undefined,
            ),
          );
          return next;
        }),
      );
      for (const [k, r] of settled.entries()) {
        results[i + k] = r;
      }
      i = j;
    }
    return results;
  }
}
