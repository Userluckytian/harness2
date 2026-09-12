# 终端键位对照表（grok parity 调研）

- 日期：2026-09-12
- 来源（grok 权威键位表）：`D:\AI_Projects\refs\grok-build\crates\codegen\xai-grok-pager\docs\user-guide\03-keyboard-shortcuts.md`（下称「手册」）
- 我方现状来源（只读归纳）：`packages/cli/src/tui/input.ts`、`packages/cli/src/tui/Composer.tsx`、`packages/cli/test/tui/keyboard.test.tsx`、`packages/cli/src/tui/runInkChat.tsx`
- 关联交付：P1 统一输入层 `packages/cli/src/input/`（parser 已支持 kitty CSI-u / SGR+X10 鼠标 / bracketed paste / 焦点 1004，为下表「目标」提供事件基础）

## 阅读说明

- 「我方现状」以 P1 时点（feat/tui-p1-input 分支）的 ink TUI 实现为准；Composer 的键位处理见 `Composer.tsx` useInput，全局滚动/展开见 `runInkChat.tsx` useInput。
- 「目标」指 P1 之后各阶段（P2 渲染层、P3 交互装配）对本键位的采纳意向；未定项标「待编排者确认」。**2026-09-12 更新：冲突项已全部裁决（按 grok 语义，见文末冲突项清单）。**
- 已知冲突（Ctrl+O、Ctrl+G、Ctrl+J/K、Ctrl+D、Shift+Tab）已于 2026-09-12 由需求方裁决：按 grok 语义采纳（见文末冲突项清单）；现有绑定改动在 P3 装配落地。

## 导航（scrollback 聚焦）

| 键位                           | grok 行为（手册原文引用）                                                           | 我方现状                                                                                   | 目标                                 | 差异理由 / 备注                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `j` / `↓`                      | "Select next entry" / vim `j`；simple 模式 `Down`                                   | 无 scrollback 选择概念；`↓` 仅 Composer 历史下翻                                           | 滚动下移（对齐 grok 的 scroll 语义） | P2/P3 装配时定；选择模型待确认                                                                       |
| `k` / `↑`                      | "Select previous entry"                                                             | `↑` 打开历史面板/上翻历史（Composer）                                                      | 同上                                 | 同上                                                                                                 |
| `⇧L` / `Shift+→`               | "Jump to next turn (user prompt)"                                                   | 无（Shift+→ 在 Composer 是字符选区）                                                       | 跨 turn 跳转                         | 待编排者确认（与选区语义冲突）                                                                       |
| `⇧H` / `Shift+←`               | "Jump to previous turn"                                                             | 无（同上为选区）                                                                           | 同上                                 | 同上                                                                                                 |
| `⇧J` / `⇧K`                    | "Jump to next/previous assistant response"                                          | 无                                                                                         | 同上                                 | 待编排者确认                                                                                         |
| `g` / `⇧G`                     | "Go to top / bottom of scrollback"（vim 模式）                                      | 无（vim 模式未引入）                                                                       | 暂不引入 vim 模式                    | 差异理由：范围裁剪，P1 无 vim 模式                                                                   |
| `Ctrl+K`                       | "Scroll up one line (without changing selection)"                                   | 无绑定                                                                                     | 采纳                                 | 无冲突                                                                                               |
| `Ctrl+J`                       | "Scroll down one line"                                                              | **冲突**：`\n`(0x0A) 在统一解析器中按 Ctrl+J 产出事件（kitty/legacy 口径），当前无绑定消费 | 采纳为滚动下移                       | 待编排者确认（Enter 在 raw mode 发 `\r`，不冲突；但 Windows 部分终端 Enter 可能发 `\n`，需闸门判断） |
| `PageUp` / `PageDown`          | "Scroll up/down one page (selection moves to viewport edge)"；prompt 聚焦时也可滚动 | runInkChat：pageUp 锚定上滚一屏、pageDown 下滚到底后恢复跟随                               | 已对齐                               | 语义细节（选区随动）P3 再对齐                                                                        |
| `Ctrl+U`                       | "Scroll up half page"                                                               | 无                                                                                         | 采纳                                 | 无冲突                                                                                               |
| `Ctrl+D` (`Shift+D` in VSCode) | "Scroll down half page"                                                             | **冲突**：Composer `Ctrl+D` = 退出（Ctrl+D 已作 exit，对齐 grok 的 VSCode 分支 quit 语义） | 待裁决                               | 待编排者确认（半页下滚 vs 退出）                                                                     |

