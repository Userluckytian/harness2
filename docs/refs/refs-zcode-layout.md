# refs-zcode-layout —— ZCode GUI 布局与信息架构（复刻权威）

> 本文档是 harness2 **GUI（桌面 / Web）壳骨架**的布局与信息架构复刻依据。
> 条目前缀 **`Z-*`**（编号一经分配**永不复用、永不重排**）；视觉与组件规格见同目录 `refs-zcode.md`（条目从 `Z-60` 起）。
> 阅读顺序：先读本文件的 **§6 默认展开折叠矩阵** 与 **§7 四种场景**，那是"壳长什么样"的核心。

---

## 分析基线

| 项              | 值                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 上游仓库        | `D:/AI_Projects/refs/ZCode`（`origin` = `https://github.com/zai-org/ZCode.git`）                                                 |
| 快照 commit     | `29628c9`                                                                                                                        |
| 版本 / 提交时间 | v3.14.3 / `2026-09-24T14:49:06+08:00`                                                                                            |
| 上游拉取        | ❌ **本轮未拉取成功**（`fetch-pack: unexpected disconnect while reading sideband packet`）。如实登记：沿用本地 `29628c9`，非最新 |
| 分析日期        | 2026-10-10                                                                                                                       |
| 是否过期        | 未超 §2 的 30 天线（距分析日 16 天）；**但上游 HEAD 未知**，进入实施前必须重试拉取并复核                                         |
| 权威范围        | GUI 的 **布局 / 区域 / 默认展开折叠 / 页面摆放 / 几何常量 / z-index / 场景形态**                                                 |
| 非权威范围      | 视觉与组件规格（见 `refs-zcode.md`）；ZCode 的业务页面（见 §10 不采纳清单）                                                      |

### 本轮更新记录

| 日期       | 执行者           | 上游 commit         | 改了什么                                                         |
| ---------- | ---------------- | ------------------- | ---------------------------------------------------------------- |
| 2026-10-10 | 编排者（主会话） | `29628c9`（未拉取） | 首建：完成布局与 IA 全量调研，产出 Z-01～Z-45 与默认展开折叠矩阵 |

---

## 1 定位与 GUI 相关目录

| 路径                             | 职责                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `packages/ui`                    | **GUI 共享前端**（桌面与 Web 共用）；shadcn 原语、壳骨架、所有页面 |
| `packages/ui/src/components/ui/` | shadcn(radix-mira) 组件原语源码                                    |
| `packages/ui/src/app-shell/`     | 壳骨架（`WorkspaceShellLayout`、席位、侧栏面板模型）               |
| `packages/ui/src/v4/`            | 工作台（分屏）、会话面板、对话行渲染                               |
| `packages/ui/src/settings/`      | 设置页                                                             |
| `packages/ui/src/lib/`           | 布局/偏好/侧面板注册表等纯逻辑                                     |
| `packages/desktop`               | Electron 壳                                                        |
| `packages/web`                   | 浏览器宿主（渲染同一个 `@zcode/ui` 的 `Root`）                     |

**关键结论：桌面与 Web 共用同一份前端**，差异只通过平台服务与 props 注入（见 §12）。

---

## 2 窗口与外壳

### Z-01 无独立顶栏

**ZCode 没有 topbar。** 传统意义上的"标题栏"是三段拼合出来的：

1. **`DesktopTopOverlay`** —— 绝对定位浮层（`packages/ui/src/DesktopTopOverlay.tsx:106`，`absolute left-0 top-0 z-20 w-fit`），展开态宽度跟随侧栏（`:98-100`）。高度：macOS `h-14`，Windows/Linux `h-12`（`:117-119`）。内含：侧栏折叠按钮、任务前进/后退、New Task（侧栏收起或文件树打开时才出现）、更新按钮。
2. **`WorkspaceHeader`** —— 每个会话列顶部，`h-12 border-b`（`packages/ui/src/WorkspaceHeader.tsx:140`）。会话态 `variant="task"`，草稿态 `variant="draft"`（只留占位，`:162-199`）。右侧动作区：帮助菜单、终端按钮、Side Pane 开关、Windows/Linux 内联窗控（`WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx:59-78`）。
3. **Side Pane 标签栏** —— `h-12 border-b`（`AnimatedSidePanePanel.tsx:950`）。

> 复刻要点：**不要做 topbar**。左上角折叠按钮是浮层；New Task 是条件出现的。

### Z-02 窗口外壳与平台圆角

`DesktopWindowFrame`（`packages/ui/src/DesktopWindowFrame.tsx:31-47`）：根是 `flex h-dvh flex-col overflow-hidden`，带 `data-desktop-window-frame="true"`，内部单层 `relative flex-1 min-h-0`。其 `title / actions / tabBar` props **已废弃不用**。

