// SessionHub 对外契约类型（A4 拆分自 sessions.ts，纯搬运）：错误类型、hooks/装配选项、
// 事件载荷等只含类型与 HubError 的声明。实现见 sessions-core / sessions-assembly /
// sessions-turn / sessions-resume / sessions-tasks / sessions-approval，出口见 sessions.ts。
import { TaskCoordinator, type TaskWriteMode } from '../agent/task-coordinator.js';
import type { CompactionOptions, TurnResult } from '../agent/types.js';
import type { ApprovalConfig } from '../config/schema.js';
import type {
  ApprovalRequestContract,
  AttemptFinalFrame,
  DeliveryDeltaFrame,
  SteerResult,
} from '../interaction/types.js';
import type { NudgeResult } from '../memory/nudge.js';
import type { PendingMemoryStore } from '../memory/pending.js';
import type { MemoryStore } from '../memory/store.js';
import type { PluginBus } from '../plugins/bus.js';
import type { ChatProvider, ToolCallRequest } from '../provider/types.js';
import { SessionManager } from '../session/manager.js';
import type { LoadedEvent } from '../session/reader.js';
import type { AnySessionEvent, SessionHeaderPayload } from '../session/types.js';
import type { SkillStore } from '../skills/store.js';
import type { ToolExecutionRequest } from '../tools/executor.js';
import type { BrowserPool } from '../tools/predefined/browser.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ApprovalDecision, ApprovalInput, ToolResult } from '../tools/types.js';

