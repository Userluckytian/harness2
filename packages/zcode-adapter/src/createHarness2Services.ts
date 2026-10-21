/**
 * createHarness2Services —— ZS1 桩服务集合装配
 *
 * 注册全部 57 个 service 频道（@zcode/shared ServiceChannels 56 + 字面量 "gen-ui"）：
 * - 空态实证触达的频道用 root-mount-stubs 的显式桩；
 * - A 类 5 频道（skills/subagents/commands/hooks/memory）用 a-class-stubs 的显式桩
 *   （ZS1 审查 P1-1：写路径显式 throw，不走工厂默认的静默 null）；
 * - 其余频道按 channel-registry 分类走工厂默认（A/C 读 null、B throw、事件 Event.None）。
 *
 * 返回 @zcode/services ServiceCollection，由 host-entry 在 ChannelServer 上
 * exposeOnChannelServer 暴露（桌面 local clientMode 无曝光过滤）。
 */
import { Emitter } from '@zcode/rpc';
import { ServiceCollection } from '@zcode/services';
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
} from '@zcode/services';
import { CHANNEL_REGISTRY } from './channel-registry.js';
import { createFileService } from './real/file-service.js';
import { createProjectService } from './real/project-service.js';
import { createSessionService } from './real/session-service.js';
import { createTaskService } from './real/task-service.js';
import { createAgentService } from './real/agent-service.js';
import { createModelSelectionService, createProviderSettingsService } from './real/provider-views.js';
import { createLocalPromptAttachmentTransferService } from './real/attachment-transfer.js';
import { createSettingsStore } from './real/settings-store.js';
import { createStubService } from './stub-factory.js';
import {
  commandsServiceStub,
  hooksServiceStub,
  memoryServiceStub,
  skillsServiceStub,
  subagentsServiceStub,
} from './a-class-stubs.js';
import {
  botsServiceStub,
  broadcastServiceStub,
  codingPlanSubscriptionServiceStub,
  credentialServiceStub,
  marketingTouchServiceStub,
  oauthServiceStub,
  onboardingRecordServiceStub,
  remoteProjectServiceStub,
  sourceServerManagementServiceStub,
  taskGroupServiceStub,
  usageStatsServiceStub,
  windowControllerServiceStub,
} from './root-mount-stubs.js';

function wrapProbe(service: unknown, channel: string): unknown {
  if (process.env.ZS2_PROBE !== '1') return service;
  return new Proxy(service as object, {
    get(target, prop, receiver) {
      const val = Reflect.get(target as object, prop, receiver);
      if (typeof val === 'function') {
        return (...args: unknown[]) => {
          const fs = require('node:fs');
          const logPath = 'D:/AI_Projects/harness2-zs1-build/zs2-probe.log';
          try {
            fs.appendFileSync(
              logPath,
              `[probe] ${channel}.${String(prop)} called args=${JSON.stringify(args).slice(0, 500)}\n`,
            );
          } catch {}
          const res = (val as (...a: unknown[]) => unknown).apply(target as object, args);
          // log async result if promise
          if (res && typeof (res as { then?: unknown }).then === 'function') {
            return Promise.resolve(res)
              .then((r: unknown) => {
                try {
                  fs.appendFileSync(
                    logPath,
                    `[probe] ${channel}.${String(prop)} result=${JSON.stringify(r).slice(0, 5000)}\n`,
                  );
                } catch {}
                return r;
              })
              .catch((e: unknown) => {
                try {
                  fs.appendFileSync(
                    logPath,
                    `[probe] ${channel}.${String(prop)} threw=${String((e as { message?: unknown })?.message ?? e).slice(0, 300)}\n`,
                  );
                } catch {}
                throw e;
              });
          }
          try {
            fs.appendFileSync(
              logPath,
              `[probe] ${channel}.${String(prop)} result=${JSON.stringify(res).slice(0, 5000)}\n`,
            );
          } catch {}
          return res;
        };
      }
      return val;
    },
  });
}

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
export interface Harness2ServicesOptions {
  home?: string;
  dataRoot?: string;
}

export function createHarness2Services(opts: Harness2ServicesOptions = {}): Harness2ServicesResult {
  const home = opts.home ?? process.env.HARNESS2_HOME;
  const dataRoot = opts.dataRoot ?? process.env.HARNESS2_DATA_ROOT;

  const sharedEmitter = new Emitter<unknown>();
  const realFileService = createFileService({ dataRoot, home });
  const realSessionService = createSessionService({ dataRoot, home });
  const realTaskService = createTaskService({ dataRoot, home, emitter: sharedEmitter });
  const realAgentService = createAgentService({ dataRoot, home, emitter: sharedEmitter });
  const realModelSelectionService = createModelSelectionService({ dataRoot, home });
  const realProviderSettingsService = createProviderSettingsService({ dataRoot, home });
  const realSettingsStore = createSettingsStore({ dataRoot, home });
  const realSettingService = createStubService<ISettingService>({
    channelName: 'setting',
    classification: 'A',
    impl: {
      async get() {
        return realSettingsStore.get();
      },
      async update(p: unknown) {
        return realSettingsStore.update(p as never);
      },
      async updateDataBaseDir() {
        throw new Error('ZS2: not implemented');
      },
    },
    throws: [],
  });

  const EXPLICIT_STUBS = new Map<string, unknown>([
    [IBroadcastService.channelName, broadcastServiceStub],
    [IBotsService.channelName, botsServiceStub],
    [ICodingPlanSubscriptionService.channelName, codingPlanSubscriptionServiceStub],
    [ICommandsService.channelName, commandsServiceStub],
    [ICredentialService.channelName, credentialServiceStub],
    [IFileService.channelName, realFileService],
    [IHooksService.channelName, hooksServiceStub],
    [IMarketingTouchService.channelName, marketingTouchServiceStub],
    [IMemoryService.channelName, memoryServiceStub],
    [IModelSelectionService.channelName, realModelSelectionService],
    [IOnboardingRecordService.channelName, onboardingRecordServiceStub],
    [IOAuthService.channelName, oauthServiceStub],
    [IProjectService.channelName, createProjectService({ home })],
    [IPromptAttachmentTransferService.channelName, createLocalPromptAttachmentTransferService()],
    [IProviderSettingsService.channelName, realProviderSettingsService],
    [IRemoteProjectService.channelName, remoteProjectServiceStub],
    [ISettingService.channelName, realSettingService],
    [ISkillsService.channelName, skillsServiceStub],
    [ISourceServerManagementService.channelName, sourceServerManagementServiceStub],
    [ISubagentsService.channelName, subagentsServiceStub],
    [ITaskGroupService.channelName, taskGroupServiceStub],
    [IUsageStatsService.channelName, usageStatsServiceStub],
    [IWindowControllerService.channelName, windowControllerServiceStub],
    [IZCodeAgentService.channelName, realAgentService],
    [IZCodeSessionService.channelName, realSessionService],
    [IZCodeTaskService.channelName, realTaskService],
  ]);

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
    services.register(descriptor as never, wrapProbe(stub, entry.channel));
    registeredChannels.push(entry.channel);
  }
  return { services, registeredChannels };
}