| 平台    | 外壳圆角                                                                  | 根背景                  |
| ------- | ------------------------------------------------------------------------- | ----------------------- |
| Linux   | `rounded-[16px] [clip-path:inset(0_round_16px)]`；最大化 → `rounded-none` | `bg-background-win-alt` |
| Windows | 面板 `rounded-[5px]`（Win10 不支持原生圆角时只收右角）                    | `bg-background-win-alt` |
| macOS   | Tahoe(≥26) `12px`，否则 `6px`                                             | `bg-background-alt`     |
| Web     | `12px`                                                                    | `bg-background-win-alt` |

常量在 `packages/ui/src/app-shell/workspaceShellWindowChrome.ts:15-63`；手柄内缩 = 面板圆角 + 4px（`:27-31`）。注释解释 Linux 合成器会丢圆角，故用同半径 `clip-path` 固定（`DesktopWindowFrame.tsx:36-40`）。

### Z-03 首层嵌套结构

```
DesktopWindowFrame (h-dvh)
└─ div[data-workspace-shell]  relative flex h-full min-h-0 w-full overflow-hidden
   ├─ div[data-workspace-sidebar-panel]   w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none
   │    transition-[width,opacity] duration-200 ease-out
   │    └─ aside > ScopedErrorBoundary > V4SplitPaneEntryProvider > WorkflowRunOpenProvider > WorkspaceSidebar
   ├─ [侧栏可见时] div[role=separator]  侧栏拖拽手柄  w-1 z-10 cursor-ew-resize
   └─ div#content  flex min-w-[320px] flex-1 flex-col
      ├─ [桌面] div.h-1.w-full [app-region:drag]   顶部拖拽留白
      └─ ResizablePanelGroup "workspace-body-layout"  [conversation-column | browser]   ← 横向
         ├─ ResizablePanel#conversation-column  minSize 35%  defaultSize 52%(右栏可见时)
         │   └─ ResizablePanelGroup "workspace-conversation-column-layout" [conversation | terminal] ← 纵向
         │      ├─ ResizablePanel#conversation  minSize 35%
         │      │   └─ section[data-workspace-conversation-frame] flex h-full flex-col overflow-hidden bg-background
         │      │      ├─ WorkspaceHeader（条件渲染）
         │      │      └─ main: automations 视图 | plugin-store 视图 | chat(V4WorkspaceChatArea)
         │      └─ AnimatedTerminalPanel（非 automations/plugin-store 时）
         └─ sidePanePanel（ResizableHandle + ResizablePanel#browser）
   └─ DesktopTopOverlay (absolute)
```

证据：`WorkspaceShellLayout.tsx:1510-1972`。侧栏宽度经 CSS 变量驱动（`:758-775`：`--workspace-sidebar-panel-width`、`--workspace-panel-radius`、`--workspace-resize-handle-inset`）；注释说明外层**不再用 react-resizable-panels**，改 CSS 变量专用 split，避免窗口 resize 每帧写 layout store（`:1525-1527`）。

### Z-04 自定义窗口控件

仅 Windows/Linux 桌面自绘三键（minimize / toggleMaximize / close），`packages/ui/src/DesktopWindowControls.tsx:33-76`；macOS 用系统红绿灯 + 左侧 96px 安全区。

**挂载点会移动**：Side Pane 关闭时在 `WorkspaceHeader` 最右；Side Pane 打开时移到 **Side Pane 标签栏右侧**（`AnimatedSidePanePanel.tsx:811`）。判定 `usesInlineWindowControls`（`WorkspaceHeader.tsx:120`）。

---

## 3 左栏（Sidebar）

### Z-05 默认与几何

| 项                  | 值                                       | 证据                              |
| ------------------- | ---------------------------------------- | --------------------------------- |
| 默认                | **展开**                                 | `hooks/useAppPanels.ts:205`       |
| 默认宽度 / 最小宽度 | `264px` / `264px`                        | `WorkspaceShellLayout.tsx:99-100` |
| 最大宽度            | 容器 × `0.5`                             | `:101,131-141`                    |
| 键盘调宽步长        | `16px`                                   | `:105`                            |
| 持久化 key          | `zcode:workspace-shell:sidebar-width-px` | `:102`                            |
| 折叠后宽度          | **桌面 `4px` / Web `0px`**               | `:354`                            |
| 折叠状态持久化      | **否**（刷新回到展开）                   | `useAppPanels.ts:1240-1242`       |

### Z-06 折叠形态：没有轨道

