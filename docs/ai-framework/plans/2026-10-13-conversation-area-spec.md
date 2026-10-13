# 对话区（中间对话列）权威规格 + 差距清单

> **任务**：从 ZCode 官方源码抽取「中间对话区」的权威规格（形态 1 无对话/草稿态、形态 2 处于某对话下），
> 并对照本仓现有实现产出差距清单。**本文件只做调研与文档，不改任何功能代码。**
>
> **权威来源（本地源码快照）**：`D:/AI_Projects/refs/ZCode/packages/ui/src/v4/`（commit `29628c9`，2026-10-10 拉取）。
> 配套：`docs/refs/refs-zcode-layout.md`（Z-17/Z-18/§①）、`docs/ai-framework/plans/2026-10-12-zcode-gap-register.md` §1.2、
> `docs/ai-framework/plans/2026-10-13-phase-Z10-p1-p2-parity.md` §0.2（1440×900 内置浏览器实测）。
>
> **对照对象（我们）**：`packages/ui-shared/src/renderer/components/ChatView.tsx`、
> `packages/ui-shared/src/renderer/conversation/**`、`packages/ui-shared/src/styles/shell.css`、
> `packages/desktop/src/renderer/conversation/assembly.tsx`、`packages/desktop/src/renderer/components/ConversationHeader.tsx`。

## 0 证据与口径

| 标记       | 含义                                                            |
| ---------- | --------------------------------------------------------------- |
| `源码:行`  | 直接读到 `refs/ZCode/packages/ui/src/...` 的源码行（权威）      |
| `class:`   | Tailwind class 名（从源码 className 抄录）                      |
| `i18n:行`  | `refs/ZCode/packages/ui/src/i18n/locales/zh-CN.ts` 的中文文案行 |
| `refs:`    | `docs/refs/refs-zcode-layout.md` 条目                           |
| `实测`     | Z10 计划 §0.2（1440×900 浏览器实测）记录                        |
| **推断**   | 源码未直接给出、由 class/结构推出的结论                         |
| **未确证** | 无法从本快照源码确证（不编造，显式登记）                        |

- 行号均相对上表文件；ZCode 组件的 className 大量使用 `@container` 变体（`/conversation`、`/composer`、`/workspace-header`），
  断点以**会话列**为容器，不是视口。
- 本轮**未跑任何测试**（纯文档任务）。

---

## 1 形态 1：无对话 / 草稿态（`isDraft`）

ZCode 的「空态」= 会话已打开但尚无任何 row。主区只渲染
`ConversationDraftEmptyState`（Logo 水印 + 问候），建议 prompts 在 composer **之下**。
证据：`SessionPane.tsx:4786-4793`（emptyState）、`SessionPane.tsx:4556-4570`（建议 prompts，在 composerNode 之后）。

### 1.1 问候语（6 档 + office 档）

**分档边界**（`ConversationDraftEmptyState.tsx:14`，与实现 `:26-36` 一致）：

```
GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23]
```

| 档位 key                           | 小时区间              | 中文文案（`i18n:4221-4226`，逐字）      |
| ---------------------------------- | --------------------- | --------------------------------------- |
| `chat.empty.greeting.morningEarly` | `[5, 9)`              | 早上好呀，新的一天开始啦                |
| `chat.empty.greeting.morning`      | `[9, 12)`             | 上午好呀，有什么想让我帮忙的吗          |
| `chat.empty.greeting.noon`         | `[12, 14)`            | 中午好呀，要不要先休息一下              |
| `chat.empty.greeting.afternoon`    | `[14, 18)`            | 下午好呀，接下来交给我吧                |
| `chat.empty.greeting.evening`      | `[18, 23)`            | 晚上好呀，今天辛苦啦                    |
| `chat.empty.greeting.lateNight`    | `[23, 24) ∪ [0, 5)`   | 夜深啦，别忘了照顾好自己哦              |
| `chat.empty.greeting.office`       | office 模式覆盖全部档 | 今天有什么工作，交给我吧（`i18n:1911`） |

- office 档由 `useIsOfficeMode()` 决定：`isOfficeMode ? office : getChatEmptyGreetingMessageId(date)`（`源码:88`）。
- **6 档文案是 6 句不同的完整句子**（不是「问候词 + 固定后缀」）。EN 版同样 6 句不同（`i18n en-US:4513-4518`）。

**字号自适应规则**（`源码:15-16, 54-78`）：

- 常量：`GREETING_MIN_FONT_SIZE_PX = 20`、`GREETING_MAX_FONT_SIZE_PX = 30`。
- 算法（`resolveGreetingFontSizePx`）：
  - 任一入参非有限 / ≤0 / `availableWidth >= naturalTextWidth` → 返回 **30px**；
  - 否则 `clamp(floor(30 * availableWidth / naturalTextWidth), 20, 30)`。
- 测量方式：容器 `<p>`（`w-full px-4`）算 `paddingLeft+paddingRight` 后的可用宽；
  隐藏测量 `<span>`（`text-3xl/[1.2]` = 30px 原始文案）算自然宽；`ResizeObserver` 同时观察两者（`源码:101-168`）。
- 渲染：`<p>` 带 CSS 变量 `--v4-draft-greeting-font-size`，class `text-[length:var(--v4-draft-greeting-font-size)]/[1.2]`（`源码:189-197`）。
  → **行高恒为字号的 1.2 倍**；30px 时行盒高 36px。
- ⚠️ **冲突登记**：Z10 实测记「问候语 36px，`[510,262 672×36]`」。按源码，**字号上限是 30px**，36 更可能是
  `30 × 1.2` 的**行盒高度**。本轮以源码为准（30px），实测的 36 视作行高（**未确证**是否另有版本差异）。

**到点自动换档定时逻辑**（`源码:38-52, 91-99`）：

- `getNextChatEmptyGreetingDelayMs`：取当天所有边界小时中**第一个严格大于当前时刻**的边界；
  若都已过，则取**次日 5:00**；返回 `max(1, 边界 - now)` 毫秒。
- `useEffect` 用 `window.setTimeout(..., delay)` 到点 `setGreetingDate(new Date())` 触发重算，effect 依赖 `greetingDate` → 链式续期。

### 1.2 Logo / 水印

`ConversationDraftEmptyState.tsx:170-247`：