## 视图（scrollback 聚焦）

| 键位                 | grok 行为（手册原文引用）                               | 我方现状 | 目标     | 差异理由 / 备注                                         |
| -------------------- | ------------------------------------------------------- | -------- | -------- | ------------------------------------------------------- |
| `h` / `l`（`←`/`→`） | "Collapse / Expand selected entry"                      | 无       | 暂不引入 | 无 scrollback 单条折叠（现有 expandedIds 是工具卡整批） |
| `e` / `⇧E`           | "Toggle fold"; "Expand all / collapse all entries"      | 无       | 同上     | 同上                                                    |
| `Ctrl+E`             | "Expand/collapse all thinking blocks"                   | 无       | 采纳     | 无冲突（Composer 未占用 Ctrl+E）                        |
| `r`                  | "Toggle raw markdown on selected entry"                 | 无       | 暂不引入 | 无 raw markdown 渲染                                    |
| `y` / `⇧Y`           | "Copy block content / metadata to clipboard"            | 无       | P3+ 评估 | 依赖 OSC52 或终端选择，待编排者确认                     |
| `Enter`（条目上）    | "Open block content in fullscreen viewer"               | 无       | 暂不引入 | 无全屏查看器                                            |
| `Ctrl+F`             | "Open block content in fullscreen viewer (alt binding)" | 无       | 同上     | 同上                                                    |

## 焦点切换

