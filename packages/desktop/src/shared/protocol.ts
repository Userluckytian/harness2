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
/** Z2-01b：窗口状态变化通道（最大化/还原）——win/linux 自绘窗控图标与 linux 最大化去圆角据此 */
export const IPC_WINDOW_STATE = 'harness2:window-state';

// 本文件保留段内部要用的线协议名字（`export type *` 只做再导出、不引入本地名字）。
import type {
  CapabilityReportShape,
  ChangeSetShape,
  ConnectionStatus,
  CronJobShape,
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

// —— 设置/模型域形状再导出（唯一事实源 @harness2/ui-shared/shared/settings.ts） ——
// Z7：设置页下沉 ui-shared 后，config/auth/preferences/模型文档等形状的唯一事实源移到共享包；
// 本文件按名字再导出，既有 `from '../shared/protocol.js'` 的引用面不变（`export type *` 只搬类型）。
export type * from '@harness2/ui-shared/shared/settings.js';

// —— 项目实体形状再导出（P0-3b；唯一事实源 @harness2/ui-shared/shared/projects.ts） ——
// ProjectEntry / ProjectsDocument 是 ui-shared 纯模块（normalize 也在共享侧），
// 主进程与渲染端引用同一份；此处按名字再导出保持桌面引用面统一（类型即擦除，不引依赖）。
export type * from '@harness2/ui-shared/shared/projects.js';

// 本文件保留段内部要用的项目形状。
import type { ProjectsDocument } from '@harness2/ui-shared/shared/projects.js';

// 本文件保留段内部要用的设置域名字（`export type *` 只做再导出、不引入本地名字）。
import type {
  ModelsProviderInputShape,
  ModelsSettingsApi,
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorReportShape,
  SettingsPreferencesShape,
  SettingsSkillsShape,
} from '@harness2/ui-shared/shared/settings.js';

// —— 桌面壳专属形状（Z2-01b 窗口控件 / Z-86 标题栏主题镜像） ——

/** Z-86：桌面 nativeTheme 镜像取值（system = 交给 Electron 跟随系统） */
export type PlatformTitleBarTheme = 'light' | 'dark' | 'system';

/** Z2-01b：桌面平台（preload 同步暴露 process.platform；渲染端据此派生平台特化外壳） */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

/** Z2-01b：窗口最大化状态（win/linux 自绘窗控图标 / linux 最大化去圆角） */
export interface WindowStateShape {
  maximized: boolean;
}

/** getContextUsage 响应（与终端 /context 同一数据源；value 为 0..1 或 null=未知） */
export interface ContextUsageShape {
  usage: number | null;
  /** 显示文本（如 "45%" 或 "—"） */
  label: string;
}

/** 会话展示态覆层 entry（B3：desktop-metadata.json 单会话元数据；title/archived/deleted/pinned 均可选） */
export interface SessionMetadataEntryShape {
  title?: string;
  archived?: boolean;
  /** 删除隐藏标记（serve 无 delete API；仅覆层标记，事件数据仍在托管下） */
  deleted?: boolean;
  /** 置顶标记（Z8-1：Pinned 区数据面；加性字段，缺省 = 未置顶） */
  pinned?: boolean;
}

/** metadata:get / metadata:set 的响应（整体覆层映射 sessionId → entry） */
export type SessionMetadataMapShape = Record<string, SessionMetadataEntryShape>;

/** 会话草稿映射（D1：sessionId → 原始输入草稿；与模型上下文分离，仅发送时合成 finalText） */
export type DraftsMapShape = Record<string, string>;

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
  // P0-3a 自动化（cron）：主进程 fs 只读扫描本地 jobs.json（core CronJobStore 同一实现），返回任务表
  | { cmd: 'cron:list' }
  // P0 自动化主区视图：新增任务（core CronJobStore.add；非法调度/超上限 → reject，如实回传）
  | { cmd: 'cron:add'; instruction: string; schedule: string }
  | { cmd: 'gitBranch'; dir: string }
  | { cmd: 'getContextUsage'; sessionId: string }
  | { cmd: 'getSnapshotForCall'; sessionId: string; seq: number }
  | { cmd: 'readFileForRef'; path: string; cwd: string }
  | { cmd: 'listDir'; relativePath: string }
  | { cmd: 'notify'; title: string; body: string; sessionId?: string }
  | { cmd: 'metadata:get' }
  | {
      cmd: 'metadata:set';
      id: string;
      patch: { title?: string; archived?: boolean; deleted?: boolean; pinned?: boolean };
    }
  // —— D1：会话草稿持久化（desktop-drafts.json；按会话隔离） ——
  | { cmd: 'drafts:get' }
  | { cmd: 'drafts:set'; drafts: DraftsMapShape }
  // —— P0-3b：侧栏「项目」实体（projects.json；桌面主进程持久化，壳侧概念不进 core） ——
  | { cmd: 'projects:list' }
  | { cmd: 'projects:add'; cwd: string }
  | { cmd: 'projects:remove'; cwd: string }
  /** 目录选择（Electron showOpenDialog；取消 = null。桌面独有能力，web 无通道 → 不摆活按钮） */
  | { cmd: 'projects:pickFolder' }
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
  | { cmd: 'runtime:setBusy'; busy: boolean; runningTurns?: number; backgroundTasks?: number }
  // —— Z1-05 / Z-86：桌面 nativeTheme 镜像（标题栏与原生控件跟随主题） ——
  | { cmd: 'platform:setTitleBarTheme'; theme: PlatformTitleBarTheme }
  // —— Z2-01b：win/linux 自绘窗口控件（mac 走系统红绿灯，不调用这些命令） ——
  | { cmd: 'window:minimize' }
  | { cmd: 'window:toggleMaximize' }
  | { cmd: 'window:close' }
  | { cmd: 'window:getState' };

/**
 * Z2-01b 窗口控件最小通道面（win/linux 自绘三键 + 最大化状态）。
 * 与 ModelsSettingsApi 同样以 Partial 并入 Harness2Api：旧夹具只覆盖旧面，缺通道时
 * 渲染端**不摆假窗控**（如实降级），既有测试夹具因此无需改动即可编译。
 */
export interface WindowControlsApi {
  /** 最小化窗口 */
  windowMinimize(): Promise<void>;
  /** 切换最大化/还原 */
  windowToggleMaximize(): Promise<void>;
  /** 关闭窗口（走既有 close 事件链，D4 关窗口提示仍生效） */
  windowClose(): Promise<void>;
  /** 读当前最大化状态（linux 最大化去圆角 / 窗控图标） */
  windowGetState(): Promise<WindowStateShape>;
  /** 订阅最大化状态变化；返回退订函数 */
  onWindowState(listener: (state: WindowStateShape) => void): () => void;
}

/**
 * P0-3b 侧栏「项目」通道面（桌面独有能力，与 WindowControlsApi 同口径）。
 * 以 Partial 并入 Harness2Api：jsdom 测试夹具 / web 宿主缺通道时渲染端如实降级
 * （组头「添加项目」= disabled 占位 + 悬停说明，不摆可点即报错的假活钮，红线⑩）。
 */
export interface ProjectsApi {
  /** 读显式项目表（~/.harness2/projects.json；损坏回退空表） */
  projectsList(): Promise<ProjectsDocument>;
  /** 加入项目（幂等：已存在 = 返回现表）；返回写后整表 */
  projectsAdd(cwd: string): Promise<ProjectsDocument>;
  /** 从侧栏移除项目（仅删 projects.json 条目；会话与事件日志不动）；返回写后整表 */
  projectsRemove(cwd: string): Promise<ProjectsDocument>;
  /** 打开系统目录选择器；用户选中 → 绝对路径，取消 → null */
  projectsPickFolder(): Promise<string | null>;
}

/** window.harness2 的形状（preload contextBridge 暴露） */
export interface Harness2Api extends Partial<ModelsSettingsApi>, Partial<WindowControlsApi>, Partial<ProjectsApi> {
  /** Z2-01b：桌面平台（preload 同步暴露）；非桌面宿主 / 旧夹具缺失时渲染端不启用平台特化 */
  readonly platform?: DesktopPlatform;
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
  /** A08 技能分区：两级扫描的技能列表（主进程 fs 只读，与 core SkillStore 同一实现） */
  settingsGetSkills(): Promise<SettingsSkillsShape>;
  /**
   * P0-3a 自动化（cron）：本地 jobs.json 任务表（主进程 fs 只读，core CronJobStore 同一实现）。
   * 可选（同 WindowControlsApi 口径）：preload 生产必给；jsdom 测试夹具 / 非桌面宿主缺通道时
   * 渲染端如实降级（「自动化」tab 显示空态，不摆假数据）。
   */
  cronList?(): Promise<CronJobShape[]>;
  /**
   * P0 自动化主区视图：新增定时任务（instruction + schedule；core CronJobStore.add 单一实现）。
   * 可选（同 cronList 口径）：preload 生产必给；jsdom 夹具 / web 宿主缺通道时渲染端如实降级
   * （模板卡/创建钮 disabled + 说明，不摆假按钮）。
   */
  cronAdd?(instruction: string, schedule: string): Promise<CronJobShape>;
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
  /** 合并写回单个会话的展示态 patch（title/archived/deleted/pinned；返回更新后整体） */
  metadataSet(
    id: string,
    patch: { title?: string; archived?: boolean; deleted?: boolean; pinned?: boolean },
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
  /** Z1-05 / Z-86：镜像主题到桌面 nativeTheme（标题栏/原生控件；system = 跟随系统） */
  setTitleBarTheme(theme: PlatformTitleBarTheme): Promise<void>;
  /** 订阅服务事件帧（delta/event/turn-end/approval-request/error）；返回退订函数 */
  onEvent(listener: (frame: WsFrame) => void): () => void;
  /** 订阅连接状态变化；返回退订函数 */
  onConnectionStatus(listener: (status: ConnectionStatus, detail?: StatusDetail) => void): () => void;
  /** D4：订阅主进程「请求停止全部」（用户选择「请求停止并退出」时）；返回退订函数 */
  onStopAll(listener: () => void): () => void;
}