折叠后只剩 4px（桌面）/ 0px（Web），内容 `opacity-0 pointer-events-none`，**不显示图标轨道**。

`WorkspaceSidebarCollapsedRail` 组件虽已导出（`WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx:7`）但**全仓无任何使用点**（只在 `WorkspaceSidebar.tsx:156` re-export）→ **属历史包袱，不要照抄**。

折叠入口在 `DesktopTopOverlay`（见 Z-01）——侧栏隐藏后入口仍在左上角。

### Z-07 分区顺序（自上而下）

| #   | 分区                                                                              | 默认                                                 | 可折叠            | 持久化                                      |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------- | ------------------------------------------- |
| 0   | 拖拽条 `h-12 [app-region:drag]`                                                   | 常驻                                                 | —                 | —                                           |
| 1   | New Task 按钮组（`h-8`）                                                          | 展开                                                 | 否                | —                                           |
| 2   | 命令中心入口（搜索图标 + 快捷键）                                                 | 常驻                                                 | 否                | —                                           |
| 3   | **Automations** 按钮                                                              | 常驻                                                 | 否                | —                                           |
| 4   | **Plugin Store** 按钮                                                             | 常驻                                                 | 否                | —                                           |
| 5   | 任务工具栏（`Grouped` / `By Project` 分段 + 全部展开/收起 + 视图筛选 + 归档按钮） | 常驻                                                 | 否                | `zcode-sidebar-task-preferences`            |
| 6   | **Pinned** 区                                                                     | **有置顶项才显示**（空则 return null），超 20 条折叠 | 列表内 "show all" | 置顶在任务 meta                             |
| 7   | **Projects** 区（列出各 workspace，可拖拽排序）                                   | **展开**                                             | 是                | `zcode-sidebar-purpose-section-preferences` |
| 8   | **Conversations** 区                                                              | **展开**                                             | 是                | 同上                                        |
| 9   | Footer（账号菜单 + 设置）                                                         | 常驻                                                 | 否                | locale/theme 等各自 key                     |
| 10  | 文件树 `WorkspaceFileTree`                                                        | **关闭**（绝对定位滑入）                             | 是（整体滑出）    | 否                                          |

证据：`WorkspaceSidebar.tsx` 全篇；Pinned `WorkspacePinnedTasksSection.tsx:464-469,94`；purpose 偏好 `sidebarPurposeSectionPreferences.ts:12,16-22`。

### Z-08 任务视图模式

| 模式                        | 进入方式                               | 默认                 |
| --------------------------- | -------------------------------------- | -------------------- |
| `workspace`（= By Project） | 顶部分段控件                           | ★ **默认**           |
| `grouped`                   | 顶部分段控件                           | —                    |
| `chronological`（timeline） | **筛选下拉**里的「Chronological List」 | —                    |
| `archived`                  | 归档按钮                               | 关闭，且**不持久化** |

`resolveSidebarTaskViewMode` 判定见 `WorkspaceSidebar.tsx:207-221`；偏好默认 `organizeBy:"project"` / `sortBy:"updated"`（`sidebarTaskPreferences.ts:12-16`）。
展开态 key：workspace `zcode-workspace-expansion`（默认展开）、grouped 组 `zcode-grouped-task-collapsed-groups`（默认全展开）。

### Z-09 会话项（任务行）

左侧 16px leading 槽，按优先级：**error 红点 > unread 蓝点 > loading spinner > pinned 图钉**（`TaskListItem.tsx:557-598,361-364`）。标题溢出用渐隐 + `pendingInteraction` 徽标 + attention 徽标（绿底 `bg-success/14`，`:622-640`）。元信息行：变更 `+/-`、cron 时钟、off-peak 月亮、相对时间（`:642-685`）。选中 `bg-selected`，hover `bg-surface-hover`。

### Z-10 任务行右键菜单

`TaskActionMenuContent.tsx:82-206`，顺序：置顶/取消 → 重命名 → 归档 → 标记未读 → **在分屏打开** →（分隔）→ 在文件管理器显示 → 复制工作区路径 → 复制任务路径 → 复制日志路径 → 复制 Session ID →（分隔）→ **查看 Model Trajectory** →（分隔）→ 反馈。

### Z-11 Footer 账号菜单

左：头像按钮 = 统一设置菜单入口（`WorkspaceSidebarFooter.tsx:220-236`），**分组顺序固定**：语言 → 主题 → 界面模式 → 缩放（桌面）→ 用量/升级 → 登录/登出（注释 `:308-311`）。右：Web 远控入口（桌面且有 workspace 时）+ 设置齿轮。

---

## 4 内容区与右栏（Side Pane）

### Z-12 分栏嵌套与默认比例