- **外层块**（`源码:171-175`）：`relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8`。
- **水印容器**（`源码:177-185`）：`pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10 -translate-x-1/2 -translate-y-1/2 text-foreground-subtlest`。
  - `25rem = 400px`；`aspect-[5/4]` → **400×320**。绝对定位 + 居中 + `-mt-10`（上移 40px）→ 水印居中于问候块、向上溢出（**推断**：因此视觉上压在问候上方/背后）。
  - `pointer-events-none`、`aria-hidden`；颜色 `foreground-subtlest`（最浅前景色）。
- **浅色资源**（`源码:216-236`）：内联 `<svg width=400 height=320 viewBox="0 0 400 320">`，`stroke="currentColor"`，
  class `opacity-70 dark:hidden` + 遮罩 `mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)`（向下渐隐）。
- **深色资源**（`源码:238-244`）：`<img src={darkEmptyStateLogoUrl}>`（`@/assets/Z.svg`，`源码:8`），class `hidden dark:block`；
  注释说明深色资源自带渐变/透明度，不再叠遮罩。
- **字号测量 span** 也在此块内（`源码:199-205`，`invisible absolute whitespace-nowrap text-3xl/[1.2]`）。

### 1.3 标题与描述

- i18n key 存在：`chat.empty.title` = 开始对话、`chat.empty.description` = 开始在 {workspace} 项目新建任务、
  `chat.empty.description.beforeWorkspace` = 开始在、`chat.empty.description.afterWorkspace` = 项目新建任务（`i18n:4217-4220`）。
- **本快照中没有任何组件引用这些 key**（对 `packages/ui/src` 全量 grep，命中仅 `locales/` 定义处）。
  → **ZCode 空态实际不渲染标题/描述**；这些 key 是历史遗留（与 `ConversationDraftEmptyState.tsx:2-5` 注释「随旧 ChatView 删除、i18n key 一直保留」一致）。
- `{workspace}` 插值只在 key 定义里，无消费方 → **未确证**其实际渲染形态。

### 1.4 建议 prompts（`ConversationDraftSuggestedPrompts*`）

**出现条件**：仅草稿态，且「非 office 模式 **或** `proactiveSuggestionsEnabled === true`」（`SessionPane.tsx:4556`）；
`className` = office `mt-4` / 编程 `mt-6`（`SessionPane.tsx:4557-4559`）。**位置：composerNode 之后**（composer 下方）。

**条数与文案来源**：

- 组件 `ConversationDraftSuggestedPrompts.tsx` 是**纯展示**；数据由 `ConversationDraftSuggestedPromptsContainer.tsx:139-155`
  经 `useDraftSuggestedPromptItems` → `mapClientScenesToDraftSuggestedPromptItems` 产出。
- 来源是 **Client Scenes 的 `draft-suggestion` scene**（`draftSuggestedPromptItems.ts:76`，远端配置；`:13` 注释「推荐配置来自 Client Scenes 的 draft-suggestion scene」）。
  → **源码内没有固定条数**；条数 = 远端配置项数（**未确证**默认条数）。
- i18n 里存在 `chat.draft.suggestedPrompt.recentCommits` = 检查近 7 天的 commit、
  `chat.draft.suggestedPrompt.createPdf` = 制作一份 PDF（含 `.prompt`，`i18n:4227-4231`），但**本快照无组件引用**（同 §1.3 结论：遗留）。
- `proactive`（office）模式用 `recommendedItems`，编程模式用 `allItems`，并按「导航到自动化」动作是否有回调过滤（`Container:144-155`）。

**点击行为 = 预填，不发送**（权威）：

- `onSelect(item)` → `Container.handleSelect` → `replacePlainPrompt` → `useZCodeSessionStore.getState().requestComposerTextInsert(...)`
  （`Container:238-252, 660-670`）→ 把文案**插入 composer 草稿**。带插件的推荐项走 `prependResolvedPlugin` 等（`:219-286`）。
- **不是**直接发送（无 submit 调用）。

**容器布局 / 尺寸**（`ConversationDraftSuggestedPrompts.tsx:288-349`，`layout="chips"` 默认）：

- 外层：`w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`（横向可滚、无滚动条）。
- 组：`mx-auto flex w-max items-center gap-4`（**间距 gap-4 = 16px**，整组水平居中）。
- 单项：`Button variant="outline" size="lg"` + `h-8 min-w-0 justify-start gap-1.5 overflow-hidden rounded-lg px-3 text-left text-ui-caption font-normal leading-4.5 text-foreground`（`源码:321`）。
  - 图标：`size-4 shrink-0 text-foreground opacity-70`（`源码:328-333`）。
  - 文本：`min-w-0 max-w-64 truncate text-ui-base text-foreground opacity-70`（`源码:334-339`）→ **文本最大 16rem**。
  - 入场动画：CSS 变量 `--zcode-draft-prompt-waterfall-delay = index*65ms`（`:322-326`），逐项 waterfall（**推断**：类 `zcode-draft-prompt-waterfall` 定义在样式表，本快照未见）。
- `layout="list"` 是 office 主动推荐（带标题 `occupationOnboarding.suggestionsHeading` + 刷新/关闭，`源码:191-286`），非本任务主形态。

### 1.5 空态整体垂直排布

时间轴在空态下的容器（`ConversationTimeline.tsx:1759-1776`）：

- **带建议（`responsiveCenteredEmptyLayout`，草稿态）**：
  `flex min-h-full flex-col items-center px-4` + 伪元素 `before:min-h-[52px] before:basis-[29dvh]`（顶部弹性留白）
  - `after:min-h-4 after:flex-1`（底部弹性留白）。`px-4` = 左右 16px。
- **不带建议（`centeredEmptyLayout`）**：`flex min-h-full flex-col items-center justify-center gap-4 px-4`（`gap-4` = 16px）。
- emptyState 包裹：`flex w-full max-w-2xl shrink-0 items-center justify-center`（`源码:1781`）→ 空态内容列**最大 2xl = 42rem = 672px**。
- 底部 dock（composer + 建议）：
  - 草稿（responsive）：`mt-3 shrink-0`（**非 sticky**，`源码:1914-1916`）；
  - centered：`shrink-0`（非 sticky）；
  - 会话态：`sticky bottom-0`（`源码:1918`）。
  - dock 内容列 `px-4 pb-4` **仅在非居中空态**时加（`源码:1928`）。
