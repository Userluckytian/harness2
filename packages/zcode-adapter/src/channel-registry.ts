/**
 * channel-registry —— ZS1 频道注册表与 A/B/C 分类
 *
 * 分类依据：spike `docs/research/2026-10-20-zcode-services-surface-spike.md` §5 +
 * A 类服务映射详表 `docs/research/2026-10-20-zs-a-class-mapping.md`。
 * 频道全集 = @zcode/shared ServiceChannels（56）+ 字面量 "gen-ui"（services/src/gen-ui/contract.ts）= 57。
 *
 * - A: core 已有对应能力，ZS2+ 写适配器映射（ZS1 读路径空态形状 / 写路径 throw）
 * - B: core 需补的 UI 支撑能力（v4 竖切/task 管线/文件树等，ZS2/ZS3）——显式 throw
 * - C: ZCode 特有/云端绑定——静默空实现（读路径空值，事件永不触发；ZS6 feature-gate 隐藏）
 */
import { ServiceChannels } from '@zcode/shared';
import type { StubClassification } from './stub-factory.js';

export interface ChannelRegistryEntry {
  /** 频道名（与 ServiceDescriptor.channelName 一致） */
  readonly channel: string;
  /** 服务显示名（注册表用途） */
  readonly service: string;
  readonly classification: StubClassification;
  /** 分类依据备注（spike §5 / 映射详表引用） */
  readonly note: string;
}

