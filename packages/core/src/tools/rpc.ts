// H-43 零开销轮次的 core 侧 RPC 服务（P7-C，本阶段优先级最高的一条）。
//
// 问题：模型逐次调工具时，每一步的工具结果都会作为 tool 消息进入下一次请求的上下文
// （loop.ts 的「Model-visible ⟺ logged」投影），一次 3 步的工具链会把 3 份完整结果都
// 灌进 prompt，token 成本线性叠加。
//
// 解法：给脚本一个直连工具的 RPC 通道。脚本在通道里**多次**调工具、自己做过滤/聚合，
// 只有脚本的最终返回值进入模型上下文——中间结果从不进 prompt。这就是 hermes 的
// 「零开销轮次」（Python 脚本经 RPC 直调工具）。
//
// 统一到既有的执行器上（不另建执行路径）：
//   - 审批：复用 ToolExecutor 的 approval 管线（decide/onAsk），RPC 通道**不得绕过审批**；
//   - 白名单：服务只认传入的 registry——已被 tools 配置剔除的工具在这里就是 `unknown tool`；
//   - 超时：服务级 timeoutMs（缺省 30s）合并外部 signal，超时中止工具并返回明确错误；
//   - 输出上限：maxOutputChars（缺省 100000）截断并标记 truncated，防脚本一次拉爆日志。
//
// 两处**不覆盖**（P1-3 如实声明，勿在此模块里假称覆盖）：
//   - 内层 write/edit 的文件改动不进 undo 快照（无 tool/call 事件 seq 作快照键）→ /undo 不可恢复；
//   - 内层调用不进会话日志与执行观察面（只有外层 run_script 这一次调用有 tool/call+result）。
//
// 传输层与协议无关：本模块只定义请求/响应与服务；换行分隔 JSON 的 stdio 协议见 rpc-stdio.ts。
import { ToolExecutor } from './executor.js';
import { classifyTool, toolSource, type ToolCategory, type ToolSource } from './inventory.js';
import type { ToolRegistry } from './registry.js';
import type { ApprovalHandler } from './types.js';

/** RPC 方法名（脚本可见的协议面） */
export const TOOL_RPC_METHODS = ['tools.list', 'tools.describe', 'tool.call'] as const;
export type ToolRpcMethod = (typeof TOOL_RPC_METHODS)[number];

/** 请求（id 由调用方给，响应原样回带；便于脚本并发调度） */
export interface ToolRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

/** 响应：失败也是**协议内**的正常回复（不抛错），脚本据此分支 */
export type ToolRpcResponse =
  { id: string | number; ok: true; result: unknown } | { id: string | number; ok: false; error: string };

/** 工具描述（脚本 tools.list / tools.describe 的返回条目） */
export interface ToolRpcToolInfo {
  name: string;
  description: string;
  category: ToolCategory;
  source: ToolSource;
  concurrencySafe: boolean;
}

/** 单次工具调用结果（结构化；与 tool/result 事件同形但**不落会话日志**） */
export interface ToolRpcCallResult {
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  /** true = 输出超过 maxOutputChars 被截断 */
  truncated?: boolean;
}

export interface ToolRpcServiceOptions {
  /** 允许被调用的工具面（已按 tools 配置过滤；服务不再二次裁剪） */
  registry: ToolRegistry;
  /** 工具执行工作目录（与宿主 turn 同源） */
  cwd: string;
  /** 审批缝（与宿主同源；缺省 allow-all，与执行器一致） */
  approval?: ApprovalHandler;
  /** 单次调用超时 ms（缺省 30000；<=0 或非有限值按缺省） */
  timeoutMs?: number;
  /** 单次调用输出字符上限（缺省 100000；<=0 或非有限值按缺省） */
  maxOutputChars?: number;
}

/** 服务级缺省值（导出供测试与文档引用） */
export const TOOL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
export const TOOL_RPC_DEFAULT_MAX_OUTPUT_CHARS = 100_000;

/** 每次调用的可选覆盖（脚本工具把宿主 turn 的取消信号透传进来） */
export interface ToolRpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 调用级取消原因（用于把「外部取消」与「服务超时」区分开，错误文案不混淆） */
class ToolRpcTimeoutError extends Error {}

export class ToolRpcService {
  private readonly registry: ToolRegistry;
  private readonly cwd: string;
  private readonly approval: ApprovalHandler | undefined;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(options: ToolRpcServiceOptions) {
    this.registry = options.registry;
    this.cwd = options.cwd;
    this.approval = options.approval;
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : TOOL_RPC_DEFAULT_TIMEOUT_MS;
    this.maxOutputChars =
      options.maxOutputChars !== undefined && Number.isFinite(options.maxOutputChars) && options.maxOutputChars > 0
        ? Math.floor(options.maxOutputChars)
        : TOOL_RPC_DEFAULT_MAX_OUTPUT_CHARS;
  }

