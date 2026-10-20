/**
 * root-mount-stubs —— Root 挂载期 9 服务 + 空态路径实证触达方法的显式桩
 *
 * 空态调用面实证来源：Task 1 原版 boot log（zs1-t1-boot2.log，19 个 channel.method）+
 * 编排者 A 类映射研究（docs/research/2026-10-20-zs-a-class-mapping.md §Root 挂载）。
 * 形状全部经 TS 接口类型对齐（编译期兜底）。
 *
 * 设计决策（登记）：
 * - A 类读路径返回空态形状、写路径 throw（假成功比 throw 危险）；
 * - C 类读路径返回空值（入口显示空数据，符合红线⑩「不留可点必炸」），
 *   动作路径（登录/支付/连接）throw——空数据下这些入口自然不可达；
 * - B 类除空态实证触达的方法外全部 throw。
 */
import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
  DynamicWorkflowClientConfig,
  MarketingTouchSnapshot,
  OAuthCachedSessionRestoreResult,
  SourceServerManagementSnapshot,
  UserInfo,
  ZCodeTaskMeta,
} from '@zcode/shared';
import type {
  ControllerSubscribeResult,
  ControllerResyncParams,
  ControllerSubscribeParams,
  ControllerUnsubscribeParams,
  WindowHostTaskAddress,
} from '@zcode/shared/zcode-protocol-v4';
import type {
  IBroadcastService,
  IBotsService,
  ICodingPlanSubscriptionService,
  ICredentialService,
  IModelSelectionService,
  IOnboardingRecordService,
  IMarketingTouchService,
  IOAuthService,
  IProjectService,
  IProviderSettingsService,
  IRemoteProjectService,
  ISettingService,
  ISourceServerManagementService,
  ITaskGroupService,
  IUsageStatsService,
  IWindowControllerService,
  IZCodeAgentService,
  ModelSelectionView,
  OffPeakClientConfig,
  ProjectTree,
  ProviderSettingsView,
  RemoteProjectDirectory,
  TaskGroupStructure,
  VirtualProject,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from '@zcode/services';
import { createStubService } from './stub-factory.js';
// ── A 类：Root 挂载 9 服务之 setting / credential / provider-settings / model-selection ──
const settingServiceImpl: Pick<ISettingService, 'get'> = {
  // Root.tsx:397-399 用 !== false / === true 判定，undefined 均有缺省语义。
  // providerFamilyDomain（编排者 2026-10-20 指示：harness2 无账户体系、壳不得有登录门）：
  // 登录门判据 `!providerFamilyDomain || (!user && !hasUsableProvider)`（useProviderAvailabilityLoginEntryGuard）
  // 要求该字段非空才可能关门；类型只有 "zai"|"bigmodel" 两值，取 "zai" 占位（ZS4/ZS6 正式隐藏账户面）。
  // workspaceShellPath 驱动：通过 lastWorkspaceSession 恢复一个默认会话工作区 tab，
  // 使 Root.tsx:1551 的 `if (!workspaceShellPath) return null` 死角被绕过，主壳空工作区渲染。
  async get(): Promise<AppSettings> {
    return {
      recentProjects: [],
      locale: 'en-US',
      providerFamilyDomain: 'zai',
      providerFamilyDomainMigrated: true,
      onboardingOccupation: 'other',
    };
  },
};
/** A: 映射 core settings ZS2+；读空态形状，写 throw */
export const settingServiceStub: ISettingService = createStubService<ISettingService>({
  channelName: 'setting',
  classification: 'A',
  impl: settingServiceImpl,
  throws: ['update', 'updateDataBaseDir'],
});

const credentialServiceImpl: Pick<ICredentialService, 'load'> = {
  async load(): Promise<string | null> {
    return null; // 未登录：无凭据
  },
};
/** A: 映射 core auth.json ZS2+ */
export const credentialServiceStub: ICredentialService = createStubService<ICredentialService>({
  channelName: 'credential',
  classification: 'A',
  impl: credentialServiceImpl,
  throws: ['save', 'delete'],
});

const emptyProviderSettingsView: ProviderSettingsView = {
  revision: 0,
  providerTemplates: [],
  providerOrder: [],
  providers: [],
};
const providerSettingsServiceImpl: Pick<IProviderSettingsService, 'getView' | 'refresh'> = {
  async getView(): Promise<ProviderSettingsView> {
    return emptyProviderSettingsView;
  },
  async refresh(): Promise<ProviderSettingsView> {
    return emptyProviderSettingsView;
  },
};
/** A: 映射 core provider/ ZS2+；空 view（无 provider） */
export const providerSettingsServiceStub: IProviderSettingsService = createStubService<IProviderSettingsService>({
  channelName: 'provider-settings',
  classification: 'A',
  impl: providerSettingsServiceImpl,
  throws: [
    'createPersonalProvider',
    'savePersonalProviderOverlay',
    'deletePersonalProvider',
    'reorderPersonalProviders',
    'reorderPersonalModels',
    'addPersonalModel',
    'renamePersonalModel',
    'deletePersonalModel',
    'savePersonalModelDraft',
    'setPersonalModelEnabled',
    'testModelConnectivity',
  ],
});

const modelSelectionServiceImpl: Pick<IModelSelectionService, 'getView'> = {
  async getView(): Promise<ModelSelectionView> {
    return { revision: 0, providers: [] }; // 无 provider → UI 落 WelcomeScreen
  },
};
/** A: 映射 core provider/ ZS2+ */
export const modelSelectionServiceStub: IModelSelectionService = createStubService<IModelSelectionService>({
  channelName: 'model-selection',
  classification: 'A',
  impl: modelSelectionServiceImpl,
});

// ── B 类空态触达：zcode-agent / broadcast / window-controller / project / task-groups ──

const zcodeAgentServiceImpl: Pick<IZCodeAgentService, 'syncAppRuntimePreferences'> = {
  // Root.tsx:396-411 空态初始化运行时偏好；ZS1 无 agent runtime，静默接受
  async syncAppRuntimePreferences(): Promise<void> {},
};
/** B: v4 conversation 竖切 ZS2/ZS3（最大项）；syncAppRuntimePreferences 空态 void */
export const zcodeAgentServiceStub: IZCodeAgentService = createStubService<IZCodeAgentService>({
  channelName: 'zcode-agent',
  classification: 'B',
  impl: zcodeAgentServiceImpl,
});

const broadcastServiceImpl: Pick<IBroadcastService, 'send' | 'tryClaim'> = {
  // ZS1 单窗口：send 丢弃（无接收者）、tryClaim 恒 true（无竞争者）；
  // acquireClaim/commitClaim/releaseClaim 走 throws（跨窗口 claim 能力不可用，显式失败）
  async send(): Promise<void> {},
  async tryClaim(): Promise<boolean> {
    return true;
  },
};
/** B: 跨窗口广播；onMessage 永不触发（工厂默认 Event.None） */
export const broadcastServiceStub: IBroadcastService = createStubService<IBroadcastService>({
  channelName: 'broadcast',
  classification: 'B',
  impl: broadcastServiceImpl,
  throws: ['acquireClaim', 'commitClaim', 'releaseClaim'],
});

const windowControllerServiceImpl: {
  listTaskList(params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerSubscribeResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  getTaskMeta(params: { address: WindowHostTaskAddress }): Promise<ZCodeTaskMeta | null>;
} = {
  async listTaskList(): Promise<WindowHostControllerTaskListResult> {
    return { items: [], total: 0, hasMore: false }; // 空任务列表
  },
  async subscribeControllerV4(): Promise<ControllerSubscribeResult> {
    return {
      ack: { subscriptionId: `zs1-${randomUUID()}`, mode: 'snapshot', logEpoch: 'zs1-stub' },
    };
  },
  async resyncControllerV4(): Promise<ControllerSubscribeResult> {
    return {
      ack: { subscriptionId: `zs1-${randomUUID()}`, mode: 'snapshot', logEpoch: 'zs1-stub' },
    };
  },
  async unsubscribeControllerV4(): Promise<void> {},
  async getTaskMeta(): Promise<null> {
    return null;
  },
};
/** B: 窗口聚合投影；空态方法空形状（boot log 高频触达），变更动作 throw */
export const windowControllerServiceStub: IWindowControllerService = createStubService<IWindowControllerService>({
  channelName: 'window-controller',
  classification: 'B',
  impl: windowControllerServiceImpl,
  throws: ['mutateTask', 'deleteArchivedTask', 'deleteArchivedTasks'],
});

const projectServiceImpl: {
  readTree(params?: { includeDeleted?: boolean; includeDeletedTasks?: boolean; hostId?: string }): Promise<ProjectTree>;
  readProjects(params?: { includeDeleted?: boolean; hostId?: string }): Promise<VirtualProject[]>;
  resolveSessionDirectories(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }, hostId?: string): Promise<{ workspacePath: string; workspaceIdentity?: string; additionalDirectories: string[]; projectId: string | null }>;
} = {
  async readTree(): Promise<ProjectTree> {
    return { projects: [], tasks: [] }; // 空项目树
  },
  async readProjects(): Promise<VirtualProject[]> {
    return [];
  },
  async resolveSessionDirectories(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }): Promise<{ workspacePath: string; workspaceIdentity?: string; additionalDirectories: string[]; projectId: string | null }> {
    return {
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      additionalDirectories: [],
      projectId: null,
    };
  },
};
/** B: 项目树；readTree/readProjects 空态空形状（boot log 3 次触达） */
export const projectServiceStub: IProjectService = createStubService<IProjectService>({
  channelName: 'project',
  classification: 'B',
  impl: projectServiceImpl,
});

