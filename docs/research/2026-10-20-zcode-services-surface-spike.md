# ZCode services 契约面盘点（「ZCode 壳 + harness2 内心」迁移 spike）

> **性质：** 只读研究 spike 报告（ZS0 交付物）
> **执行：** 只读 Explore 子代理（编排者派发），2026-10-20
> **对象：** ZCode v3.16.2（`3c5b2276`，D:/AI_Projects/refs/ZCode，Apache-2.0）
> **用途：** 为「保留 ZCode UI 壳、后端换 harness2 core」提供耦合面数据与可行性判断；迁移总纲见 `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md`

**核心结论（一句话）**：UI 与后端的全部耦合收敛在一个 browser-safe 的 TypeScript 接口 `IServiceAccessor`（约 60 个 service 属性）+ 一套 VS Code 风格的 RPC 通道抽象上；传输层可插拔（进程内 / MessagePort / WebSocket / stdio 共用同一接口），因此 harness2 只需**按 descriptor 频道名实现这 60 个 service 接口**并挂到任意 ChannelServer 上，UI 壳即可复用——工作量大头在 `IZCodeAgentService`/`IZCodeTaskService` 两个巨型门面（会话+流+MCP+插件+自动化+工作流全在里面）。

---

## 1 服务使用清单

import `@zcode/services` 的文件：**packages/ui/src 222 个，packages/desktop/src 62 个**。UI 侧不直接 new 服务，统一经 React Context 拿 `IServiceAccessor`（`packages/ui/src/hooks/useServices.tsx:34` `useServices()`；`ServiceProvider` 注入）。desktop 侧主要是 host 装配（注册实现）而非消费。

按 services 目录分组（「引用数」= ui+desktop 中 import 该符号的文件数，粗计）：

| 分组 | 被引用的接口/类型 | 引用数 | 用途 |
|---|---|---|---|
| (根) | `IServiceAccessor` | 45 | 服务门面类型本体 |
| zcode-agent/ | `IZCodeAgentService` | 22 | 会话/流/MCP/插件/自动化/工作流总门面（UI 最大耦合点） |
| model-provider/ | `ProviderSettingsView` 19、`ModelSelectionView` 18、`IProviderSettingsService` 6、`IModelSelectionService` 3 | ~46 | Provider 配置与模型选择视图（设置页/模型选择器） |
| feedback/ | `IFeedbackService` 11、`FeedbackUploadProgress` | 12 | 工单创建/列表/附件上传 |
| source-server-management/ | `ISourceServerManagementService` 9、`UpdateConnectionProfileInput` | 10 | 远程 Server 连接档案管理 |
| usage-stats/ | `IUsageStatsService` | 8 | 用量/订阅额度快照 |
| session/ | `IZCodeTaskService` 6、`ZCodeModelTrajectory*` 7、`IOffPeakTaskService`、`isValidCronExpr`、`SessionRealtimePort` | ~16 | task 包装、模型轨迹、闲时任务、实时口 |
| zcode-session/ | `IZCodeSessionService` | 3 | app 侧会话 facade |
| broadcast/ | `BroadcastMessage` 6、`IBroadcastService` 4 | 10 | 跨窗口/跨端广播 |
| plugins/ + plugin-ui-bridge/ | `IPluginManagementService` 4、`PluginUiPluginScope` 4、`IPluginUiBridgeService` 3、`IPluginsService`、`IPluginUiSamplingService`、`IPluginUiAppToolsService`、`withPluginTelemetry` 2 | ~16 | 插件管理、插件 UI 沙箱桥 |
| coding-plan-subscription/ | `ICodingPlanSubscriptionService` | 4 | 订阅购买/状态 |
| client-scenes/ | `IClientScenesService` 3、`ClientSceneConfig/Item` | 5 | 客户端场景配置（运营下发） |
| bots/ | `IBotsService` 3、`BotRemoteWorkspaceResolver` | 4 | Bot 绑定码/远程工作区 |
| subagents/ | `ISubagentsService` | 3 | 子代理开关/模型覆盖 |
| hooks/ | `IHooksService` | 3 | Hooks 管理 |
| file/ + fileWatcher/ | `IFileService` 3、`IFileWatcherService` 3 | 6 | 文件浏览/搜索/读片、fs 监视 |
| cua-permission-broker/ | `isCuaPermissionStatusAvailable` 4、`CuaPermissionStatus*` 3 | ~8 | macOS Computer Use 权限 |
| credential/ | `ICredentialService` | 2 | key-value 凭据 |
| commands/ | `ICommandsService` | 2 | 斜杠命令文件管理 |
| git/ | `IGitService` | 2 | Git 状态/diff/分支 |
| oauth/ | `IOAuthService` | 2 | OAuth 登录 |
| mcp-sync/ skill-sync/ plugin-sync/ | `IMcpSyncService` 2、`ISkillSyncService`、`IPluginSyncService` | 4 | SSH 远端同步 |
| skills/ | `ISkillsService` | 2 | Skills 列表/开关 |
| conversation-share/ | `ConversationShareFailureIssue` 2、`ConversationSharePreflightResult`、`IConversationShareService` | 4 | 会话分享发布/导入 |
| project/ remote-projects/ project-catalog/ | `VirtualProject` 2、`ProjectTree`、`RemoteProjectHost/Directory`、`readProjectCatalog` | ~6 | 项目树/虚拟项目/远程项目 |
| storage/ | `StorageRootSpec` 2、`StorageScanProgress` 2、`runStorageScan`、`IStorageService` | 6 | 资源管理器「存储」tab |
| memory/ | `IMemoryService` | 1 | agent 记忆文件读写 |
| 其余单点 | `ISettingService` 6、`ISettingsSyncService`、`IGenUiService`、`IMediaPreviewService`、`ICloudContentService`、`IMarketingTouchService`、`IPromptAttachmentTransferService`、`IWindowControllerService`、`IHighspeedCardService`、`IOffPeakTaskService`、`IProviderProvisioningTargetService`、`IOnboardingRecordService`、`IOutputStyleService`、`ITaskGroupService`、`IProjectService`、`IRemoteProjectService`、`ITerminalService`、`ISystemService`、`IGitCheckpointService` | 各 1-6 | 设置、同步、媒体预览、附件传输、窗口控制、高速卡等 |
| 路径/环境工具 | `getAppConfigDir` 4、`getZCodeDataRootDir` 3、`setDataBaseDir`、`resolveDefaultZCodeAgentCommand`、`prepareTasksIndexStorage` | ~10 | 配置目录/数据根目录（desktop 装配用） |