| 层       | 面板                  | min   | default             | 展开尺寸 |
| -------- | --------------------- | ----- | ------------------- | -------- |
| 外层横向 | `conversation-column` | 35%   | 52%（仅右栏可见时） | —        |
| 外层横向 | `browser`（右栏）     | 240px | **0px**             | 45%      |
| 内层纵向 | `conversation`        | 35%   | —                   | —        |
| 内层纵向 | `terminal`            | 140px | **0px**             | 30%      |
| 内容区   | `#content`            | 320px | —                   | —        |

证据：`WorkspaceShellLayout.tsx:121-122,1639,1653-1657,1664-1668`；`sidePaneLayout.ts:1-2`；`animatedSidePanePanelModel.ts:52-59`；`AnimatedTerminalPanel.tsx:107-110`。

### Z-13 右栏默认收起且默认无 tab

- **默认收起**：`DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.isSidePaneCollapsed = true`（`taskSidePaneMemory.ts:18-25`），注释明确"右侧共享面板默认关闭，只在用户主动查看时再展开"（`useAppPanels.ts:193-197`）。
- **默认一个 tab 都不开**：无可见 tab 时显示 **"Open a tab" 启动器**（`AnimatedSidePanePanel.tsx:814-859,931`）。
- 可见条件：`workspaceMainView === "chat" && isSidePaneOpen`（`WorkspaceShellLayout.tsx:423`）。
- **新建任务会强制收起右栏**（`App.tsx:296-334`，靠 `draftFocusVersion` 触发）。
- 持久化：**内存模块级 Map**（非 localStorage），key 只用 workspace 身份、忽略 taskId（`taskSidePaneMemory.ts:53-70`），LRU 上限 50 → **重启不保留**。

### Z-14 右栏 tab 清单与出现条件

全部为**按需出现**，默认都不在（`lib/workspaceSidePane.ts:516-535`）：

| tab                                                                           | 入口                                         | 备注                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| `browser`                                                                     | 加号菜单 / 打开 URL / webview popup          | 折叠时仍挂载，仅显式关 tab 才销毁     |
| `git`                                                                         | 加号菜单 review / Header 入口                | id 固定 `"git"`                       |
| `code-viewer`                                                                 | 打开文件/预览                                | 同一 id                               |
| `model-trajectory`                                                            | **任务右键「查看 Model Trajectory」**        | id `model-trajectory:{taskId}`        |
| `terminal`                                                                    | 加号菜单                                     | office 模式隐藏                       |
| `developer-tools`                                                             | 加号菜单                                     | 受 `useDeveloperToolsVisibility` 门控 |
| `bash-output`                                                                 | 后台 bash 输出                               | 折叠时仍挂载                          |
| `browser-use`                                                                 | main 进程驱动                                | 折叠时仍挂载                          |
| `subagent-session` / `subagent-directory`                                     | 工具卡子代理药丸                             | —                                     |
| `selection-side-chat`                                                         | 划词「Ask in side chat」                     | 需 activeTaskId                       |
| `plan-detail`                                                                 | 计划详情                                     | —                                     |
| `workflow-run` / `-directory` / `-actor-session` / `-workspace` / `-artifact` | 工作流卡片/行                                | —                                     |
| `treemapping`                                                                 | **已停用**（被状态边界过滤 + handler no-op） | 历史包袱                              |
| `whiteboard`                                                                  | 菜单入口已注释                               | 历史包袱                              |

加号菜单项由 `resolveOpenTabLauncherItemIds` 生成（`animatedSidePanePanelModel.ts:10-42`）：selection-side-conversation、review、terminal、browser、developer-tools。

tab 行为：可横向滚动、可拖拽排序、可关闭/关闭其他/全部关闭；溢出常量 `SIDE_PANE_TAB_MIN_WIDTH_PX = 60`、gap `4`（`sidePaneLayout.ts:4-6`）。

### Z-15 自动收起规则

| 常量             | 值                       |
| ---------------- | ------------------------ |
| 右栏自动收起阈值 | conversation < **480px** |
| 左栏自动收起阈值 | conversation < **360px** |
| resize idle      | **300ms**                |

判定顺序：先右栏、后左栏（`WorkspaceShellLayout.tsx:459-509`）。**只在窗口 resize 后 idle 判定**，不监听 conversation 自身 ResizeObserver——注释说明是为了避免"用户手动展开又被关回去"（`:493-494`）。

---

## 5 主区与对话页

### Z-16 主区三视图