- 推断的垂直顺序（自上而下）：`[~29dvh 顶部留白] → Logo 水印 + 问候（gap-6=24px）→ composer（mt-3）→ 建议 chips（mt-6，SessionPane）→ [flex-1 底部留白 min-h-4]`。
- 与实测吻合：Logo `y=80`、问候 `y=262`、composer `y=446`、chips `y=511`（`实测` §0.2）。**注意**：实测的问候块高度 36 = 字号 30 × 行高 1.2（见 §1.1 冲突登记）。

---

## 2 形态 2：处于某对话下（有 row）

### 2.1 会话头 `ConversationHeader`

`ConversationHeader.tsx`（全文 121 行）：

- **不占布局高度**（`源码:36-38` 注释「pane chrome：不占布局高度，只在右上角悬浮拆分/关闭入口」）。
- 唯一常驻输出：`<span data-testid={TID_V4_SESSION_TITLE} data-title={title} className="sr-only" />`（`源码:45`）——**仅投影，不渲染占位 header**。
- 仅当 `workspaceBadge || onClosePane` 时渲染悬浮动作行（`源码:46-49`）：
  `pointer-events-none absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1`。
  - workspace 徽标：`h-7 max-w-[10rem] rounded-md border bg-popover px-2 font-mono text-ui-base text-foreground-subtle shadow-md`（`:56`）。
  - 关窗格按钮：`Button variant="outline" size="icon-md"`，图标 `XIcon size-4`（`:93-113`）。
  - 拆分按钮（splitRight/splitDown）**已注释下线**（`:64-92`），仅保留接口。
- → 没有标题栏、没有 Git/项目/模型信息、没有高度。**标题不显示**（`title` 只进 `data-title`）。

**可见的「顶栏」其实是 `WorkspaceHeader`**（`refs` Z-01/Z-17）：`h-12`（48px）、`border-b`、`flex items-center justify-between p-2`
（`WorkspaceHeader.tsx:139-157`），含任务标题/工作区上下文标签 + Git 分支切换器 + 动作区（`WorkspaceHeaderSections.tsx`）。
对话列本身**没有独立会话头横条**。

### 2.2 时间轴容器 `ConversationTimeline`

`ConversationTimeline.tsx:1690-1960`：

- 根：`relative flex min-h-0 flex-1 flex-col`（`:1690`）。
- 滚动区：`data-testid={TID_V4_TIMELINE}` + `data-v4-timeline-scroll="true"`；class
  `min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]`，并挂表格内缩 CSS 变量
  `--markdown-table-layout-left/right-inset`（默认 16px，`max-md` 8px；≥864px 且有轮次导航时左 48px）（`:1744-1757`）。
- 内容列宽（`conversationLayout.ts:3-9`，`getConversationContentWidthClassName`）：
  - 草稿居中：`max-w-2xl`；
  - 会话态：`w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl`。
  - 同一类名套在：headerSlot、virtual history、live tail、composer dock content（`:1803-1807, 1816-1823, 1864-1869, 1926-1930`）。
  - ⚠️ `conversationLayout.ts:4-5`（带状态面板）与 `:6-7`（不带）**字符串完全相同** → 面板有无不改变内容列宽（**推断**：疑似遗留/冗余常量）。
- 状态面板让位：`@min-[1280px]/conversation:-translate-x-42`（`-42*4 = -168px`）（`conversationLayout.ts:8-9`）。
- 虚拟化：`useVirtualizer`；轮次单元 `data-v4-turn-unit`、`absolute left-0 top-0 w-full` + `translateY`（`:1826-1853`）。

### 2.3 轮次结构（TurnGroup / TurnRow）

- **没有可见轮次头**。轮次是逻辑分组，视觉分隔靠**顶部留白**：
  `ConversationTurnGroup.tsx:1302-1310`：
  `section` class `relative mx-auto flex w-full flex-col gap-5 px-4 @md/conversation:px-6 pb-5` + `pt-14`（`pt-0` 当轮首是 workflow 通知卡）。
  → **`px-4`（16px）/ `@md` `px-6`（24px）、`pb-5`（20px）、`pt-14`（56px）、子项 `gap-5`（20px）**；无 border、无文字头。
- 内部 assistant 区：`group/assistant-turn flex w-full flex-col gap-5`（`:1322`）。
- **「耗时」文案在 work-history 段头**，不在轮次头：`AssistantHistoryStatus`（`:565-609`）：
  - 容器 `flex w-full border-b border-[var(--color-border)]/50 pb-2`；
  - 按钮 `text-ui-base text-foreground-subtle`；
  - 文案（`i18n:4322-4323`）：运行中 `chat.history.workingFor` = **工作中 {duration}**；完成且有耗时 `chat.history.workedFor` = **已工作 {duration}**；
    完成无耗时 `chat.history.worked`；被中断 `chat.history.stopped`。
  - 时长格式 `conversationWorkDuration.ts`：秒/分/时/天（`chat.history.duration.second/minute/hour/day` = 秒/分/时/天），最少 1 秒。
  - → **不是**「持续了 N 秒」，也**不是**每轮顶部一行。
- `ConversationTurnRow.tsx` 本身只是把 `ConversationRow` 透传给 `ConversationRowView`（`:61-80`），无布局。

### 2.4 用户输入体 `UserInputBody` / 用户气泡

`ConversationRowView.tsx` `UserInputRowView`（`:1195-1307`）：

- 行壳：`RowShell className="group/user-row flex flex-col items-end"`（`:1195`）→ **整体右对齐**。
- **是气泡**（不是通栏块）：`data-v4-user-input-bubble`，class
  `flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl`（`:1257-1259`）。
  → 圆角 `rounded-xl`（12px）、**右上角 `rounded-tr-xs`（2px）**、`border-border`、`bg-surface`、`px-4 py-3`（16/12px）、
  容器 ≥624px 时 `max-w-xl`（36rem = 576px）。
- 折叠体 `ConversationUserInputBody.tsx`：折叠最大高 **120px**（`:7`），超出时 `overflow-hidden` + 底部渐隐遮罩
  `mask-image:linear-gradient(to_bottom,black 0%,black 70%,transparent 100%)`（`:110-114`），并出现圆形展开按钮
  `Button size="sm" variant="outline"` + `rounded-full bg-background shadow-sm backdrop-blur-sm`（`:125-140`）。
