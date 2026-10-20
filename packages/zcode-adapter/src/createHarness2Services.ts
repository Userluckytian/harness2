/**
 * createHarness2Services —— ZS1 桩服务集合装配
 *
 * 注册全部 57 个 service 频道（@zcode/shared ServiceChannels 56 + 字面量 "gen-ui"）：
 * - 空态实证触达的频道用 root-mount-stubs 的显式桩；
 * - 其余频道按 channel-registry 分类走工厂默认（A/C 读 null、B throw、事件 Event.None）。
 *
 * 返回 @zcode/services ServiceCollection，由 host-entry 在 ChannelServer 上
 * exposeOnChannelServer 暴露（桌面 local clientMode 无曝光过滤）。
 */
import { ServiceCollection } from "@zcode/services";
import {
  IBroadcastService,
  IBotsService,
  ICodingPlanSubscriptionService,
  ICredentialService,
  IFileService,
  IFileWatcherService,
  IGenUiService,
  IGitCheckpointService,
  IGitService,
  IHighspeedCardService,
  IHooksService,
  IMarketingTouchService,
  IMediaPreviewService,
  IMemoryService,
  IModelSelectionService,
  IMcpSyncService,
  IOAuthService,
  IOffPeakTaskService,
  IOnboardingRecordService,
  IOutputStyleService,
  IPluginManagementService,
  IPluginSyncService,
  IPluginUiAppToolsService,
  IPluginUiBridgeService,
  IPluginUiSamplingService,
  IPluginsService,
  IProjectService,
  IPromptAttachmentTransferService,
  IProviderProvisioningTargetService,
  IProviderSettingsService,
  IRemoteProjectService,
  ISettingService,
  ISettingsSyncService,
  ISkillsService,
  ISkillSyncService,
  ISourceServerManagementService,
  ISourceServerWorkspaceService,
  ISubagentsService,
  ISystemService,
  ITaskGroupService,
  ITerminalService,
  IUsageStatsService,
  IWindowControllerService,
  IWindowProjectChangesService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  ICloudContentService,
  IClientConfigService,
  IClientScenesService,
  ICommandsService,
  IConversationShareService,
  ICuaPermissionService,
  ICuaPipSessionService,
  IFeedbackService,
} from "@zcode/services";
import { CHANNEL_REGISTRY } from "./channel-registry.js";
import { createStubService } from "./stub-factory.js";
import { fileServiceStub } from "./file-stubs.js";
import {
  botsServiceStub,
  broadcastServiceStub,
  codingPlanSubscriptionServiceStub,
  credentialServiceStub,
  marketingTouchServiceStub,
  modelSelectionServiceStub,
  oauthServiceStub,
  projectServiceStub,
  providerSettingsServiceStub,
  remoteProjectServiceStub,
  settingServiceStub,
  sourceServerManagementServiceStub,
  taskGroupServiceStub,
  usageStatsServiceStub,
  windowControllerServiceStub,
  zcodeAgentServiceStub,
} from "./root-mount-stubs.js";

/** 显式桩表：频道名 → 已实例化的桩（其余频道按注册表分类现场生成默认桩） */
const EXPLICIT_STUBS = new Map<string, unknown>([
  [IBroadcastService.channelName, broadcastServiceStub],
  [IBotsService.channelName, botsServiceStub],
  [ICodingPlanSubscriptionService.channelName, codingPlanSubscriptionServiceStub],
  [ICredentialService.channelName, credentialServiceStub],
  [IFileService.channelName, fileServiceStub],
  [IMarketingTouchService.channelName, marketingTouchServiceStub],
  [IModelSelectionService.channelName, modelSelectionServiceStub],
  [IOAuthService.channelName, oauthServiceStub],
  [IProjectService.channelName, projectServiceStub],
  [IProviderSettingsService.channelName, providerSettingsServiceStub],
  [IRemoteProjectService.channelName, remoteProjectServiceStub],
  [ISettingService.channelName, settingServiceStub],
  [ISourceServerManagementService.channelName, sourceServerManagementServiceStub],
  [ITaskGroupService.channelName, taskGroupServiceStub],
  [IUsageStatsService.channelName, usageStatsServiceStub],
  [IWindowControllerService.channelName, windowControllerServiceStub],
  [IZCodeAgentService.channelName, zcodeAgentServiceStub],
]);

