// 跨壳线协议（wire contract）：serve WS/HTTP 帧形状 + 冻结交互契约（S0/S3/S7 镜像）。
//
// 归属：本文件是 **desktop / web（以及未来的壳）共用** 的唯一类型事实源 —— 形状与 core
// `packages/core/src/server/ws.ts` / `interaction/types.ts` / `server/http.ts` 同形（加性同步），
// 但**不 import core**（浏览器壳零 Node）。桌面壳的 IPC / 设置 / 模型配置形状不在这里
// （见 `packages/desktop/src/shared/protocol.ts`，它把本文件的名字 type-only 再导出）。
//
// 冻结口径（`docs/API-STABILITY.md`）：
//   - `turn-end.textOutcome` 在 core 端恒发（必填）；跨壳镜像声明为**可选**，仅为兼容旧版
//     serve 实例（缺失时按 finalText/partialText 推断）。这是明示并接受的差异，不要「顺手修齐」。

// —— 连接状态（壳 → 角标） ——

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface StatusDetail {
  port?: number;
  attemptsLeft?: number;
  error?: string;
}

// —— 服务事件帧（core WS 事件面同形） ——

export interface ToolCallShape {
  id: string;
  name: string;
  arguments: string;
}

export type WsFrame =
  | { type: 'delta'; sessionId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'delta'; sessionId: string; kind: 'tool'; call: ToolCallShape }
  | { type: 'event'; sessionId: string; event: SessionEventShape }
  | {
      type: 'turn-end';
      sessionId: string;
      stopReason: string;
      /** P3-a：完整最终文本（textOutcome='final'） */
      finalText?: string;
      /** P3-b：半截 attempt 文本（textOutcome='partial'；展示须标注未完成） */
      partialText?: string;
      /** P3-a/P3-b：终态文本展示判别（与 core WS 帧同契约） */
      textOutcome?: 'final' | 'partial' | 'empty';
      error?: string;
      warning?: string;
    }
  | {
      type: 'approval-request';
      sessionId: string;
      tool: string;
      args: unknown;
      requestId: string;
      /** once=一次性 / session=「本会话总是」（框定 sessionId；跨 session 卡片会被策略层拒收） */
      scope?: ApprovalScopeShape;
      /** 过期时刻 ISO；迟到将被拒（客户端据此计时自弃） */
      expiresAt?: string;
      /** 卡片归属会话 cwd（工具执行基于它） */
      cwd?: string;
      /** 任务分组链路（加性字段；旧 serve 不发时为 undefined） */
      taskId?: string;
      parentTaskId?: string;
    }
  | { type: 'error'; error: string }
  // —— S0/S3 冻结契约镜像（core server/ws.ts WsServerMessage 同形；加性同步，旧 serve 不发） ——
  /** 带水位的文本增量：chunkOffset 单调，续块 = 上一块 offset + 该块文本长度 */
  | {
      type: 'text-delta';
      sessionId: string;
      turnId: string;
      attemptId: string;
      chunkOffset: number;
      text: string;
    }
  | {
      type: 'reasoning-delta';
      sessionId: string;
      turnId: string;
      attemptId: string;
      chunkOffset: number;
      text: string;
    }
  /** 单次 attempt 终态（含半截文本；attemptId 归属明确） */
  | {
      type: 'attempt-final';
      sessionId: string;
      turnId: string;
      attemptId: string;
      state: AttemptFinalStateShape;
      finalText?: string;
      error?: string;
    }
  /** 重订阅快照：在途 attempt / 任务 / 待批 / 队列一次补齐（epoch 旧值丢弃） */
  | { type: 'resume-snapshot'; sessionId: string; epoch: number; snapshot: ResumeSnapshotShape }
  /** 取消三态 ack：stopping=已受理 / cancelled=确认已取消 / unknown=连接不明 */
  | { type: 'cancel-ack'; requestId: string; state: CancelAckStateShape }
  /** 提交幂等 ack：unknown ≠ rejected（调用方不得把 unknown 当拒绝） */
  | {
      type: 'submit-ack';
      clientMessageId: string;
      sessionId: string;
      state: SubmitAckStateShape;
      reason?: string;
      queueSeq?: number;
    }
  | { type: 'forked'; sessionId: string; parentSession: string; copiedEvents: number }
  | { type: 'nudge-started'; sessionId: string }
  | {
      type: 'nudge-finished';
      sessionId: string;
      stopReason: string;
      toolCalls: number;
      /** ask 模式下本次复盘新增暂存的待审批条数 */
      staged: number;
      error?: string;
    }
  /**
   * cron 通知帧（core server/ws.ts WsServerMessage 同形镜像）：**广播全部连接、无会话归属**
   * （core ws.ts「cron 通知帧广播：不按会话订阅过滤，投递全部连接」）。漏镜像时它会被
   * 当作会话帧落到 ensureStream(frame.sessionId = undefined) → undefined 幽灵流（审查 P2）。
   */
  | { type: 'cron'; op: 'finished'; id: string; ok: boolean; error?: string }
  // —— Z9-2（2026-10-13）终端帧（server→client；冻结契约见阶段计划 §1.2）——
  // 终端会话**连接私有**：仅创建它的连接收到 opened/data/exit；连接断开即全杀。
  // 生成/退出/错误一律如实回传，UI 不得把 terminal/error 画成成功。
  /** spawn 成功（requestId 回带；id = 连接内终端句柄） */
  | { type: 'terminal/opened'; requestId: string; id: string }
  /** PTY 输出（该终端归属连接独收） */
  | { type: 'terminal/data'; id: string; data: string }
  /** PTY 退出（id 此后失效；exitCode 缺省 = 平台未提供） */
  | { type: 'terminal/exit'; id: string; exitCode?: number }
  /** 终端错误（open 失败带 requestId；input/resize/close 未知或跨连接带 id）——如实失败 */
  | { type: 'terminal/error'; requestId?: string; id?: string; error: string }
  /**
   * 本地回传帧（非服务帧）：系统通知被点击 → 壳聚焦窗口并把该帧推给呈现层，
   * 据此 selectSession 跳转（桌面走既有 IPC 通道，无需新建）。
   */
  | { type: 'notify/click'; sessionId: string };

