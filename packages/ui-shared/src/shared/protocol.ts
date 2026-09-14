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
  | { op: 'approval-response'; requestId: string; decision: 'allow' | 'deny' }
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
    };

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