/** descriptor 表：频道名 → ServiceDescriptor（注册用） */
const DESCRIPTORS = new Map<string, { channelName: string }>([
  [IBroadcastService.channelName, IBroadcastService],
  [IBotsService.channelName, IBotsService],
  [ICloudContentService.channelName, ICloudContentService],
  [IClientConfigService.channelName, IClientConfigService],
  [IClientScenesService.channelName, IClientScenesService],
  [ICodingPlanSubscriptionService.channelName, ICodingPlanSubscriptionService],
  [ICommandsService.channelName, ICommandsService],
  [IConversationShareService.channelName, IConversationShareService],
  [ICredentialService.channelName, ICredentialService],
  [ICuaPermissionService.channelName, ICuaPermissionService],
  [ICuaPipSessionService.channelName, ICuaPipSessionService],
  [IFeedbackService.channelName, IFeedbackService],
  [IFileService.channelName, IFileService],
  [IFileWatcherService.channelName, IFileWatcherService],
  [IGenUiService.channelName, IGenUiService],
  [IGitService.channelName, IGitService],
  [IGitCheckpointService.channelName, IGitCheckpointService],
  [IHighspeedCardService.channelName, IHighspeedCardService],
  [IHooksService.channelName, IHooksService],
  [IMarketingTouchService.channelName, IMarketingTouchService],
  [IMediaPreviewService.channelName, IMediaPreviewService],
  [IMemoryService.channelName, IMemoryService],
  [IModelSelectionService.channelName, IModelSelectionService],
  [IMcpSyncService.channelName, IMcpSyncService],
  [IOAuthService.channelName, IOAuthService],
  [IOffPeakTaskService.channelName, IOffPeakTaskService],
  [IOnboardingRecordService.channelName, IOnboardingRecordService],
  [IOutputStyleService.channelName, IOutputStyleService],
  [IPluginManagementService.channelName, IPluginManagementService],
  [IPluginSyncService.channelName, IPluginSyncService],
  [IPluginUiAppToolsService.channelName, IPluginUiAppToolsService],
  [IPluginUiBridgeService.channelName, IPluginUiBridgeService],
  [IPluginUiSamplingService.channelName, IPluginUiSamplingService],
  [IPluginsService.channelName, IPluginsService],
  [IProjectService.channelName, IProjectService],
  [IPromptAttachmentTransferService.channelName, IPromptAttachmentTransferService],
  [IProviderProvisioningTargetService.channelName, IProviderProvisioningTargetService],
  [IProviderSettingsService.channelName, IProviderSettingsService],
  [IRemoteProjectService.channelName, IRemoteProjectService],
  [ISettingService.channelName, ISettingService],
  [ISettingsSyncService.channelName, ISettingsSyncService],
  [ISkillsService.channelName, ISkillsService],
  [ISkillSyncService.channelName, ISkillSyncService],
  [ISourceServerManagementService.channelName, ISourceServerManagementService],
  [ISourceServerWorkspaceService.channelName, ISourceServerWorkspaceService],
  [ISubagentsService.channelName, ISubagentsService],
  [ISystemService.channelName, ISystemService],
  [ITaskGroupService.channelName, ITaskGroupService],
  [ITerminalService.channelName, ITerminalService],
  [IUsageStatsService.channelName, IUsageStatsService],
  [IWindowControllerService.channelName, IWindowControllerService],
  [IWindowProjectChangesService.channelName, IWindowProjectChangesService],
  [IWindowProjectService.channelName, IWindowProjectService],
  [IWindowRemoteProjectService.channelName, IWindowRemoteProjectService],
  [IZCodeAgentService.channelName, IZCodeAgentService],
  [IZCodeSessionService.channelName, IZCodeSessionService],
  [IZCodeTaskService.channelName, IZCodeTaskService],
]);

export interface Harness2ServicesResult {
  /** 已注册全部频道的 ServiceCollection（供 ChannelServer 暴露） */
  readonly services: ServiceCollection;
  /** 已注册频道名清单（诊断/单测用） */
  readonly registeredChannels: readonly string[];
}

/**
 * 装配 harness2 ZS1 桩服务集合。
 * 幂等：每次调用返回全新实例（ServiceCollection 无全局状态）。
 */
export function createHarness2Services(): Harness2ServicesResult {
  const services = new ServiceCollection();
  const registeredChannels: string[] = [];
  for (const entry of CHANNEL_REGISTRY) {
    const descriptor = DESCRIPTORS.get(entry.channel);
    if (!descriptor) {
      throw new Error(`ZS1: channel registry entry has no descriptor (${entry.channel})`);
    }
    const stub =
      EXPLICIT_STUBS.get(entry.channel) ??
      createStubService<Record<string, unknown>>({
        channelName: entry.channel,
        classification: entry.classification,
      });
    services.register(descriptor as never, stub);
    registeredChannels.push(entry.channel);
  }
  return { services, registeredChannels };
}
