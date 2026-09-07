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
      error?: string;
      warning?: string;
    }
  | { type: 'approval-request'; sessionId: string; tool: string; args: unknown; requestId: string }
  | { type: 'error'; error: string };

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
  | { cmd: 'metadata:set'; id: string; patch: { title?: string; archived?: boolean; deleted?: boolean } };

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
  settingsUpdateConfig(patch: Record<string, unknown>): Promise<{ ok: boolean; config?: SettingsConfigShape; warnings?: string[]; error?: string }>;
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
  readFileForRef(path: string, cwd: string): Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }>;
  /** 任务完成系统通知（主进程 Electron Notification） */
  notify(title: string, body: string, sessionId?: string): Promise<void>;
  /** 读会话展示态覆层整体（~/.harness2/desktop-metadata.json；损坏回退空映射） */
  metadataGet(): Promise<SessionMetadataMapShape>;
  /** 合并写回单个会话的展示态 patch（title/archived/deleted；返回更新后整体） */
  metadataSet(id: string, patch: { title?: string; archived?: boolean; deleted?: boolean }): Promise<SessionMetadataMapShape>;
  /** 订阅服务事件帧（delta/event/turn-end/approval-request/error）；返回退订函数 */
  onEvent(listener: (frame: WsFrame) => void): () => void;
  /** 订阅连接状态变化；返回退订函数 */
  onConnectionStatus(listener: (status: ConnectionStatus, detail?: StatusDetail) => void): () => void;
}
