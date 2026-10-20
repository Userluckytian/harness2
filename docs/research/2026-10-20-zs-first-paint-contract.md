# ZCode 首帧渲染链路分析（ZS 迁移研究——最小渲染契约表）

> **性质：** 只读源码分析（cat-jam 子代理产出，编排者派发 2026-10-20 晚；ZS1 灰屏事件驱动）
> **对象：** `D:/AI_Projects/refs/ZCode` v3.16.2（`3c5b2276`）
> **用途：** ①ZS1 灰屏修复的选路校验与差距清单；②ZS2（垂直切片）服务契约地图；③新壳启动验证判据依据
> **背景：** harness2 保留 ZCode UI 壳、后端为桩（IServiceAccessor 57 频道）。新壳启动灰屏——CDP 探针实锤 `#root` 存在但 innerText 空：React 挂载了，Root 渲染 null。

harness2 壳当前灰屏直接机制 = Root 渲染分支树末尾 `return null`（`packages/ui/src/Root.tsx:1551-1558`）。

## 1 冷启动 → 首帧决策链

```
main.tsx:169 createRoot(#root)
main.tsx:372-376 renderDatabaseStartup()   // GlobalDatabaseStartupLoading，零 service 依赖
main.tsx:375 sendStartupControl({action:"snapshot"})
  ↓ window "message"
main.tsx:275 handleServicePortMessage
  ├─ DatabaseStartupState → admission.acceptState (279-281)
  │    renderDatabaseStartup() (282) + enterAppIfPrepared() (283)
  └─ ServicePort → admission.acceptPort (315) + enterAppIfPrepared (316)
main.tsx:197 enterAppIfPrepared → takeReadyPort → initializeBusinessRoot(port) (199-200)
main.tsx:319-370 initializeBusinessRoot
  ├─ connectViaMessagePort(port) (321) → IServiceAccessor
  ├─ registerBaseWorkspaceServices(services) (325)
  ├─ settingService = supportsSettings ? services.settingService : undefined (327)
  └─ appRoot.render(<Root services=... platform=... restoreSession supportsSettings initialWorkspaceAbsPath .../>) (344-369)
Root.tsx:193 RootInner
  ├─ useZCodeStore user / isRestoringOAuthSession (263)
  ├─ useSettings() → settingService.get() (useSettingService.ts:~188)
  ├─ useRootOAuthEffects → oauthService.restoreCachedSessionState() (useRootOAuthEffects.ts:150)
  │     → setIsRestoringOAuthSession(false) (180)
  ├─ providerFamilyDomainMigration effect (538-549) → ensureProviderFamilyDomainMigration(services)
  ├─ rootModelSelectionRead = useModelSelectionServiceView(modelSelectionService) → getView() (306)
  ├─ useRootProviderSettingsSnapshot → providerSettingsService.getView() (connectProviderSettingsSnapshot)
  ├─ isResolvingStartupAuthState = isRestoringOAuthSession (570)
  ├─ providerStartupSyncPending = isProviderStartupSyncPending (575-580)
  ├─ isResolvingProviderStartupState = shouldResolveProviderStartupState (609-614)
  ├─ canRestoreWorkspaceSession = !auth && !provider && !loginEntry (618-620)
  ├─ useTabPersistence(restoreSession && canRestoreWorkspaceSession) → isRestoring (929-936)
  ├─ isStartupRenderBlocked = shouldShowRootStartupLoading (966-973)
  └─ 分支树（1495-1558）：
       1. isStartupRenderBlocked → RootStartupLoading (1495-1501)
       2. welcomeScreenOpenReason → WelcomeScreen (1503-1511)
       3. !workspaceShellPath && isSettingsTabActive → SettingsPage (1513-1525)
       4. !workspaceShellPath && !isDesktop && initialWorkspaceAbsPath && fallback → loading (1527-1539)
       5. !workspaceShellPath → (dialog/browser/error) ? RootShell : null (1541-1558)  ← 灰屏死角
       6. else → RootShell + OccupationOnboarding + RootWorkspaceContent (1551-1654)
```

**null 死角判据链**（`Root.tsx:1541-1558`）：`!workspaceShellPath` 且非 startup-block、非 login、非 settings tab、非 web loading、且 `remoteConnectionDialogOpen || directoryBrowserOpen || rootModelSelectionErrorNode` 全 false → `return null`。在 harness2 空态下，`ensureConversationWorkspace` 若失败或未完成、或 onboarding 子组件返回 null，都会落到此分支或其上游 null。

## 2 workspaceShellPath 数据流