  /** 可调用工具清单（脚本用它决定调什么；顺序 = 注册顺序） */
  list(): ToolRpcToolInfo[] {
    return this.registry.list().map((def) => ({
      name: def.name,
      description: def.description,
      category: classifyTool(def.name),
      source: toolSource(def.name),
      concurrencySafe: def.concurrencySafe === true,
    }));
  }

  /** 单个工具详情；未注册（含被 tools 配置剔除）返回 undefined */
  describe(name: string): ToolRpcToolInfo | undefined {
    return this.list().find((t) => t.name === name);
  }

  /**
   * 调用一个工具：复用 ToolExecutor（审批 → 取消前置门 → 参数自纠 → 超时 → 执行），
   * 结果**结构化返回给脚本**，不写会话日志、不进模型上下文。
   */
  async call(name: string, args: unknown, options: ToolRpcCallOptions = {}): Promise<ToolRpcCallResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'tool.call: name 必须是非空字符串', durationMs: elapsed() };
    }
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : this.timeoutMs;

    // 取消 + 服务超时合并成执行器看得懂的单一信号；超时用自有错误标记，便于区分文案
    const ac = new AbortController();
    let timedOut = false;
    const external = options.signal;
    const onExternalAbort = (): void => ac.abort(external?.reason ?? new Error('aborted'));
    if (external !== undefined) {
      if (external.aborted) onExternalAbort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new ToolRpcTimeoutError(`rpc timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      const executor = new ToolExecutor(this.registry, this.approval);
      const result = await executor.execute(
        { callId: `rpc-${Math.random().toString(36).slice(2, 10)}`, tool: name, args: args ?? {} },
        { signal: ac.signal, cwd: this.cwd },
      );
      if (timedOut) {
        return { ok: false, error: `tool.call 超时（>${timeoutMs}ms）: ${name}`, durationMs: elapsed() };
      }
      return this.capResult(result, elapsed());
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** 输出上限截断（output 与 error 都受限；error 顺带上限防巨型错误日志） */
  private capResult(
    result: { ok: boolean; output?: string; error?: string; durationMs: number },
    durationMs: number,
  ): ToolRpcCallResult {
    const cap = this.maxOutputChars;
    let truncated = false;
    let output = result.output;
    if (output !== undefined && output.length > cap) {
      output = `${output.slice(0, cap)}\n...[rpc 输出截断，原文 ${output.length} 字符]`;
      truncated = true;
    }
    let error = result.error;
    if (error !== undefined && error.length > cap) {
      error = `${error.slice(0, cap)}…（rpc 错误截断，原文 ${error.length} 字符）`;
    }
    return {
      ok: result.ok,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      durationMs,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** 协议入口：解析请求 → 分发 → 结构化响应（任何异常都收口为 ok:false，不抛给传输层） */
  async handle(request: ToolRpcRequest, options: ToolRpcCallOptions = {}): Promise<ToolRpcResponse> {
    const id = request?.id ?? 0;
    try {
      switch (request?.method) {
        case 'tools.list':
          return { id, ok: true, result: this.list() };
        case 'tools.describe': {
          const name = (request.params as { name?: unknown } | undefined)?.name;
          if (typeof name !== 'string' || name.trim() === '') {
            return { id, ok: false, error: 'tools.describe: params.name 必须是非空字符串' };
          }
          const info = this.describe(name);
          return info === undefined ? { id, ok: false, error: `未找到工具: ${name}` } : { id, ok: true, result: info };
        }
        case 'tool.call': {
          const params = request.params as { name?: unknown; args?: unknown; timeoutMs?: unknown } | undefined;
          const name = params?.name;
          if (typeof name !== 'string' || name.trim() === '') {
            return { id, ok: false, error: 'tool.call: params.name 必须是非空字符串' };
          }
          const callOptions: ToolRpcCallOptions = { ...options };
          if (typeof params?.timeoutMs === 'number') callOptions.timeoutMs = params.timeoutMs;
          const result = await this.call(name, params?.args ?? {}, callOptions);
          // 协议层 ok=true = 请求已被处理；工具本身成败在 result.ok（脚本据此分支）
          return { id, ok: true, result };
        }
        default:
          return {
            id,
            ok: false,
            error: `未知 RPC 方法: ${String(request?.method)}（可用：${TOOL_RPC_METHODS.join(', ')}）`,
          };
      }
    } catch (e) {
      return { id, ok: false, error: `rpc 处理失败: ${(e as Error)?.message ?? String(e)}` };
    }
  }
}