const taskGroupServiceImpl: Pick<ITaskGroupService, 'read'> = {
  async read(): Promise<TaskGroupStructure> {
    return { groups: [], members: [], order: [] };
  },
};
/** B: 任务分组；read 空态空结构（boot log 2 次触达） */
export const taskGroupServiceStub: ITaskGroupService = createStubService<ITaskGroupService>({
  channelName: 'task-groups',
  classification: 'B',
  impl: taskGroupServiceImpl,
});

// ── C 类空态触达：oauth / coding-plan-subscription / bots / remote-projects / source-server-management / marketing-touch ──

/** harness2 本地身份（无账户体系；编排者 2026-10-20 指示「无登录门」的桩身份） */
const harness2LocalUserInfo: UserInfo = {
  id: 'harness2-local',
  username: 'harness2',
  displayName: 'harness2',
};

const oauthServiceImpl: Pick<
  IOAuthService,
  'getProviders' | 'getActiveProvider' | 'restoreCachedSession' | 'restoreCachedSessionState' | 'restoreSession'
> = {
  async getProviders(): Promise<[]> {
    return []; // 无可用 OAuth provider（harness2 无账户体系）
  },
  async getActiveProvider(): Promise<null> {
    // null：refreshRestoredOAuthProviderFamilyAfterStartup 对 null 直接返回，
    // 不触发 family selection 写入（setting.update 是 throw 桩）
    return null;
  },
  async restoreCachedSession(): Promise<UserInfo> {
    return harness2LocalUserInfo;
  },
  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    // 编排者 2026-10-20 指示：无登录门——桩报告稳定的「已登录·本地身份」，
    // 使 useProviderAvailabilityLoginEntryGuard 判 shouldOpenLoginEntry=false，
    // UI 跳过 WelcomeScreen 直达主壳空工作区。onDidChangeSession 永不触发（身份恒定）。
    return { status: 'authenticated', userInfo: harness2LocalUserInfo };
  },
  async restoreSession(): Promise<UserInfo> {
    return harness2LocalUserInfo;
  },
};
/** C: ZCode OAuth；读路径未登录态；登录动作 throw（ZS2 映射 core auth 或 ZS6 隐藏） */
export const oauthServiceStub: IOAuthService = createStubService<IOAuthService>({
  channelName: 'oauth',
  classification: 'C',
  impl: oauthServiceImpl,
  throws: [
    'startOAuth',
    'startOAuthWithPolling',
    'pollPendingOAuth',
    'handleCallback',
    'refreshToken',
    'logout',
    'logoutAll',
    'cancelPending',
  ],
});