- `Root.tsx:428-438`：`resolveRootWorkspaceShellTarget({activeWorkspaceTab, activeWorkspacePath, activeWorkspaceIdentity, workspaceTabs})`（`root/rootWorkspaceShellTarget.ts:20-62`）。
- 输入全部来自 tab store：`useTabStore` tabs/activeTabId/activeWorkspacePath/activeWorkspaceIdentity（`Root.tsx:420-427`）。
- Tab 来源三条：
  1. 启动恢复：`useTabPersistence` → `settingService.get()` → `readPersistedWorkspaceSessionEntries(settings)`（`hooks/useTabPersistence.ts:184-208`）读 `settings.lastActiveWorkspace` / `settings.lastWorkspaceSession`，`store.restoreTabs(tabs, activeIndex)`。
  2. 初始入口：`useRootPlatformEffects` 在 `canBootstrapInitialWorkspace` 时对 `initialWorkspaceAbsPath` 调 `addTab(...)`（`root/useRootPlatformEffects.ts:117-130`）。
  3. 兜底：无 workspaceShellPath 时 Root effect 调 `services.fileService.ensureConversationWorkspace()` → `handleSelectConversationWorkspace(result.path)`（`Root.tsx:1176-1208`）。
- 远程会话恢复分支（`useRemoteWorkspaceHistory.restorePersistedSession`，`root/useRemoteWorkspaceHistory.ts:1737-1772`）还会调 `ensureConversationWorkspace()`（仅 `ensureConversationWorkspaceOnRestore`）。
- **最小渲染空壳数据形状**：tab store 至少一条 `WorkspaceTabState`，`workspacePath: string` 非空；`workspaceShellPath` 为该字符串。`activeWorkspacePath` 可同值；identity/remoteSessionId 可 undefined。服务侧最小：`settingService.get()` 返回 `AppSettings`（`recentProjects: []`，`lastActiveWorkspace` 可 null/undefined，`providerFamilyDomain` 非空）；`fileService.ensureConversationWorkspace()` 返回 `{path, created, workspacePurpose:"conversation"}`。

## 3 onboarding / WelcomeScreen 判据

- `WelcomeScreen`：`Root.tsx:1503-1511`，条件 `welcomeScreenOpenReason !== null`。reason 枚举 `Root.tsx:128-133`。启动 reason `startup-provider-required` 由 `useProviderAvailabilityLoginEntryGuard` 设置（`Root.tsx:602-608`），判据 `shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider)`（`root/useProviderAvailabilityLoginEntryGuard.ts:76`）。
- `OccupationOnboarding`（全屏引导）：`Root.tsx:1551-1654`，仅在 workspaceShellPath 已有后作为 children 包装；`onboardingVisible = requested || (needsOnboarding===true && !dismissed)`（`onboarding/OccupationOnboarding.tsx:95`）。`useOnboardingTrigger`（`onboarding/useOnboardingTrigger.ts:69-75`）：`claimAnonymousRecord()` → `shouldOnboard(loadDeviceMid())`；true 走引导，false 跳过。失败/超时/无服务一律 false（3s 兜底，`useOnboardingTrigger.ts:47-66`）。
- `OccupationOnboarding` null 死角：`if (!settings) return ... null`（`OccupationOnboarding.tsx:129`）；`if (!requested && needsOnboarding===null && !settings.onboardingOccupation) return null`（`OccupationOnboarding.tsx:131`）——判定进行中且无职业记录时 children 不渲染。
- `OnboardingDialog`：`Root.tsx:1642-1649`，挂载于主壳内，仅对话框。
- 桌面「已登录 + 无工作区」可见路径：`isStartupRenderBlocked` loading 或 fallback 创建中；否则 null/SettingsPage（settings tab）；无独立空工作区页（已删）。

## 4 启动期 RPC 调用清单（boot → 首帧）

