# ZS4 调用面盘点（ZS3→ZS4 Task 0）

> **唯一产出**：本文件。只读研究，未修改任何源码、未 commit/push、未启动应用。

## 0. 元信息

- 日期：2026-10-21
- 分支：`main`（基线 ≥ `e9f7362`，ZS3.5 `e9f7362`）
- ZCode 锚点核对：本地 `D:/AI_Projects/refs/ZCode` HEAD = `3c5b2276`（2026-10-20 v3.16.2）；`docs/refs/refs-zcode.md` 与 `refs-zcode-layout.md` 「分析基线」均登记 `3c5b2276`；refs README §4 判定条件 1 不满足 → **未过期，本轮不重拉、不改 refs 文档**（登记于本节）。
- 方法：对 harness2 与 ZCode 源做 grep + 定点读码；所有结论附 `file:line`。读不到/不确定标「待核实」。
- 相关计划：`docs/ai-framework/plans/2026-10-21-phase-ZS4-sidebar-and-settings.md`（Task 0 ①~⑥）。

---

## 1. ITaskGroupService 契约与消费点

### 1.1 两个容易混淆的服务

| 服务                | 频道          | 契约文件                                                               | 职责                                      | harness2 现状                                                                                                  |
| ------------------- | ------------- | ---------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ITaskGroupService` | `task-groups` | `refs/ZCode/packages/services/src/task-groups/contract.ts:37-50`       | 任务**分组**（group/move/admit）          | `root-mount-stubs.ts` `taskGroupServiceStub` 仅 `read()`，其余抛（`createHarness2Services.ts` EXPLICIT_STUBS） |
| `IZCodeTaskService` | `zcode-task`  | `refs/ZCode/packages/services/src/session/zcodeTaskService.ts:185-780` | 任务**索引**（pin/archive/delete/rename） | `task-service.ts` createTaskService，仅 createTask/sendPrompt/listTasks 等少量方法，其余抛                     |

> 计划 Task 0 ① 写作 `ITaskGroupService`，但列出的 UI 文件（`task-mutation.ts`/`useArchiveManagement`/`ArchiveGroupCard`/`project-sidebar/index.tsx`）实际消费的是 **`IZCodeTaskService`**（task 索引）。本节两部分都登记，避免 T2/T3 落点错配。

### 1.2 ITaskGroupService（task-groups）全方法

来源：`refs/ZCode/packages/services/src/task-groups/contract.ts:37-47`

| 方法           | 签名（入参/返回）                                                 |
| -------------- | ----------------------------------------------------------------- |
| `read()`       | `() => Promise<TaskGroupStructure>`（`{groups, members, order}`） |
| `save(input)`  | `{ id?, title?, color? } => Promise<TaskGroup>`                   |
| `ungroup(id)`  | `(string) => Promise<void>`                                       |
| `move(input)`  | `MoveGroupNode => Promise<void>`                                  |
| `admit(input)` | `{ tasks: GroupTaskRef[]; placement? } => Promise<void>`          |

UI 消费点（`refs/ZCode/packages/ui/src/project-sidebar/useTaskGroups.ts`）：

- `service.read()`（行 20-33）刷新结构；
- `service.admit({tasks})`（行 73）按 host 批量登记；
- `save`/`move`/`ungroup`（行 89-109）经 `required()` 后调用并 `refresh()`；
- `available: Boolean(service)`（行 130）控制菜单可用性。

### 1.3 IZCodeTaskService 任务索引：task-mutation.ts 消费

来源：`refs/ZCode/packages/ui/src/project-sidebar/task-mutation.ts:38-75` `mutateProjectTask`

| mutation.kind      | 调用的服务方法                                                  | 入参形状                                      | 期望返回        |
| ------------------ | --------------------------------------------------------------- | --------------------------------------------- | --------------- |
| `archive`          | `ports.service.archiveTask(target)` / `unarchiveTask(target)`   | `{workspacePath, workspaceIdentity?, taskId}` | `ZCodeTaskMeta` |
| `delete`           | `ports.service.deleteTask(target)`                              | 同上                                          | `void`          |
| `rename`           | `ports.service.renameTask({...target, title})`                  | `{...target, title}`                          | `ZCodeTaskMeta` |
| `pin`              | `ports.service.setTaskPinned({...target, pinned})`              | `{...target, pinned}`                         | `ZCodeTaskMeta` |
| `mark-read/unread` | `ports.service.setTaskUnread({..., unread, expectedUnreadAt?})` | `{...target, unread, expectedUnreadAt?}`      | `ZCodeTaskMeta` |
| 远端               | `ports.controller.mutateTask({address, mutation})`              | `WindowHostTaskAddress` + mutation            | 透传            |

`readProjectTaskMeta`（行 28-36）：`getTaskMeta(task)` 或 controller.getTaskMeta，返回 `ZCodeTaskMeta | null`。

### 1.4 useArchiveManagement.ts 消费

来源：`refs/ZCode/packages/ui/src/project-sidebar/useArchiveManagement.ts:31-93`

- 服务：`zcodeTaskService` + `windowControllerService`（行 17）；
- 仅操作 `archived === true` 的任务（行 35）；
- `delete` 走 `mutateProjectTask(..., {kind:"delete"})`（行 71）+ `removeTaskState(...)`（行 75）；
- `unarchive` 走 `{kind:"archive", archived:false}`（行 71）；
- 每批次后 `latest.current.refresh()`（行 87）；
- 确认弹窗：`confirm({intent:"archive-management-delete", title:"archives.deleteTitle", description:"archives.deleteDescription", confirmLabel:"archives.delete", confirmVariant:"destructive"})`（行 44-52），文案 id `archives.deleteTitle`/`archives.deleteDescription`/`archives.delete`；
- 返回计数 `{succeeded, failed, skipped}`（行 23-27、88）。

### 1.5 ArchiveGroupCard.tsx 消费

来源：`refs/ZCode/packages/ui/src/project-sidebar/ArchiveGroupCard.tsx:90-103,132-149`

- 批量：`onAction(group.tasks, "unarchive")`（行 93）/ `onAction(group.tasks, "delete")`（行 100）；
- 单条：`onAction([task], "delete")`（行 141）/ `onAction([task], "unarchive")`（行 149）；
- `disabled` 控制按钮（行 84、136、148）；`archives.deleteTask`/`archives.unarchive` 文案 id。

### 1.6 project-sidebar/index.tsx 消费

来源：`refs/ZCode/packages/ui/src/project-sidebar/index.tsx`

- 通过 `useProjectDirectory()` 取 `tree`/`service`/`remoteService`/`refresh`（行 67-78）；
- `service` 传给 `ProjectSidebarNode`（行 189）与 `ProjectCreation`/`ProjectEditor`（行 348-389）；
- `tree.tasks` 作为 `TaskGroupedView tasks`（行 289）；
- `pin`（`useProjectPinIntent`，行 80）用于 pinned 排序；
- 无直接 ITaskGroupService 调用（分组走 `useTaskGroups`）。

### 1.7 错误/`fault.*` 字面量

- ZCode UI 侧在上述文件中**未见** `fault.*`/`guard.*` 字面量；错误通过 thrown Error + `logger.error`（`useArchiveManagement.ts:79`）+ ConfirmDialog 呈现。
- harness2 适配器错误词表（`fault.*`/`guard.*`）为计划 T3 约定，需与 UI 期望的 thrown message 对齐；**待核实**具体 UI 侧是否有 toast 文案 id 对 `fault.*` 的映射（grep `fault\.` 在 `packages/ui/src` 仅命中 saved-workflows，非本主题）。

---

## 2. 批量语义（Z-50/Z-51）真实入口

### 2.1 ZCode 上游现状（@3c5b2276）

- 主列表/右键菜单**无「删除会话」**：refs-zcode-layout.md:212（搜索 `taskList.delete`/`deleteTask`/`Trash` 于列表组件零命中；分组右键菜单项 = 移组/置顶/重命名/归档/未读/复制×4/提供商配置/反馈）。
- 删除只存在于**归档区**：
  - 单条：`WorkspaceArchivedTasksFlatSection.tsx:275-290` ConfirmDialog「删除这个归档任务？」/「任务将从任务列表和归档列表中移除。」+ destructive「删除任务」；删除中按钮 disabled `:256-266`；文案 `zh-CN.ts:589-590,2063`。
  - 批量：`DeleteAllArchivedTasksButton.tsx:60-96`「删除 {count} 个归档任务？」+ 结果计数「已删除 x，跳过 y，失败 z」。
  - `ArchiveGroupCard.tsx:92-102` 批量「全部恢复 unarchiveAll」「全部删除 deleteAll」。
- `WebRemoteControlTaskIndex.tsx:405-412` 同一逻辑 web 远控。

### 2.2 harness2 自主新增（Z-50/Z-51，refs-zcode-layout.md:216-230）

- Z-50 批量「归档其他会话」：会话行右键菜单新增；除该行外全部 `archived:true`；软标记、一键无确认、toast「已归档 N 个会话」；单次落盘。
- Z-51 批量「删除其他会话」：除该行外全部**物理删除**会话目录；强确认对话框（数量+不可恢复警示+destructive）；结果计数「已删除 x，跳过 y（运行中/失败）」；运行中与当前会话自动跳过。

### 2.3 服务方法链（逐跳）

ZCode 侧（归档区删除，harness2 需复刻/对齐）：

1. UI `ArchiveGroupCard` / `WorkspaceArchivedTasksFlatSection` → `onAction(tasks, "delete")`（`ArchiveGroupCard.tsx:98-101` / `useArchiveManagement.ts:31`）。
2. `useArchiveManagement.run` → `mutateProjectTask({service, controller}, task, {kind:"delete"}, remoteSessionId)`（`useArchiveManagement.ts:68-73`）。
3. `mutateProjectTask`（`task-mutation.ts:59-61`）：controller 存在 → `controller.mutateTask({address, mutation})`；否则 `service.deleteTask(target)`。
4. 服务端 `IZCodeTaskService.deleteTask` / `deleteArchivedTask` / `deleteArchivedTasks`（`zcodeTaskService.ts:675-693`）：
   - `deleteTask(params)` → `Promise<void>`（软删/列表不可见，CLI 会话保留）；
   - `deleteArchivedTask(params)` → `Promise<boolean>`（仅删仍归档的任务；已恢复/已删/不存在返回 false，不清理 CLI 会话）；
   - `deleteArchivedTasks(params)` → `Promise<ZCodeArchivedTaskDeletionResult>`（`{deletedTaskIds, skippedTaskIds, failedTaskIds}`）。

harness2 现状：

- `project-service.ts` readTree 返回 `deletedTasks: []`（行 33），无 deleteTask 实现（`IZCodeTaskService` 通道由 `task-service.ts` 提供，仅 createTask/sendPrompt/listTasks，无 delete/archive/rename/pin）；
- `ITaskGroupService`（task-groups）stub 仅 read；
- core `SessionManager` **无 deleteSession**（grep `deleteSession` 于 `manager.ts` 零命中）——计划 T1 唯一加性窗口。

### 2.4 确认弹窗层级与文案 id

- 层级：UI 层（React `useConfirmDialog`），非 core；`intent: "archive-management-delete"`（`useArchiveManagement.ts:45`）。
- 文案 id：`archives.deleteTitle`（带 `{count}`）、`archives.deleteDescription`、`archives.delete`、`archives.deleteTask`（`ArchiveGroupCard.tsx:137-138`）；归档区批量 `archives.deleteAll`（行 102）/`archives.unarchiveAll`（行 95）。
- Z-51 强确认对齐 Z-49 形态：「删除 {count} 个归档任务？」+ 结果计数（refs-zcode-layout.md:212）。

### 2.5 删除后 UI 期望的列表/投影刷新路径

- `useArchiveManagement.run`：操作循环后 `await latest.current.refresh()`（`useArchiveManagement.ts:87`）+ `setResult(counts)`（行 88）；
- `mutateProjectTask` controller 路径由 controller 侧广播 `state:task-groups`（`useTaskGroups.ts:41-42`）触发 read；
- harness2 适配器：`project-service.ts` readTree 从 `manager.list()` 重建 tasks（行 20-33）；删除后需 `manager.list()` 不再包含该会话。core 无 deleteSession → **必须先过 T1 提案**；否则降级为归档隐藏。

### 2.6 ZCode 是否存在「删除其他/归档其他」字面功能？

**不存在**（Z-50/Z-51 明示「上游无此能力」，全仓 grep `archiveOthers/deleteOthers/closeOthers` 零命中）。harness2 自主新增。UI 入口落点选择是**决策点**：ZCode UI 上下文菜单无对应项，harness2 在「UI 零改动」约束下无法仅靠服务端暴露入口；需编排者拍板是 (a) 破例加 UI patch、(b) 通过命令面板/快捷键、(c) 降级为仅归档区清理。**本盘点不硬造入口**。

---

## 3. pinned/archived 权威归属

### 3.1 ZCode 消费点

- `ProjectTask`（`refs/ZCode/packages/services/src/project-storage/contract.ts:53`）= `ZCodeTaskMeta & { projectId, hostId, pinned, archived }`；`ProjectTree.tasks: ProjectTask[]`（行 57）。
- `useProjectPinIntent`（`project-sidebar/index.tsx:80`）从 `authoritativeTree` 派生 pinned 排序；`reorder` 仅同 pinned 分组（`index.tsx:161-170`）。
- `selectProjectRows(tree, {kind:"pinned"})`（`index.tsx:253,283`）读 pinned 任务。
- `mutateProjectTask` pin 分支调 `setTaskPinned({..., pinned})`（`task-mutation.ts:65`）返回 `ZCodeTaskMeta`；archive 分支 `archiveTask`/`unarchiveTask`（行 56-58）返回 `ZCodeTaskMeta`。

### 3.2 core 事实源

- `SessionSummary`（`packages/core/src/session/manager.ts:74-89`）**无 pinned/archived 字段**；仅 id/dir/cwd/mtimeMs/firstUserText/messageCount/lastSeq/title。
- `SessionManager.list()`（行 227-244）按 mtime 倒序，无 pin 优先；无归档过滤。
- 标题走侧车 `title.json`（`titles.ts`，`readSessionTitle`/`writeSessionTitle`，行 356-365），已证明「侧车文件」模式在 core 中可行。

### 3.3 本机侧车 `session-meta.json` 方案与 UI 期望的兼容性

计划 T2：`{pinned, archived, renamed?}` 侧车，readTree 排序 = pinned 优先 → mtime；archived 默认过滤。

| 维度            | UI 期望                                                              | sidecar 方案                           | 偏差                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段            | `ProjectTask.pinned/archived: boolean`                               | sidecar boolean                        | 兼容                                                                                                                                                                                                                                              |
| 排序            | pinned 优先（UI `reorder` 同组）                                     | pinned 优先 → mtime                    | 兼容                                                                                                                                                                                                                                              |
| 归档视图        | archived 任务在 `listArchivedTasks`（`zcodeTaskService.ts:464-468`） | readTree `includeDeleted`/归档视图包含 | 需 readTree 支持 `includeDeleted`/`includeDeletedTasks`（`project-service.ts:16` 已接参但未实现）                                                                                                                                                 |
| 重命名          | `renameTask` 返回 `ZCodeTaskMeta`（含 title）                        | sidecar `renamed?` 或复用 `title.json` | **语义偏差**：core 已有 `title.json`（`SessionManager.rename`，manager.ts:362），UI `renameTask` 期望更新 ZCodeTaskMeta.title；harness2 应复用 `title.json` 而非 sidecar `renamed`，避免双写。sidecar `renamed?` 字段建议**不落**或仅作迁移标记。 |
| 删除            | `deleteTask` 软删/`deleteArchivedTask` 物理删归档                    | core 无 deleteSession                  | 依赖 T1 core 窗口；失败则降级归档隐藏                                                                                                                                                                                                             |
| 跨进程/多客户端 | ZCode 云端 task 索引强一致                                           | 本机侧车仅本机可见                     | 计划已登记风险「侧车 meta 与 ZCode 云端 task 索引语义漂移」；harness2 单机，可接受                                                                                                                                                                |

结论：**兼容**，但 rename 应复用 `title.json`（manager.ts:356-365），pinned/archived 走 sidecar；`deletedTasks` 需 readTree 实现（目前返回 `[]`，`project-service.ts:33`）。

---

## 4. IProviderSettingsService 十投

### 4.1 契约（ZCode）

来源：`refs/ZCode/packages/services/src/model-provider/providerFacadeServices.ts:30-71`

| #    | 方法                            | 入参 TS 形状                                                                                                                                                                         | 返回                                                             |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1    | `createPersonalProvider`        | `input?: { templateId?, providerName?, locale?, initialConfig?: ProviderConfigObject }`（facade.ts:304-309）                                                                         | `Promise<ProviderSettingsCreationResult>` = `{providerId, view}` |
| 2    | `savePersonalProviderOverlay`   | `(providerId: ProviderId, config: ProviderConfigObject, metadata?)`                                                                                                                  | `Promise<ProviderSettingsView>`                                  |
| 3    | `deletePersonalProvider`        | `(providerId: ProviderId)`                                                                                                                                                           | `Promise<ProviderSettingsView>`                                  |
| 4    | `reorderPersonalProviders`      | `(providerIds: readonly ProviderId[])`                                                                                                                                               | `Promise<ProviderSettingsView>`                                  |
| 5    | `reorderPersonalModels`         | `(providerId, modelIds: readonly ModelId[])`                                                                                                                                         | `Promise<ProviderSettingsView>`                                  |
| 6    | `addPersonalModel`              | `(providerId, modelId, config: ModelConfigObject, useRecommendedConfig?)`                                                                                                            | `Promise<ProviderSettingsView>`                                  |
| 7    | `renamePersonalModel`           | `(providerId, currentModelId, nextModelId)`                                                                                                                                          | `Promise<ProviderSettingsView>`                                  |
| 8    | `deletePersonalModel`           | `(providerId, modelId)`                                                                                                                                                              | `Promise<ProviderSettingsView>`                                  |
| 9    | `savePersonalModelDraft`        | `SavePersonalModelDraftInput` = `{providerId, originalModelId, nextModelId, personalConfig: ModelConfigObject, useRecommendedConfig?, basedOnRevision: number}`（facade.ts:140-147） | `Promise<ProviderSettingsView>`                                  |
| 10   | `setPersonalModelEnabled`       | `(providerId, modelId, enabled: boolean)`                                                                                                                                            | `Promise<ProviderSettingsView>`                                  |
| +    | `testModelConnectivity`         | `ProviderSettingsConnectivityRequest` = `{workspacePath, workspaceIdentity?, providerId, modelId}`（providerFacadeServices.ts:84-89）                                                | `Promise<ModelConnectivityResult>`                               |
| 读   | `getView()` / `refresh(reason)` | `() / (string)`                                                                                                                                                                      | `Promise<ProviderSettingsView>`                                  |
| 事件 | `onDidChange`                   | `Event<ProviderSettingsView>`                                                                                                                                                        | —                                                                |

> `resolveModelConfig(input: ResolveModelConfigInput)`（providerFacadeServices.ts:36-37）也属契约，harness2 stub 未列（factory 默认 null）；UI 是否消费待核实。

### 4.2 harness2 现状

- `provider-views.ts` `createProviderSettingsService`：`getView`/`refresh` 真实现（读 config + auth）；其余 **10 方法** 在 `throws` 列表（行 95-104：createPersonalProvider, savePersonalProviderOverlay, deletePersonalProvider, reorderPersonalProviders, reorderPersonalModels, addPersonalModel, deletePersonalModel, savePersonalModelDraft, setPersonalModelEnabled, testModelConnectivity）。
- **注意**：`renamePersonalModel` **不在** throws 列表（provider-views.ts 行 95-104）且契约含该方法；root-mount-stubs 版本 throws 列表含 `renamePersonalModel` 但实际使用 provider-views 版本。**待核实**：harness2 是否需要实现 renamePersonalModel（UI `useModelProviders` 未见 rename 调用，grep `renamePersonalModel` 在 ui/src 仅 useModelProviders? 实际 grep 早前未命中除契约；UI 可能不调用）。标「待核实」。

### 4.3 UI 表单字段对照（settings/models 页）

组件落点（ZCode）：

- `packages/ui/src/settings/ModelProviderSection.tsx`（主页面，行 1003 createPersonalProvider 调用、行 1083 testModelConnectivity）；
- `packages/ui/src/hooks/useModelProviders.ts`（mutation 编排：saveProvider/createPersonalProvider/addPersonalModel/savePersonalModelDraft/setPersonalModelEnabled/deletePersonalModel/deleteProvider/reorderProviderModels/saveDisplayOrder/testModelConnectivity）；
- `packages/ui/src/settings/model-provider-section/` 子组件：`ProviderFormControls.tsx`、`ProviderModelMetadataFields.tsx`、`ModelEditorAdvanced.tsx`、`ApiKeyInput.tsx`、`ProviderModelReasoningLevelEditor.tsx`、`ProviderModelModalityOptions.tsx`、`InlineEditableProviderCard.tsx`、`ProviderCardSections.tsx`、`ProviderDetailFeedback.tsx`、`ProviderTemplatePicker.tsx`、`ProviderApiFormatSelect.tsx`。

字段（从契约与 UI 推导，**字段名** only，无密钥值）：

- Provider 级：`providerId` (string)、`providerName`、`templateId`、`enabled`、`providerFamily?`；配置 `ProviderConfigObject`（api baseUrl/apiType/headers、models map、visibility/group 等）；`envKey`（环境变量名，非密钥）。
- Model 级：`modelId`、`ModelConfigObject`（contextWindow、maxTokens、reasoningLevel values/map、modality、pricing 等）；`useRecommendedConfig` boolean。
- 草稿：`SavePersonalModelDraftInput` 含 `basedOnRevision`（乐观并发）。
- 密钥字段名/路径：`channels.<providerId>.apiKey`（`core/config/auth.ts:7-8,17-21`）；可选 `gateways.<name>.{appId,appSecret}`（`auth.ts:12-16`）。auth 文件路径 `~/.harness2/auth.json`（`provider-views.ts:16`、`task-service.ts:22`）。**绝不抄任何真实密钥值**。
- UI 表单组件文件:line：`ModelProviderSection.tsx:997-1017`（handleCreateProvider）、`:1078-1086`（handleTestModel）；`useModelProviders.ts:77-212` mutation 回调。

### 4.4 成功后 UI 刷新链路

- mutation 返回 `ProviderSettingsView` → `commitProviderSettingsView(view)`（`useModelProviders.ts:47-55`）→ `useProviderSettingsServiceView` 守卫 → `projectProviderSettingsViewToFormProviders` 投影 → `modelProviders` state。
- `refresh()`（行 59-75）调 `providerSettingsService.refresh("settings-manual")` 后 commit。
- `onDidChange` 事件（契约）用于跨窗口/外部变更；harness2 stub 默认 Event.None（factory）。

### 4.5 错误展示形状

- UI 接收 thrown Error message（`useModelProviders` 各回调 `.then`/`try-catch`；`ModelProviderSection` handleCreateProvider catch 后 rethrow 行 1010-1013）。
- `ModelConnectivityResult` = `{success: boolean; error?: {code, message}}`（providerFacadeServices.ts:191-198）；UI `handleTestModel` 返回该对象（`ModelProviderSection.tsx:1083-1085`）。
- harness2 必须 `redactSecrets` 出口（`provider-views.ts:43,86` 已用）。

### 4.6 testModelConnectivity 请求/返回期望

- 请求：`ProviderSettingsConnectivityRequest` = `{workspacePath, workspaceIdentity?, providerId, modelId}`（providerFacadeServices.ts:84-89）；UI 传 `workspacePath: connectivityWorkspacePath || target.workspacePath`（`useModelProviders.ts:199`）。
- 返回：`ModelConnectivityResult`（`{success, error?:{code,message}}`）；ZCode 服务端先校验 provider/model enabled/executable，不可用返回 `{success:false, error:{code:"provider-unavailable"|"model-unavailable", message}}`（providerFacadeServices.ts:178-198），再调 `testConnectivity` tester。
- harness2 需实现 tester：发一次最小请求，密钥脱敏；workspacePath 必须本地（UI fail-closed 无本地 workspace，`useModelProviders.ts:184-197`）。

---

## 5. getModelTrajectory 映射差

### 5.1 UI/服务契约期望形状

来源：`refs/ZCode/packages/services/src/session/zcodeTaskService.ts:638-642` + `:66-152`

`getModelTrajectory(params: { taskId: string; limit?: number }) => Promise<ZCodeModelTrajectory>`，其中：

- `ZCodeModelTrajectory` = `{ taskId, available: boolean, records: ZCodeModelTrajectoryRecord[], sourceFiles: string[], truncated: boolean }`（行 143-152）。
- `ZCodeModelTrajectoryRecord`（行 107-140）：`requestId, attempt, startedAt, completedAt?, durationMs?, turnId?, traceId?, callSource?{kind, querySource?}, model{modelId?,providerId?,role?,source?}, request{messages: ZCodeModelTrajectoryMessage[], toolNames: string[]}, response?{finishReason?, text?, reasoningText?, toolCalls[], usage?, responseId?, modelId?}, error?{name,message,stack?}`。
- `ZCodeModelTrajectoryMessage` = `{ role: string; parts: ZCodeModelTrajectoryContentPart[] }`（行 76-79）；part kinds: text/reasoning/tool-call/tool-result/image/unknown（行 67-73）。
- `ZCodeModelTrajectoryUsage` = `{inputTokens?, outputTokens?, totalTokens?, cacheReadTokens?, reasoningTokens?}`（行 82-88）。
- `callSource.kind` ∈ main/sidecar/subagent/compact/unknown（行 90-95）。

### 5.2 core trajectory/view.ts 实际形状

来源：`packages/core/src/trajectory/view.ts` + `packages/core/src/session/reader.ts:16-29`

- `renderTrajectory(session: LoadedSession, options?) => string[]` / `formatTrajectory => string`（view.ts:164-172）——**文本渲染**，非结构化。
- `LoadedSession` = `{ dir, header: SessionHeaderPayload|null, events: LoadedEvent[], extensionEvents, warnings }`（reader.ts:16-29）。
- `LoadedEvent` = `{ event: AnySessionEvent; active: boolean }`（reader.ts:10-14）。
- 事件类型（view.ts switch）：`user/message`、`assistant/message`（含 model?/usage?）、`assistant/attempt`、`step/start`、`step/end`、`tool/call`、`tool/result`、`rewind/marker`、`compaction/applied`；每事件含 `payload.turnId?`。
- `SessionProjection`（reader.ts:53-68）：`messages: ProjectionMessage[]`（seq, ts, role, text, turnId?）、activeCount、shadowedCount、rewindCount、opaqueEvents。

### 5.3 逐字段映射差

| UI 字段                                                                                 | core 对应                                                            | 结论                                                                                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `taskId`                                                                                | `SessionHeaderPayload.sessionId`（header） / 目录名                  | 可直投（需 resolve session dir by taskId；core `locate` manager.ts:384）                                        |
| `available`                                                                             | 无直接等价；core 无 model-io 落盘                                    | **需降级**：core 只有会话事件日志，无 provider model-io；应如实 `available:false` 或降级为事件轨迹              |
| `records[].requestId/attempt/startedAt/completedAt/durationMs`                          | 无 model-io；`step/start`/`step/end` 有 stepId/durationMs；事件 `ts` | **需投影层**：只能从 step 事件近似，无 requestId                                                                |
| `records[].turnId`                                                                      | `ProjectionMessage.turnId` / `turnIdOf(event)`                       | 可直投                                                                                                          |
| `records[].traceId`                                                                     | 无（core 无 traceId 字段）                                           | **需降级**：置 undefined                                                                                        |
| `records[].callSource`                                                                  | 无                                                                   | **需降级**：unknown                                                                                             |
| `records[].model.modelId/providerId/role/source`                                        | `assistant/message.payload.model?`（view.ts:113）；provider 无       | **部分**：modelId 可从 payload，providerId/source 无                                                            |
| `records[].request.messages`                                                            | `ProjectionMessage[]`（role,text,turnId,seq,ts）                     | **需投影层**：core 只有 user/assistant 文本，无 tool-call parts；需映射为 `{role, parts:[{kind:"text", text}]}` |
| `records[].request.toolNames`                                                           | `tool/call.payload.tool` 集合                                        | **需投影层**：从事件聚合                                                                                        |
| `records[].response.text/reasoningText/toolCalls/usage/finishReason/responseId/modelId` | `assistant/message.payload.text/usage`；tool/result 事件             | **部分**：text/usage 可取；finishReason/responseId/modelId 无                                                   |
| `records[].error`                                                                       | `assistant/attempt.payload.error`                                    | 可直投（attempt 失败）                                                                                          |
| `sourceFiles`                                                                           | session dir 路径                                                     | 可直投（`LoadedSession.dir`）                                                                                   |
| `truncated`                                                                             | 无 limit 语义；core 无                                               | **需投影层**：harness2 侧按 limit 截断并置 true                                                                 |
| `limit`                                                                                 | n/a                                                                  | harness2 侧实现                                                                                                 |

结论三态：

- **可直投**：taskId, turnId, error, sourceFiles, assistant text/usage, tool names（聚合）。
- **需投影层**：request.messages（从 ProjectionMessage 映射）、request.toolNames、truncated、attempt→duration 近似。
- **需降级**：available（core 无 model-io → false 或降级为事件轨迹）、traceId、callSource、providerId/source/finishReason/responseId/modelId in response。

建议：T5 实现 `trajectory-service.ts` 时，优先返回 `available:false` + 空 records 并在 sourceFiles 给出 session dir，或提供一个「事件轨迹」降级视图；**不得造假 model-io**（红线⑩）。

---

## 6. 周边频道能力对账表

每行：UI 消费点 / core 能力（file:line）/ 结论。

| 频道                | UI 消费点（ZCode）                                                                                       | core 能力                                                                                                                                                                                                                                                       | 结论                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commands            | `CommandsSection.tsx`、`CommandForm.tsx`、`CommandCard.tsx`（settings）                                  | `packages/core/src/commands/{registry,catalog,handlers,parse}.ts` 存在                                                                                                                                                                                          | **接线**：core 有命令注册/解析/执行；harness2 a-class-stub 仅 `list` 空态 + 写 throw；T5 应把 `list` 接 core 命令目录（只读），写路径保持 throw 或补                                                                                                                               |
| skills              | `Skills` settings（grep `ISkillsService`）                                                               | `packages/core/src/skills/{store,tool,authoring}.ts`                                                                                                                                                                                                            | **接线**：core 有 skill store；只读 list 可接，写 throw 保持                                                                                                                                                                                                                       |
| memory              | `MemorySettingsSection.tsx`、`MemorySettingsViewer.tsx`                                                  | `packages/core/src/memory/{store,tool,mode,nudge,pending}.ts`                                                                                                                                                                                                   | **接线**：core 有 memory store；`loadMemory`/`listProjectMemories` 可接只读                                                                                                                                                                                                        |
| hooks               | `HooksSection.tsx`、`HookForm.tsx`、`HooksList.tsx`                                                      | `packages/core/src/hooks/{executor,runner,matcher,extension,types}.ts`                                                                                                                                                                                          | **接线**：core 有 hooks 执行；`loadHooks` 可接（空态 `hooksEnabled:false`）                                                                                                                                                                                                        |
| subagents           | settings subagents（grep `ISubagentsService`）                                                           | `packages/core/src/agent/subagent.ts`、`subagent-fanout.ts`（执行引擎）                                                                                                                                                                                         | **部分**：core 有 subagent 执行引擎，但**定义文件 CRUD 缺口**（a-class-stubs 注释）；`list` 可返回空态，CRUD 写路径保持 throw（ZS4 不补 CRUD，登记后续）                                                                                                                           |
| automations (cron)  | `AutomationsSection.tsx`（行 534 用 `offPeakTaskService`/`zcodeAgentService`，行 1024 updateAutomation） | `packages/core/src/cron/{jobs,scheduler,delivery,natural}.ts`                                                                                                                                                                                                   | **部分**：core 有 cron jobs/scheduler；但 UI 走 `IZCodeAgentService` automation API（ZCode 侧），harness2 的 `IZCodeAgentService` 仅 `syncAppRuntimePreferences`；ZS4 仅「cron 最小状态」——建议暴露 core cron job 列表只读，写路径 throw                                           |
| MCP                 | `McpSettingsSection.tsx`、`McpServerForm.tsx`、`McpServerList.tsx`、`McpFailurePresentation.tsx`         | `packages/core/src/mcp/client.ts`                                                                                                                                                                                                                               | **部分**：core 有 MCP client；但 UI 用 `IMcpSyncService`（ZCode），harness2 未注册 `IMcpSyncService`? 查 `createHarness2Services.ts`：未在 EXPLICIT_STUBS，走 factory 默认（A 类读 null/B throw）；结论：保持空态/throw，ZS4 不做 MCP 增删（计划 §Global Constraints #7 明确不做） |
| IFileService 搜索面 | `searchWorkspaceFiles` 等（file.ts:23-79）                                                               | harness2 `file-service.ts` 实现 readdir/stat/readTextFile/checkFilesExist/resolvePath/ensureConversationWorkspace/createDefaultWorkspace；**缺少** `searchWorkspaceFiles`、`readMediaPreview`、`readFileRange`、`listWorkspaceFilesLength/Range`、ignore 读写等 | **部分**：ZS3 遗留不确定项③结论——harness2 仅实现基础文件操作，workspace 文件索引/搜索/ignore 未接；UI 文件选择器若调 `searchWorkspaceFiles` 将抛（factory 默认 B throw）。ZS4 scope 不含文件索引，登记为 ZS5 或按需                                                                |

---

## 7. 汇总表：T1~T5 待改文件 → 依赖的盘点条目

| Task | 待改文件（计划 File Structure）                                                               | 依赖盘点条目                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `packages/core/src/session/manager.ts`（deleteSession 加性）                                  | §1.3（deleteTask 链）、§2.3（core 无 deleteSession）、§2.5（刷新路径）                                                                                          |
| T2   | `packages/zcode-adapter/src/real/task-index.ts`（新建 sidecar）                               | §3.2/§3.3（sidecar 兼容、rename 复用 title.json）、§1.3（pin/archive）                                                                                          |
| T2   | `packages/zcode-adapter/src/real/project-service.ts`（readTree 接 task-index）                | §1.6、§3.1、§3.3（deletedTasks 实现）、§2.5                                                                                                                     |
| T3   | `packages/zcode-adapter/src/real/project-service.ts` + `session-service.ts`                   | §1.3-§1.5（ITaskGroupService/IZCodeTaskService 方法全集）、§2.3（deleteTask/deleteArchivedTask/deleteArchivedTasks）、§2.4（确认弹窗文案 id）、§1.7（错误词表） |
| T3   | `packages/zcode-adapter/src/real/task-service.ts`                                             | §1.3（archive/rename/pin/unread/delete 方法实现）                                                                                                               |
| T4   | `packages/zcode-adapter/src/real/provider-settings-service.ts`（新建/并入 provider-views.ts） | §4.1（十投签名）、§4.3（UI 字段）、§4.4（刷新链路）、§4.5（错误形状）、§4.6（connectivity 请求/返回）、§4.2（renamePersonalModel 待核实）                       |
| T4   | `packages/core/src/config/auth.ts`（写 0600）                                                 | §4.3（密钥字段名/路径）                                                                                                                                         |
| T5   | `packages/zcode-adapter/src/real/trajectory-service.ts`（新建）                               | §5.1-§5.3（三态映射）                                                                                                                                           |
| T5   | a-class-stubs（commands/skills/memory/hooks/subagents）+ cron/MCP                             | §6（周边频道对账）                                                                                                                                              |
| T5   | `packages/zcode-adapter/src/real/file-service.ts`（search 面）                                | §6（IFileService 搜索面）— 建议登记后续，ZS4 不做                                                                                                               |

---

## 附：决策点（需编排者拍板）

1. **core `deleteSession` 锁语义**（T1）：提案 `deleteSession(id, opts?)` 持 writer 锁 fail-closed 抛错；被否 → 批量删除降级为归档隐藏。本盘点确认 core 当前无 deleteSession 且 `SessionManager.locate/resume` 持锁语义（manager.ts:384,413），T1 提案可直接复用 locate 定位 + writer 锁检查。
2. **批量入口落点**（Z-50/Z-51）：ZCode UI 无「删除其他/归档其他」菜单项；在 UI 零改动约束下无法仅靠服务端暴露。需拍板 (a) 破例 UI patch、(b) 命令面板/快捷键、(c) 降级为仅归档区清理。
3. **rename 语义**：sidecar `renamed?` 与 core `title.json` 双写风险；建议复用 `title.json`（manager.ts:362），sidecar 不落 renamed。
4. **renamePersonalModel**：契约含但 harness2 未 throw 也未实现；UI 是否调用待核实（grep 未见），建议保持 throw 直到 T4 实测。
5. **ModelTrajectory**：core 无 model-io；建议 `available:false` + 空 records 或事件轨迹降级，不得造假。
6. **IMcpSyncService / IZCodeAgentService automation**：保持空态/throw，ZS4 不做 MCP 增删与 automation 写路径。