| 键位                       | grok 行为（手册原文引用）                                                                                       | 我方现状                                                                    | 目标            | 差异理由 / 备注                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------- | ------------------------------- |
| `Tab`                      | "Focus the prompt input"（scrollback 聚焦）/ "Focus the scrollback"（prompt 聚焦）                              | Tab 未绑定焦点切换；overlay 内 Tab 由 SelectList 等消费                     | 采纳双态 Tab    | P3 层级焦点模型装配时实现       |
| `Space`（scrollback 聚焦） | "Space (and `i` in vim mode) → Focus the prompt input"；"any letter key auto-focuses the prompt"（simple 模式） | 无                                                                          | 采纳 auto-focus | P2 渲染层复用 dispatcher 后装配 |
| `Shift+Tab`                | "Walk that card's rows, wrapping round at the ends"（阻塞卡片聚焦时）                                           | 无（parser 已产出 shift+tab，`\x1b[Z`）                                     | 采纳            | 无冲突                          |
| `Enter`（prompt 聚焦）     | "Send the current prompt"                                                                                       | Composer：Enter 发送；`Shift+Enter`/行尾 `\` 换行（keyboard.test.tsx 覆盖） | 已对齐          | —                               |

## 阻塞卡片（审批 / 提问 / 取消面板）

| 键位                | grok 行为（手册原文引用）                                                        | 我方现状                                            | 目标                 | 差异理由 / 备注     |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------- | ------------------- |
| `↑`/`↓`、`j`/`k`    | "Move between options (clamped at the ends)"                                     | ConfirmDialog/SelectList 支持 ↑↓                    | 已对齐（j/k 不支持） | j/k 随 vim 模式决策 |
| `Tab` / `Shift+Tab` | "Walk the options in a loop"                                                     | SelectList 未绑 Tab                                 | 采纳                 | —                   |
| `1`–`9`             | "Choose that option directly"                                                    | ConfirmDialog 支持 y/a/n 数字待查                   | 采纳                 | 数字直选待补齐      |
| `Esc`               | "steps back out, one rung at a time… clears whatever the card has pending first" | Esc 关闭 overlay（runInkChat）                      | 采纳分级回退         | P3 装配             |
| `Ctrl+C`            | "Cancel the request"                                                             | Ctrl+C 双击闸门（清草稿/取消 turn），卡片内语义待接 | 采纳                 | —                   |

## Escape 语义

| 键位                              | grok 行为（手册原文引用）                                                             | 我方现状                                                          | 目标     | 差异理由 / 备注                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `Esc`（turn 运行中）              | "Cancel immediately… the draft is **preserved**"                                      | Composer：busy 时 Esc 取消 turn（abortCurrentTurn），草稿保留     | 已对齐   | —                                                                     |
| `Esc`（cancelling）               | "Re-sends cancel in **every** mode"                                                   | 无重发语义                                                        | 采纳     | 无冲突                                                                |
| `Esc Esc`（800ms 双击，非空草稿） | "Clear the prompt; the cleared draft is stashed (`Ctrl+S` or `Alt+S` restores it)"    | 无双击清除                                                        | 采纳     | 需 parser 的 Esc 超时语义配合（flushIdle 50ms 与 800ms 双击计时正交） |
| `Esc Esc`（空 prompt）            | "Open the rewind picker (same as `/rewind`)"                                          | 无                                                                | P3+ 评估 | 依赖 rewind 功能本体                                                  |
| `Esc`（全屏 vim）                 | "Swallowed no-op"                                                                     | 无 vim 模式                                                       | 不适用   | 范围裁剪                                                              |
| Steal-Esc 顺序                    | "overlays, modals, slash/file dropdowns… run before mid-turn cancel / clear / rewind" | overlay 打开时 Composer 的 Esc 不触发（`isActive: !overlayOpen`） | 已对齐   | dispatcher 的 overlay 最高优先级即此语义                              |

## Agent 级

| 键位                       | grok 行为（手册原文引用）                                                                              | 我方现状                                                                               | 目标     | 差异理由 / 备注                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `Ctrl+P` / `?`             | "Open the command palette"                                                                             | 无命令面板（有 /help 浮层）                                                            | P3+ 评估 | 待编排者确认（是否引入面板）                                         |
| `Ctrl+M`                   | "Open the model picker"；prompt 聚焦时 "Toggle multiline input mode"                                   | 无                                                                                     | 暂不引入 | 无模型选择器/多行模式开关；0x0D 已由 Enter 消费                      |
| `Ctrl+C`                   | "Cancel the current turn (or clear non-empty draft first… a second Ctrl+C on an empty prompt cancels)" | Composer：双击闸门（createCtrlCGuard，CTRL_C_WINDOW_MS），busy 取消/空闲清草稿语义一致 | 已对齐   | —                                                                    |
| `Ctrl+O`                   | "Toggle always-approve (YOLO) mode"                                                                    | **冲突**：runInkChat `Ctrl+O` = 展开/收起最近一张工具卡（toggleLastTool）              | 待裁决   | **待编排者确认**（工具卡展开是既有已文档化快捷键，与 YOLO 开关冲突） |
| `F3`                       | "Open the session picker (resume a previous session, same as `/resume`)"                               | 无（/sessions 命令有）                                                                 | 暂不引入 | F1-F4 已在 parser 支持                                               |
| `Ctrl+;` / `Ctrl+'`        | "Toggle the prompt queue pane (when non-empty)"                                                        | 队列面板常驻（QueuePanel），无开关键                                                   | 暂不引入 | 差异理由：我方队列常驻渲染，无折叠需求                               |
| `Shift+Tab`（prompt 聚焦） | "Cycle mode (Normal → Plan → Auto → Always-approve)"                                                   | 无模式循环                                                                             | 暂不引入 | 与阻塞卡片 Tab 回行走查冲突，待编排者确认优先级                      |
| `Ctrl+B`                   | "Send the running foreground command to the background"                                                | 无前台任务概念                                                                         | 不适用   | 架构差异                                                             |
| `Ctrl+T`                   | "Toggle the todos pane"                                                                                | 无                                                                                     | 不适用   | 无 todos 面板                                                        |
| `Ctrl+G`                   | "Toggle the tasks pane"（全 TUI）/ "Edit the current draft in an external editor"（minimal 模式）      | **冲突**：runInkChat `Ctrl+G` = 回到末尾并恢复跟随（resumeFollow，已文档化）           | 待裁决   | **待编排者确认**（跟随回底是滚动核心键，grok 无此键）                |
| `Ctrl+L`                   | VS Code 系 "Send now"；其它终端 "Open the extensions modal"                                            | 无                                                                                     | 暂不引入 | 无插件面板；send-now 见下节                                          |
| `↑`（空 prompt）           | 历史 "open the history panel with your last prompt filled in"                                          | Composer：`↑` 上翻历史并恢复 draft（historyPrev/historyNext，恢复 selection）          | 已对齐   | 细节差异：grok 有独立面板，我方就地翻页                              |
| `Ctrl+S`（`Alt+S`）        | "Stash / pop the draft, git stash-style"                                                               | Composer 已绑定 Ctrl+S（草稿暂存/恢复）                                                | 已对齐   | —                                                                    |
| `!`                        | "Enter shell mode"                                                                                     | 无（legacy REPL 有 shell 能力，ink 侧未接）                                            | P3+ 评估 | 待编排者确认                                                         |
| `Ctrl+.`（`Ctrl+X`）       | "Open the keyboard shortcuts help"；"needs the Kitty keyboard protocol"                                | 无（parser 已支持 kitty CSI-u，可接收 Ctrl+.）                                         | P3+ 采纳 | 依赖 kitty 协议探测（terminal-capabilities 待扩展）                  |
| `F2`                       | "Open the settings modal"                                                                              | 无                                                                                     | 不适用   | 无设置面板                                                           |

