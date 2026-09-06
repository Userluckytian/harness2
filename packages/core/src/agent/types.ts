// Agent loop 类型：一次用户 turn 的执行选项与结果。
import type { ChatProvider, ToolCallRequest } from '../provider/types.js';
import type { MemoryStore } from '../memory/store.js';
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
  provider: ChatProvider;  tools: ToolRegistry;
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
  /**
   * 可选：turn 内流式事件回调（CLI 渲染用，纯观察、不参与模型上下文组装）。
   * text-delta 随 provider 块逐片回调；tool-call 随 provider 块回调；
   * tool-result 在对应 tool/result 事件落盘后回调（含解析失败/拒绝/取消的失败结果）。
   */
  onStream?: (event: TurnStreamEvent) => void;
  /**
   * 可选：长期记忆 store（阶段 6）。装配层在 config.memory.mode ≠ off 时才提供——
   * off 模式不传本选项 = 零注入、零事件、零 store 读取。提供且本 turn 是用户 turn
   * （userText 提供）时：会话活动投影已有 memory/snapshot 事件 → 复用其 content 作为
   * ChatRequest.system（会话内冻结，不重读文件，保 prefix cache 语义）；没有则读 store
   * 组装快照、先落 memory/snapshot 事件再注入（老会话首个新 turn 即补快照）。
   * 两个记忆文件都为空 → 不注入不落事件。
   */
  memory?: MemoryStore;
}

/** turn 内流式观察事件（onStream 回调 payload；纯渲染缝，非模型上下文来源） */
export type TurnStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'tool-result'; callId: string; ok: boolean; error?: string };

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