`WorkspaceMainView = "chat" | "automations" | "plugin-store"`，**默认 `chat`**（`app-shell/types.ts:120`、`App.tsx:826`）。切换靠**左栏的 Automations / Plugin Store 按钮**（`aria-pressed` + `bg-selected`），回到 chat 靠选任务 / 新建任务 / 面包屑返回。

> ⚠️ **主区没有视图环 / 标签条。** 切到 automations / plugin-store 时**不渲染 `WorkspaceHeader`**，改用面包屑框架（`WorkspaceShellLayout.tsx:1494-1497,1752,1802`）。

### Z-17 对话页区块构成与默认显隐

| 区块                                                                    | 默认                                                         | 证据                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `ConversationHeader`                                                    | 不占高度，仅浮动拆分/关窗按钮                                | `ConversationHeader.tsx:35-49`                    |
| `ConversationStatusPanel`                                               | 有内容才渲染；`auto` 模式 <1280px 出 mini 胶囊、≥1280px 展开 | `ConversationStatusPanel.tsx:1858-1859,1908,1963` |
| └ Git / Goal / SessionPlans / Plan 子块                                 | **展开**                                                     | `:290,389,527,823,886`                            |
| └ Terminal / Workflow / Agent 子块                                      | **收起**                                                     | `:1064,1166,1361`                                 |
| `ConversationTurnNavigator`                                             | 需 ≥2 项**且**容器 ≥864px                                    | `ConversationTurnNavigator.tsx:133-144`           |
| QueuePanel                                                              | 有队列时                                                     | `SessionPane.tsx:4527-4540`                       |
| QuotaBanner / PendingCommandRecoveryBanner / WorkspaceHookPendingBanner | 对应状态时                                                   | `:4495-4526`                                      |
| 交互对话框（权限 / 提问）                                               | 有 pendingInteraction 时                                     | `:4543-4553`                                      |
| Composer                                                                | **常驻**                                                     | `:4554`                                           |
| DraftSuggestedPrompts                                                   | 仅草稿态                                                     | `:4556-4570`                                      |
| Timeline                                                                | 主内容                                                       | `:4735-4828`                                      |

对话内容宽度（`conversationLayout.ts:3-9`）：草稿 `max-w-2xl`；非草稿在 ≥864px 时 `w-[calc(100%-6rem)] max-w-4xl`，≥1280px 时 `w-[calc(100%-24rem)] max-w-6xl`。

### Z-18 空态

`isDraft` 时 Timeline 的 emptyState = `ConversationDraftEmptyState`（testid `TID_CHAT_EMPTY`，`SessionPane.tsx:4786-4793`）：**按时段问候语**（边界 5/9/12/14/18/23 点）+ ZCode Logo 水印（`ConversationDraftEmptyState.tsx:14-36,170-208`）；office 模式用另一套文案。空态下 **StatusPanel 不渲染**。

### Z-19 分屏工作台

- 宿主 `V4WorkspaceChatArea`（`v4/V4WorkspaceChatArea.tsx:129-141`）；primary pane id = **`"workspace-main"`**；**上限 4 pane**（`paneLayoutTree.ts:20-23`）。
- 布局是**二叉分割树**；边缘投放 32% 带（侧栏 `workbenchDragDrop.ts:81-107`）。
- 持久化 key **`zcode-v4-pane-layout:v2`**（`paneLayoutPersistence.ts:17`）。
- 非 primary pane 右上角浮动关闭按钮（`ConversationHeader.tsx:93-113`）；跨 workspace pane 显示 workspace 徽标。
- **左栏任务行可拖拽进分屏**；已在分屏内的会话禁用拖拽。

### Z-20 权限 / 提问的落点

| 类型                            | 形态                                                                                      | 层级                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| 权限（permission）              | **底部 dock 卡片**（`relative z-1`，**无遮罩、不是模态**）                                | 在 composer 区 `z-20` 内 |
| 提问（userInput / elicitation） | 底部 dock 卡片，或固定居中模态 `V4UserInputDialog`（`fixed inset-0 z-[100] bg-black/40`） | 100                      |

`V4InteractionDialogs` 取 `pendingInteractions` 首个 permission/userInput（`V4InteractionDialogs.tsx:115-122`）。

---

## 6 ★ 默认展开折叠矩阵

> 这是本文件的核心。复刻时逐行落实。

