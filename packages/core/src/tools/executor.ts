// 工具执行器：审批管线 → 超时组合 → 统一结果。
// 注意：执行器不写会话日志事件（单一写者是 agent loop），只返回结果供 loop 落盘。
// 并发波次（runWave）：按提交顺序分组——unsafe（默认）调用独占执行；
// 连续的 safe 调用并行；批内 lockKey 相同的调用按键串行。
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

export interface ExecutionEnv {
  signal: AbortSignal;
  cwd: string;
}

export const DENIED_MESSAGE = 'denied by approval policy';

/** 任意抛出值归一为可读错误串 */
function errorMessage(e: unknown): string {
  return (e as Error | undefined)?.message ?? String(e);
}

/** 与 signal 竞速：即使工具实现不观察 signal，超时/取消也能短路（不遗漏其后续 rejection） */
function raceAbort<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
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

  /** 单次执行：审批决策 → deny 短路 → 超时组合 → 执行 → 统一 {ok, output?, error?, durationMs} */
  async execute(req: ToolExecutionRequest, env: ExecutionEnv): Promise<ToolResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const def = this.registry.get(req.tool);
    if (!def) return { ok: false, error: `unknown tool: ${req.tool}`, durationMs: elapsed() };

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

    // 超时信号与外部取消信号组合（AbortSignal.timeout 的定时器不阻塞事件循环退出）
    const signal =
      def.timeoutMs !== undefined ? AbortSignal.any([env.signal, AbortSignal.timeout(def.timeoutMs)]) : env.signal;

    let out: ToolOutput;
    try {
      out = await raceAbort(signal, Promise.resolve(def.execute(req.args, { signal, cwd: env.cwd })));
    } catch (e) {
      const err = e as Error;
      let error = err?.message ?? String(err);
      if (env.signal.aborted) error = 'cancelled';
      else if (signal.aborted) error = `tool timeout after ${def.timeoutMs}ms`;
      return { ok: false, error, durationMs: elapsed() };
    }
    return { ok: out.error === undefined, output: out.output, error: out.error, durationMs: elapsed() };
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
            return { callId: item.callId, ok: false, error: `lockKey callback threw: ${errorMessage(e)}`, durationMs: 0 };
          }
          const run = async (): Promise<ExecutedToolResult> =>
            ({ ...(await this.execute(item, env)), callId: item.callId });
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
