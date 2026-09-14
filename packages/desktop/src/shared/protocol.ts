// 桌面端协议：preload 暴露的 window.harness2 API、IPC 通道名，以及**桌面专属**的设置 / 模型
// 配置形状。本文件是 main / preload / renderer 三方的唯一类型事实源。
//
// 跨壳线协议（serve WS/HTTP 帧 + S0/S3/S7 冻结交互契约）**不在本文件定义**：唯一事实源已下沉
// `@harness2/ui-shared`（`shared/protocol.ts`，web 壳同一份），本文件按名字再导出，既有
// `from '../shared/protocol.js'` 的引用面不变（`export type *` 只搬类型，构建后擦除——
// 主进程 / preload 的 CJS 产物不因此 require 共享包）。渲染进程零 Node、不 import 任何核心模块。
export const IPC_INVOKE = 'harness2:invoke';
export const IPC_EVENT = 'harness2:event';
export const IPC_STATUS = 'harness2:status';
/** D4：关窗口「请求停止并退出」时主进程要求渲染端取消全部运行中工作 */
export const IPC_STOP_ALL = 'harness2:stop-all';
/** P6-B（D-58）：设置域事件通道（settings/credentials/llm/connection），渲染端订阅而非轮询 */
export const IPC_SETTINGS_EVENT = 'harness2:settings-event';

// 本文件保留段内部要用的线协议名字（`export type *` 只做再导出、不引入本地名字）。
import type {
  CapabilityReportShape,
  ChangeSetShape,
  ConnectionStatus,
  EffectiveRunConfigShape,
  MessageReferenceShape,
  PlanStateShape,
  SessionEventsPayloadShape,
  SessionSummaryShape,
  SnapshotForCallShape,
  StatusDetail,
  SubmitIntentShape,
  ToolExecutionViewShape,
  UndoRedoResponseShape,
  WsFrame,
} from '@harness2/ui-shared/shared/protocol.js';

// —— 跨壳线协议再导出（唯一事实源 @harness2/ui-shared/shared/protocol.ts） ——
export type * from '@harness2/ui-shared/shared/protocol.js';

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
