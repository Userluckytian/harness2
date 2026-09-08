// Agent loop 类型：一次用户 turn 的执行选项与结果。
import type { ChatProvider, ToolCallRequest } from '../provider/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';
import type { SnapshotStore } from '../session/snapshots.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ApprovalHandler } from '../tools/types.js';
import type { ExecutionLifecycleObserver } from '../tools/executor.js';
import type { SteerRequest, SteerResult } from '../interaction/types.js';

/**
 * S6 控制输入（steer）通道。外部实现把绑定到某 turn 的 steer 塞进队列；loop 在每个
 * 安全 step 边界消费一个 `take()`，并把结果经 `resolve()` 回帧（ack）——调用方不得丢。
 * 语义由 loop：只有 `expectedTurnId === 当前 turnId` 才接受；同 id 只生效一次。
 * steer 是控制输入：只在下一 step 的请求上叠加一条 control user 消息，**不写入
 * session.log**（不进投影、不污染 user/message 正文）。模型可见输入 = 日志投影 + 单次
 * 控制叠加（文档化取舍，见 task-S6-report）。
 */
export interface SteerSink {
  /** 出队一个待应用的 steer（仅当 loop 处于可应用边界才调用）；无 → undefined */
  take(): SteerRequest | undefined;
  /** 上报一次 steer 处理结果（accepted/stale/rejected），调用方据此发 ack 回帧；不丢 */
  resolve(result: SteerResult): void;
}

/** 一条已应用 steer 的 id（供 loop 内最近一步判断用）；不落盘 */
export interface AppliedSteerRecord {
  id: string;
  text: string;
}

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

/**
 * 上下文压缩选项（阶段 7，Task 1）。提供时 runTurn 在每个 turn 开始检查触发：
 * 活动消息估算 token（字符/4）> contextWindow × 0.75 → 摘要 → append compaction/applied。
 * 不提供 = 零压缩行为（cron/subagent 等短生命周期会话无需装配）。
 */
export interface CompactionOptions {
  /** 触发阈值分母（roles.main 模型容量声明；缺省 128k） */
  contextWindow?: number;
  /** 摘要 provider（roles.small）；缺省 = 本 turn 的主 provider */
  summarizer?: ChatProvider;
  /** 摘要最大字符数（缺省 2000） */
  maxSummaryChars?: number;
}

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
  /**
   * 可选：项目/全局 Skills（阶段 10）。提供时 turn 开始扫描两级目录（项目
   * .harness2/skills/ > 全局 ~/.harness2/skills/，同名覆盖 + 告警；上限 50），把
   * 「[Skills 可用] 名称: 描述」列表追加进 ChatRequest.system（每 turn 重扫磁盘——
   * 项目文件可中途新增；同一 turn 内冻结，与 memory 快照同款 prefix cache 语义）。
   * 全文不进 system：模型经 skill 工具按需加载（工具由装配层注册）。
   * 空 skills = 零注入；扫描告警并入 TurnResult.warning。
   */
  skills?: SkillStore;
  /**
   * 可选：上下文压缩（阶段 7）。提供时 turn 开始（user/message 落盘后、首个 step 前）
   * 检查触发：估算超阈值 → 摘要 → append compaction/applied 事件；摘要失败不落事件、
   * 本轮跳过（TurnResult.warning 告知），turn 不中断。
   */
  compaction?: CompactionOptions;
  /**
   * 可选：工具执行生命周期观察（S1）。透传给 ToolExecutor 的 env.observer——
   * 真正启动才 onExecuteStart，每个提交调用终态回调一次 onExecuteEnd（含未启动的取消/拒绝）。
   * 供 S3 delivery 的 callId 状态、S7 toolExecutionView 使用；纯观察，不落第二套日志。
   */
  executionObserver?: ExecutionLifecycleObserver;
  /**
   * 可选：S6 控制输入（steer）通道。提供时 loop 在每个安全 step 边界消费一个 steer：
   *   - 只接受 expectedTurnId === 本 turnId 的 steer（其余 stale 拒绝 + draftKept）；
   *   - 同 steer id 只生效一次（重复 → rejected，不双注入）；
   *   - 上一步执行了 must-complete（cancelGuaranteed:false）工具时，steer 排队等干净边界
   *     （不强行另开 step、不打断 provider 当前流）；
   *   - 接受的 steer 作为**控制输入**叠加在下一 step 请求末尾（一条 user 控制消息），
   *     不写入 session.log（不进投影，不伪造 user/message 正文）。
   * 不提供 = 零 steer 行为（既有 loop 路径完全不变）。
   */
  steer?: SteerSink;
}

/** turn 内流式观察事件（onStream 回调 payload；纯渲染缝，非模型上下文来源）。
 *  turnId = 本 turn 的真实 id（loop 单点生成，落盘 user/message 等事件同源）——
 *  S3c2 复用为 delta 展示投影归属，保证增量帧与重放事件可对上同一 turn。 */
export type TurnStreamEvent =
  | { type: 'text-delta'; text: string; turnId: string }
  | { type: 'reasoning-delta'; text: string; turnId: string }
  | { type: 'tool-call'; call: ToolCallRequest; turnId: string }
  | { type: 'tool-result'; callId: string; ok: boolean; error?: string; turnId: string };

export interface TurnResult {
  stopReason: TurnStopReason;
  /** 已执行的 step 数（模型调用次数） */
  steps: number;
  /** 已提交执行器的工具调用数 */
  toolCalls: number;
  durationMs: number;
  /** 本 turn 的真实 id（与 user/message 等落盘事件同源；S3c2 展示投影归属用） */
  turnId?: string;
  /** end_turn 时的最终 assistant 文本 */
  finalText?: string;
  /** error/cancelled 时的错误摘要 */
  error?: string;
  /** 非致命告警（如 provider 请求暂停续跑 paused）：turn 正常返回，调用方应向用户展示 */
  warning?: string;
}
