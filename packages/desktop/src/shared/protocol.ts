// 桌面端共享协议：preload 暴露的 window.harness2 API、IPC 通道名与服务帧类型。
// 本文件是 main / preload / renderer 三方的唯一类型事实源；
// 服务帧类型按阶段 5 冻结契约（core server/ws.ts）同形复制——渲染进程零 Node、
// 不 import 任何 Node/核心模块，类型随构建擦除。
export const IPC_INVOKE = 'harness2:invoke';
export const IPC_EVENT = 'harness2:event';
export const IPC_STATUS = 'harness2:status';
/** D4：关窗口「请求停止并退出」时主进程要求渲染端取消全部运行中工作 */
export const IPC_STOP_ALL = 'harness2:stop-all';
/** P6-B（D-58）：设置域事件通道（settings/credentials/llm/connection），渲染端订阅而非轮询 */
export const IPC_SETTINGS_EVENT = 'harness2:settings-event';

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
   * cron 通知帧（core server/ws.ts WsServerMessage 同形镜像）：**广播全部连接、无会话归属**
   * （core ws.ts「cron 通知帧广播：不按会话订阅过滤，投递全部连接」）。漏镜像时它会被
   * 当作会话帧落到 ensureStream(frame.sessionId = undefined) → undefined 幽灵流（审查 P2）。
   */
  | { type: 'cron'; op: 'finished'; id: string; ok: boolean; error?: string }
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

/** 会话草稿映射（D1：sessionId → 原始输入草稿；与模型上下文分离，仅发送时合成 finalText） */
export type DraftsMapShape = Record<string, string>;

// —— P6-B 模型配置页（D-50～D-59）：提供方行 / 模型目录 / 凭据确认 / 发现模型 ——
//
// 红线（HANDOFF §7）：密钥只落 ~/.harness2/auth.json（channels.<route>.apiKey）或环境变量；
// config.json 只持有**具名引用**（providers.<id>.envKey = <ROUTE>_API_KEY），永不持有密钥值；
// 渲染端只写不回读明文——回读只有「已确认/已确认缺失/未确认」与具名引用名。

/** D-52：凭据状态三态——只在已确认时上色，不猜 */
export type CredentialStateShape = 'confirmed' | 'missing' | 'unknown';

/** 凭据确认信息（不含任何明文；reference 是「具名引用」而非密钥值） */
export interface CredentialStatusShape {
  state: CredentialStateShape;
  /** 具名引用名（provider.envKey，缺省时由主进程派生 <ROUTE>_API_KEY）；无引用时 undefined */
  reference?: string;
  /** confirmed 的确认来源：auth.json 渠道条目 / 环境变量 */
  source?: 'auth.json' | 'env';
}

/** 提供方行的配置层归属（D-59：删除只看用户层是否独自携带该行） */
export type ModelsProviderLayerShape = 'user' | 'project';