| # | 服务.方法 | 调用点 | 目的 | 失败/空值 UI 行为 |
|---|---|---|---|---|
| 1 | settingService.get | useSettingService.ts:~188 | 读 AppSettings，恢复 tab | 失败保留旧快照；loading 结束 |
| 2 | oauthService.restoreCachedSessionState | useRootOAuthEffects.ts:150 | 恢复本地登录态 | 失败→isRestoringOAuthSession false，user 保持 null |
| 3 | oauthService.getActiveProvider | useRootOAuthEffects.ts:162/184 | provider family 选择 | null→不写 family |
| 4 | modelSelectionService.getView | useModelSelectionView.ts (read) via Root.tsx:306 | provider 可用性 | 失败→error 态 + 重试；空 providers→无可用 provider |
| 5 | providerSettingsService.getView | providerSettingsSnapshot.ts:read (Root.tsx:537) | provider 设置快照 | 失败保留 LKG 或 error |
| 6 | providerSettingsService.refresh | useRootProviderStateRefresh (Root.tsx:536) | 刷新 registry | catch warn，不阻断 |
| 7 | zcodeAgentService.syncAppRuntimePreferences | Root.tsx:396-411 | 运行时偏好 | catch warn |
| 8 | botsService.syncAppRuntimePreferences | Root.tsx:404-411 | Bot 偏好 | catch warn |
| 9 | fileService.ensureConversationWorkspace | Root.tsx:1183 / useRemoteWorkspaceHistory.ts:1739 | 兜底/恢复会话工作区 | 失败→workspaceActionError 横幅；不切主壳 |
| 10 | onboardingRecord.claimAnonymousRecord / shouldOnboard / getLatestEntry | useOnboardingTrigger.ts:69-75 / OccupationOnboarding.tsx:~256 | 首启引导判定 | 超时 3s→false；失败→false；null 服务→false |
| 11 | broadcastService.onMessage (subscribe) | Root.tsx:335 | 跨窗口广播 | Event.None 永不触发 |
| 12 | settingService.update (CAS) | oauthProviderFamilySelectionRefresh 等 | 写 family | throw 时 catch warn |
| 13 | windowController.listTaskList | v4/windowControllerTaskListRegistry.ts:267 | 侧栏任务列表 | 空列表 |
| 14 | projectService.readTree | project-sidebar/project-tree-reader.ts:15-18 | 项目树 | 空树 |
| 15 | remoteProjectService.readDirectory | project-tree-reader.ts:13 | 远程 host | 空目录 |
| 16 | taskGroupService.read | project-sidebar/useTaskGroups.ts:27 | 任务分组 | 空结构 |

## 5 最小渲染契约表（桩必须返回）

| 服务.方法 | 必须返回形状（字段级） | 渲染结果 |
|---|---|---|
| settingService.get | `{recentProjects:[], locale, providerFamilyDomain:"zai", providerFamilyDomainMigrated:true}` (+lastActiveWorkspace null/undefined) | 无 startup block 后进入 fallback |
| oauthService.restoreCachedSessionState | `{status:"authenticated", userInfo:{id,username,displayName}}` | user 非空，跳过 WelcomeScreen |
| oauthService.getActiveProvider | `null` | 不触发 family 写入 |
| modelSelectionService.getView | `{revision:number, providers:[]}` | hasUsableProvider false 但 guard 关闭 |
| providerSettingsService.getView | `{revision:0, providerTemplates:[], providerOrder:[], providers:[]}` | 设置页空态 |
| credentialService.load | `null` | 无凭据 |
| fileService.ensureConversationWorkspace | `{path:string, created:boolean, workspacePurpose:"conversation"}` | 兜底 tab → workspaceShellPath 非空 → 主壳 |
| onboardingRecordService.claimAnonymousRecord | `void` | 认领匿名记录 |
| onboardingRecordService.shouldOnboard | `false` | 跳过 OccupationOnboarding 全屏引导 |
| onboardingRecordService.getLatestEntry | `null` | 无预填 |
| zcodeAgentService.syncAppRuntimePreferences | `void` | 无 throw |
| botsService.syncAppRuntimePreferences | `void` | 无 throw |
| broadcastService.onMessage/send/tryClaim | `Event.None` / `void` / `true` | 单窗口无广播 |
| windowControllerService.listTaskList | `{items:[], total:0, hasMore:false}` | 空任务列表 |
| windowControllerService.subscribeControllerV4/resync | `{ack:{subscriptionId,mode:"snapshot",logEpoch}}` | 订阅成功 |
| projectService.readTree | `{projects:[], tasks:[]}` (+deletedTasks 可省) | 空项目树 |
| taskGroupService.read | `{groups:[], members:[], order:[]}` | 空分组 |
| remoteProjectService.readDirectory | `{hosts:[], entries:[]}` | 空远程目录 |
| sourceServerManagementService.getSnapshot | `{generation:0, profiles:[], servers:[], workspaceHistory:[], states:[], failedPathCount:0, abandonedPathCount:0, migrationCounts:[]}` | 空源服务器 |
| marketingTouchService.query | `{serverTime, language, deliveries:[], rejectedCount:0, scope}` | 无运营位 |

## 6 harness2 zcode-adapter 差距清单

（`packages/zcode-adapter/src/`，分析时点 2026-10-20 晚）

1. **`onboardingRecordService` 无显式桩**：工厂默认返回 null → `shouldOnboard` 解析为 null → OccupationOnboarding null 死角（`OccupationOnboarding.tsx:131`）。需显式返回 false/null/void。**（灰屏最确切嫌疑点）**
2. `settingService.get` 未含 `onboardingOccupation`（次要，修 1 即可）。
3. `fileService` 其余方法（readdir/stat/searchWorkspaceFiles 等）走 B 类默认 throw；主壳内文件树/搜索触达时会抛错，但首帧主壳本身不阻塞——ZS2/ZS3 补。
4. `windowController`/`project`/`task-groups` 桩已对齐，无差距。
5. onboarding 服务频道已注册（`createHarness2Services.ts:156`），但 impl 为默认 null-stub，需按上表修正。