完整频道名清单见 `packages/shared/src/channels.ts:91-175`（`ServiceChannels`，约 55 个字符串频道）。

## 2 重点服务的形状

**`IZCodeAgentService`**（`packages/services/src/zcode-agent/zcodeAgent.ts:620-920+`，约 100 个方法，UI 引用最多）：

- 存储/运行时：`prepareStorage(target)`、`initialize(target)`、`getStorageStartupState`、`onDynamicStorageStartupState(target): Event`
- 会话：`createSession(params): Promise<ZCodeSessionStateSnapshot>`、`resumeSession`、`listSessions`、`readSession`、`readSessionMessages`、`readSessionEvents`、`listSessionSubagents`
- 写路径：`sendPrompt(params)`（deprecated，收敛 v4）、`compactSession`、`goalSession`、`closeSession`、`setModel/setMode/setThoughtLevel`
- **v4 conversation 竖切通道**（当前主路径）：`helloConversationV4()`、`initializeConversationV4(clientHello)`、`subscribeConversationV4(params)`、`resyncConversationV4`、`unsubscribeConversationV4`、`conversationRowsRangeV4`（行分页 loadOlder）、`conversationPlansV4`、`conversationWorkflowRunEventsV4/RunsV4/ArtifactsV4/ArtifactDataV4/ArtifactReadV4`
- MCP：`listMcpServerStatuses`、`readMcpResource`、`sampleMcpApp/cancelMcpAppSampling`、`callMcpToolForUi`、`readMcpResourceForUi/listMcpResourcesForUi/subscribeMcpResourceForUi`、App-Provided Tools（`registerAppToolsForUi/claimAppToolCallForUi/resolveAppToolCallForUi`）
- 插件：`listPlugins/installPlugin/uninstallPlugin/updatePlugin/setPluginEnabled/addPluginMarketplace…`（约 15 个）
- 自动化：`listAutomations/createAutomation/updateAutomation/deleteAutomation/runAutomationNow/listAutomationRuns…`（约 10 个）
- 保存工作流：`listSavedWorkflows/getSavedWorkflow/updateSavedWorkflowMeta/moveSavedWorkflow/saveSavedWorkflowFromRun…`
- 事件：`onDynamicSessionEvent`（旧协议，deprecated）、`onDynamicProviderRuntimeHeadersRequest`、`onDynamicWorkspaceProviderRuntimeHeadersRequest`、`onDynamicProcessResourceSample`、`onDynamicMcpTelemetry` 等

