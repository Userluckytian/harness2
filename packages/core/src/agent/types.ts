// Agent loop 类型：一次用户 turn 的执行选项与结果。
import type { ChatProvider } from '../provider/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ApprovalHandler } from '../tools/types.js';

export type TurnStopReason = 'end_turn' | 'error' | 'cancelled' | 'max_steps';

export interface TurnOptions {
  provider: ChatProvider;
  tools: ToolRegistry;
  /** 审批策略缝；缺省 allow-all（工具直接执行） */
  approval?: ApprovalHandler;
  /** 单 turn 最大 step 数（模型调用次数），默认 25 */
  maxSteps?: number;
  /** 外部取消信号（用户中断等） */
  signal?: AbortSignal;
  /** 工具执行的工作目录 */
  cwd: string;
  /**
   * 可选：本 turn 的用户消息文本。提供时 loop 先把它作为 user/message 事件追加进日志
   * 再开始循环——用户输入同样必须 logged（Model-visible ⟺ logged）。
   */
  userText?: string;
}

export interface TurnResult {
  stopReason: TurnStopReason;
  /** 已执行的 step 数（模型调用次数） */
  steps: number;
  /** 已提交执行器的工具调用数 */
  toolCalls: number;
  durationMs: number;
  /** end_turn 时的最终 assistant 文本 */
  finalText?: string;
  /** error/cancelled 时的错误摘要 */
  error?: string;
}
