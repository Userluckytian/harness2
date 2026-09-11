// 桌面端共享协议：preload 暴露的 window.harness2 API、IPC 通道名与服务帧类型。
// 本文件是 main / preload / renderer 三方的唯一类型事实源；
// 服务帧类型按阶段 5 冻结契约（core server/ws.ts）同形复制——渲染进程零 Node、
// 不 import 任何 Node/核心模块，类型随构建擦除。
export const IPC_INVOKE = 'harness2:invoke';
export const IPC_EVENT = 'harness2:event';
export const IPC_STATUS = 'harness2:status';

// —— 连接状态（桌面壳 → 渲染端角标） ——

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
   * 本地回传帧（非服务帧）：系统通知被点击 → 主进程聚焦窗口并把该帧推给渲染端，
   * 渲染端据此 selectSession 跳转。走既有的 IPC_EVENT 通道，无需新建 IPC。
   */
  | { type: 'notify/click'; sessionId: string };

/** 会话事件（core session/types.ts 同形；渲染端只需最小字段） */
export interface SessionEventShape {
  v: 1;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

// —— HTTP 报文（渲染端消费的最小形态） ——

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

// —— 设置弹窗（B2）与后续任务的配置/偏好契约 ——

export type SettingsTheme = 'warmPaper' | 'dark' | 'system';
export type SettingsNotifyDetails = 'minimal' | 'full';

/** settings:getConfig 的响应（脱敏后的可用字段；与 CLI 共用同一份 config.json） */
export interface SettingsProviderShape {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  envKey?: string;
  models?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
}

export interface SettingsRoleShape {
  channel: string;
  model: string;
}

export interface SettingsConfigShape {
  providers: Record<string, SettingsProviderShape>;
  roles: Record<string, SettingsRoleShape>;
  approval: { mode: string; tools?: Record<string, string> };
  memory: { mode: string; nudgeInterval: number };
  browser: { enabled: boolean; idleDestroyMs: number; maxConcurrent: number };
  plugins: { enabled: boolean; allow: string[] };
  mcpServers: Record<string, unknown>;
  subagent: { maxDepth: number; maxTurns: number };
  gateways?: Record<string, unknown>;
  /** 全局/项目配置文件是否存在（供 UI 提示写哪份） */
  sources: { global: boolean; project: boolean };
  /** 校验告警（未知字段/缺省补全） */
  warnings: string[];
  /** 致命错误（config 解析失败时展示） */
  errors: string[];
}

/** auth.json 掩码视图（永不回显明文密钥） */
export interface SettingsAuthMaskedShape {
  channels: Array<{ channel: string; masked: boolean }>;
  gateways: Array<{ channel: string; maskedAppId: boolean; maskedAppSecret: boolean }>;
  /** 损坏时的一行错误（已脱敏） */
  error?: string;
}

/** 桌面偏好（读写 desktop-preferences.json；纯 UI 偏好，不进 config.json） */
export interface SettingsPreferencesShape {
  theme: SettingsTheme;
  defaultPaneCount: number;
  showWelcome: boolean;
  notifyDetails: SettingsNotifyDetails;
}

/** doctor 六项检查（core runDoctor 响应经 IPC 直传的最小形态） */
export interface SettingsDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  summary: string;
  details?: string[];
}

export interface SettingsDoctorReportShape {
  checks: SettingsDoctorCheck[];
  exitCode: 0 | 1;
}

export interface SettingsCrashReportShape {
  fileName: string;
  /** 文件修改时间戳（ISO） */
  mtime: string;
  size: number;
}

/** getContextUsage 响应（与终端 /context 同一数据源；value 为 0..1 或 null=未知） */
export interface ContextUsageShape {
  usage: number | null;
  /** 显示文本（如 "45%" 或 "—"） */
  label: string;
}

/** getSnapshotForCall 响应（读写 rewind_points.jsonl 单条；before/after null = 文件当时不存在） */
export interface SnapshotForCallShape {
  ok: boolean;
  /** 命中条目（seq 匹配的 tool/call 快照） */
  entry?: { file: string; before: string | null; after: string | null };
  /** 未命中 / 读取失败 / 参数非法时的一行错误 */
  error?: string;
}

/** 会话展示态覆层 entry（B3：desktop-metadata.json 单会话元数据；title/archived/deleted 均可选） */
export interface SessionMetadataEntryShape {
  title?: string;
  archived?: boolean;
  /** 删除隐藏标记（serve 无 delete API；仅覆层标记，事件数据仍在托管下） */
  deleted?: boolean;
}