const disabledDynamicWorkflowConfig: DynamicWorkflowClientConfig = {
  mode: 'disabled',
  enabled: false,
  source: 'default',
  offeredMode: 'disabled',
};
const codingPlanSubscriptionServiceImpl: Pick<
  ICodingPlanSubscriptionService,
  | 'getDynamicWorkflowClientConfig'
  | 'getOffPeakClientConfig'
  | 'getStaticProducts'
  | 'getStaticTeamProducts'
  | 'getStartPlanPreview'
  | 'getBillingDiscount'
  | 'getRequestVerificationConfig'
  | 'getForceUpdateConfig'
> = {
  // fail-closed：动态工作流关闭（红线⑩——不暴露未实现入口）
  async getDynamicWorkflowClientConfig(): Promise<DynamicWorkflowClientConfig> {
    return disabledDynamicWorkflowConfig;
  },
  async getOffPeakClientConfig(): Promise<OffPeakClientConfig> {
    return { enabled: false, modelSelectionView: { revision: 0, providers: [] } };
  },
  async getStaticProducts(): Promise<Record<string, never>> {
    return {}; // CodingPlanStaticProductsConfig = Partial<...>，空对象合法
  },
  async getStaticTeamProducts(): Promise<Record<string, never>> {
    return {};
  },
  async getStartPlanPreview(): Promise<null> {
    return null;
  },
  async getBillingDiscount(): Promise<undefined> {
    return undefined;
  },
  async getRequestVerificationConfig(): Promise<null> {
    return null;
  },
  async getForceUpdateConfig(): Promise<null> {
    return null;
  },
};
/** C: 订阅购买；读路径空数据（订阅页显示空产品 → 无可点支付入口），支付动作 throw */
export const codingPlanSubscriptionServiceStub: ICodingPlanSubscriptionService =
  createStubService<ICodingPlanSubscriptionService>({
    channelName: 'coding-plan-subscription',
    classification: 'C',
    impl: codingPlanSubscriptionServiceImpl,
    throws: [
      'batchPreview',
      'getManualClaimPlanPreviews',
      'claimManualPlan',
      'getModelContextBudgetStrategy',
      'productInfo',
      'preview',
      'createSign',
      'updateSign',
      'checkPayment',
      'checkPendingOrders',
      'queryStripeCards',
      'bindStripeCard',
      'unbindStripeCard',
      'payStripe',
      'checkPaypalSupport',
      'createPaypalSetupToken',
      'subscribePaypal',
      'getEnterprisePricing',
      'getEnterpriseBalance',
      'calculateEnterpriseOrder',
      'createEnterpriseOrder',
      'getEnterprisePendingOrders',
      'cancelEnterpriseOrder',
      'continueEnterpriseOrderPayment',
      'checkEnterpriseOrderStatus',
    ],
  });

