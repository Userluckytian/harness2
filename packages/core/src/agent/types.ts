// Agent loop 类型：一次用户 turn 的执行选项与结果。
import type { ChatProvider } from '../provider/types.js';
import type { SnapshotStore } from '../session/snapshots.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ApprovalHandler } from '../tools/types.js';

/**
 * Turn 终止原因：end_turn/error/cancelled/max_steps 为 loop 自身状态；
 * length/content_filter/refusal/max_tokens 为 provider 白名单透传（P2-4，不再折叠为 end_turn）；
 * paused = provider 请求暂停（Anthropic pause_turn），续跑未实现（登记 OPEN.md）。
 */
export type TurnStopReason =
  | 'end_turn'
  | 'error'
  | 'cancelled'
  | 'max_steps'
  | 'length'
  | 'content_filter'
  | 'max_tokens'
  | 'refusal'
  | 'paused';

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
  /**
   * 可选：文件快照存储（决策 D6）。提供时 write/edit 工具执行前 capture、成功后
   * commitAfter（键 = tool/call 事件 seq）；失败/取消不记 after。bash/read 等工具
   * 不产生快照（bash 副作用不进快照，见 chat 帮助与 README 的如实声明）。
   */
  snapshots?: SnapshotStore;
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
  /** 非致命告警（如 provider 请求暂停续跑 paused）：turn 正常返回，调用方应向用户展示 */
  warning?: string;
}