**`IZCodeSessionService`**（`zcode-session/zcodeSession.ts:142-168`，agent 服务的 app 命名 facade）：`initializeWorkspace`、`createSession/resumeSession/listSessions/readSession/readSessionMessages/readSessionEvents`、`promoteDeferredDraftSession/closeSession/closeDeferredDraftSession`、`setModel/setThoughtLevel/setMode`、`respondProviderRuntimeHeaders`。

**`IZCodeTaskService`**（`session/zcodeTaskService.ts:185-777`，task 列表/派发包装）：

- `initialize({workspacePath})`、`createTask({workspacePath, modelSelection, forkedFromTaskId, …}): Promise<ZCodeTaskCreateResult>`、`releaseWorkspacePreparation`
- `sendPrompt({taskId, content, attachments, modelSelection, toolDenylist, …})`、`enqueueTaskCommand`、`deliverSessionMessage`
- 轨迹：`getModelTrajectory(params): Promise<ZCodeModelTrajectory>`（:638）
- 事件：`onDynamicStreamEvent(taskId): Event<ZCodeStreamEvent>`（:745）、`onDynamicTaskTerminalOutcome`、`onDynamicTaskReady`、`onDynamicTaskEvent({workspacePath, taskId, deliveryKind})`、`onDynamicWorkspaceEvent`、`onError`
- 可选 Bot 群输入面：`submitBotGroupInput/cancelBotGroupInput` 等

**`SessionRealtimePort`**（`session/sessionRealtimePort.ts:14-40`，审批/交互的实时口）：`publish(TaskRealtimeEvent)`、`requestOwnerCommand(stop_generation | respond_permission | respond_elicitation | respond_workspace_hook_review | enqueue_task_command | …)`、`onDidReceiveEvent`、`acquireTaskRunLease` —— **这是审批流（permission）、澄清（elicitation）、hook 审阅的服务器侧契约**。

**`IFileService`**（`file/file.ts:21-66+`）：`searchWorkspaceFiles`、`readdir`、`stat`、`checkFilesExist`、`resolvePath`、`ensureConversationWorkspace/createDefaultWorkspace/createScratchWorkspace`、`readTextFile({path, offset, length})`、`readFileRange(...): Promise<Uint8Array>`、`readMediaPreview/readBinaryPreview`、`listWorkspaceFilesLength/listWorkspaceFilesRange`（列式打包分块拉取，性能关键设计）。

**`ICommandsService`**（`commands/commands.ts:13-26`）：`list({agentSource, workspacePath})`、`writeCommandFile/updateCommandFile/deleteCommandFile/setCommandEnabled/getPrimaryUserCommandsDirectory`。

**`ICredentialService`**（`credential/credential.ts:11-15`）：`load(key)/save(key,value)/delete(key)` —— 极小，3 方法。

**`ISettingService`**（`setting/setting.ts:11-25`）：`get(): Promise<AppSettings>`、`update(patch, expected?)`、`updateDataBaseDir(newDir)`。

**`IFeedbackService`**（`feedback/feedback.ts:25+`）：`create/cancelCreate/list/get/comment/uploadAttachment*/onDynamicUploadProgress`。

**`IUsageStatsService`**（`usage-stats/usageStats.ts:21-35`）：`getAppUsageSnapshot/getCodingPlanUsageSnapshot/getCodingPlanResetStatus/useCodingPlanReset/getSnapshot/getEntitlementSnapshot`。

**小而重要**：`ISubagentsService`（`subagents.ts:15`：list/setEnabled/setBuiltInModelOverride）、`IMemoryService`（`memory.ts:26`：loadMemory/saveMemory）、`ISkillsService`（`skills.ts:5`：list/setEnabled）。

## 3 UI↔后端的传输层

**机制：VS Code 式 RPC + 服务自动代理，UI 拿到的永远是同一个 `IServiceAccessor` 对象，传输可插拔。**

