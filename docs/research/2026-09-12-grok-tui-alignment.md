# grok-build TUI 对齐研究（5 项交互反馈 + 整体复刻可行性）

> 日期：2026-09-12 · 作者：编排者（主会话）
> 问题来源：`docs/issue-log/2026-09-12.md` §2（用户真机实测反馈）
> 参考对象：`D:\AI_Projects\refs\grok-build`（Grok Build CLI/TUI 的 Rust 源码）
> 结论用途：作为 `docs/ai-framework/plans/2026-09-12-phase-tui-ux-polish.md` 的行为规格与后续对齐阶段的依据。

---

## 0. 结论摘要（TL;DR）

1. **5 项反馈在 grok 里全部有明确原版机制**，且都能落到我们「core 底座 + `packages/cli` Ink TUI」架构上复刻，**无需改动冻结区**（`packages/core` / `packages/gateway`）。
2. **「逐像素/逐帧完整复刻」不现实**：grok 是 Rust + ratatui + crossterm 自绘缓冲区（含文本选择、超链接、图片、逐帧动画、鼠标命中测试）；我们是 Ink/React 行式渲染。但终端 UI 都是字符网格——**「交互语义 + 布局结构」可以对齐**，视觉细节可在字符层面高度接近。
3. 建议走 **B 档「交互对齐」**（见 §2.3）：先把 5 项做对（进行中），再补键位/状态行/子代理实时视图/鼠标点击，分 2~3 个阶段推进；不做 C 档（换渲染引擎重写 TUI 层）。

---

## 1. 五问五答（grok 原版机制 → 我们的现状 → 对齐方案）

参考路径约定：`$GROK = D:\AI_Projects\refs\grok-build\crates\codegen\xai-grok-pager`（TUI crate）。
手册入口：`$GROK/docs/user-guide/`（27 篇，含键盘/斜杠/通知/子代理/计划模式/状态行/终端支持）。

### T1 子代理执行内容不可见

**grok 原版机制：**

- **转录内生命周期块**（`$GROK/src/scrollback/blocks/subagent.rs`）：子代理在父会话里是一个**专用块**（不是普通工具卡）——「始终折叠、运行时有动画圆点、完成后按成功/失败着色」，阻塞式（sync）与后台式（async）两种呈现；文案示例：`Subagent "description"` / `Subagent started: "..."` / `Subagent completed in 43s: "..."`。
- **Enter / Ctrl+F 打开子代理全屏视图**（`$GROK/src/app/agent_view/panes.rs:77`、`render.rs:95 open_subagent_fullscreen`）：子代理有自己的完整 scrollback 视图（`agent.subagent_views`），打开时按需重放子会话历史（`ensure_subagent_child_replayed`），运行中通过 ACP 子会话通知**实时**把更新路由进该视图（`app/acp_handler/session_notification.rs`）。
- 其他面：dashboard 有子代理行（`Ctrl+X` 杀）、`group_tool_verbs` 可把子代理行折叠成动词组、`send_subagent_message` 有专门块形（`scrollback/blocks/tool/sent_message.rs`）。
- 手册：`16-subagents.md`（类型/人设/契约）、`23-dashboard.md`。

**我们的现状：** TUI 对 `subagent` 零呈现（源码 grep 零命中）；模型调 `subagent_start` 只有一张普通工具卡；子会话的流式输出/工具调用/结果完全不可见。

**对齐方案（可落地）：**

- transcript 增加**子代理块**：由 `tool/call`（`subagent_start`/`subagent_continue`）+ `tool/result` 生命周期驱动，显示任务描述、状态（运行中/完成/失败/取消）、耗时；结果 JSON 已含 `childSessionId` 与 `stopReason`。
- 交互：`Enter`（选中块）/ `Ctrl+J` 打开子会话**只读视图**（v1 从磁盘 `projectSession()` 重投影；`SessionManager.locate()` 定位）。
- 实时性升级（v2）：core 已导出 `SubagentHooks.onChildEvent`（`packages/core/src/agent/subagent.ts:62`），CLI 装配层传入即可把子会话事件桥进父 TUI——**属装配层改动，不违反冻结**。