export const CHANNEL_REGISTRY: readonly ChannelRegistryEntry[] = [
  // ── A 类：core 已有，ZS2+ 映射 ─────────────────────────────────────────────
  {
    channel: ServiceChannels.Setting,
    service: 'ISettingService',
    classification: 'A',
    note: 'A: core settings/（映射详表 §setting）；ZS1 读空态形状',
  },
  {
    channel: ServiceChannels.Credential,
    service: 'ICredentialService',
    classification: 'A',
    note: 'A: core settings/ + auth.json；load→null（未登录）',
  },
  {
    channel: ServiceChannels.ProviderSettings,
    service: 'IProviderSettingsService',
    classification: 'A',
    note: 'A: core provider/（factory/roles）；ZS1 空 view',
  },
  {
    channel: ServiceChannels.ModelSelection,
    service: 'IModelSelectionService',
    classification: 'A',
    note: 'A: core provider/；ZS1 空 view（无 provider → WelcomeScreen）',
  },
  { channel: ServiceChannels.Skills, service: 'ISkillsService', classification: 'A', note: 'A: core skills/' },
  {
    channel: ServiceChannels.Subagents,
    service: 'ISubagentsService',
    classification: 'A',
    note: 'A: core agent/subagent.ts',
  },
  { channel: ServiceChannels.Commands, service: 'ICommandsService', classification: 'A', note: 'A: core commands/' },
  { channel: ServiceChannels.Hooks, service: 'IHooksService', classification: 'A', note: 'A: core hooks/' },
  { channel: ServiceChannels.Memory, service: 'IMemoryService', classification: 'A', note: 'A: core memory/' },

  // ── B 类：v4 竖切 / UI 支撑，ZS2/ZS3 补 ────────────────────────────────────
  {
    channel: ServiceChannels.ZCodeAgent,
    service: 'IZCodeAgentService',
    classification: 'B',
    note: 'B: v4 conversation 竖切 ZS2/ZS3（最大项）；syncAppRuntimePreferences 空态 void',
  },
  {
    channel: ServiceChannels.ZCodeTask,
    service: 'IZCodeTaskService',
    classification: 'B',
    note: 'B: task 索引/派发管线 ZS2/ZS4',
  },
  {
    channel: ServiceChannels.ZCodeSession,
    service: 'IZCodeSessionService',
    classification: 'B',
    note: 'B: app 会话 facade ZS2；旧 ZCodeSessionEvent v4 UI 零消费（映射详表）',
  },
  {
    channel: ServiceChannels.WindowController,
    service: 'IWindowControllerService',
    classification: 'B',
    note: 'B: 窗口聚合投影；空态方法（listTaskList/subscribeV4）空形状',
  },
  {
    channel: ServiceChannels.Project,
    service: 'IProjectService',
    classification: 'B',
    note: 'B: 项目树；readTree/readProjects 空态空形状',
  },
  {
    channel: ServiceChannels.TaskGroups,
    service: 'ITaskGroupService',
    classification: 'B',
    note: 'B: 任务分组；read 空态空结构',
  },
  {
    channel: ServiceChannels.File,
    service: 'IFileService',
    classification: 'B',
    note: 'B: workspace 文件索引（列式分块）ZS2/ZS3',
  },
  {
    channel: ServiceChannels.FileWatcher,
    service: 'IFileWatcherService',
    classification: 'B',
    note: 'B: fs 监视 ZS3+',
  },
  { channel: ServiceChannels.Git, service: 'IGitService', classification: 'B', note: 'B: GitPane；core 无 git 集成' },
  {
    channel: ServiceChannels.GitCheckpoint,
    service: 'IGitCheckpointService',
    classification: 'B',
    note: 'B: core 只有文件快照',
  },
  {
    channel: ServiceChannels.Terminal,
    service: 'ITerminalService',
    classification: 'B',
    note: 'B: 全表唯一直接映射 core terminal/manager.ts（映射详表）；PTY ZS3+',
  },
  { channel: ServiceChannels.System, service: 'ISystemService', classification: 'B', note: 'B: 系统信息/打开路径' },
  { channel: ServiceChannels.MediaPreview, service: 'IMediaPreviewService', classification: 'B', note: 'B: 媒体预览' },
  {
    channel: ServiceChannels.Broadcast,
    service: 'IBroadcastService',
    classification: 'B',
    note: 'B: 跨窗口广播；ZS1 单窗口 no-op（onMessage 永不触发）',
  },
  {
    channel: ServiceChannels.ConversationShare,
    service: 'IConversationShareService',
    classification: 'B',
    note: 'B: 本地导出可做 ZS4+；云发布属 C',
  },
  {
    channel: ServiceChannels.PromptAttachmentTransfer,
    service: 'IPromptAttachmentTransferService',
    classification: 'B',
    note: 'B: composer 附件管线 ZS3',
  },
  { channel: ServiceChannels.Plugins, service: 'IPluginsService', classification: 'B', note: 'B: 插件体系' },
  {
    channel: ServiceChannels.PluginManagement,
    service: 'IPluginManagementService',
    classification: 'B',
    note: 'B: 设置页插件管理',
  },
  {
    channel: ServiceChannels.PluginUiBridge,
    service: 'IPluginUiBridgeService',
    classification: 'B',
    note: 'B: 插件 UI 沙箱桥',
  },
  {
    channel: ServiceChannels.PluginUiSampling,
    service: 'IPluginUiSamplingService',
    classification: 'B',
    note: 'B: 页面 sampling',
  },
  {
    channel: ServiceChannels.PluginUiAppTools,
    service: 'IPluginUiAppToolsService',
    classification: 'B',
    note: 'B: App-Provided Tools',
  },
  {
    channel: 'gen-ui',
    service: 'IGenUiService',
    classification: 'B',
    note: 'B: GenUI（字面量频道，services/src/gen-ui/contract.ts）',
  },
  { channel: ServiceChannels.OutputStyle, service: 'IOutputStyleService', classification: 'B', note: 'B: 输出样式' },
  {
    channel: ServiceChannels.SettingsSync,
    service: 'ISettingsSyncService',
    classification: 'B',
    note: 'B: 首启设置同步',
  },

  // ── C 类：云端绑定 / 专有，静默空实现（ZS6 feature-gate 隐藏） ────────────────
  {
    channel: ServiceChannels.OAuth,
    service: 'IOAuthService',
    classification: 'C',
    note: 'C: ZCode OAuth；ZS1 未登录态（getProviders→[]，restoreCachedSessionState→signed-out）；登录动作 throw',
  },
  {
    channel: ServiceChannels.CodingPlanSubscription,
    service: 'ICodingPlanSubscriptionService',
    classification: 'C',
    note: 'C: 订阅购买；getDynamicWorkflowClientConfig→disabled/default（fail-closed）',
  },
  { channel: ServiceChannels.OffPeakTask, service: 'IOffPeakTaskService', classification: 'C', note: 'C: 闲时任务' },
  { channel: ServiceChannels.HighspeedCard, service: 'IHighspeedCardService', classification: 'C', note: 'C: 高速卡' },
  {
    channel: ServiceChannels.UsageStats,
    service: 'IUsageStatsService',
    classification: 'C',
    note: 'C: 用量快照（coding-plan 面）；app 用量聚合 core 缺',
  },
  { channel: ServiceChannels.Feedback, service: 'IFeedbackService', classification: 'C', note: 'C: 反馈工单' },
  { channel: ServiceChannels.ClientConfig, service: 'IClientConfigService', classification: 'C', note: 'C: 运营配置' },
  {
    channel: ServiceChannels.ClientScenes,
    service: 'IClientScenesService',
    classification: 'C',
    note: 'C: 客户端场景',
  },
  { channel: ServiceChannels.CloudContent, service: 'ICloudContentService', classification: 'C', note: 'C: 云内容' },
  {
    channel: ServiceChannels.MarketingTouch,
    service: 'IMarketingTouchService',
    classification: 'C',
    note: 'C: 运营位；query→空快照',
  },
  {
    channel: ServiceChannels.Bots,
    service: 'IBotsService',
    classification: 'C',
    note: 'C: ZCode 绑定码体系（≠harness2 gateway QQ bot）；syncAppRuntimePreferences→void',
  },
  {
    channel: ServiceChannels.CuaPermission,
    service: 'ICuaPermissionService',
    classification: 'C',
    note: 'C: macOS CUA 专有',
  },
  {
    channel: ServiceChannels.CuaPipSession,
    service: 'ICuaPipSessionService',
    classification: 'C',
    note: 'C: macOS CUA PiP',
  },
  {
    channel: ServiceChannels.RemoteProjects,
    service: 'IRemoteProjectService',
    classification: 'C',
    note: 'C: 远程 host 体系；readDirectory→空目录（boot log 空态实证 6 次）',
  },
  {
    channel: ServiceChannels.SourceServerManagement,
    service: 'ISourceServerManagementService',
    classification: 'C',
    note: 'C: Source Server 管理；getSnapshot→空（boot log 空态实证 4 次，renderer 侧代理恒存在故必须注册）',
  },
  {
    channel: ServiceChannels.SourceServerWorkspace,
    service: 'ISourceServerWorkspaceService',
    classification: 'C',
    note: 'C: SSH 远端 workspace 身份',
  },
  {
    channel: ServiceChannels.SkillSync,
    service: 'ISkillSyncService',
    classification: 'C',
    note: 'C: SSH 远端 skills 同步',
  },
  { channel: ServiceChannels.McpSync, service: 'IMcpSyncService', classification: 'C', note: 'C: SSH 远端 MCP 同步' },
  {
    channel: ServiceChannels.PluginSync,
    service: 'IPluginSyncService',
    classification: 'C',
    note: 'C: SSH 远端 plugin 同步',
  },
  {
    channel: ServiceChannels.WindowProject,
    service: 'IWindowProjectService',
    classification: 'C',
    note: 'C: 手机远端窗口目录',
  },
  {
    channel: ServiceChannels.WindowRemoteProjects,
    service: 'IWindowRemoteProjectService',
    classification: 'C',
    note: 'C: 手机远端项目',
  },
  {
    channel: ServiceChannels.WindowProjectChanges,
    service: 'IWindowProjectChangesService',
    classification: 'C',
    note: 'C: 手机远端变更',
  },
  {
    channel: ServiceChannels.ProviderProvisioningTarget,
    service: 'IProviderProvisioningTargetService',
    classification: 'C',
    note: 'C: 远端 Environment 专有',
  },
  {
    channel: ServiceChannels.OnboardingRecord,
    service: 'IOnboardingRecordService',
    classification: 'C',
    note: 'C: ZCode onboarding 记录',
  },
];

/** 与 @zcode/shared ServiceChannels 的全集对账（56 频道 + gen-ui = 57） */
export function assertRegistryMatchesServiceChannels(): {
  missing: string[];
  unknown: string[];
} {
  const registered = new Set(CHANNEL_REGISTRY.map((entry) => entry.channel));
  const allChannels = new Set<string>(Object.values(ServiceChannels) as string[]);
  allChannels.add('gen-ui');
  const missing = [...allChannels].filter((channel) => !registered.has(channel));
  const unknown = [...registered].filter((channel) => !allChannels.has(channel));
  return { missing, unknown };
}