- **服务标识**：每个 service 是一个 `ServiceDescriptor = { channelName: string }`（`packages/services/src/descriptors.ts:8-16`，同名 interface+const 技巧）。频道名集中在 `packages/shared/src/channels.ts:91`。
- **服务端暴露**：`ServiceCollection.register(descriptor, instance)` + `exposeOnChannelServer(server, overrides, exposurePolicy)`（`packages/services/src/collection.ts:34`）——内部用 `ProxyChannel.fromService(service)` 把方法映射为 `channel.call`、`on*` 映射为 `channel.listen`（`packages/rpc/src/proxy-channel.ts:30`）。
- **客户端获取**：`packages/client/src/remoteServiceAccess.ts:68` `RemoteServiceAccess implements IServiceAccessor`——约 60 个 getter，每个是 `ProxyChannel.toService(channelClient.getChannel(descriptor.channelName))`（ES6 Proxy 拦截，调用像本地方法）。**新增服务只需加一个 getter**。
- **rpc 分层**（`packages/rpc/src/index.ts:1-36` 注释）：序列化(VQL) → MessagePortProtocol/SocketProtocol → ChannelServer/ChannelClient → IPCServer/IPCClient → ProxyChannel → Remote(PersistentProtocol)。二进制走顶层 Uint8Array 原始字节通道（见 file.ts:37-41 注释）。
- **桌面端链路**：main 进程 `electronUtilityProcess.fork(hostModulePath)` 每窗口一个 host 进程（`packages/desktop/src/main/desktopHostProcess.ts:251`）→ host 入口 `packages/desktop/src/host/index.ts` 用 `createLocalServices`（`packages/services/src/node.ts:1178`，Node 侧装配全部实现）构建 `ServiceCollection`，在 MessagePort 上开 `ChannelServer`（host/index.ts:2577-2584），经 `exposeWindowHostAttachmentServices`（`host/windowHostAttachmentRpcPolicy.ts:82-111`，带 per-clientMode 曝光策略）发布 → preload 用 `window.postMessage` 把 MessagePort 转交 renderer（不能过 contextBridge）→ renderer `connectViaMessagePort(port)`（`packages/desktop/src/renderer/src/main.tsx:319-321` → `packages/client/src/messageport.ts:58`）得到 accessor。
- **Web 端**：`packages/web/src/main.tsx:2067` `connectViaWebSocket(bootstrap.wsUrl)` → 同一 `IServiceAccessor`，对端是 `packages/server` 的 HTTP 服务（`entry-http.ts`：`createServerHostServices` + `createHttpServer`，默认 3030，支持 authToken/staticRoot）。
- **stdio**：`entry-stdio.ts` 把 stdout 作为 RPC 帧通道（`createStdioServer` + hello/helloAck 握手），用于 SSH 远端 source server。**entry-http/entry-stdio 只被远程 server 部署引用（`packages/server/package.json`、`build-remote.ts`、`zcode-server-cli`），桌面端不经过它们**——桌面是 utilityProcess+MessagePort 直连。
- **含义（对迁移关键）**：UI 不关心传输。harness2 core 的 serve HTTP/WS 只要实现「ChannelServer 语义 + 60 个频道」，或更省事——**在 core 侧写一个 `ServiceCollection` 等价物直接进程内实现 `IServiceAccessor`**（web/tests 已有进程内先例，`ServiceProvider` 接受任意实现）。

## 4 启动依赖（最小可跑子集线索）

- **服务未就绪时的 UI**：desktop renderer 在拿到 ServicePort 前只渲染 `GlobalDatabaseStartupLoading`（数据库启动 loading/失败重试屏，`renderer/src/main.tsx:181-206`），**该屏零 service 依赖**；30s 超时显示 startup_status_timeout 错误态（:221-233）。即：壳层可以无后端渲染。
- **业务 Root 的门槛**：`RootProps` 必填 `services: IServiceAccessor` + `platform: IPlatformService`（`packages/ui/src/root/types.ts:54`）。Root 挂载即调用（`Root.tsx:253-416`）：`codingPlanSubscriptionService`、`sourceServerManagementService`（可选）、`oauthService`、`broadcastService.onMessage`、`zcodeAgentService.syncAppRuntimePreferences`、`botsService`、`modelSelectionService.getView()`、`providerSettingsService`、`settingService`（受 `supportsSettings` 开关）。
- **无工作区空态**：`workspaceShellPath` 为空时 Root 只渲染 `RootShell` + 弹窗或 null（`Root.tsx:1536-1554`）；登录收敛为 `WelcomeScreen`（Root.tsx:49,1238）。即**主界面骨架需要 accessor 对象存在，但聊天工作区才真正依赖 task/agent 服务**。
- **必填 vs 可选**：`IServiceAccessor`（`accessor.ts:58-124`）必填约 38 个，可选约 20 个（project/remoteProject/taskGroup/window*/cua/mediaPreview/cloudContent/marketing/onboarding/sourceServerManagement/genUi/pluginUi* 三件套）。**但客户端 `RemoteServiceAccess` 是懒失败**：代理对象总是存在，服务端缺频道只在真正调用时抛错——所以「最小可跑」实际由 Root 挂载期调用的上面那 9 个 + 渲染工作区所需（zcodeTaskService.createTask/list、zcodeAgentService v4 订阅、fileService、projectService）决定。