const botsServiceImpl: Pick<IBotsService, 'syncAppRuntimePreferences'> = {
  async syncAppRuntimePreferences(): Promise<void> {},
};
/** C: ZCode 绑定码体系（≠harness2 gateway QQ bot）；syncAppRuntimePreferences 空态 void */
export const botsServiceStub: IBotsService = createStubService<IBotsService>({
  channelName: 'bots',
  classification: 'C',
  impl: botsServiceImpl,
});

const remoteProjectsServiceImpl: Pick<IRemoteProjectService, 'readDirectory'> = {
  async readDirectory(): Promise<RemoteProjectDirectory> {
    return { hosts: [], entries: [] }; // 空目录（boot log 空态 6 次触达）
  },
};
/** C: 远程 host 体系；readDirectory 空目录；连接动作 throw（ZS6 隐藏清单项） */
export const remoteProjectServiceStub: IRemoteProjectService = createStubService<IRemoteProjectService>({
  channelName: 'remote-projects',
  classification: 'C',
  impl: remoteProjectsServiceImpl,
  throws: ['connectHost', 'saveHost', 'bindHost', 'removeHost', 'addEntry', 'refreshEntry', 'removeEntry'],
});

const emptySourceServerSnapshot: SourceServerManagementSnapshot = {
  generation: 0,
  profiles: [],
  servers: [],
  workspaceHistory: [],
  states: [],
  failedPathCount: 0,
  abandonedPathCount: 0,
  migrationCounts: [],
};
const sourceServerManagementServiceImpl: Pick<ISourceServerManagementService, 'getSnapshot'> = {
  async getSnapshot(): Promise<SourceServerManagementSnapshot> {
    return emptySourceServerSnapshot;
  },
};
/**
 * C: Source Server 管理。getSnapshot 空（boot log 空态 4 次触达——renderer 侧
 * RemoteServiceAccess 恒提供代理，不注册频道会 RPC 报错，故必须注册；
 * 与映射详表「accessor 可不提供」的差异见计划执行记录登记）。
 */