- 附件区在气泡**上方**：`mb-2 flex max-w-xl flex-col items-end gap-2`（`:1197-1201`）。
- 行内动作（复制/编辑）：`mt-1 opacity-0 group-hover/user-row:opacity-100`（`:1284-1288`）。
- 正文渲染 `ConversationUserInputContent.tsx`：`text-ui-base leading-6`（`:69`），mention chip 分类着色。

### 2.5 助手正文

`ConversationRowView.tsx` `AssistantTextRowView`（`:1477-1541`）：

- 行壳 `group/assistant-row`；正文包 `div data-conversation-selectable className="w-full text-ui-base"`（`:1523`）。
- 走 `MessageResponse`（streamdown）渲染 markdown/代码块，`streaming` 容错（`:1516-1540`）。
- **无气泡、无背景、无额外内边距**；宽度 = 内容列宽（受 §2.2 的 max-w 约束）。
- 轮尾动作（复制/分叉/重试/反馈）在 `ConversationAssistantTextActions`，
  `opacity-0 group-hover/assistant-turn:opacity-100`（`:1414-1435`）。

### 2.6 工具调用行 `ConversationAgentToolCallRow` / ToolLayout

- `ConversationAgentToolCallRow.tsx`：包 `ToolCallBlock`；**与普通工具行同缩进，不加 px-4**（`:74-95` 注释「Agent 工具行和普通工具行同属工作流，不能在配对壳上额外加 px-4」）。
- `ToolCallBlocks/ToolLayout.tsx` + `ToolSummaryRow.tsx`：
  - 折叠/展开：`Collapsible`；摘要行 `inline-flex max-w-full items-center gap-2 text-ui-base`（`ToolSummaryRow.tsx:209`）。
  - 图标：`shrink-0 text-foreground-subtlest [&_svg]:text-foreground-subtlest`（`:73-77`）——**统一最浅前景色，非状态色**。
  - 类别标签 `kindLabel`：`font-medium whitespace-nowrap shrink-0`，运行中 `animated-gradient-text`（扫光），否则 `text-foreground-subtlest`（`ToolLayout.tsx:144-147`）。
  - 展开箭头：`ChevronRightIcon size-4 text-foreground-subtlest opacity-0 group-hover/tool-summary:opacity-100`，展开时 `rotate-90`（`ToolSummaryRow.tsx:213-219`）。
  - 展开内容：`CollapsibleContent` + 内层 `pt-2`；收起后**延迟 300ms 卸载**（`ToolLayout.tsx:19-21, 195-210, 346-357`）。
  - 状态：`statusLabel` 普通为 `whitespace-nowrap`；失败态加 `underline decoration-dotted underline-offset-2 cursor-help` + Tooltip（`ToolLayout.tsx:240-302`）。
  - **状态色**：通用 `ToolLayout` **不硬编码**颜色，由各 renderer 的 `statusLabel`/`statusIndicator` 决定（**未确证**通用状态色映射；
    具体 renderer 在 `ToolCallBlocks/renderers/*`）。
  - **右侧耗时**：通用工具行**没有**逐行耗时字段（**未确证**是否有 renderer 自带）；耗时在 work-history 段头（§2.3）。

### 2.7 轮次导航 `ConversationTurnNavigator`

`ConversationTurnNavigator.tsx`：

- **出现条件**：`items.length >= 2`（JS 侧，`:133-135`，否则 `return null`）+ CSS 容器 ≥864px
  （`@min-[864px]/conversation`，`:144`）。与既有审计一致（`refs` Z-17：轮次 ≥2 且列宽 ≥864px）。
- 形态：**左侧细条 rail**（不是数字按钮）：
  - nav：`pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 -translate-x-2 opacity-0`，≥864px 时 `visible/translate-x-0/opacity-100`（`:144`）。
  - rail 容器：`absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 overflow-x-hidden overflow-y-auto py-1`（`:150`）。
  - 单项：外层 `h-2.5 w-9`；内层条 `block h-0.5 w-3 origin-left rounded-full`，颜色 `bg-foreground`（focus）/`bg-foreground-subtlest`（muted），
    `scaleX` 按状态缩放，运行中 `opacity >= 0.72`（`:204-219`）。
  - 悬停提示 `HoverCardContent`：`w-80 p-3`，user 预览 `line-clamp-2`、assistant 预览 `line-clamp-3`（`:222-244`）。
  - 点击 = 平滑跳转到该轮（`:193-198`）。
- 虚拟化：`estimateSize: () => 10`，overscan 6（`:110-116`）。
- → 视觉是**长短不一的细横条**，无序号文字；提示卡给「用户首句 + 助手摘要」。

### 2.8 状态面板 `ConversationStatusPanel`

`ConversationStatusPanel.tsx` + `conversationLayout.ts`：

- **出现条件**：`model.hasContent || canRenderEndedWorkflows` 才渲染，否则 `return null`（`:1858-1860`）。
  → **草稿态不渲染**（`refs` Z-18）。
- 外层容器：`pointer-events-none absolute top-0 z-20 pt-4`；`auto` 模式
  `inset-x-0 flex justify-end px-4 @min-[1280px]/conversation:left-auto @min-[1280px]/conversation:right-4 @min-[1280px]/conversation:px-0`（`:1862-1874`）。
  → **右上角浮层**（不是内容列内的一行）。
- `aside` 外壳：`rounded-2xl border border-popover-border bg-popover shadow-md`（`:1896`），三态（`:1897-1901`）：
  - `mini`：`inline-flex max-h-8.5 w-[var(--chat-summary-panel-mini-width)]`（胶囊）；
  - `panel`：`flex max-h-[min(64dvh,32rem)] w-80`（320px 面板）；
  - `auto`：<1280px 走 mini，`@min-[1280px]/conversation` 变 `w-80 max-h-[min(64dvh,32rem)]`。
- 内容子块默认：Git / Goal / SessionPlans / Plan **展开**；Terminal / Workflow / Agent **收起**（`refs` Z-17，`源码:290,389,527,823,886` / `:1064,1166,1361`）。

### 2.9 composer 在会话态 vs 草稿态的差异

`ConversationComposer.tsx`：