## 5 粗分类（对照 harness2 core，`packages/core/src` 目录实证）

**A. core 已有对应能力，写适配器映射到 ZCode 契约即可**：

- 会话 CRUD/读取：`IZCodeSessionService`、`IZCodeAgentService` 的 createSession/resumeSession/listSessions/readSession(Messages/Events) → core `session/`（writer/reader/manager/fork）
- 流式事件：`onDynamicStreamEvent/onDynamicTaskEvent`、v4 `subscribeConversationV4` → core `server/ws.ts` + 事件日志投影
- 审批/交互：`SessionRealtimePort.requestOwnerCommand(respond_permission/respond_elicitation)`、permission 事件 → core `approval/` + `interaction/approval-queue.ts`
- 工具调用展示（tool call/result 流事件）→ core `tools/`
- `IMemoryService` → core `memory/`；`ISkillsService` → `skills/`；`IHooksService` → `hooks/`；`ICommandsService` → `commands/`；`ISubagentsService` → `agent/subagent.ts`；自动化 → `cron/`；轨迹 `getModelTrajectory` → `trajectory/`；`ISettingService`/`ICredentialService` → `settings/` + auth.json；`IModelSelectionService/IProviderSettingsService` → `provider/`（factory/roles）；MCP 状态 → `mcp/client.ts`（部分）；`ITerminalService` → `terminal/`；工作流 → `workflow/`

**B. core 需补的 UI 支撑能力**：

- `IFileService` 的 workspace 文件索引（列式打包分块、searchWorkspaceFiles、.zcodeignore）与 `IFileWatcherService` —— core 只有工具级 read/glob/grep，无 UI 文件树服务
- `IZCodeTaskService` 的 app 侧包装（tasks-index 持久化、置顶/归档、sendPrompt 附件管线、`IPromptAttachmentTransferService`）
- v4 conversation 协议面（hello/subscribe/resync/rowsRange/plans/workflowRun 分页）——core ws 是另一套协议，需按 ZCode 词表实现或改 UI
- `IProjectService/ITaskGroupService`（项目树/任务分组）、`IBroadcastService`（跨窗口）、`IWindowControllerService`
- `IGitService/IGitCheckpointService`（GitPane；core 只有文件快照，无 git 集成）
- `IUsageStatsService`（事件级 usage 有，聚合快照无）、`IStorageService`、`ISystemService`、`IMediaPreviewService`、`IOutputStyleService`、`ISettingsSyncService`、`IGenUiService`/plugin-ui-bridge 三件套、`IConversationShareService`（本地导出可做，云发布属 C）

**C. ZCode 特有/云端绑定，建议隐藏或 stub**：

- `IRemoteProjectService`、`ISourceServerManagementService/ISourceServerWorkspaceService`、`skill-sync/mcp-sync/plugin-sync`（SSH 远端同步）、window-project-directory —— 整个远程 host 体系
- `ICodingPlanSubscriptionService`、`IOffPeakTaskService`、`IHighspeedCardService`（订阅/闲时/高速卡）
- `IBotsService`（ZCode 绑定码体系；harness2 gateway 的 QQ bot 是另一套）
- `IOAuthService`、`IUsageStatsService` 的 coding-plan 面、`IFeedbackService`、`IClientScenesService/IClientConfigService/ICloudContentService/IMarketingTouchService`、CUA permission broker（macOS 专有）、`IOnboardingRecordService`、`IConversationShareService` 云发布、zcode-agent 运行时管理本身（spawn ZCode CLI 子进程——被 harness2 core 进程内取代）

**迁移可行性判断**：耦合面大但形状好——单门面 + 频道名 + 自动代理意味着替换后端不需要动 UI 代码，只需在 core 侧实现/伪造 `IServiceAccessor`（A 类做真实现，B 类按需补，C 类给空实现并在 UI 层用已有的 optional/feature-gate 语义隐藏）。最大工程量在 `IZCodeAgentService` 的 v4 conversation 竖切与 `IZCodeTaskService` 的 task 索引/派发管线。