/** 会话事件（core session/types.ts 同形；呈现层只需最小字段） */
export interface SessionEventShape {
  v: 1;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

// —— 会话事件 payload 形状（Z3-07 加性镜像；core session/types.ts 同形） ——
// 线上 `SessionEventShape.payload` 仍是 Record<string, unknown>（旧 serve 兼容，不加宽）；
// 这里只给呈现层投影用到的三种事件**具名形状**（收窄读取 + 文档化），缺字段一律按
// 缺省处理、不臆造。event 帧（live）与 /events 重放两条路共用同一形状。

/** `compaction/applied`：上下文压缩边界（覆盖区摘要 + 覆盖到的最后一条消息 seq） */
export interface CompactionAppliedPayloadShape {
  summary: string;
  coveredUpToSeq: number;
}

/** `rewind/marker`：回退标记（追加式撤回；reason 'redo' 前缀 = redo 链中立化语义） */
export interface RewindMarkerPayloadShape {
  rewindToSeq: number;
  reason?: string;
}

/** `assistant/attempt`：失败/被取消的模型尝试（append-only；text = 半截产出时展示须标注未完成） */
export interface AssistantAttemptPayloadShape {
  error: string;
  text?: string;
  model?: string;
  turnId?: string;
}

// —— HTTP 报文（呈现层消费的最小形态） ——

export interface SessionSummaryShape {
  id: string;
  dir: string;
  cwd?: string;
  mtimeMs: number;
  firstUserText: string;
  messageCount: number;
  lastSeq: number;
}

export interface SessionEventsPayloadShape {
  id: string;
  dir: string;
  header: { sessionId: string; cwd?: string; createdAt?: string } | null;
  events: Array<SessionEventShape & { active: boolean }>;
  warnings: string[];
  lastSeq: number;
}

export interface UndoRedoResponseShape {
  results: Array<{
    kind: string;
    dryRun: boolean;
    markerSeq: number;
    rewindToSeq: number;
    messages: number;
    files: Array<{ file: string; target: string | null; externallyModified: boolean }>;
  }>;
  error?: string;
}

/** 指定 tool/call 事件 seq 对应的文件快照读取结果（读 `rewind_points.jsonl` 单条） */
export interface SnapshotForCallShape {
  ok: boolean;
  /** 命中条目（seq 匹配的 tool/call 快照） */
  entry?: { file: string; before: string | null; after: string | null };
  /** 未命中 / 读取失败 / 参数非法时的一行错误 */
  error?: string;
}

/** `@path` 引用读取结果（与桌面 preload `readFileForRef` 同形；壳各自注入实现） */
export interface FileRefReadResultShape {
  ok: boolean;
  content?: string;
  truncated?: boolean;
  error?: string;
  /**
   * 失败归因（P2-3，加性可选）：`'not-found'` = 文件确实不存在；
   * `'unavailable'` = 读取通道缺失/不可用/读取失败（文件可能存在）。
   * 旧实现未标注时按 `'not-found'` 处理，既有读取通道契约与文案不变。
   */
  reason?: 'not-found' | 'unavailable';
}

// —— S0/S3/S7 冻结契约镜像（core interaction/* 同形；core 冻结后只能加性同步） ——
//
// 说明：core 的 `textOutcome` 在 turn-end 帧恒发（必填），本镜像声明为可选——这是 API-STABILITY.md
// 「跨端展示语义」节明示并接受的差异（兼容旧版 serve 实例），不要「顺手修齐」。

export type AttemptFinalStateShape = 'completed' | 'failed' | 'cancelled' | 'unknown';
export type SubmitAckStateShape = 'accepted' | 'rejected' | 'unknown';
export type CancelAckStateShape = 'stopping' | 'cancelled' | 'unknown';
export type QueueItemStateShape = 'queued' | 'paused';
export type SubmitIntentShape = 'queue' | 'steer';
export type ApprovalScopeShape = { mode: 'once' } | { mode: 'session'; sessionId: string };
/** Z10-5 审批决定五态（与 core ApprovalResponseDecision 同值域；跨壳 UI 复用同一名字） */
export type ApprovalDecisionShape = 'allow' | 'allow-session' | 'allow-always' | 'deny' | 'deny-always';
export type TaskStateShape =
  | 'registered'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting-approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface MessageReferenceShape {
  id: string;
  kind: 'file' | 'clipboard' | 'url';
  path?: string;
  text?: string;
  url?: string;
  range?: { start: number; end: number };
}

export interface TaskContractShape {
  taskId: string;
  parentTaskId?: string;
  /** background:true 注册后立即返回 handle（status/wait/continue/cancel 分离） */
  background: boolean;
  state: TaskStateShape;
  expectedTurnId?: string;
  updatedAt?: string;
}

/**
 * P0-3a：定时任务（cron）形状。与 `@harness2/core` 的 `cron/jobs.ts CronJob` **同形**（字段一一对应），
 * 但刻意放在**跨壳线协议**里（此处浏览器壳零 Node，不 import core）。桌面主进程读本地 `jobs.json`
 * （用 core 的同一 `CronJobStore.list()`）后投影为本形状，经 IPC `cron:list` 送出给右栏「自动化」tab。
 * `deliver`（投递目标）属执行细节、右栏列表不展示，故不入形状。可选字段用 `?: T | undefined`
 * （exactOptionalPropertyTypes 严格模式下与 core 口径一致）。
 */
export interface CronJobShape {
  /** 任务 id */
  id: string;
  /** 发给模型的指令（cron 执行 = 以此为 user turn 起独立临时会话） */
  instruction: string;
  /** 调度表达式（interval "5m" / "daily HH:MM" / "weekly <dows> HH:MM"，见 core jobs.ts） */
  schedule: string;
  /** 下次应执行时间（ISO8601 UTC） */
  nextRun: string;
  /** 是否启用（core 熔断时置 false） */
  enabled: boolean;
  /** 连续失败计数（成功归零；≥3 熔断 enabled=false） */
  failCount: number;
  /** 创建时间（ISO8601） */
  createdAt: string;
  /** 上次执行时间（缺省 = 从未跑过） */
  lastRunAt?: string | undefined;
  /** 上次错误摘要（缺省 = 无） */
  lastError?: string | undefined;
}

export interface AttemptSnapshotShape {
  attemptId: string;
  turnId: string;
  textChunkOffset: number;
  reasoningChunkOffset: number;
  status: 'running' | 'waiting-approval' | 'unknown';
  /** 本 turn 的代次（重连快照据此发正确代次的 cancel） */
  generation?: number;
}

export interface QueueEntryShape {
  /** 幂等键 = 提交时的 clientMessageId */
  id: string;
  revision: number;
  rawText: string;
  references?: MessageReferenceShape[];
  intent: SubmitIntentShape;
  state: QueueItemStateShape;
}

export interface ResumeSnapshotShape {
  epoch: number;
  replay: { fromSeq: number; toSeq: number };
  activeAttempt?: AttemptSnapshotShape;
  tasks: TaskContractShape[];
  pendingApprovals: Array<{
    requestId: string;
    sessionId: string;
    parentTaskId?: string;
    taskId?: string;
    tool: string;
    args: unknown;
    cwd?: string;
    scope: ApprovalScopeShape;
    expiresAt: string;
  }>;
  queue: QueueEntryShape[];
}

/** WsFrame 之外的客户端→服务端操作（与 core WsClientMessage 同形；经 WS 发送） */
export type WsClientOp =
  | { op: 'subscribe'; sessionId: string }
  | { op: 'unsubscribe'; sessionId: string }
  | { op: 'abort'; sessionId: string }
  | { op: 'user-message'; sessionId: string; text: string }
  | {
      op: 'approval-response';
      requestId: string;
      /**
       * Z10-5 加性五态（与 core `interaction/types.ts` ApprovalResponseDecision 同值域）：
       * allow/deny 一次性；allow-session 本会话内该工具不再问；
       * allow-always/deny-always 全局（写 config.approval.tools；跨会话/重启生效）。
       */
      decision: ApprovalDecisionShape;
    }
  | { op: 'fork'; sessionId: string; atSeq?: number }
  | { op: 'resume-subscription'; sessionId: string; lastSeq: number; epoch: number }
  | {
      op: 'cancel';
      requestId: string;
      target: { kind: 'turn' | 'task'; id: string };
      expectedId?: string;
      expectedTurnGeneration?: number;
    }
  | {
      op: 'submit';
      clientMessageId: string;
      sessionId: string;
      rawText: string;
      intent: SubmitIntentShape;
      references?: MessageReferenceShape[];
      expectedTurnId?: string;
    }
  // —— Z9-2（2026-10-13）终端帧（client→server；冻结契约见阶段计划 §1.2）——
  // 冻结契约 §1.2 以「终端/动词」命名；并入本联合（WsClientOp / core WsClientMessage 同形）
  // 时判别字段沿既有客户端帧的 `op`（服务端帧仍为 `type`）。字段名与形状逐字同 §1.2。
  /** 请求创建终端（cols/rows 必填；cwd 缺省 = serve 进程 cwd） */
  | { op: 'terminal/open'; requestId: string; cols: number; rows: number; cwd?: string }
  /** 向终端写入用户输入 */
  | { op: 'terminal/input'; id: string; data: string }
  /** 终端视口尺寸变化（xterm fit） */
  | { op: 'terminal/resize'; id: string; cols: number; rows: number }
  /** 关闭终端（kill 归属 PTY） */
  | { op: 'terminal/close'; id: string };

// —— S7 只读查询端点镜像（serve GET /api/sessions/:id/{run-config,plan-state,execution-view,change-review}） ——

export type EffectiveConnectionStatusShape = 'connected' | 'disconnected' | 'unknown';

/** 有效运行配置只读视图（脱敏；同一次 run 内不被后续异步变化改写） */
export interface EffectiveRunConfigShape {
  session: { sessionId: string; root: string; cwd: string; perSessionCwd: boolean };
  provider: {
    role: string;
    channel: string;
    model: string;
    protocol: 'openai' | 'anthropic';
    name: string;
  };
  approval: { mode: string; tools: Record<string, 'allow' | 'ask' | 'deny'> };
  modes: { memory: string };
  tools: string[];
  connection: { status: EffectiveConnectionStatusShape };
  instructions: { skills: Array<{ name: string; source: 'project' | 'global' }> };
  context: {
    contextWindow?: number;
    maxOutputTokens?: number;
    retry: {
      maxExtraAttempts: number;
      backoffSeconds: number[];
      maxExtraPerTurn: number;
      maxTotalWaitSeconds: number;
      budget?: {
        usedAttempts: number;
        remainingAttempts: number;
        waitMs: number;
        remainingWaitMs: number;
        maxExtraAttempts: number;
        maxWaitMs: number;
        stopReason: string;
      };
    };
  };
  snapshot: { revision: number; capturedAt: string; effectiveAt: string };
  redacted: true;
}

/** 计划状态只读投影（可指回 journal seq 与 user/message 事件，不臆造） */
export interface PlanStateShape {
  planId: string;
  goal: string;
  goalEvidence?: {
    source: 'user-message';
    seq: number;
    ts: string;
    anchor: { kind: 'session-log-seq'; seq: number } | { kind: 'journal-ts'; ts: string };
  };
  steps: Array<{
    stepId: string;
    state: TaskStateShape;
    evidence: { source: 'runtime-journal'; taskId: string; journalSeqs: number[] };
  }>;
  readOnly: true;
  sourceDir: string;
}

export type ToolExecutionStatusShape = 'not-executed' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';
export type ToolExecutionCommandSourceShape = 'executed' | 'planned-only' | 'none';
export type ToolExecutionExitCodeSourceShape = 'bash-error' | 'bash-ok' | 'none';

/** 工具/命令执行只读视图：真实 shell 与 exitCode 归属清楚（未执行不虚构） */
export interface ToolExecutionViewShape {
  callId: string;
  taskId?: string;
  turnId?: string;
  tool: string;
  args: unknown;
  plannedCommand?: string;
  actualCommand?: string;
  commandSource: ToolExecutionCommandSourceShape;
  cwd: string;
  shell?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  outputRef: string;
  outputTruncated: boolean;
  exitCode?: number;
  exitCodeSource: ToolExecutionExitCodeSourceShape;
  status: ToolExecutionStatusShape;
  error?: string;
  readOnly: true;
}

/** 变更审查只读视图（区分拟议 diff 与真实落盘；外部改动 dirty 标记） */
export interface ChangeSetShape {
  sourceDir: string;
  files: Array<{
    file: string;
    planned: { before: string | null; after: string | null };
    current: string | null;
    lastKnown: string | null;
    dirty: boolean;
    matchesPlan: boolean;
  }>;
  changedFiles: number;
  dirtyFiles: number;
  readOnly: true;
}

/** undo/redo 前比对报告（外部修改不静默覆盖） */
export interface UndoRedoCompareShape {
  kind: 'undo' | 'redo';
  scopeSeq: number;
  items: Array<{
    file: string;
    expected: string | null;
    current: string | null;
    target: string | null;
    externallyModified: boolean;
  }>;
  externalModifications: number;
  requiresUserDecision: boolean;
  readOnly: true;
}

// —— 能力盘点（D0）：把「后端真实具备什么」如实投影为可行动的能力表 ——

export type CapabilityStatusShape = 'available' | 'unavailable';

export type CapabilityIdShape =
  | 'serve'
  | 'run-config'
  | 'plan-state'
  | 'execution-view'
  | 'change-review'
  | 'queue'
  | 'steer'
  | 'cancel'
  | 'fork'
  | 'resume-subscription';

export interface CapabilityEntryShape {
  id: CapabilityIdShape;
  status: CapabilityStatusShape;
  /** unavailable 时的可行动原因（一句话；UI 据此 disabled + 解释，不摆假入口） */
  reason?: string;
}

export interface CapabilityReportShape {
  /** probe 时点 ISO */
  probedAt: string;
  entries: CapabilityEntryShape[];
}