| 维度          | 草稿态                                                                               | 会话态                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 外层          | `centered` → 加 `max-w-2xl`（`:2205`）                                               | 不 `centered`，随内容列宽                                                                                                          |
| 内层输入壳    | 有 `contextHeader` → `rounded-2xl bg-surface shadow-xl/5`（卡片）（`:2232`）         | 无卡片（回落页面底色）                                                                                                             |
| contextHeader | workspace 菜单 + Git 分支，包 `p-1.5 flex flex-wrap gap-0`（`:2235-2238`）           | 无                                                                                                                                 |
| 定位          | 非 sticky（由 timeline `responsiveCenteredEmptyLayout` 的 `mt-3 shrink-0` 承载）     | timeline `sticky bottom-0`（`ConversationTimeline.tsx:1918`）                                                                      |
| placeholder   | `chat.placeholder.newTask` = 向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力 | 有历史空闲 → `followUpAsk` = 提出后续修改要求；处理中 → `followUpQueue` = 继续输入以排队后续修改（`:1598-1606`，`i18n:4264-4268`） |
| 编辑器        | `ChatPromptEditor`（@ 提及 / `/` 命令 / 附件 / 模式-模型-档位控件 / 发送）           | 同左                                                                                                                               |

- 移动端另有 `chat.placeholder.newTaskMobile` = 向 ZCode 提问…（`i18n:4265`）。

---

## 3 差距清单（ZCode 规格 / 我们现状 / 差距 / 建议批次）

证据列：`源码`/`i18n`/`refs`/`实测`/`我们:<文件:行>`/`推断`/`未确证`。

### 3.1 形态 1（草稿/空态）

| #   | ZCode 规格                                                                                                                                                                                             | 我们现状                                                                                                                                                                      | 差距                                                                                                                                         | 批次 | 证据                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| G1  | 6 档问候 = 6 句**不同**完整句（早上好呀，新的一天开始啦 / 上午好呀，有什么想让我帮忙的吗 / 中午好呀，要不要先休息一下 / 下午好呀，接下来交给我吧 / 晚上好呀，今天辛苦啦 / 夜深啦，别忘了照顾好自己哦） | `EmptyState.tsx:34-49` 6 档，但**只有「上午」档逐字对齐**；其余 5 档是「〈问候词〉，有什么想让我帮忙的吗」同句式自拟（清晨好呀/中午好呀/下午好呀/傍晚好呀/夜深了 + 固定后缀） | **文案逐字不一致（5/6 档）**；档位命名也不同（ZCode 无「清晨/傍晚」词）                                                                      | B1   | `i18n:4221-4226` vs `我们:EmptyState.tsx:34-49`                                    |
| G2  | office 模式覆盖档 `chat.empty.greeting.office` = 今天有什么工作，交给我吧                                                                                                                              | 无 office 概念                                                                                                                                                                | 无此档（**未确证**我们是否需要 office 模式）                                                                                                 | B3   | `i18n:1911`、`源码:88`                                                             |
| G3  | 字号自适应：20–30px，按「问候容器可用宽 vs 30px 自然宽」实时缩放（`ResizeObserver`），行高 1.2                                                                                                         | `shell.css:991-1000` 固定 `font-size:36px`，无自适应、无测量                                                                                                                  | **字号 36 vs 30、无自适应**；且 36 疑为实测把行盒高当字号（见 §1.1 冲突）                                                                    | B1   | `源码:15-16,54-78` vs `我们:shell.css:995`、`实测` §0.2                            |
| G4  | 到点自动换档：`setTimeout` 到下一个边界（5/9/12/14/18/23 点，跨日取次日 5:00）自动重算                                                                                                                 | 无定时；进入时取一次 `now` 后不再变                                                                                                                                           | **缺自动换档**                                                                                                                               | B1   | `源码:38-52,91-99` vs `我们:EmptyState.tsx:83-91`                                  |
| G5  | Logo 水印：`aspect-[5/4] w-[min(72vw,25rem)]` = 400×320，绝对居中 + `-mt-10` 上移、`foreground-subtlest`；浅色内联 SVG 400×320 + 向下渐隐遮罩；深色 `assets/Z.svg`                                     | `EmptyState.tsx:58-69` 用**本仓中性鱼形占位** SVG（220×220），`shell.css:981-990` 容器 `max-width:400px; height:320px; opacity:.5`                                            | 尺寸容器接近（400×320）但**资源完全不同**（占位非 ZCode 商标，已声明）；ZCode 是**背景水印**（绝对定位溢出），我们是普通块级居中；无深浅两套 | B1   | `源码:177-247` vs `我们:EmptyState.tsx:58-69`、`shell.css:981-990`                 |
| G6  | 空态标题/描述 key 存在但**无组件消费**（不渲染）                                                                                                                                                       | 我们也不渲染标题/描述                                                                                                                                                         | **一致**（无需改；仅登记）                                                                                                                   | —    | 全量 grep（仅 locales 命中）                                                       |
| G7  | 建议 prompts：条数/文案来自 **Client Scenes `draft-suggestion` scene**（远端配置，无固定条数）                                                                                                         | `EmptyState.tsx:26` 硬编码 4 条「周报总结/报错修复/PPT 制作/闲时任务」（来自 Z10 §0.2 实测）                                                                                  | 数据源不同（静态 vs 远端）；ZCode 可随场景刷新，我们固定                                                                                     | B2   | `draftSuggestedPromptItems.ts:76`、`Container:139-155` vs `我们:EmptyState.tsx:26` |
| G8  | 建议 chip 单项：`Button outline size-lg h-8 rounded-lg px-3`，**带图标 `size-4`** + 文本 `max-w-64 truncate`；组 `gap-4` 居中；容器横向可滚无滚动条；入场 waterfall 逐项 65ms                          | `shell.css:1001-1030`：`h2-empty-suggestion` 高 32px、`padding 0 16px`、圆角 8px、**无图标**、间距 17px、无 waterfall                                                         | **尺寸接近（32 vs 32、8 vs 8px 圆角）但缺图标、缺入场动画、间距 17 vs 16**                                                                   | B2   | `源码:288-349` vs `我们:shell.css:1001-1030`                                       |
| G9  | 建议 chip 点击 = **预填 composer**（不发送）                                                                                                                                                           | 点击 = `composerStore.insert-text` 预填（不发送）                                                                                                                             | **一致**（语义对齐）                                                                                                                         | —    | `Container:238-252` vs `我们:seat.tsx:513-519`                                     |
| G10 | 建议 chip 位置 = composer **下方**（composer dock 内，`mt-6`）                                                                                                                                         | `seat.tsx:508-519` 在 `.composer-overlay` 内、`Composer` **之后**                                                                                                             | **一致**（均在 composer 下）                                                                                                                 | —    | `SessionPane.tsx:4556-4570` vs `我们:seat.tsx:508-519`                             |
| G11 | 空态垂直排布：顶部 `basis-[29dvh]` 弹性留白 → 内容（max-w-2xl）→ composer（mt-3）→ chips → 底部 `flex-1 min-h-4`；composer **非 sticky**                                                               | `shell.css:970-979` `.h2-empty` `flex:1; justify-content:center; gap:24px; padding:48px 16px 8px`；composer 是**绝对浮层**（`shell.css:683-689`）                             | **排布机制不同**：ZCode 用 29dvh 弹性上留白 + 内容自然流；我们靠 `justify-content:center` + composer 浮层预留；间距量级相近                  | B1   | `ConversationTimeline.tsx:1759-1776,1906-1948` vs `我们:shell.css:970-979,683-689` |