| 区域                                             | 默认状态                   | 触发条件                               | 持久化 key                                                      | 备注                    |
| ------------------------------------------------ | -------------------------- | -------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| 左栏整体                                         | **展开 264px**             | 点左上角折叠按钮；窗口 <360px 自动收起 | 宽 `zcode:workspace-shell:sidebar-width-px`；**折叠态不持久化** | 折叠后 4px/0，无轨道    |
| New Task / 命令中心 / Automations / Plugin Store | 常驻                       | —                                      | —                                                               | —                       |
| 任务工具栏                                       | 常驻                       | —                                      | `zcode-sidebar-task-preferences`（organizeBy/sortBy）           | 默认 project/updated    |
| Pinned                                           | **空则隐藏**               | 有置顶任务                             | 置顶在任务 meta                                                 | 超 20 条折叠            |
| Projects                                         | **展开**                   | 点标题                                 | `zcode-sidebar-purpose-section-preferences`                     | 可拖拽排序              |
| Conversations                                    | **展开**                   | 点标题                                 | 同上                                                            | —                       |
| 任务视图模式                                     | **project**                | 分段控件 / 筛选下拉                    | `zcode-sidebar-task-preferences`                                | timeline 在筛选里       |
| 归档视图                                         | **关闭**                   | 归档按钮                               | **否**                                                          | —                       |
| 单 workspace 展开                                | **展开**                   | 点 workspace 行                        | `zcode-workspace-expansion`                                     | —                       |
| grouped 分组                                     | **展开**                   | 点分组标题                             | `zcode-grouped-task-collapsed-groups`                           | 默认空集                |
| 文件树                                           | **关闭**                   | Git 面板 / 任务行按钮                  | **否**                                                          | 绝对定位滑入            |
| Footer 账号 / 设置                               | 常驻                       | —                                      | locale/theme 等                                                 | —                       |
| **右栏整体**                                     | **收起**                   | 打开任意 tab / toggle                  | **内存 Map**（重启不保留）+ per-owner 折叠偏好                  | 45% 展开                |
| 右栏 tab 条                                      | **无 tab**（"Open a tab"） | 打开 tab                               | 内存 Map（tabs+顺序）                                           | defaultSize 0           |
| **终端（底部）**                                 | **关闭**                   | Header / 快捷键                        | 否                                                              | 展开 30%                |
| conversation 列                                  | 常驻                       | —                                      | RRP `workspace-body-layout`                                     | 右栏可见时默认 52%      |
| 状态面板                                         | **auto**                   | 有内容才出现                           | pane 内状态                                                     | <1280 mini / ≥1280 展开 |
| └ Git/Goal/Plans/Plan                            | **展开**                   | 点标题                                 | 组件内 state                                                    | —                       |
| └ Terminal/Workflow/Agent                        | **收起**                   | 点标题                                 | 父级 state                                                      | —                       |
| 轮次导航                                         | 按需（≥2 项且 ≥864px）     | 轮次增加                               | 否                                                              | 左侧 rail               |
| 队列面板                                         | 按需                       | 有队列                                 | 否                                                              | 底部 dock               |
| 配额 / Banner / 恢复条                           | 按需                       | 对应状态                               | 配额 dismiss 有 store                                           | —                       |
| 权限 / 提问                                      | 按需                       | pendingInteraction                     | 草稿有 store                                                    | 底部 dock / 模态        |
| DesktopTopOverlay                                | 常驻                       | —                                      | 否                                                              | z-20，h-14/h-12         |
| 菜单 / 下拉 / Toast                              | 按需                       | 交互                                   | —                                                               | z-60 / z-9999           |

---

## 7 ★ 四种场景的默认形态

**① 空态（无任何会话）**
左栏展开 264px：New Task、命令中心、Automations、Plugin Store、任务工具栏；Projects + Conversations 均展开（可为空态文案）。内容列：草稿 Header（`border-transparent`）→ 居中**按时段问候语 + Logo 水印** → 底部 composer → composer 下方建议提示。**右栏收起且无 tab、终端关闭、状态面板不渲染、轮次导航无、无视图环。**

**② 单会话在跑**
左栏任务行 leading 显示 spinner。内容列：时间轴流式行 + 常驻 composer；状态面板按容器宽出 mini 或 panel（运行中的 terminal/agent/workflow 子块**默认收起**）；轮次 ≥2 且列宽 ≥864px 时左侧出现轮次导航。**右栏仍默认收起。**

**③ 多会话（分屏）**
主内容列被二叉分割成多 pane（≤4），非 primary pane 右上角浮动关闭按钮；左栏任务行可拖进分屏。布局持久化 `zcode-v4-pane-layout:v2`。

**④ 有审批 / 提问在等待**
权限 → 底部 dock 卡片；提问 → 底部 dock 或居中模态。左栏对应任务行显示 attention 徽标 / `pendingInteraction` 徽标。软审核（workspaceHookReview）**不阻塞** composer。窗口失焦时走系统通知。

---

## 8 几何与常量表