export const sourceServerManagementServiceStub: ISourceServerManagementService =
  createStubService<ISourceServerManagementService>({
    channelName: 'source-server-management',
    classification: 'C',
    impl: sourceServerManagementServiceImpl,
  });

const marketingTouchServiceImpl: Pick<IMarketingTouchService, 'query' | 'report'> = {
  async query(input: { locale: 'zh-CN' | 'en-US' }): Promise<MarketingTouchSnapshot & { scope: string }> {
    return {
      serverTime: 0,
      language: input.locale,
      deliveries: [],
      rejectedCount: 0,
      scope: 'zs1-stub',
    };
  },
  async report(): Promise<void> {},
};
/** C: 运营位；query 空快照（无投放），report 静默 void */
export const marketingTouchServiceStub: IMarketingTouchService = createStubService<IMarketingTouchService>({
  channelName: 'marketing-touch',
  classification: 'C',
  impl: marketingTouchServiceImpl,
});

// ── C 类：onboarding 记录（显式桩——契约表 §5：shouldOnboard 必须为 false） ──
//
// 工厂默认返回 null 会被 useOnboardingTrigger 当 resolved 值直通，导致
// needsOnboarding === null → OccupationOnboarding.tsx:131 null 死角 → 灰屏。
// 显式返回 false/null/void 才能跳过全屏引导、渲染 children。

const onboardingRecordServiceImpl: Pick<
  IOnboardingRecordService,
  | 'claimAnonymousRecord'
  | 'shouldOnboard'
  | 'getLatestEntry'
  | 'appendRecord'
  | 'dismissOnboarding'
  | 'syncSettingsFromRecord'
  | 'updateRecordPreferences'
  | 'getRecords'
  | 'clearRecords'
> = {
  async claimAnonymousRecord(): Promise<void> {},
  async shouldOnboard(): Promise<boolean> {
    return false;
  },
  async getLatestEntry(): Promise<null> {
    return null;
  },
  async appendRecord(): Promise<void> {},
  async dismissOnboarding(): Promise<void> {},
  async syncSettingsFromRecord(): Promise<null> {
    return null;
  },
  async updateRecordPreferences(): Promise<void> {},
  async getRecords(): Promise<null> {
    return null;
  },
  async clearRecords(): Promise<void> {},
};

/** C: ZCode onboarding 记录；shouldOnboard 显式 false（契约表 §5） */
export const onboardingRecordServiceStub: IOnboardingRecordService = createStubService<IOnboardingRecordService>({
  channelName: 'onboarding-record',
  classification: 'C',
  impl: onboardingRecordServiceImpl,
});

// ── 其余频道：按分类走工厂默认（A/C 读 null；B throw；事件 Event.None） ──

/** C: 用量快照；空态不触达（boot log 实证），默认 null，T3 实测兜底 */
export const usageStatsServiceStub: IUsageStatsService = createStubService<IUsageStatsService>({
  channelName: 'usage-stats',
  classification: 'C',
});