### 3.2 形态 2（会话态）

| #   | ZCode 规格                                                                                                                                                                         | 我们现状                                                                                                                                                   | 差距                                                                                                                                                                   | 批次  | 证据                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| G12 | `ConversationHeader` 不占高度、无标题栏，只在有 pane 动作时右上角悬浮（`absolute left-2 top-2 z-20`）workspace 徽标 + 关窗格按钮                                                   | 桌面 `ConversationHeader.tsx:169-237` 是 `.pane-header` **占高的横条**（cwd/branch/model/上下文水条 + 右栏开关 + 窗控）                                    | **定位/职责不同**：我们的 `.pane-header` 实际对应 ZCode 的 `WorkspaceHeader`（h-12），不是 `ConversationHeader`；ZCode 的 pane 浮动动作（关闭/workspace 徽标）我们未做 | B3    | `ConversationHeader.tsx:36-49,93-113` vs `我们:ConversationHeader.tsx:169-237`                                 |
| G13 | 可见顶栏 `WorkspaceHeader`：`h-12 border-b p-2`，含任务标题 + 工作区标签 + **Git 分支切换器** + 动作区                                                                             | `.pane-header`：cwd + 分支 + **model** + **上下文占用水条** + 右栏开关 + 窗控；无任务标题、无工作区切换器                                                  | 字段集不同（我们多 model/上下文条，少任务标题/工作区切换器/分支切换动作）                                                                                              | B3    | `WorkspaceHeader.tsx:139-157`、`WorkspaceHeaderSections.tsx` vs `我们:ConversationHeader.tsx:169-237`          |
| G14 | 内容列宽：≥864px `w-[calc(100%-6rem)] max-w-4xl`，≥1280px `w-[calc(100%-24rem)] max-w-6xl`（+ 面板让位 `-translate-x-42`）                                                         | `shell.css` 无内容列 max-width；`.chat` 通栏；仅 `.messages` `padding:12px 16px`                                                                           | **缺内容列收窄**（宽屏正文会拉满整列，观感差最大之一）                                                                                                                 | B1    | `conversationLayout.ts:3-9` vs `我们:shell.css:103-121`                                                        |
| G15 | 轮次分隔 = `pt-14`（56px）纯留白，**无分隔线、无文字头**                                                                                                                           | `.turn-header` 是 `border-top:1px solid; margin-top:12px` 的**细线**                                                                                       | **有分隔线 vs 无**；间距 12px vs 56px                                                                                                                                  | B1    | `ConversationTurnGroup.tsx:1302-1310` vs `我们:shell.css:123-130`                                              |
| G16 | 轮次内边距 `px-4 @md:px-6 pb-5 gap-5`                                                                                                                                              | `.messages` 统一 `padding:12px 16px; gap:8px`，无 `@md` 24px、无 `pb-5`/`gap-5`                                                                            | 间距偏小且无断点                                                                                                                                                       | B1    | 同上 vs `shell.css:106-121`                                                                                    |
| G17 | 「耗时」文案：work-history 段头 `chat.history.workedFor` = **已工作 {duration}**（运行中 **工作中 {duration}**），时长支持 秒/分/时/天                                             | `chat-model.ts:104-107` `formatTurnDuration` → **「持续了 N 秒」**（只到秒、ceil、无分/时/天）；`ChatView.tsx:159-191` 渲染在 `turn-summary`               | **文案与时长粒度都不同**；且 ZCode 是段头（`border-b`）而非轮尾摘要                                                                                                    | B1    | `ConversationTurnGroup.tsx:565-609`、`i18n:4322-4329` vs `我们:chat-model.ts:104-107`                          |
| G18 | 用户消息：右对齐气泡 `rounded-xl rounded-tr-xs border bg-surface px-4 py-3`，≥624px `max-w-xl`，超 120px 折叠 + 渐隐 + 圆形展开钮                                                  | `shell.css:138-144` `.bubble-user` 右对齐 `border-radius:8px; background:var(--color-secondary); padding:12px 16px`；无右上角小圆角、无 border、无折叠     | 圆角/边框/折叠**不一致**（无折叠是功能缺口：长输入会撑满）                                                                                                             | B1    | `ConversationRowView.tsx:1257-1259`、`ConversationUserInputBody.tsx:7,104-142` vs `我们:shell.css:138-144`     |
| G19 | 助手正文：`w-full text-ui-base` + markdown 渲染，无气泡；轮尾动作 hover 显现（复制/分叉/重试/反馈）                                                                                | `.bubble-assistant` 无背景/无内边距（一致）；`MessageActions` 有复制/分叉，**无赞/踩/重试**（已声明无后端）                                                | 动作集少（赞踩/重试/反馈）——既有登记                                                                                                                                   | B3    | `ConversationRowView.tsx:1477-1541,1414-1435` vs `我们:ChatView.tsx:66-91`                                     |
| G20 | 工具行：图标 `foreground-subtlest`、kind 标签运行中扫光、展开箭头 hover 显现 `rotate-90`、内容 `pt-2` 延迟 300ms 卸载                                                              | `ToolCard.tsx:305-404` 有 `tool-{status}`、状态色 `STATUS_TEXT_COLOR`、running LoaderIcon 旋转、展开动画                                                   | **大体对齐**（细节：ZCode 图标非状态色、运行态用文字扫光而非旋转图标）                                                                                                 | B3    | `ToolLayout.tsx:144-147`、`ToolSummaryRow.tsx:213-219` vs `我们:ToolCard.tsx:305-404`                          |
| G21 | 工具行**无逐行右侧耗时**（耗时在 work-history 段头）                                                                                                                               | `ToolCard` 亦无逐行耗时（**推断**一致）                                                                                                                    | **一致**（登记）                                                                                                                                                       | —     | `ToolLayout.tsx` 无耗时字段                                                                                    |
| G22 | 轮次导航：左侧**细条 rail**（`h-0.5 w-3` 条、`origin-left`、hover 缩放、悬停卡给「用户首句 + 助手摘要」），无序号文字                                                              | `turn-navigator.tsx:119-142` 渲染**数字按钮**（`第 N 轮`、`turn-rail-item` 18×18 圆角）；`shell.css:1626-1670`                                             | **形态不同（细条 vs 数字按钮）**；无悬停预览卡；显隐条件（≥2 且 ≥864px）**一致**                                                                                       | B2    | `ConversationTurnNavigator.tsx:133-244` vs `我们:turn-navigator.tsx:119-142`                                   |
| G23 | 状态面板：右上角浮层 `absolute top-0 pt-4`，`rounded-2xl border bg-popover shadow-md`；auto <1280 胶囊 / ≥1280 `w-80` 面板；Git/Goal/Plans/Plan 展开、Terminal/Workflow/Agent 收起 | `seat.tsx:447-457` 槽位在**会话列内、转录之上**（非浮层）；`ConversationStatusPanel.tsx` 结构对齐（auto/capsule、rounded-2xl 等）                          | 承载位置不同（列内 vs 浮层）；子块默认展开/收起**未确证**是否一致                                                                                                      | B3    | `ConversationStatusPanel.tsx:1858-1901` vs `我们:seat.tsx:447-457`、`status-panel/ConversationStatusPanel.tsx` |
| G24 | 状态面板草稿态不渲染                                                                                                                                                               | `seat.tsx:447-457` 由壳回调返回 null 决定；`statusPanelHasContent` 无内容返回 null                                                                         | **大体一致**（登记）                                                                                                                                                   | —     | `refs` Z-18                                                                                                    |
| G25 | composer：草稿态**居中 max-w-2xl + `rounded-2xl bg-surface shadow-xl/5` 卡片 + contextHeader（项目/Git）**；会话态无卡片、sticky 吸底                                              | `Composer.tsx` 无 centered/卡片分支；`.composer` 恒 `border-top + bg-panel`；composer 是绝对浮层（非 sticky）；context chips 走 `contextChips` 行（Z10-2） | **缺草稿居中卡形态**；composer 定位机制不同（浮层 vs sticky）                                                                                                          | B1/B3 | `ConversationComposer.tsx:2189-2238` vs `我们:Composer.tsx:556-640`、`shell.css:683-708`                       |
| G26 | placeholder 动态三态：无历史 `newTask` / 有历史空闲 `followUpAsk` / 处理中 `followUpQueue`                                                                                         | `Composer.tsx:192-193,551` 仅二态：有会话 = 「向 harness2 提问，使用 @ 添加上下文，使用 / 选择命令或能力」，无会话 = 「选择会话后开始输入」                | **缺 followUpAsk/followUpQueue 两态**；且品牌名 harness2 vs ZCode（**品牌差异，可保留**）                                                                              | B2    | `ConversationComposer.tsx:1598-1606`、`i18n:4264-4268` vs `我们:Composer.tsx:192-193`                          |
| G27 | composer 右簇三件套（模式 / 模型 / 思考档位）常驻                                                                                                                                  | `composer-controls.tsx` 已实现，但由壳注入 `modeSwitch/modelSelect/thoughtLevel`；web 壳无通道则不渲染                                                     | 桌面有、web 可能缺（既有总账已登记 P0）                                                                                                                                | B3    | `ConversationComposer.tsx` vs `我们:composer-controls.tsx`、`seat.tsx:500-505`                                 |
| G28 | 时间轴有「回到底部」圆钮（`ConversationBackToBottomButton`，composer dock 上/下）                                                                                                  | `ChatView.tsx` 无回到底部按钮（grep 无命中）                                                                                                               | **缺回到底部按钮**                                                                                                                                                     | B2    | `ConversationTimeline.tsx:1932-1958` vs `我们:ChatView.tsx:253-306`                                            |
| G29 | 时间轴虚拟化（`useVirtualizer`）、稳定 scrollbar-gutter                                                                                                                            | `.messages` 普通滚动 + 稳定滚动逻辑（`nextScrollTop`），无虚拟化                                                                                           | 长会话性能差异（非观感；**推断**可暂缓）                                                                                                                               | B3    | `ConversationTimeline.tsx:1826-1853` vs `我们:ChatView.tsx:220-234`                                            |
| G30 | 消息动作行含复制/赞/踩/分叉/重试/编辑/反馈                                                                                                                                         | `MessageActions` 仅复制/分叉（赞踩重试无后端，已声明不做）                                                                                                 | 动作集少（既有登记）                                                                                                                                                   | B3    | `ConversationRowView.tsx:1414-1435` vs `我们:ChatView.tsx:79-87`                                               |