| 项                    | 值                                                                                            | 证据                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 左栏 默认/最小        | 264px / 264px                                                                                 | `WorkspaceShellLayout.tsx:99-100`                                       |
| 左栏 最大             | 容器 × 0.5                                                                                    | `:101,131-141`                                                          |
| 左栏 折叠宽           | 4px（桌面）/ 0（Web）                                                                         | `:354`                                                                  |
| 左栏 键盘步长         | 16px                                                                                          | `:105`                                                                  |
| 内容列最小宽          | 320px                                                                                         | `:1639`                                                                 |
| conversation-column   | 默认 52% / min 35%                                                                            | `:1653-1657`                                                            |
| conversation          | min 35%                                                                                       | `:1664-1668`                                                            |
| 终端                  | 0 / 140px / 50%，展开 30%                                                                     | `AnimatedTerminalPanel.tsx:107-110`；`:410-414`                         |
| 右栏                  | 0 / 240px / 65%，展开 45%                                                                     | `animatedSidePanePanelModel.ts:52-59`；`sidePaneLayout.ts:1`            |
| 右栏 tab 最小宽 / gap | 60px / 4px                                                                                    | `sidePaneLayout.ts:4-5`                                                 |
| 自动收起阈值          | 右栏 480px / 左栏 360px                                                                       | `:108,117`                                                              |
| resize idle           | 300ms                                                                                         | `:118`                                                                  |
| 面板圆角              | Win 5 / mac 12·6 / 其他 12                                                                    | `workspaceShellWindowChrome.ts:15-25`                                   |
| 手柄内缩              | 圆角 + 4px                                                                                    | `:27-31`                                                                |
| 窗口控件 padding      | mac 左 96px / win 右 136px                                                                    | `useAppChromeState.ts:7-8`                                              |
| 分屏上限              | 4 pane                                                                                        | `paneLayoutTree.ts:23`                                                  |
| 头部高度              | Header / 侧栏拖拽条 / Side Pane tab 条 = **48px**；TopOverlay 56（mac）/48                    | 各处                                                                    |
| 拖拽条                | 1px 视觉 / 4px 热区                                                                           | `WorkspaceShellLayout.tsx:1627`                                         |
| 过渡时长              | 侧栏 width/opacity 200ms；面板 flex-grow 200ms（兜底 240）；右栏锁定 200ms；预览 settle 220ms | 各处                                                                    |
| 断点                  | 状态面板/内容 1280px；轮次导航 864px                                                          | `conversationLayout.ts:5,9,43`；`ConversationTurnNavigator.tsx:133,144` |
| 设置页导航            | 68px 图标栏 / lg 起 268px                                                                     | `SettingsPage.tsx:1375`                                                 |
| 设置页内容列          | `max-w-4xl px-4 lg:px-8`                                                                      | `SettingsPageParts.tsx:21-22`                                           |

---

## 9 z-index 梯子与动效

| 层                                    | z      | 证据                                      |
| ------------------------------------- | ------ | ----------------------------------------- |
| Toast                                 | `9999` | `components/ui/toast.tsx:51-57`           |
| V4UserInputDialog                     | `100`  | `V4UserInputDialog.tsx:46`                |
| 下拉 / 右键 / 子菜单 / popover        | `60`   | `dropdown-menu.tsx:45,249`；`popover.tsx` |
| Dialog 遮罩与内容 / 拖拽落点遮罩      | `50`   | `dialog.tsx:34,63`                        |
| 草稿 drop 遮罩                        | `40`   | `WorkspaceHeader.tsx:146`                 |
| TopOverlay / 状态面板 / pane 浮动按钮 | `20`   | 各处                                      |
| 侧栏手柄 / 轮次导航 / tab 内容        | `10`   | 各处                                      |

动效：collapsible 300ms；侧栏 200ms ease-out；reasoning 收起后 **300ms 延迟卸载内容**；接口滚动条 14px / thumb `min 32px` / `border 3px transparent` / `bg-border`。

---

## 10 复刻等级矩阵（本文件范围）

| 条目                                             | 等级       | 说明                             |
| ------------------------------------------------ | ---------- | -------------------------------- |
| Z-01～Z-04 外壳与浮层                            | **必刻**   | 含"无 topbar"这一反直觉结论      |
| Z-05～Z-11 左栏                                  | **必刻**   | 含分区顺序、默认展开、持久化 key |
| Z-12～Z-15 内容区与右栏                          | **必刻**   | 含"右栏默认收起且无 tab"         |
| Z-16～Z-20 主区与对话页                          | **必刻**   | 含"主区无视图环"                 |
| §6 折叠矩阵 / §7 四场景                          | **必刻**   | 验收基准                         |
| §8 几何常量                                      | **必刻**   | 数值逐条对齐                     |
| §9 z-index 与动效                                | **必刻**   | —                                |
| 文件树滑入                                       | **参考**   | 交互自定                         |
| `treemapping` / `whiteboard` / `developer-tools` | **不采纳** | ZCode 业务专属或已停用           |
| office 模式（`InterfaceMode`）                   | **参考**   | 我们有类似需求时再定，本期不做   |
| 平台圆角/窗控细节                                | **参考**   | 桌面端按 Electron 实际能力实现   |