**工作量：** 中（块 + 视图 + 键盘路径 + 用例）。**风险：** 大转录渲染性能（复用既有虚拟化）。

---

### T2 输入框锚底 + 对话内容滚动

**grok 原版机制：**

- **纵向分层（自下而上）**：快捷键条在最底 → 可选状态行在其上（`25-status-line.md`：`status_line` 在 full screen 位于 shortcuts bar 之上）→ 输入框（prompt，底边带模式/模型指示，`views/prompt_widget/mod.rs`）→ scrollback 占剩余空间。输入框恒定贴底，弹层/卡片都锚在输入框附近，不会把它顶走。
- **滚动**：scrollback 是独立 pane，有完整滚动模型（`scrollback/scrollback_pane.rs`、`sticky.rs`）；键位 `PageUp/PageDown`、`Ctrl+U/Ctrl+D` 半页、`Ctrl+K/Ctrl+J` 单行；**prompt 聚焦时 PageUp/PageDown 仍滚动会话**（`03-keyboard-shortcuts.md`）。
- **鼠标**：终端鼠标上报（`21-terminal-support.md` 有「Mouse scrolling stops working」排查）；`app/mouse.rs` 处理滚轮/点击/滚动条拖动，滚轮在补全下拉上则移动选择（`panes.rs:958` 用例）。

**我们的现状：** Composer 在渲染树末尾，但转录固定高度（`rows-8`）+ 浮层占位，观感不贴底；滚动只有键盘（PageUp/PageDown/Ctrl+G 跟随），alt-screen 下未开鼠标上报 → 滚轮无效。

**对齐方案：** 布局改「状态条/面板在下、输入框恒底、转录吃剩余高度」；开 SGR 鼠标上报并把滚轮映射到既有锚定/跟随滚动逻辑；退出还原。降级条款：若与键盘/IME 冲突则默认关鼠标并如实登记（已写入阶段计划 T2）。

**工作量：** 中。**风险：** 鼠标上报与 Ink 输入通道的兼容性（有降级）。

---

### T3 `/mode` 选择弹层位置

**grok 原版机制：**

- grok **没有**「大弹窗模式选择器」：**`Shift+Tab` 循环** Normal → Plan → Auto → Always-approve（`03-keyboard-shortcuts.md`），`/plan`（进入时下一条消息生效）、`/auto`、`/always-approve` 是真实开关（`04-slash-commands.md:120`）。
- 模式以**指示器**呈现：prompt 底边右侧的 model/mode 指示（`views/prompt_widget/mod.rs:3294` 注释明确「dashboard 的 dispatch 框可绘制同样的 model and mode indicator」）；上下文提示（undo/plan）也在 prompt 内部（`contextual_hint_plan_mode`）。
- 相关：`19-plan-mode.md`（计划模式行为：只读除 plan.md、`exit_plan_mode` 审批）、`app/agent_view/mod.rs:1435 plan_mode_active`。

**我们的现状：** `/mode` 打开 `Modal + SelectList`，经 `OverlayHost` 渲染在 StatusBar 与 Transcript 之间 → 受转录固定高度挤压，落在顶部区域。

**对齐方案：** 选择器贴输入框上方渲染；在输入框/状态区加**模式指示**；后续可加 `Shift+Tab` 循环（键位表见 B 档）。

**工作量：** 小（T3 本身）。**风险：** 无。

---

### T4 回合结束声音提醒

**grok 原版机制（手册 + 源码双重确证）：**

- 配置段 `[ui.notifications]`（`05-configuration.md:440-463`）：

  | 键                    | 默认                                    | 取值                                                       |
  | --------------------- | --------------------------------------- | ---------------------------------------------------------- |
  | `method`              | `auto`                                  | `auto\|osc9\|osc99\|osc777\|bel\|none`（`bel` 即终端响铃） |
  | `condition`           | `unfocused`                             | `unfocused`（终端失焦才提醒）`\|always\|never`             |
  | `idle_threshold_secs` | `3`                                     | 失焦满 N 秒才发                                            |
  | `events`              | `["turn_complete","approval_required"]` | 可选 `session_ready`、`task_complete`、`agent_error`       |
  | `title.items`         | —                                       | 终端标题栏内容                                             |