> 说明：G6/G9/G10/G21/G24 为**已一致项**，登记以便后续回归时不误改。

---

## 4 建议批次拆分（可见度 × 改动量）

> 排序原则：**可见度越高、改动越小越靠前**。每批给出验收要点（命令/断言层面，供后续实现阶段使用）。
> 本任务**不实现**，批次仅作后续计划的输入。

### 批次 B1 — 空态与消息区「一眼可见」形态对齐（高可见度 / 中改动量）

覆盖 G1、G3、G4、G5、G11、G14、G15、G16、G17、G18、G25。

- 空态：6 档问候改**逐字 ZCode 文案**（含 6 句不同句）+ 20–30px 自适应字号（行高 1.2）+ 到点自动换档；
  水印改为背景水印定位（绝对居中、上移、向下渐隐）。
- 消息区：内容列加 `max-w-4xl`/`max-w-6xl` + `w-[calc(100%-6rem)]`（≥864px）/`w-[calc(100%-24rem)]`（≥1280px）；
  轮次分隔去掉细线、改 `pt-14` 留白；间距对齐 `px-4/@md:px-6 pb-5 gap-5`；
  耗时文案改「已工作 {duration}」（含分/时/天）；用户气泡改 `rounded-xl rounded-tr-xs border bg-surface px-4 py-3 max-w-xl` + 120px 折叠。