---

## 11 与当前原型的差异（**必须修正**）

`design/prototype-zcode.html` 是"解剖图"，与 ZCode 真实骨架有以下方向性差异，实施时按 ZCode 为准：

| #   | 原型做法                           | ZCode 真实                                                                     |
| --- | ---------------------------------- | ------------------------------------------------------------------------------ |
| 1   | 有独立顶栏（topbar）               | **没有 topbar**，是 `DesktopTopOverlay` 浮层（h-14/h-12，z-20，宽度跟随侧栏）  |
| 2   | 左栏可折叠成 52px 图标轨道         | 折叠后 **4px（桌面）/0**，**没有轨道**；且折叠态不持久化                       |
| 3   | 左栏宽度 264–420，默认 280         | **最小也是 264，默认 264**，最大 = 容器 50%                                    |
| 4   | 主区有视图环（chat \| trajectory） | **没有视图环**；trajectory 是右栏 `model-trajectory` tab（任务右键进入）       |
| 5   | 右栏 8 个 tab 常驻展开             | 右栏**默认收起且一个 tab 都不开**，显示 "Open a tab" 启动器                    |
| 6   | 浏览器/终端作为常驻副栏分屏        | 二者都是**右栏按需 tab**；终端另有独立底部面板（默认关闭，展开 30%）           |
| 7   | 状态行 / 上下文环放在主区顶栏      | 上下文用量在 **composer 右侧**（`ChatContextUsage`）；状态信息在**状态面板**里 |

原型的价值：**能力盘点与视觉观感评审**。骨架以本文档为准。

---

## 12 平台特化 / 设计意图 / 历史包袱

### 平台特化（照实做，但按我们的 Electron 能力取舍）

- 圆角：Linux 16px 外壳 + `clip-path`；Windows 5px（Win10 只收右角）；macOS Tahoe(≥26) 12px、否则 6px。
- 根背景：mac `bg-background-alt`，其余 `bg-background-win-alt`。
- 窗口控件：mac 原生红绿灯 + 左 96px 安全区；Win/Linux 自绘内联三键，位置随右栏开合切换。
- Web / 移动远控不支持内嵌 browser；用 `h-dvh` 而非 `100vh`。
- office 模式隐藏 terminal 与 review 入口。

### 代码注释里直接写明的设计意图（可当规格读）

1. 侧栏折叠按钮**外置**到左上角（`useAppPanels.ts:202-204`）。
2. 右栏默认关闭，**避免一进工作区就占住主会话空间**（`:193-194`）。
3. 终端默认关闭，**避免默认创建 xterm / 进程**（`:189-191`）。
4. 外层 split **不用 react-resizable-panels**，避免窗口 resize 每帧写 layout store（`WorkspaceShellLayout.tsx:1525-1527`）。
5. 拖拽**只写 CSS 变量、松手才 setState**（`:547-549`）。
6. 自动收起**只响应窗口 resize idle 后的 conversation 宽**（`:493-494`）。
7. 面板收起**只隐藏不卸载**（终端 / 右栏 / tab），保留会话与动画。
8. 面板拖到最小**不应触发 collapse**，只有显式关闭才折叠。
9. auto 状态面板**保留到 DOM 由容器查询裁决**，React 不做 ResizeObserver→业务状态翻译（`conversationLayout.ts:26-30`）。

### 历史包袱（不要照抄）

`WorkspaceSidebarCollapsedRail` 未使用；`treemapping` 全链路保留但已过滤；`whiteboard` 菜单入口被注释；`DesktopWindowFrame` 的 `title/actions/tabBar` props 废弃；分屏 `onSplitRight/onSplitDown` 按钮被注释下线；侧栏旧百分比宽度 key 需迁移到像素 key。

---

## 13 待确认项

1. **ZCode 上游未拉取成功**——实施前必须重试，并复核本文档是否过期。
2. macOS 原生标题栏的精确像素高度无法从本仓库确认（Electron 窗口 chrome 决定，UI 侧仅用 96px 安全区近似）。
3. 右栏 tab 的**位置顺序跨重启不保留**（只有内存 Map）——若我们要做得更好，属于"改进"而非"复刻"。