/** metadata:get / metadata:set 的响应（整体覆层映射 sessionId → entry） */
export type SessionMetadataMapShape = Record<string, SessionMetadataEntryShape>;

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

/** 终态集合（与 core TASK_TERMINAL_STATES 同口径；进入即单调不回退） */
export const TASK_TERMINAL_STATES: ReadonlySet<TaskStateShape> = new Set([
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);

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

/** WsFrame 之外的客户端→服务端操作（bridge 经 WS 发送；与 core WsClientMessage 同形） */
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

// —— IPC 调用命令 ——

export type InvokeCommand =
  | { cmd: 'listSessions'; cwd?: string }
  | { cmd: 'createSession'; cwd?: string } // cwd 缺省 = 主进程 serve 的 --root
  | { cmd: 'events'; sessionId: string }
  | { cmd: 'undo'; sessionId: string; n?: number; dryRun?: boolean }
  | { cmd: 'redo'; sessionId: string }
  | { cmd: 'subscribe'; sessionId: string }
  | { cmd: 'unsubscribe'; sessionId: string }
  | { cmd: 'sendMessage'; sessionId: string; text: string }
  | { cmd: 'abort'; sessionId: string }
  | { cmd: 'respondApproval'; requestId: string; decision: 'allow' | 'deny' }
  | { cmd: 'loadLayout' }
  | { cmd: 'saveLayout'; layout: unknown }
  | { cmd: 'getStatus' }
  | { cmd: 'settings:getConfig' }
  | { cmd: 'settings:updateConfig'; patch: Record<string, unknown> }
  | { cmd: 'settings:getAuthMasked' }
  | { cmd: 'settings:updateAuth'; patch: Record<string, unknown> }
  | { cmd: 'settings:getPreferences' }
  | { cmd: 'settings:setPreferences'; preferences: unknown }
  | { cmd: 'settings:getDoctorReport' }
  | { cmd: 'settings:getCrashReports' }
  | { cmd: 'gitBranch'; dir: string }
  | { cmd: 'getContextUsage'; sessionId: string }
  | { cmd: 'getSnapshotForCall'; sessionId: string; seq: number }
  | { cmd: 'readFileForRef'; path: string; cwd: string }
  | { cmd: 'notify'; title: string; body: string; sessionId?: string }
  | { cmd: 'metadata:get' }
  | { cmd: 'metadata:set'; id: string; patch: { title?: string; archived?: boolean; deleted?: boolean } }
  // —— D0：S7 只读查询端点 + S3 交互 op ——
  | { cmd: 'runConfig'; sessionId: string }
  | { cmd: 'planState'; sessionId: string }
  | { cmd: 'executionViews'; sessionId: string }
  | { cmd: 'changeReview'; sessionId: string }
  | { cmd: 'fork'; sessionId: string; atSeq?: number }
  | {
      cmd: 'submit';
      clientMessageId: string;
      sessionId: string;
      rawText: string;
      intent: SubmitIntentShape;
      references?: MessageReferenceShape[];
      expectedTurnId?: string;
    }
  | {
      cmd: 'cancel';
      requestId: string;
      target: { kind: 'turn' | 'task'; id: string };
      expectedId?: string;
      expectedTurnGeneration?: number;
    }
  | { cmd: 'resumeSubscription'; sessionId: string; lastSeq: number; epoch: number }
  | { cmd: 'capabilities'; sessionId?: string };

/** window.harness2 的形状（preload contextBridge 暴露） */
export interface Harness2Api {
  listSessions(cwd?: string): Promise<SessionSummaryShape[]>;
  createSession(cwd?: string): Promise<{ id: string }>;
  events(sessionId: string): Promise<SessionEventsPayloadShape>;
  undo(sessionId: string, opts?: { n?: number; dryRun?: boolean }): Promise<UndoRedoResponseShape>;
  redo(sessionId: string): Promise<UndoRedoResponseShape>;
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  respondApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  loadLayout(): Promise<unknown>;
  saveLayout(layout: unknown): Promise<void>;
  /** 主动查询当前连接状态（onConnectionStatus 只订阅、可能错过启动前已发出的 connected，用于补齐初始状态） */
  getStatus(): Promise<{ status: ConnectionStatus; detail?: StatusDetail }>;
  /** 读 config.json 脱敏视图（与 CLI 共用同一份，渲染端零 Node） */
  settingsGetConfig(): Promise<SettingsConfigShape>;
  /** 改 config.json（白名单字段合并；密钥类字段被拒；返回新视图或错误） */
  settingsUpdateConfig(
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; config?: SettingsConfigShape; warnings?: string[]; error?: string }>;
  /** 读 auth.json 掩码视图（channel/gateway 只回显掩码状态） */
  settingsGetAuthMasked(): Promise<SettingsAuthMaskedShape>;
  /** 写 auth.json gateway 凭据（仅 auth.json；渲染端不回显明文） */
  settingsUpdateAuth(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  /** 读桌面偏好（desktop-preferences.json） */
  settingsGetPreferences(): Promise<SettingsPreferencesShape>;
  /** 写桌面偏好 */
  settingsSetPreferences(preferences: unknown): Promise<SettingsPreferencesShape>;
  /** doctor 六项检查结果 */
  settingsGetDoctorReport(): Promise<SettingsDoctorReportShape>;
  /** 崩溃报告列表（~/.harness2/crash/*.log 摘要） */
  settingsGetCrashReports(): Promise<SettingsCrashReportShape[]>;
  /** 读当前 git 分支（主进程 git rev-parse；非 git 目录返回 null） */
  gitBranch(dir: string): Promise<string | null>;
  /** 读上下文占用（core getContextUsage 经 IPC；与终端 /context 同一数据源） */
  getContextUsage(sessionId: string): Promise<ContextUsageShape>;
  /** 读指定 tool/call 事件 seq 对应的文件快照（rewind_points.jsonl 单条；只读） */
  getSnapshotForCall(sessionId: string, seq: number): Promise<SnapshotForCallShape>;
  /** 读 @file 引用内容（主进程 fs，64KB 截断；失败返回 null） */
  readFileForRef(
    path: string,
    cwd: string,
  ): Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }>;
  /** 任务完成系统通知（主进程 Electron Notification） */
  notify(title: string, body: string, sessionId?: string): Promise<void>;
  /** 读会话展示态覆层整体（~/.harness2/desktop-metadata.json；损坏回退空映射） */
  metadataGet(): Promise<SessionMetadataMapShape>;
  /** 合并写回单个会话的展示态 patch（title/archived/deleted；返回更新后整体） */
  metadataSet(
    id: string,
    patch: { title?: string; archived?: boolean; deleted?: boolean },
  ): Promise<SessionMetadataMapShape>;
  // —— D0：S7 只读查询 + S3 交互 op + 能力盘点 ——
  /** 有效运行配置只读视图（脱敏；serve 未就绪/失败 → 抛错，由调用方 fallback） */
  runConfig(sessionId: string): Promise<EffectiveRunConfigShape>;
  /** 计划状态只读投影（会话无 task/transition 账本 → null，不臆造计划） */
  planState(sessionId: string): Promise<PlanStateShape | null>;
  /** 工具/命令执行只读视图列表（真实 shell/cwd/输出/退出码；未执行不虚构） */
  executionViews(sessionId: string): Promise<ToolExecutionViewShape[]>;
  /** 变更审查只读视图（拟议 vs 真实落盘；外部改动 dirty） */
  changeReview(sessionId: string): Promise<ChangeSetShape>;
  /** 从既有会话分叉（不改原会话）；成功经 'forked' 帧回传 */
  fork(sessionId: string, atSeq?: number): Promise<void>;
  /** 提交（幂等 clientMessageId；结果经 'submit-ack' 帧回传，unknown ≠ rejected） */
  submit(op: {
    clientMessageId: string;
    sessionId: string;
    rawText: string;
    intent: SubmitIntentShape;
    references?: MessageReferenceShape[];
    expectedTurnId?: string;
  }): Promise<void>;
  /** 取消 turn/task（三态经 'cancel-ack' 帧回传；不把取消当 undo） */
  cancel(op: {
    requestId: string;
    target: { kind: 'turn' | 'task'; id: string };
    expectedId?: string;
    expectedTurnGeneration?: number;
  }): Promise<void>;
  /** 重订阅：带水位回放 + 在途状态（结果经 'resume-snapshot' 帧回传） */
  resumeSubscription(sessionId: string, lastSeq: number, epoch: number): Promise<void>;
  /** 能力盘点：后端真实具备哪些能力（unavailable 带可行动原因） */
  capabilities(sessionId?: string): Promise<CapabilityReportShape>;
  /** 订阅服务事件帧（delta/event/turn-end/approval-request/error）；返回退订函数 */
  onEvent(listener: (frame: WsFrame) => void): () => void;
  /** 订阅连接状态变化；返回退订函数 */
  onConnectionStatus(listener: (status: ConnectionStatus, detail?: StatusDetail) => void): () => void;
}
