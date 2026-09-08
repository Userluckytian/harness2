// 工具系统契约：定义、上下文、执行结果与审批缝。
// 审批策略细化（分级/白名单）在阶段 3；本阶段只留 allow/deny/ask 回调缝。

/** 工具名约束：小写字母/数字/下划线 */
export const TOOL_NAME_PATTERN = /^[a-z0-9_]+$/;

/** 工具执行上下文：由执行器注入，工具实现不得自行另起信号源 */
export interface ToolContext {
  /** 外部取消信号（用户中断/turn 取消），与超时信号由执行器组合 */
  signal: AbortSignal;
  /** 工作目录：相对路径一律相对它解析 */
  cwd: string;
}

/** 工具实现返回值：error 存在即失败；意外异常由执行器兜底捕获 */
export interface ToolOutput {
  output?: string;
  error?: string;
}

/** 执行器统一结果（执行器负责计时与 ok 判定） */
export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface ToolDefinition {
  /** ^[a-z0-9_]+$ */
  name: string;
  description: string;
  /** JSON Schema 对象；无参数工具给 { type: 'object', properties: {} } */
  parameters: Record<string, unknown>;
  execute(args: unknown, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
  /** true = 可与其它调用并行执行（默认 false = 串行） */
  concurrencySafe?: boolean;
  /** 单次执行超时 ms（缺省不限时；由执行器与外部 signal 组合） */
  timeoutMs?: number;
  /**
   * 可选锁键：safe 并行批内同键调用彼此串行。
   * **Ph3 并发模型预留**：阶段 2 的 unsafe 调用独占执行（本就串行）不会消费本字段，
   * 因此 unsafe 工具（如 write/edit）不声明它；待 Ph3 引入新的并发模型时再启用。
   */
  lockKey?(args: unknown): string;
  /**
   * 可选：取消保证（S1）。声明 true = 工具一旦被外部取消（ctx.signal abort），
   * 执行器可以保证它及时停止（观察 signal 完成收尾 / 原子完成 / 进程树击杀）。
   * 声明后执行中取消的结果归一为 `cancelled`；**未声明**的第三方/黑盒工具在执行中
   * 被取消时无法保证是否已停止，取消结果归一为 `unknown`（UI 区分「已取消」与
   * 「取消未知」，见 tools/executor.ts）。
   */
  cancelGuaranteed?: boolean;
}

// ---- 审批缝（阶段 3 细化）----

export type ApprovalDecision = 'allow' | 'deny' | 'ask';

export interface ApprovalInput {
  tool: string;
  args: unknown;
}

export interface ApprovalHandler {
  /** 每次工具调用前的决策；缺省策略为 allow-all（无 handler 即放行） */
  decide(input: ApprovalInput): ApprovalDecision | Promise<ApprovalDecision>;
  /** decide 返回 'ask' 时的异步确认回调；返回 true 放行。未提供时 'ask' 按拒绝处理 */
  onAsk?(input: ApprovalInput): boolean | Promise<boolean>;
}

/** 默认策略：全部放行 */
export const allowAllApproval: ApprovalHandler = { decide: () => 'allow' };