- composer 草稿态居中卡（`max-w-2xl` + `rounded-2xl bg-surface shadow-xl/5` + contextHeader）。
- **验收要点**：
  1. 空态截图（1440×900）与 ZCode 实测坐标（Logo y≈80 / 问候 y≈262 / composer y≈446 / chips y≈511）偏差 ≤8px；
  2. 单测：`timeGreetingForHour` 6 档返回值逐字等于 `i18n:4221-4226`；边界 5/9/12/14/18/23 各 +1 分钟换档断言；
  3. 字号自适应纯函数在 avail<natural 时返回 `clamp(floor(30*avail/natural),20,30)`；
  4. 宽屏（≥1280px）内容列宽 = `min(calc(100%-24rem), 72rem)`；
  5. 长用户消息（>120px）出现折叠渐隐 + 圆形展开钮，展开/收起可断言。

### 批次 B2 — 建议 chips、轮次导航、composer placeholder、回到底部（中可见度 / 小-中改动量）

覆盖 G7、G8、G22、G26、G28。

- 建议 chip：补图标槽（`size-4`）+ 入场 waterfall + 间距 16px（是否改为远端 scene 数据源，需产品决策 → 见 §5）。
- 轮次导航：数字按钮改**细条 rail**（`h-0.5 w-3 origin-left` + hover 缩放 + 悬停卡「用户首句/助手摘要」）。
- composer placeholder 补 `followUpAsk`/`followUpQueue` 两态。
- 补「回到底部」圆钮（贴底时隐藏）。
- **验收要点**：
  1. 建议 chip 单项含 `<svg>`/`<img>` 图标节点且文本 `max-w-64 truncate`；
  2. 轮次导航 DOM 无序号文本、悬停出现 `w-80` 提示卡（user `line-clamp-2` + assistant `line-clamp-3`）；
  3. placeholder 三态断言（无历史/空闲/处理中）；
  4. 上滚时「回到底部」按钮出现、点击后 `scrollTop` 到底且按钮消失。

### 批次 B3 — 会话头职责、状态面板承载、工具/动作细节（中可见度 / 大改动量，或受后端限制）

覆盖 G2、G12、G13、G19、G20、G23、G27、G29、G30。

- 会话头：厘清「ZCode ConversationHeader（不占高、悬浮 pane 动作）」与「WorkspaceHeader（h-12 可见顶栏）」的对应；
  决定我们 `.pane-header` 是保留（作为 WorkspaceHeader 等价物）还是拆分出 pane 浮动动作。
- 状态面板改为右上角浮层（`absolute top-0 pt-4`）。
- 工具行细节（图标去状态色、运行态文字扫光）、消息动作补全（受后端反馈通道限制，赞踩/重试如实登记）。
- **验收要点**：会话头高度/内容与 `refs` Z-01/Z-17 对照表一致；状态面板定位 `absolute` 且 <1280 胶囊 / ≥1280 面板；
  无法兑现项（赞踩/重试）在验收表**如实登记跳过**，不作全绿。

---

## 5 未确证 / 冲突 / 需产品决策项（不得当已确证使用）

| #   | 项                                                               | 状态                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | 问候字号 36px（实测）vs 30px（源码）                             | **冲突**。本轮以源码 30px 为准；36 疑为 `30×1.2` 行盒高。需真机复测确认。                                                                       |
| U2  | 建议 prompts 的默认条数/文案                                     | **未确证**。源码内条数来自远端 Client Scenes；`chat.draft.suggestedPrompt.*` i18n 在本快照**无消费方**（遗留）。我们 4 条来自实测，非源码常量。 |
| U3  | `chat.empty.title` / `chat.empty.description` 的实际渲染         | **未确证/未使用**。本快照无组件引用（历史遗留 key）。                                                                                           |
| U4  | 工具行通用「状态色」映射                                         | **未确证**。`ToolLayout` 不硬编码颜色，由各 renderer 决定；未逐一核对 `ToolCallBlocks/renderers/*`。                                            |
| U5  | 工具行是否有逐行右侧耗时                                         | **未确证**（通用路径无；个别 renderer 可能有）。                                                                                                |
| U6  | 空态水印的精确像素位置                                           | **推断**。源码是绝对定位居中 + `-mt-10`，精确 y 依赖容器高度与 29dvh；实测值需真机复测。                                                        |
| U7  | `conversationLayout.ts:4-7` 带/不带状态面板宽度类名完全相同      | **疑似源码冗余/遗留**，我们按「不因面板改变列宽」理解；是否影响 ZCode 真实行为**未确证**。                                                      |
| U8  | 轮次导航细条的 hover 缩放参数（`scaleX` 具体值）                 | **未确证**。在 `conversationTurnNavigatorHelpers.ts`（本轮未展开）；形态（细条/无序号）已确证。                                                 |
| U9  | 状态面板子块默认展开/收起清单                                    | 依据 `refs` Z-17（Git/Goal/Plans/Plan 展开、Terminal/Workflow/Agent 收起）；源码行号引自 refs，本轮未逐行复核。                                 |
| U10 | 建议 chip 是否应改为远端 scene 数据源（G7）                      | **需产品决策**：改成远端配置成本高，且我们无对应 scene 通道。                                                                                   |
| U11 | 品牌名差异（placeholder「向 harness2 提问」vs「向 ZCode 提问」） | **需产品决策**：是否保留本仓品牌名（当前保留，属合理差异）。                                                                                    |

---

## 6 变更记录

| 日期       | 变更                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-13 | 首建：从 `refs/ZCode@29628c9` 源码抽取对话区权威规格（形态 1/2 共 30 条对照），产出差距清单（30 项，含 5 项已一致登记）、3 批建议与 11 项未确证/决策项。 |