/** 模型目录行（容量元数据可选；未知就不填，不臆造） */
export interface ModelsModelRowShape {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** 提供方行（读视图；含层归属与凭据确认） */
export interface ModelsProviderRowShape {
  /** Provider ID = config.providers 键 + 凭据引用词干（不可改） */
  id: string;
  /** 显示名称（config 无此字段：由桌面覆层 desktop-models.json 承载；缺省回退 id） */
  displayName: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  /** 配置里的具名凭据引用（只有名字，没有值） */
  apiKeyRef?: string;
  models: ModelsModelRowShape[];
  /** 携带该行的配置层（用户层 / 项目层；两层都有 = 两层都列） */
  layers: ModelsProviderLayerShape[];
  /** D-59：仅当用户层独自携带该行时可删（删后恢复组合基线） */
  deletable: boolean;
  /** 不可删除的可行动原因（deletable=false 时必有） */
  lockedReason?: string;
  credential: CredentialStatusShape;
}

/** 模型配置文档（D-58：每次写入须带读到的 revision；并发写报 settings/conflict） */
export interface ModelsDocumentShape {
  /** 不透明版本令牌（用户层 + 项目层 config 原文指纹）；写入必须回带 */
  revision: string;
  providers: ModelsProviderRowShape[];
  /** D-59 首运行：已确认的声明版本（0 = 未确认；UI 与声明版本常量比对） */
  declarationAckVersion: number;
  sources: { global: boolean; project: boolean };
  warnings: string[];
  errors: string[];
}

/** 提供方写入输入（单卡保存：用户层 upsert） */
export interface ModelsProviderInputShape {
  id: string;
  displayName: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  /** 保留既有具名引用用（UI 不提供改名入口；缺省时主进程派生 <ROUTE>_API_KEY） */
  apiKeyRef?: string;
  models: ModelsModelRowShape[];
}

/** 写入失败码（settings/conflict = 并发写；validation = 校验拒绝；locked = 规则不允许；io = 落盘失败） */
export type ModelsWriteCodeShape = 'settings/conflict' | 'validation' | 'locked' | 'io';

export interface ModelsWriteResultShape {
  ok: boolean;
  code?: ModelsWriteCodeShape;
  /** 校验失败字段（就地阻断用；如 id / baseUrl / models.<id>.contextWindow） */
  field?: string;
  error?: string;
  /** 成功后的最新文档；settings/conflict 时也回带（供 UI 刷新后重试，不盲目覆盖） */
  document?: ModelsDocumentShape;
}

/** 密钥写入结果：只回「具名引用」，永不回显明文 */
export interface ModelsCredentialWriteResultShape {
  ok: boolean;
  code?: ModelsWriteCodeShape;
  field?: string;
  error?: string;
  reference?: string;
}

/** 发现模型条目（id + 显示名；搜索同时匹配两者） */
export interface ModelsDiscoveryModelShape {
  id: string;
  displayName: string;
}

export interface ModelsDiscoveryResultShape {
  ok: boolean;
  models?: ModelsDiscoveryModelShape[];
  error?: string;
}

/** 首运行声明确认结果 */
export interface ModelsDeclarationAckShape {
  ok: boolean;
  declarationAckVersion: number;
  error?: string;
}

/** D-58：设置域事件帧（订阅而非轮询） */
export type SettingsEventFrame =
  | { type: 'settings/document-updated'; revision: string }
  | { type: 'credentials/reference-updated'; route: string }
  | { type: 'llm/adapters-updated' }
  | { type: 'connection/reset' };

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
  // —— P6-B（D-50～D-59）：模型配置文档 + 凭据通道（只写不回读明文） ——
  | { cmd: 'settings:getModels' }
  | {
      cmd: 'settings:updateModels';
      revision: string;
      provider: ModelsProviderInputShape;
      /** 编辑既有行时的原 id（Provider ID 不可改：不一致即拒） */
      originalId?: string;
      /** 可选：同时把 roles.main 指向该提供方的模型（空 = 不动 roles.main） */
      mainModel?: string;
    }
  | { cmd: 'settings:deleteProvider'; route: string; confirmRoute: string }
  | { cmd: 'settings:writeChannelKey'; route: string; key: string }
  | { cmd: 'settings:getCredentialStatus'; routes: string[] }
  | { cmd: 'settings:ackModelsDeclaration'; version: number }
  | {
      cmd: 'settings:discoverModels';
      route: string;
      baseUrl: string;
      protocol: ModelsProviderInputShape['protocol'];
    }
  | { cmd: 'settings:getPreferences' }
  | { cmd: 'settings:setPreferences'; preferences: unknown }
  | { cmd: 'settings:getDoctorReport' }
  | { cmd: 'settings:getCrashReports' }
  | { cmd: 'gitBranch'; dir: string }
  | { cmd: 'getContextUsage'; sessionId: string }
  | { cmd: 'getSnapshotForCall'; sessionId: string; seq: number }
  | { cmd: 'readFileForRef'; path: string; cwd: string }
  | { cmd: 'listDir'; relativePath: string }
  | { cmd: 'notify'; title: string; body: string; sessionId?: string }
  | { cmd: 'metadata:get' }
  | { cmd: 'metadata:set'; id: string; patch: { title?: string; archived?: boolean; deleted?: boolean } }
  // —— D1：会话草稿持久化（desktop-drafts.json；按会话隔离） ——
  | { cmd: 'drafts:get' }
  | { cmd: 'drafts:set'; drafts: DraftsMapShape }
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
  | { cmd: 'capabilities'; sessionId?: string }
  // —— D4：运行态上报（关窗口提示依据：关 UI 不等于停任务） ——
  | { cmd: 'runtime:setBusy'; busy: boolean; runningTurns?: number; backgroundTasks?: number };

/**
 * P6-B 模型配置页所需的最小通道面（D-50～D-59）。
 * 装配说明：`Harness2Api` 以 Partial 形式并入本面——这是**加性**通道，渲染端在缺失时
 * 如实降级（显示「此版本主进程未提供模型配置通道」，不摆假入口），也因此不会让既有
 * 测试夹具（只覆盖旧面）编译失败。
 */
export interface ModelsSettingsApi {
  /** 读模型配置文档（提供方行/模型目录/凭据确认/层归属/revision；不含任何密钥明文） */
  settingsGetModels(): Promise<ModelsDocumentShape>;
  /** 保存单张提供方卡（用户层 upsert；revision 不符 → code='settings/conflict'） */
  settingsUpdateModels(opts: {
    revision: string;
    provider: ModelsProviderInputShape;
    originalId?: string;
    mainModel?: string;
  }): Promise<ModelsWriteResultShape>;
  /** 删除提供方（仅用户层独有可删；confirmRoute 必须与 route 一致 = 确认框指名） */
  settingsDeleteProvider(route: string, confirmRoute: string): Promise<ModelsWriteResultShape>;
  /** 写渠道 API 密钥（只写：唯一的密钥入口；回读只有具名引用，不含明文） */
  settingsWriteChannelKey(route: string, key: string): Promise<ModelsCredentialWriteResultShape>;
  /** 凭据确认查询（只回「已确认/已确认缺失/未确认 + 具名引用」，永不回显明文） */
  settingsGetCredentialStatus(routes: string[]): Promise<Record<string, CredentialStatusShape>>;
  /** 首运行声明「已确认」（版本化落盘 ~/.harness2/desktop-models.json） */
  settingsAckModelsDeclaration(version: number): Promise<ModelsDeclarationAckShape>;
  /** 「获取可用模型」：拿表单当前端点查（密钥取自已存凭据，不经渲染端回传） */
  settingsDiscoverModels(input: {
    route: string;
    baseUrl: string;
    protocol: ModelsProviderInputShape['protocol'];
  }): Promise<ModelsDiscoveryResultShape>;
  /** 订阅设置域事件（D-58：settings/credentials/llm/connection）；返回退订函数 */
  onSettingsEvent(listener: (frame: SettingsEventFrame) => void): () => void;
}

/** window.harness2 的形状（preload contextBridge 暴露） */
export interface Harness2Api extends Partial<ModelsSettingsApi> {
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
  /** PD7：工作区只读列目录（根 = 主进程持有的 serve --root；仅相对路径；realpath 边界校验） */
  listDir(relativePath: string): Promise<
    | {
        ok: true;
        path: string;
        entries: Array<{ name: string; kind: 'dir' | 'file' | 'symlink' | 'other' }>;
        truncated: boolean;
      }
    | { ok: false; error: string }
  >;
  /** 任务完成系统通知（主进程 Electron Notification） */
  notify(title: string, body: string, sessionId?: string): Promise<void>;
  /** 读会话展示态覆层整体（~/.harness2/desktop-metadata.json；损坏回退空映射） */
  metadataGet(): Promise<SessionMetadataMapShape>;
  /** 合并写回单个会话的展示态 patch（title/archived/deleted；返回更新后整体） */
  metadataSet(
    id: string,
    patch: { title?: string; archived?: boolean; deleted?: boolean },
  ): Promise<SessionMetadataMapShape>;
  /** 读会话草稿（desktop-drafts.json；按会话隔离；损坏回退空映射） */
  draftsGet(): Promise<DraftsMapShape>;
  /** 整体写回草稿映射（写前归一化；返回归一化后的结果） */
  draftsSet(drafts: DraftsMapShape): Promise<DraftsMapShape>;
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
  /** D4：上报「是否有运行中工作」（main 进程据此在关窗口前提示，不静默丢弃任务） */
  setBusy(busy: boolean, counts?: { runningTurns: number; backgroundTasks: number }): Promise<void>;
  /** 订阅服务事件帧（delta/event/turn-end/approval-request/error）；返回退订函数 */
  onEvent(listener: (frame: WsFrame) => void): () => void;
  /** 订阅连接状态变化；返回退订函数 */
  onConnectionStatus(listener: (status: ConnectionStatus, detail?: StatusDetail) => void): () => void;
  /** D4：订阅主进程「请求停止全部」（用户选择「请求停止并退出」时）；返回退订函数 */
  onStopAll(listener: () => void): () => void;
}