export class HubError extends Error {
  constructor(
    readonly code: 'not_found' | 'locked' | 'busy' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

/** 流式增量（唯一允许的未落盘推送；与随后落盘的最终事件一致） */
export type TurnDelta =
  { kind: 'text'; text: string } | { kind: 'reasoning'; text: string } | { kind: 'tool'; call: ToolCallRequest };

/** S2 历史类型（API 面兼容保留）：审批上抛已升级为 ApprovalRequestContract（含 scope/expiresAt/cwd） */
export interface PendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  args: unknown;
}

export type ApprovalSettleReason = 'response' | 'timeout' | 'cancelled' | 'expired';

/** S7：provider 装配元数据（run-config 只读投影的装配来源；与 config.roles/providers 同源，非第二套配置存储） */
export interface SessionHubProviderMeta {
  role: string;
  channel: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  /** provider 标识（channel/model；与 ChatProvider.name 一致） */
  name: string;
}

/** hub 级记忆装配（阶段 6）：mode ≠ off 时由启动器注入；off 不传 = 零记忆行为 */
export interface SessionHubMemory {
  store: MemoryStore;
  mode: 'ask' | 'auto';
  /** 每 N 个用户 turn 触发一次后台复盘（模型调过 memory 工具的 turn 重置计数） */
  nudgeInterval: number;
  /** 复盘 provider（roles.small）；缺省 = 主 provider */
  reviewProvider?: ChatProvider;
  /** ask 模式暂存区；缺省 = store.root/pending */
  pending?: PendingMemoryStore;
}

/** hub 级 subagent 装配（阶段 8）：注入后每次 turn 按会话 id 重绑 subagent 工具（血缘/审批按子会话上抛） */
export interface SessionHubSubagent {
  /** 子会话 provider（roles.subagent 派生；缺省回退主 provider） */
  provider: ChatProvider;
  /** 深度上限（config.subagent.maxDepth；默认 1 = 子内无 subagent 工具） */
  maxDepth: number;
  /** 子会话单 turn 最大 step 数（config.subagent.maxTurns） */
  maxTurns: number;
  /** S5：subagent_start 是否注册为后台任务（走协调器只读 K=2 / 写串行；缺省 false = 同步 inline）。
   *  开启时 subagent_start 立返 taskId，不阻塞父 turn；subagent_continue 接 taskId 取 status/结果。 */
  backgroundTasks?: boolean;
  /** S5：后台子代理任务的资源型（仅 backgroundTasks 时生效；缺省 'write' = 子会话可能写文件）。 */
  taskWriteMode?: TaskWriteMode;
}

/** hub 级插件装配（阶段 8）：工具链已在共享注册表；这里只桥接事件总线（插件 on 订阅） */
export interface SessionHubPlugins {
  bus: PluginBus;
}

export interface SessionHubHooks {
  /** 落盘事件镜像（append 返回后同步回调；含 rewind/marker） */
  onEvent?(sessionId: string, event: AnySessionEvent): void;
  /** 流式增量（turn 进行中逐片回调；text/reasoning 与随后 assistant/message 一致） */
  onDelta?(sessionId: string, delta: TurnDelta): void;
  /** S3c2 带水位的增量帧（展示投影；与 onDelta 同源，但带真实 turnId + 合成 attemptId + chunkOffset） */
  onDeliveryDelta?(sessionId: string, frame: DeliveryDeltaFrame): void;
  /** S3c2 turn 落定帧（display 终态归属：completed/failed/cancelled；对应 attempt-final 帧） */
  onAttemptFinal?(sessionId: string, frame: AttemptFinalFrame): void;
  /** turn 结束（stopReason：end_turn/error/cancelled/max_steps/…） */
  onTurnEnd?(sessionId: string, result: TurnResult): void;
  /**
   * 审批上抛：进入待处理队列后回调。deliverTo = 送达链（自身会话 + 祖先父子会话）——
   * 父/子/孙订阅者都能收到该卡（child 审批在子会话结束前对父可见）。
   */
  onApprovalRequest?(approval: ApprovalRequestContract, deliverTo: string[]): void;
  /** 审批落定（响应/超时/取消；false = 按拒绝处理） */
  onApprovalSettled?(requestId: string, allowed: boolean, reason: ApprovalSettleReason): void;
  /** 后台复盘开始（turn-end 之后异步触发；提示帧，UI 自行决定展示） */
  onNudgeStarted?(sessionId: string): void;
  /** 后台复盘结束（产出 = 记忆写入或 pending 暂存；error 存在 = 复盘失败，主对话不受影响） */
  onNudgeFinished?(sessionId: string, result: NudgeResult): void;
  /** 工具执行生命周期（S1，S3 delivery / S7 toolExecutionView 消费；纯观察，不落第二套日志） */
  onExecuteStart?(sessionId: string, req: ToolExecutionRequest): void;
  onExecuteEnd?(sessionId: string, req: ToolExecutionRequest, result: ToolResult): void;
  /** S6 会话级 steer 回帧（loop 在安全 step 边界消费后 resolve；accepted/stale/rejected） */
  onSteerResult?(sessionId: string, result: SteerResult): void;
}

export interface SessionHubOptions {
  manager: SessionManager;
  provider: ChatProvider;
  tools: ToolRegistry;
  /** 工具执行 cwd + 新会话分组目录 */
  cwd: string;
  /** 策略决策缝（ask/allow/deny/auto/bypass 落这里；hub 缺省 ask——绝不静默允许） */
  decide?: (input: ApprovalInput) => ApprovalDecision;
  /** 审批等待超时 ms（默认 120_000；超时按拒绝处理） */
  approvalTimeoutMs?: number;
  /** 记忆装配（mode ≠ off 时注入；缺省 = 无记忆行为） */
  memory?: SessionHubMemory;
  /** 上下文压缩装配（阶段 7；缺省 = 不压缩）。由启动器按 roles.main 容量 + roles.small 摘要派生 */
  compaction?: CompactionOptions;
  /** 浏览器装配（阶段 7；config.browser.enabled 时注入）——按会话绑定池键注册 browser_* 工具 */
  browser?: { pool: BrowserPool };
  /** subagent 装配（阶段 8；config.subagent 派生）——按会话 id 绑定血缘的 subagent 工具 */
  subagent?: SessionHubSubagent;
  /** Skills 装配（阶段 10）——每次 turn 扫描两级目录并把列表追加进 system（skill 工具在共享注册表） */
  skills?: SkillStore;
  /** 插件装配（阶段 8）——插件事件订阅的桥接（emitSessionEvent） */
  plugins?: SessionHubPlugins;
  hooks?: SessionHubHooks;
  /** S5 后台任务协调器（缺省 = hub 内部单例；跨会话共享写锁 = 全局串行） */
  taskCoordinator?: TaskCoordinator;
  /** S7：provider 装配元数据（启动器从已加载 config 派生；缺省 = 注入 provider 的 name 推导，见 runConfigView） */
  providerMeta?: SessionHubProviderMeta;
  /** S7：审批策略装配来源（config.approval 同源；缺省 = default 空规则） */
  approvalConfig?: ApprovalConfig;
  /** S7：roles.main 模型容量元数据（config.providers.<channel>.models 派生；缺省不声明） */
  contextWindow?: number;
  /** S7：roles.main 模型 maxOutputTokens（config.providers.<channel>.models 派生；缺省不声明） */
  maxOutputTokens?: number;
}

export interface SessionEventsPayload {
  id: string;
  dir: string;
  header: SessionHeaderPayload | null;
  /** 日志顺序的全部事件（active = 当前投影内；影子事件 false，渲染必须过滤） */
  events: Array<LoadedEvent['event'] & { active: boolean }>;
  warnings: string[];
  lastSeq: number;
}