- 实现在 `notifications/`（`config.rs` / `focus.rs` / `protocol.rs` / `hooks.rs` / `title.rs` / `sleep.rs` / `tmux.rs`）：**回合完成**与**需要审批**触发；焦点由终端 focus 事件跟踪；审批通知有批量去重；支持自定义 hook 命令（如 `terminal-notifier` 系统通知）；`/doctor` 会诊断通知与焦点问题。
- 手册明确：「focus-gated by default, so they only fire when you're not looking at the terminal」。

**我们的现状：** TUI 无任何 bell/通知（grep 零命中）。

**对齐方案：** `HARNESS2_NOTIFY=always|unfocused|never`（缺省 `unfocused`）、`HARNESS2_NOTIFY_METHOD=bel|osc9`（缺省 `bel`）；DECSET 1004 焦点跟踪（T2 一并实现）；turn 终态（final/partial/empty）触发。**因 core config schema 冻结，暂用环境变量**；后续如需 `config.json` 配置面，走解冻窗口或 CLI 本地设置文件。

**工作量：** 小~中。**风险：** 终端支持差异（不支持 focus 事件时按「未失焦」保守处理）。

---

### T5 斜杠候选与权限提示的位置

**grok 原版机制：**

- 斜杠菜单 = **prompt 挂钩的内联下拉**（`views/slash_dropdown.rs`、`views/completion_dropdown.rs`）：`render_dropdown_chrome(buf, …, self.inline_prompt_area, layout.prompt, …)`（`app/agent_view/render.rs:3292-3305`）——以 prompt 区域为锚渲染「分隔线 + 列表」，出现在**输入框上方**（prompt 贴底）；最多 6 行、有滚动条、支持鼠标悬停与滚轮改选（`panes.rs:958`）。模糊搜索、Tab/Enter 接受（`04-slash-commands.md`）。
- 权限提示 = **blocking card**（`03-keyboard-shortcuts.md`）：占位在输入框区域，Tab/Shift+Tab 走选项、数字直选、`Ctrl+F` 展开参数、`Esc` 把键盘**寄放**到 scrollback（不回答不关闭）、`Ctrl+C` 取消；`Ctrl+O` 打开 always-approve。
- 同族还有 question card / MCP elicitation / cancel-turn panel 共用这套卡片契约。

**我们的现状：** Composer 候选列表渲染在输入行**下方**（`packages/cli/src/tui/Composer.tsx:349-375`）；审批 `ConfirmDialog` 是居中浮层。

**对齐方案：** 候选列表移到输入行上方；审批（及 T3 选择器）统一锚在输入框上方；Esc/Ctrl+C 语义保持与现有实现一致。

**工作量：** 小。**风险：** 浮层高度把输入框挤出屏幕（用 rows 约束）。

---

## 2. 「完整复刻」可行性评估

### 2.1 两边的架构对照

| 维度          | grok-build                                            | harness2                                                   | 可对齐性                               |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| 语言/渲染     | Rust + ratatui + crossterm（自绘缓冲、逐帧）          | TypeScript + Ink/React（行式渲染）                         | 布局/交互可对齐；**逐帧视觉细节受限**  |
| 内核/前端分层 | agent runtime（xai-grok-shell，ACP 面）+ pager（TUI） | `packages/core`（serve/HTTP+WS）+ `packages/cli`/`desktop` | **结构同构**，适配良好                 |
| scrollback    | 独立 pane：选择/复制/搜索/超链接/图片/鼠标命中        | `TranscriptView` 虚拟化 viewport + 键盘滚动                | 滚动模型可对齐；选择/超链接/图片需自研 |
| 子代理        | 块 + 全屏子视图 + 实时路由 + dashboard 行             | 工具卡（无视图/无实时）                                    | 块 + 只读/实时视图可复刻               |
| 通知          | 焦点门控 + 5 种协议 + hooks + 标题                    | 无                                                         | 可复刻（配置改 env 过渡）              |
| 鼠标          | 全量（点击聚焦、命中测试、滚轮、滚动条）              | 无                                                         | 滚轮/点击可复刻；文本选区需自研        |
| 主题          | `theme/` + `/theme` 命令                              | Ink 有限样式                                               | 部分对齐                               |