## Turn 进行中

| 键位                               | grok 行为（手册原文引用）                                     | 我方现状                                     | 目标              | 差异理由 / 备注                                                     |
| ---------------------------------- | ------------------------------------------------------------- | -------------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `Enter`（运行中，有文本）          | "**queues** a follow-up for later"                            | busy 时 submit 入队（FIFO，drainQueue）      | 已对齐            | —                                                                   |
| `Ctrl+Enter` / `Ctrl+I` / `Ctrl+L` | "Send now (cancels the current turn, runs your message next)" | 无 send-now（Ctrl+I=0x09 已是 Tab）          | P3+ 评估          | 依赖 kitty 协议区分 Ctrl+Enter；待编排者确认                        |
| `Ctrl+R`                           | （手册对应 `r` = raw markdown；无 Ctrl+R 绑定）               | busy 时 `Ctrl+R` = 展开/收起推理折叠块（T8） | 保留现状          | 差异理由：我方推理展示为既有功能键位；与 grok 不冲突（grok 未占用） |
| `Ctrl+O`（工具卡）                 | —                                                             | runInkChat：展开/收起最近工具卡              | 与 grok YOLO 冲突 | **待编排者确认**（同上）                                            |

## 全局

| 键位                | grok 行为（手册原文引用）                                                     | 我方现状                                                     | 目标                  | 差异理由 / 备注             |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------- | --------------------------- |
| `Ctrl+N`            | "Create a new session… Yes (double-press within 1000ms)"                      | 无                                                           | 暂不引入              | 有 /new 命令                |
| `Ctrl+\`            | "Open or toggle the Agent Dashboard"                                          | 无 dashboard                                                 | 不适用                | 无 dashboard                |
| `Ctrl+Q` / `Ctrl+D` | "Quit the application… Yes (double-press within 1000ms)"；VS Code 系仅 Ctrl+D | Composer：`Ctrl+D` = 退出（含请求退出请求路径）；Ctrl+Q 未绑 | 已对齐（VSCode 分支） | Ctrl+Q 是否补绑待编排者确认 |

## 鼠标

| 键位                  | grok 行为（手册原文引用）                                           | 我方现状                                | 目标                              | 差异理由 / 备注    |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------- | --------------------------------- | ------------------ |
| 点击条目              | "Click on a scrollback entry to select it"                          | 无（P1 parser 已支持 SGR/X10 鼠标事件） | P2+ 采纳                          | —                  |
| 滚轮                  | "Scroll wheel to scroll through the scrollback"                     | 无                                      | P2+ 采纳（SGR 滚轮 64/65 已解析） | —                  |
| 点击 prompt           | "Click on the prompt area to focus it"                              | 无                                      | P2+ 评估                          | 光标定位需列宽换算 |
| 中键粘贴              | "Middle click on Linux X11/XWayland to paste the PRIMARY selection" | 无                                      | 暂不引入                          | 平台依赖重         |
| Alt+V（Windows 贴图） | "`Alt+V` on Windows is grok-specific"                               | 无                                      | 不适用                            | 无图片粘贴         |

---

## 冲突项清单（已裁决：2026-09-12 需求方拍板「按 grok 语义采纳」）

> 裁决口径：冲突键一律采纳 grok 行为；我方既有绑定相应重排（P1 只登记语义，重排落地在 P3 装配阶段，实现时如有真机问题再上报）。下表正文中遗留的「待编排者确认」字样一律按本节结论读。

1. **Ctrl+O**：✅ 采纳 grok = 切换 always-approve 模式；我方「展开/收起最近工具卡」迁移到其他键（P3 装配时定，候选沿用 grok 块交互 `Enter`/`Ctrl+F` 语义）。
2. **Ctrl+G**：✅ 采纳 grok = 任务面板开关；我方「回到末尾并恢复跟随」迁移（P3 定新键，候选 grok 的 `End`/`G`）。
3. **Ctrl+J / Ctrl+K**：✅ 采纳 grok = scrollback 下/上滚动一行；Windows 个别终端 Enter 发 `\n` 的场景在装配层闸门判断（Enter 判定优先 `\r` 与 kitty 编码，见 parser 设计取舍）。
4. **Ctrl+D**：✅ 采纳 grok = 半页下滚；退出路径保留既有 Ctrl+C 双击升级语义，不再依赖 Ctrl+D。
5. **Shift+Tab**：✅ 采纳 grok = prompt 聚焦时模式循环（Normal→Plan→Auto→Always-approve），阻塞卡片层 Shift+Tab = 卡片行走查（dispatcher 卡片层优先，与 grok 一致）。

## 逃生开关约定

统一命名：`HARNESS2_<能力> = 1` 启用、`= 0` 显式禁用、未设置 = 自动探测（与既有 `HARNESS2_TUI` / `HARNESS2_NO_TUI` 口径一致；数值语义上 `0/空/未设置` 一律视为关闭，仅 `1` 视为强制开）。

| 环境变量                   | 作用                                                                            | 默认值（建议）                                          | 说明                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `HARNESS2_MOUSE`           | 启用鼠标上报（SGR 1006 + 按下/释放/滚轮；X10 仅探测不支持时回退）               | 未设置 = 不启用（自动探测在未来版本按终端白名单开启）   | P1 parser 已可解析 SGR/X10/滚轮/修饰位；启用还需写 `\x1b[?1000;1002;1006h` 的终端模式开关（P2 接入） |
| `HARNESS2_MOUSE_FORCE=1`   | 无白名单强开鼠标（调试用）                                                      | 未设置                                                  | 逃生舱：非白名单终端可手动验证                                                                       |
| `HARNESS2_KITTY_KEYS`      | 请求 kitty keyboard protocol（ progressive enhancement：`\x1b[>1u` push flags） | 未设置 = 不启用                                         | Ctrl+Enter / Ctrl+. 等修饰键区分依赖它；探测失败静默回退 legacy 序列                                 |
| `HARNESS2_FOCUS`           | 启用焦点上报（focus-events 1004，写 `\x1b[?1004h`）                             | 未设置 = 不启用                                         | parser 已解析 CSI I / O；失焦时可降 UI 节流                                                          |
| `HARNESS2_NOTIFY`          | 终端通知（OSC 9 / OSC 777 turn 完成提醒）                                       | 未设置 = 不启用；`=1` 走 OSC 9，`=osc777` 强制 OSC 777  | 仅在终端失焦（需 HARNESS2_FOCUS）时发送，避免打扰                                                    |
| `HARNESS2_BRACKETED_PASTE` | 强制 bracketed paste 开关（覆盖能力探测）                                       | 未设置 = 跟随 terminal-capabilities（altScreen 同闸门） | 关闭时粘贴退化为逐字符注入（风险：多行粘贴触发提交），仅排障用                                       |
| `HARNESS2_INPUT_DEBUG`     | 输入层调试回显（把 parser 产出的事件写 stderr）                                 | 未设置 = 关闭                                           | 排障键位问题时用；不入 UI                                                                            |

命名与默认值均为**建议稿**，随 P2 接入时由编排者定稿；所有开关必须可在 `/doctor` 中展示当前生效状态。