### 2.2 差距清单（按复刻成本）

| 级别         | 项目                                                                                                                 | 说明                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 🟢 易        | 布局分层、输入框贴底、候选/审批锚点、模式指示、`Shift+Tab` 循环、通知（env 版）、子代理块与只读视图、状态行/快捷键条 | 与当前 5 项同一批可做                                       |
| 🟡 中        | 滚轮跨区域、点击聚焦、子代理实时流、块折叠/展开组、时间线/搜索（已有部分）、逐帧 spinner                             | 需自研解析/状态桥接，但仍 CLI 内                            |
| 🔴 难/另立项 | 文本选择与复制、超链接点击、内联图片、全量 Vim 模式、ratatui 级自绘平滑                                              | Ink 限制；若要「逐像素复刻」= 换渲染引擎重写 TUI 层，不建议 |

### 2.3 三档建议

- **A 档（最小）**：只修 5 项反馈。≈ 当前阶段 `2026-09-12-phase-tui-ux-polish`（进行中）。
- **B 档（交互对齐，推荐）**：A + 键位表对齐（Tab 焦点、PageUp/PageDown、Ctrl+U/D、`Shift+Tab` 模式循环）+ 子代理实时视图 + 滚轮/点击 + 状态行/快捷键条。分 2~3 个阶段。
- **C 档（重度复刻）**：引入自绘终端引擎以追平选择/图片/动画——**成本高、收益低**，不建议；如确需，另立阶段再评估（Node 侧可考虑逐帧渲染库，但等于重写 `packages/cli/src/tui`）。

### 2.4 冻结区影响

- 本对齐**不需要**改 `packages/core` / `packages/gateway`：子代理事件钩子（`SubagentHooks`）已导出、通知/鼠标/布局全在 CLI。
- 若未来要复刻 grok 的「动态 agent 路由 / 后台任务面板 / dashboard 数据面」，需要 core 新能力 → 届时按冻结公告走独立解冻窗口，不夹带。

---

## 3. 关键参考索引（给实现者）

| 主题               | grok 路径                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 键盘/焦点/卡片契约 | `docs/user-guide/03-keyboard-shortcuts.md`                                                                                                               |
| 斜杠命令与菜单     | `docs/user-guide/04-slash-commands.md`、`src/views/slash_dropdown.rs`、`src/views/completion_dropdown.rs`                                                |
| 通知               | `docs/user-guide/05-configuration.md` §Notifications、`src/notifications/`                                                                               |
| 子代理             | `docs/user-guide/16-subagents.md`、`src/scrollback/blocks/subagent.rs`、`src/app/agent_view/render.rs:95`、`src/app/acp_handler/session_notification.rs` |
| 计划模式           | `docs/user-guide/19-plan-mode.md`、`src/app/agent_view/mod.rs:1435`                                                                                      |
| 状态行             | `docs/user-guide/25-status-line.md`、`src/views/status_line/`                                                                                            |
| 鼠标               | `src/app/mouse.rs`、`src/scrollback/scrollback_pane.rs`、`docs/user-guide/21-terminal-support.md`                                                        |
| 提示符组件         | `src/views/prompt_widget/mod.rs`（模式/模型指示、模式循环提示）                                                                                          |
| 下拉渲染锚点       | `src/app/agent_view/render.rs:3292-3305`、`src/app/agent_view/mod.rs:2004 render_dropdown_chrome`                                                        |
