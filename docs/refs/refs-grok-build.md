# refs-grok-build —— CLI 交互完全复刻规格

> 定位：**CLI 交互的权威规格。复刻等级默认「必刻」**（逐键位、逐文案、逐状态）。
> 本项目 CLI 出现的任何交互，都必须能在本文找到 `G-*` 编号。

## 分析基线

| 项目         | 值                                         |
| ------------ | ------------------------------------------ |
| 本地路径     | `D:/AI_Projects/refs/grok-build`           |
| 远程         | `https://github.com/xai-org/grok-build`    |
| 分析 commit  | `37949780`                                 |
| 上游提交时间 | `2026-09-09T19:03:16Z`                     |
| 分支         | `main`                                     |
| `SOURCE_REV` | `c4ea71cfdbcdb21e32e41bc25a0043d7d4836714` |
| 分析日期     | 2026-09-13                                 |
| 分析者       | 开发子代理 P0-A（编排者派工）              |

## 定位与仓库结构

Rust 工作区，产物二进制 `xai-grok-pager`，官方以 `grok` 名称分发。构建入口 `cargo run -p xai-grok-pager-bin`。
根目录：`.cargo/`、`bin/`（DotSlash 管理的 `protoc`）、`crates/{build,codegen,common}`、`prod/`、`third_party/`、`Cargo.toml`（19KB，**生成物，只读**）、`SOURCE_REV`、`rust-toolchain.toml`、`clippy.toml`、`rustfmt.toml`。

| crate                        | 职责                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `codegen/xai-grok-pager-bin` | 合成根（composition root），唯一可执行产物                         |
| `codegen/xai-grok-pager`     | **TUI 层**：scrollback、prompt、modals、rendering、slash、settings |
| `codegen/xai-grok-shell`     | agent 运行时 + leader / stdio / headless 入口                      |
| `codegen/xai-grok-tools`     | terminal / file edit / search 工具                                 |
| `codegen/xai-grok-workspace` | FS / VCS / 执行 / checkpoints                                      |

**这套分层即 harness2 的目标分层**：`xai-grok-shell + tools + workspace` ≈ 我们的 `core`；`xai-grok-pager` ≈ 我们的 `cli` 壳。

`xai-grok-pager/src` 关键目录：`app/`、`views/`、`scrollback/`、`slash/`、`minimal/`、`settings/`、`actions/`、`acp/`、`notifications/`、`tips/`、`voice/`、`diagnostics/`、`headless/`。关键单文件：`headless.rs`(65KB)、`mcp_cmd.rs`(50KB)、`plugin_cmd.rs`(47KB)、`tracing.rs`(34KB)、`wrap_filter.rs`(33KB)、`memory_trace.rs`(32KB)、`git_info.rs`(30KB)、`pty_wrap.rs`、`sessions_cmd.rs`、`tool_usage.rs`、`trace_cmd.rs`、`input_log.rs`、`hyperlink_route.rs`、`wrap_clipboard_image.rs`。

## 权威依据

`crates/codegen/xai-grok-pager/docs/user-guide/` 27 篇手册（README 分三层：Tier1 01–05 / Tier2 06–13 / Tier3 14–27）。本轮重点精读：

| 文件                        | 用途                   |
| --------------------------- | ---------------------- |
| `03-keyboard-shortcuts.md`  | 键位与焦点模型（30KB） |
| `04-slash-commands.md`      | 斜杠命令全集（24KB）   |
| `25-status-line.md`         | 状态行契约（18KB）     |
| `05-configuration.md`       | 配置面（50KB）         |
| `26-config-reference.md`    | 配置项参考（58KB）     |
| `06-theming.md`             | 主题（15KB）           |
| `10-hooks.md`               | 钩子（56KB）           |
| `14-headless-mode.md`       | 无头模式（41KB）       |
| `22-permissions-and-safety` | 权限与安全（34KB）     |

其余：`01-getting-started`、`02-authentication`、`07-mcp-servers`、`08-skills`、`09-plugins`、`11-custom-models`、`12-project-rules`、`13-memory`、`15-agent-mode`、`16-subagents`、`17-sessions`、`18-sandbox`、`19-plan-mode`、`20-background-tasks`、`21-terminal-support`、`23-dashboard`、`24-monitoring-usage`、`27-grok-clone`。

## 交互 / 布局 / 样式

本文的交互 / 布局 / 样式规格全部以 `G-*` 编号条目的分组小节呈现，键位表、状态机、边界条件随条目逐条展开，不另设独立长文。布局与渲染模式 → G-1x 渲染模式与布局区域（G-01～G-06）；键位与焦点 → G-2x 输入与焦点模型（G-07～G-13）、G-6x Agent 级键位（G-31～G-41）。
状态机与边界条件 → G-3x Esc 语义状态表（G-14～G-20）、G-4x 阻塞卡片（G-21～G-25）、G-5x 运行中回合（G-26～G-30）、G-7x 状态行契约（G-42～G-49）；样式 / 主题 → G-84（`/theme`）、G-92（Terminal 原生主题）。

## 功能面清单

本文的功能面以命令面为主体：斜杠命令全集集中在 G-8x（G-50～G-90，含「会话与历史」「模型与模式」「记忆 · 扩展 · 调度 · 其他」三个子分组）；基线刷新新增的能力面见 G-9x（G-91～G-95）。本小节仅作导航，条目内容不在此复制。

## 复刻矩阵

本文各条目分组表即复刻矩阵：通用列为「ID / 条目 / 行为要点 / 等级（复刻等级）/ 状态」，部分分组对中间两列使用同位异名（G-4x「卡片 / 来源 / 交互」、G-6x「键位 / 功能」、G-8x 子表「命令 / 要点」），G-9x 另含「依据路径」列，G-8x 基础机制表省略等级列（表头注明均必刻）。分组索引如下（条目数与状态按 2026-09-14 P9 归存后正文实际统计；合计 95 条）：

| 分组小节                                              | ID 区间    | 条目数 | 状态分布                    |
| ----------------------------------------------------- | ---------- | ------ | --------------------------- |
| G-1x 渲染模式与布局区域                               | G-01～G-06 | 6      | 5 🟡 · 1 ✅                 |
| G-2x 输入与焦点模型                                   | G-07～G-13 | 7      | 4 🟡 · 3 ✅                 |
| G-3x Esc 语义状态表（最易做成半成品的一块，逐行复刻） | G-14～G-20 | 7      | 6 ✅ · 1 ➖                 |
| G-4x 阻塞卡片（四件套）                               | G-21～G-25 | 5      | 2 ✅ · 3 🟡                 |
| G-5x 运行中回合（队列 / 转向）                        | G-26～G-30 | 5      | 5 ✅                        |
| G-6x Agent 级键位                                     | G-31～G-41 | 11     | 5 ✅ · 6 🟡                 |
| G-7x 状态行契约（`[ui.status_line]`）                 | G-42～G-49 | 8      | 8 ✅                        |
| G-8x 斜杠命令全集（依据 `04-slash-commands.md`）      | G-50～G-90 | 41     | 14 ✅ · 25 🟡 · 2 ➖        |
| G-9x 基线刷新新增条目（37949780，2026-09-13）         | G-91～G-95 | 5      | 5 ⬜                        |
| 合计                                                  | G-01～G-95 | 95     | 44 ✅ · 43 🟡 · 5 ⬜ · 3 ➖ |

每条 `⬜` 均已在状态列写明归存结论与事实理由（硬规则 #2）；43 条 🟡 亦逐条写明剩余部分与接收方（旧「下放 P3/P7」的口径在 P9 统一改为「P9 后另行排期」），五类汇总见下文「归存汇总（2026-09-14 P9）」小节。

## G-1x 渲染模式与布局区域

| ID   | 条目         | 行为要点                                                                                                                                                                 | 等级 | 状态                                                                                                                                            |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| G-01 | 双渲染模式   | `fullscreen`（默认，接管屏幕）与 `minimal`（原生 scrollback，不接管屏幕）两套完整 UI                                                                                     | 必刻 | 🟡（归存：P9 后另行排期——fullscreen 已落；minimal 为降级指引/基座接线，实体模式切换待真机（OPEN.md））                                          |
| G-02 | 进程内切模式 | `/minimal` / `/fullscreen`（`/full`）当场切换不重启；配置 `[ui] screen_mode`；`GROK_SCREEN_MODE_SWITCH=exec` 改为重执行                                                  | 必刻 | 🟡（归存：P9 后另行排期——`/minimal` `/fullscreen` 已注册且 `[ui] screen_mode` 初值可用；minimal 实体切换当前为降级指引，真机项在 OPEN.md）      |
| G-03 | 模式限定命令 | 仅 fullscreen：`/find` `/jump` `/timeline` `/theme` `/tutorial` `/dashboard`；仅 minimal：`/expand`；`/workflow runs` 在 minimal 降级为纯文本                            | 必刻 | 🟡（归存：P9 后另行排期——门控已落（P2/P3），`/workflow runs` 走 minimal 纯文本降级；`/dashboard` `/tutorial` 等命令本身未实现（见 G-56/G-86）） |
| G-04 | 布局区域清单 | scrollback（主区）· prompt（输入）· status line（可选）· shortcuts bar（焦点提示）· queue pane · todos pane · tasks pane · overlay modal（命令面板/模型/会话/扩展/设置） | 必刻 | ✅                                                                                                                                              |
| G-05 | 块折叠与视图 | `h`/`l`（或 `←`/`→`）折叠展开·`e` 切折叠·`Shift+E` 全展·`Ctrl+E` thinking 块·`r` 原始 markdown；`[scrollback.scroll] respect_manual_folds` 控制自动折叠是否覆盖手动折叠  | 必刻 | 🟡（归存：P9 后另行排期——folds/block-ops 已接线（P3 minimal 基座）；`respect_manual_folds` 配置面未落）                                         |
| G-06 | 块内容操作   | `y` 复制正文·`Shift+Y` 复制含元数据·`Enter` / `Ctrl+F` 全屏查看器                                                                                                        | 必刻 | 🟡（归存：P9 后另行排期——`Ctrl+F` 全屏查看器与复制部分接线；`Shift+Y` 含元数据复制未落）                                                        |

## G-2x 输入与焦点模型

| ID   | 条目         | 行为要点                                                                                                                                                                                                  | 等级 | 状态                                                                                                   |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| G-07 | 两种输入模式 | `simple`（默认）与 `vim`（`[ui].vim_mode` 或 `/vim-mode`）；两套键位表并行存在                                                                                                                            | 必刻 | 🟡（归存：P9 后另行排期——simple 输入已落；vim 模式键位表未接（`[ui].vim_mode` / `/vim-mode`））        |
| G-08 | 焦点环       | `Tab` 在 prompt / scrollback 间切换；simple 下 `Space` 亦可，vim 下 `i` 回输入；**`Esc` 不是焦点键**                                                                                                      | 必刻 | ✅                                                                                                     |
| G-09 | 导航键位     | `j`/`k` ↔ `↓`/`↑`·`Shift+L`/`Shift+H` ↔ `Shift+→`/`Shift+←`（按 turn）·`Shift+J`/`Shift+K` 跳视口顶上/下方 turn（与 timeline 箭头同目标；2026-09-13 修正：原稿写「按助手回复」已失真）·`g`/`Shift+G` 首尾 | 必刻 | 🟡（归存：P9 后另行排期——turn 跳转（Shift+J/K 目标）已接线；`g`/`Shift+G` 首尾跳转未落）               |
| G-10 | 滚动粒度     | `Ctrl+K`/`Ctrl+J` 行滚动·`PageUp`/`PageDown` 整页·`Ctrl+U`/`Ctrl+D` 半页                                                                                                                                  | 必刻 | ✅                                                                                                     |
| G-11 | Shell 模式   | 行首 `!` 进入 shell 模式直接执行命令                                                                                                                                                                      | 必刻 | 🟡（归存：P9 后另行排期——行首 `!` 已接（`tui/next/shell-exec.ts`）；`{!cmd}` 多行与交互式 shell 未落） |
| G-12 | 图片粘贴     | Windows 用 **`Alt+V`**（`Ctrl+V` 被终端占）；Linux 区分 PRIMARY / CLIPBOARD，`Shift+Insert` 走 PRIMARY；拖拽亦可                                                                                          | 必刻 | 🟡（归存：P9 后另行排期——`Alt+V` 接线已落；真机透传待验（OPEN.md 真机清单））                          |
| G-13 | 终端能力依赖 | WezTerm 需 `enable_kitty_keyboard = true` 才能收到全量和弦；终端族差异在 `21-terminal-support.md`                                                                                                         | 必刻 | ✅                                                                                                     |

## G-3x Esc 语义状态表（最易做成半成品的一块，逐行复刻）

| ID   | 场景                         | 行为                                                                                                                                                                                                                                                                                                                                                           | 等级 | 状态 |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| G-14 | 回合运行中（一切模式/窗格）  | `Esc` **永不取消回合**：显示 `Press Ctrl+C to cancel the turn` 提示（fullscreen 走 toast；minimal 无 toast 槽，写一条滚动区系统行，每用户回合最多一条去重），草稿原样保留；取消统一走 `Ctrl+C`（2026-09-13 修正：上游已废除 Esc 取消）。保真度备注：上游实际渲染 `Ctrl+c`（键位显示模块把 CONTROL+c 归一为大写 C、小写 c），harness2 文案用 `Ctrl+C`，语义同源 | 必刻 | ✅   |
| G-15 | 正在取消中（TurnCancelling） | `Esc` 无声吞掉（连提示也不给，避免误导）；`Ctrl+C` 在此状态升级为退出（2026-09-13 修正：原稿的「fullscreen+vim 特例 no-op」已推广为全模式统一行为）                                                                                                                                                                                                            | 必刻 | ✅   |
| G-16 | 正在取消中重发取消           | **➖ 已移除**：上游删除了「再按 `Esc` 重发取消（硬中断）」路径——Esc 在取消中是纯 no-op（见 G-15），重试/升级职责全归 `Ctrl+C`；`StopCancelled.cancelTrigger` 也不再发送 `esc`（仅 `ctrl_c`/`mouse`/`dashboard_stop`）                                                                                                                                          | 必刻 | ➖   |
| G-17 | 空闲 + 草稿非空              | **800ms 内双击 `Esc`** 清空草稿并 stash；`Ctrl+S` / `Alt+S` 恢复                                                                                                                                                                                                                                                                                               | 必刻 | ✅   |
| G-18 | 空闲 + 草稿为空 + 有历史消息 | 双击 `Esc` 打开 rewind picker（两窗格皆可武装；清草稿仍限 prompt 窗格）                                                                                                                                                                                                                                                                                        | 必刻 | ✅   |
| G-19 | mid-turn Esc 宽限期          | 回合中每按一次 `Esc` 即把 rewind 武装压制 deadline 推到 **now+1000ms**（`ESC_CANCEL_REWIND_GRACE`）：Esc 连打穿越回合结束（取消或自然完成）也不会误开 rewind picker（2026-09-13 修正：触发方由「取消后」改为「mid-turn Esc」）                                                                                                                                 | 必刻 | ✅   |
| G-20 | 阻塞卡片打开时               | `Esc` 逐级退出卡片，退到最后把焦点 park 到 scrollback 并给提示                                                                                                                                                                                                                                                                                                 | 必刻 | ✅   |

## G-4x 阻塞卡片（四件套）

| ID   | 卡片              | 来源                     | 交互                                         | 等级 | 状态                                                                                                                    |
| ---- | ----------------- | ------------------------ | -------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| G-21 | permission prompt | 工具/命令权限请求        | 优先级最高，遮盖其他卡片                     | 必刻 | ✅                                                                                                                      |
| G-22 | cancel-turn panel | 取消确认                 | 优先级次于 permission                        | 必刻 | 🟡（归存：P9 后另行排期——卡片渲染与优先级已落（`tui/cards/`）；无真实来源（取消走 Esc/Ctrl+C 直连），接线需上游事件面） |
| G-23 | question card     | `ask_user_question` 工具 | 选项 + 自由文本                              | 必刻 | 🟡（归存：P9 后另行排期——卡片渲染已落；`ask_user_question` 工具未提供来源）                                             |
| G-24 | MCP elicitation   | `x.ai/mcp/elicit`        | 优先级最低                                   | 必刻 | 🟡（归存：P9 后另行排期——卡片渲染已落；`x.ai/mcp/elicit` 无客户端来源（MCP 侧未实现 elicitation 通道））                |
| G-25 | 卡片内焦点        | 四类共用                 | `Tab` / `Shift+Tab` 卡内环走（不泄漏到全局） | 必刻 | ✅                                                                                                                      |

优先级固定：`permission > cancel-turn > question > elicitation`。

## G-5x 运行中回合（队列 / 转向）

| ID   | 条目           | 行为要点                                                                                                | 等级 | 状态 |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------- | ---- | ---- |
| G-26 | 普通 Enter     | 回合运行中 `Enter` **入队**（不打断）；`[ui].follow_up_behavior = queue \| steer` 切换为队列或实时转向  | 必刻 | ✅   |
| G-27 | 空输入再 Enter | composer 为空时再 `Enter` 发送队首一条                                                                  | 必刻 | ✅   |
| G-28 | send-now 和弦  | `Ctrl+Enter` / `Ctrl+I` = **取消当前回合并立即发送**；Apple Terminal 用 `Ctrl+O`，VS Code 族用 `Ctrl+L` | 必刻 | ✅   |
| G-29 | 队列面板       | `Ctrl+;`（备用 `Ctrl+'`，macOS VS Code 系 `Ctrl+4`）打开；`↑` 在队列/历史间转焦点                       | 必刻 | ✅   |
| G-30 | 阻塞等待中     | 卡片等待时 `Enter` 直送（不入队）                                                                       | 必刻 | ✅   |

## G-6x Agent 级键位

| ID   | 键位                | 功能                                                                                                                                        | 等级 | 状态                                                                                                                                                              |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-31 | `Ctrl+P` / `?`      | 命令面板（palette）                                                                                                                         | 必刻 | ✅                                                                                                                                                                |
| G-32 | `Ctrl+M`            | 模型选择器；**prompt 聚焦时改为多行切换**（双语义）                                                                                         | 必刻 | 🟡（归存：P9 后另行排期——键位已在 `keymaps.ts` `AGENT_CHORD_TABLE` 登记占用；本仓无运行期模型选择器，`Ctrl+M` 双语义都无落点）                                    |
| G-33 | `Shift+Tab`         | 模式循环 Normal → Plan → Auto → Always-approve；`Ctrl+O` 直切 always-approve                                                                | 必刻 | ✅                                                                                                                                                                |
| G-34 | `Ctrl+R`            | 会话选择器（2026-09-13 修正：原键位 `F3` 已废除，改为 `Ctrl+R`；welcome 屏与会话内皆开；scrollback 聚焦时该和弦可被 G-91 鼠标上报开关借用） | 必刻 | ✅                                                                                                                                                                |
| G-35 | `Ctrl+T` / `Ctrl+G` | todos 面板 / tasks 面板（minimal 下 `Ctrl+G` 改为外部编辑器）                                                                               | 必刻 | 🟡（归存：P9 后另行排期——键位已登记；无 todos 数据源、`/tasks` 需 cron 句柄（`ChatRuntime` 未注入），两种语义都无落点；与 G-37 同批等 TaskCoordinator/cron 装配） |
| G-36 | `Ctrl+L`            | extensions 模态（VS Code 族下改为 interject）                                                                                               | 必刻 | 🟡（归存：P9 后另行排期——键位已登记；本壳无 extensions 模态（MCP/插件只读面走 `/mcps` `/plugins`））                                                              |
| G-37 | `Ctrl+B`            | 当前回合转后台                                                                                                                              | 必刻 | 🟡（归存：P9 后另行排期——键位已登记；CLI 未装配 core `TaskCoordinator`（OPEN.md 已知项），「转后台」无落点，不谎称转后台）                                        |
| G-38 | `Ctrl+C`            | 取消/退出——回合取消的唯一键（与 Esc 语义不同，见 G-14～G-19；取消中再按升级为退出）                                                         | 必刻 | ✅                                                                                                                                                                |
| G-39 | `Ctrl+.` / `Ctrl+X` | 快捷键帮助                                                                                                                                  | 必刻 | ✅                                                                                                                                                                |
| G-40 | `F2` / `Ctrl+,`     | 设置面板                                                                                                                                    | 必刻 | 🟡（归存：P9 后另行排期——键位已登记；无统一设置面板（配置经 config.json 与 `/mode` `/theme` 单点命令））                                                          |
| G-41 | `Ctrl+\`            | agents dashboard（`GROK_AGENT_DASHBOARD=0` 可关）                                                                                           | 参考 | 🟡（归存：P9 后另行排期——参考级；无多 agent 运行时/dashboard 数据源；备用位 `Ctrl+4` 与 G-29 的 macOS 族主键撞位需先裁决）                                        |

## G-7x 状态行契约（`[ui.status_line]`）

| ID   | 条目       | 行为要点                                                                                                                                                                            | 等级 | 状态 |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| G-42 | 三种类型   | `type = builtin / command / disabled`，默认 `disabled`（`off` `none` `hidden` 同义）                                                                                                | 必刻 | ✅   |
| G-43 | builtin 项 | `items` 默认 `[cwd, model, context]`；可选 `cost`（低于 $0.005 隐藏）、`turn-timer`、`session-name`                                                                                 | 必刻 | ✅   |
| G-44 | 省略规则   | 目录与会话名在 40 列以下省略；模型名在 30 列以下省略                                                                                                                                | 必刻 | ✅   |
| G-45 | command 型 | 外部命令走 stdin JSON：`workspace.repo_root`、`context_window.context_tokens`、`context_window.session_usage`、`transcript_path`、`prompt_id`、`trigger = state / refresh_interval` | 必刻 | ✅   |
| G-46 | 刷新策略   | 事件驱动 + 300ms 防抖（紧急 100ms）；`refresh_interval` 1–86400 秒；`padding` 上限 16                                                                                               | 必刻 | ✅   |
| G-47 | 输出限额   | 最多 5 行、每行 1024 字符、stdout 超 64KiB 截断、超时 10s 显示 `[status line: timed out]`                                                                                           | 必刻 | ✅   |
| G-48 | 失败降级   | 失败写 `~/.grok/logs/unified.jsonl`；**连续三次失败**才在状态行画错误                                                                                                               | 必刻 | ✅   |
| G-49 | 子进程环境 | `COLUMNS` / `LINES` 给的是状态行自身尺寸；`GIT_OPTIONAL_LOCKS=0`；清空 `BASH_ENV` / `ENV`                                                                                           | 必刻 | ✅   |

## G-8x 斜杠命令全集（依据 `04-slash-commands.md`）

基础机制（均必刻）：

| ID   | 条目         | 行为要点                                                              | 状态                                                                                                             |
| ---- | ------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| G-50 | 命令来源分裂 | shell builtins 与 pager builtins 两类，**合并进同一个菜单**，模糊匹配 | ✅                                                                                                               |
| G-51 | 菜单行为     | 输入 `/` 弹菜单，模糊筛选，回车直执行                                 | ✅                                                                                                               |
| G-52 | 技能升为命令 | skill 可声明 `user-invocable`，自动出现在菜单                         | 🟡（归存：P9 后另行排期——`/skills` 只读列出已落；skill 声明 `user-invocable` 自动进菜单未落）                    |
| G-53 | 名字冲突     | 冲突时用 `/plugin-name:login` 形式限定，并在菜单打 badge 区分来源     | 🟡（归存：P9 后另行排期——来源 badge 已落（`tui/commands/palette-model.ts`）；`/plugin-name:login` 限定形式未落） |

### 会话与历史

| ID   | 命令                                            | 要点                                                                         | 等级 | 状态                                                                                                               |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| G-54 | `/new`（`/clear`）                              | 新会话                                                                       | 必刻 | ✅                                                                                                                 |
| G-55 | `/resume`                                       | 恢复会话选择器                                                               | 必刻 | ✅                                                                                                                 |
| G-56 | `/dashboard`（`/agents-dashboard` `/sessions`） | agents 仪表盘，`Ctrl+\` 开，仅 fullscreen                                    | 参考 | 🟡（归存：P9 后另行排期——本仓无 agents dashboard（与 G-41/G-94 同因））                                            |
| G-57 | `/compact [说明]`                               | 人工压缩；**自动压缩阈值 85%**（`[session] auto_compact_threshold_percent`） | 必刻 | ✅                                                                                                                 |
| G-58 | `/context`                                      | 上下文分类占用明细                                                           | 必刻 | ✅                                                                                                                 |
| G-59 | `/session-info`（`/status` `/info`）            | 会话详情；`c` 复制会话 id，`y` 复制整块                                      | 必刻 | ✅                                                                                                                 |
| G-60 | `/fork`                                         | 分叉会话                                                                     | 必刻 | ✅                                                                                                                 |
| G-61 | `/rewind`（`/undo`）                            | 回退选择器（与双击 Esc 同入口，见 G-18）                                     | 必刻 | ✅                                                                                                                 |
| G-62 | `/copy [n 或 path]`                             | 复制回复；备份到 `~/.grok/last-copy.txt`，`GROK_COPY_FILE` 可改              | 必刻 | 🟡（归存：P9 后另行排期——`Ctrl+C` 复制（OSC52）已落；`/copy [n 或 path]` 命令与 `~/.grok/last-copy.txt` 备份未落） |
| G-63 | `/export`                                       | 导出会话                                                                     | 必刻 | ✅                                                                                                                 |
| G-64 | `/delete`                                       | 删会话；选择器内 `d` 后 `y` 确认，仪表盘 `Ctrl+X` 两次                       | 必刻 | 🟡（归存：P9 后另行排期——无删会话命令与选择器内 `d`→`y` 确认）                                                     |
| G-65 | `/rename`（`/title`）                           | 重命名，支持 `--auto`                                                        | 必刻 | 🟡（归存：P9 后另行排期——本仓为 `/title`（`--auto` 已可用，H-14 ✅）；`/rename` 别名未注册）                       |
| G-66 | `/history`                                      | 历史浏览                                                                     | 必刻 | 🟡（归存：P9 后另行排期——有 `/timeline`（只读轨迹，仅 fullscreen）与 `/undo`；交互式历史浏览浮层未落）             |
| G-67 | `/home`（`/welcome`） · `/quit`（`/exit`）      | 首屏与退出                                                                   | 必刻 | 🟡（归存：P9 后另行排期——`/exit`（别名 `/quit`）已注册；`/home` 首屏命令未注册）                                   |

### 模型与模式

| ID   | 命令                            | 要点                                                   | 等级 | 状态                                                                                                                     |
| ---- | ------------------------------- | ------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| G-68 | `/model`（`/m`）                | 模型选择器，可带 effort 参数                           | 必刻 | 🟡（归存：P9 后另行排期——本仓无运行期模型选择器（模型由 config/provider 装配期确定，与 G-32 同因））                     |
| G-69 | `/effort low/medium/high/xhigh` | 推理强度（按模型能力）                                 | 必刻 | 🟡（归存：P9 后另行排期——有 `/reasoning on/off`（展示开关）；low/medium/high/xhigh 推理强度档位未落）                    |
| G-70 | `/auto` · `/always-approve`     | **真开关**（非一次性命令），与 `Shift+Tab` 循环同源    | 必刻 | ✅                                                                                                                       |
| G-71 | `/plan [描述]` · `/view-plan`   | 计划模式与计划查看（`/show-plan` `/plan-view`）        | 必刻 | 🟡（归存：P9 后另行排期——审批模式含 plan 态（`/mode plan`、Shift+Tab 循环）；`/plan <描述>` 与 `/view-plan` 计划面未落） |
| G-72 | `/multiline`（`/ml`）           | 多行输入开关                                           | 必刻 | 🟡（归存：P9 后另行排期——composer 有 Shift+Enter 换行；`/multiline` 开关未落）                                           |
| G-73 | `/vim-mode` · `/compact-mode`   | 输入模式与紧凑渲染                                     | 必刻 | 🟡（归存：P9 后另行排期——vim 模式未落（G-07）；compact-mode 紧凑渲染未落）                                               |
| G-74 | `/edit-prompt`                  | 外部编辑器写 prompt，顺序 `$VISUAL` → `$EDITOR` → `vi` | 必刻 | 🟡（归存：P9 后另行排期——无外部编辑器写 prompt（`$VISUAL`→`$EDITOR`→`vi`）面）                                           |
| G-75 | `/minimal` · `/fullscreen`      | 渲染模式切换（见 G-02）                                | 必刻 | ✅                                                                                                                       |
| G-76 | `/timestamps`                   | 时间戳显示开关                                         | 必刻 | 🟡（归存：P9 后另行排期——无时间戳显示开关）                                                                              |

### 记忆 · 扩展 · 调度 · 其他

| ID   | 命令                                                                                                    | 要点                                                                                                                                                                                                                                                                                                                                                                                                                      | 等级   | 状态                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| G-77 | `/memory`（`/mem` on/off） · `/remember` · `/flush` · `/dream`                                          | 记忆子系；需 `GROK_MEMORY=1` 或 `[memory] enabled`                                                                                                                                                                                                                                                                                                                                                                        | 补齐   | 🟡（归存：P9 后另行排期——`/memory` 只读查看已落（core catalog）；`/remember` `/flush` `/dream` 未落）              |
| G-78 | `/hooks` `/plugins` `/marketplace` `/skills` `/workflows`                                               | **同一个 extensions 模态的 5 个 tab**（不是 5 个独立窗口）                                                                                                                                                                                                                                                                                                                                                                | 必刻   | 🟡（归存：P9 后另行排期——`/plugins` `/skills` `/mcps` 只读命令已落；无统一 extensions 模态与 5 tab）               |
| G-79 | `/loop [间隔] <prompt>`                                                                                 | 定时自循环；间隔 `Ns`（≥60）/`Nm`/`Nh`/`Nd`，7 天过期；每次触发在**独立后台子代理**中运行（看不到会话上下文，prompt 必须自含，仅结果返回；2026-09-13 修正：原「每次触发创建新回合」已失真）                                                                                                                                                                                                                               | 补齐   | 🟡（归存：P9 后另行排期——cron（H-46）为等价能力（60s tick + 自然语言）；`/loop` 命令与独立后台子代理触发语义未落） |
| G-80 | `/goal <目标> [--budget tokens]` + `status/pause/resume/clear`                                          | 长期目标与预算                                                                                                                                                                                                                                                                                                                                                                                                            | 补齐   | 🟡（归存：P9 后另行排期——无目标/预算面）                                                                           |
| G-81 | `/workflow <name>` + `runs/pause/resume/stop/save`                                                      | `.grok/workflows/*.rhai` 与 `~/.grok/workflows/*.rhai`；`agent_budget` 默认 128、范围 1–1024、并发上限 32；详情页 `p`/`r`/`x`/`s`                                                                                                                                                                                                                                                                                         | 补齐   | 🟡（归存：P9 后另行排期——无 workflow 运行时（`.rhai`）；core `flows/` 是特权/审批 flow，非该语义）                 |
| G-82 | `/deep-research <query>`                                                                                | 深度研究流                                                                                                                                                                                                                                                                                                                                                                                                                | 补齐   | 🟡（归存：P9 后另行排期——无内置深度研究流）                                                                        |
| G-83 | `/imagine` · `/imagine-video`                                                                           | 图像/视频生成                                                                                                                                                                                                                                                                                                                                                                                                             | 不采纳 | ➖                                                                                                                 |
| G-84 | `/theme`（`/t`）                                                                                        | 主题切换（仅 fullscreen）；picker 支持键入按**任意 config 名/别名**实时过滤排名（如 `transparent` 排到 `terminal` 行，回车仍插入规范名）                                                                                                                                                                                                                                                                                  | 必刻   | ✅                                                                                                                 |
| G-85 | `/doctor [fix]`                                                                                         | 终端自检；别名 `/terminal-setup` `/terminal-check` `/terminal-info`                                                                                                                                                                                                                                                                                                                                                       | 必刻   | ✅                                                                                                                 |
| G-86 | `/docs`（`/howto` `/guides`） · `/tutorial`（`/tour` `/onboarding`） · `/release-notes`（`/changelog`） | 内置文档与引导                                                                                                                                                                                                                                                                                                                                                                                                            | 参考   | 🟡（归存：P9 后另行排期——`/doctor`（G-85 ✅）已有；`/docs` `/tutorial` `/release-notes` 未落）                     |
| G-87 | `/settings`（`/config` `/preferences` `/prefs`）                                                        | 设置面板（与 `F2` 同源）                                                                                                                                                                                                                                                                                                                                                                                                  | 必刻   | 🟡（归存：P9 后另行排期——无设置面板（与 G-40 同因）；`/theme` `/mode` 为单点命令）                                 |
| G-88 | `/mcps` · `/config-agents`（`/agents`） · `/personas`                                                   | MCP 与子代理/人格配置                                                                                                                                                                                                                                                                                                                                                                                                     | 补齐   | 🟡（归存：P9 后另行排期——`/mcps` 只读已落；子代理/人格配置命令未落）                                               |
| G-89 | `/btw` · `/feedback`                                                                                    | `/feedback` 重写（2026-09-13 修正）：裸命令在 full TUI 打开**独立反馈模态**（`Write`/`Drafts` 双 tab、类型/任务类别/失败模式枚举 picker、图片粘贴、草稿本地持久化、trace 同意卡、可被更高优先级阻塞卡片让位且归位恢复）；`/feedback <text>` 变为模型回合（先存本地草稿，让模型调 `send_feedback` 分类，禁止自称已发送）；minimal 无模态渲染器，只接受 `/feedback <text>` 并对裸命令给出可见拒绝；voice 占用输入时同样拒绝 | 参考   | 🟡（归存：P9 后另行排期——`/btw` 与独立反馈模态未落；minimal 下的可见拒绝行为随模态一并延后）                       |
| G-90 | `/login` `/logout` `/usage`（`/cost`） `/privacy` `/import-claude`                                      | xAI 账号/计费/导入专有；本轮 `/usage` 在会话内改为打开 tab 式 usage 模态（账户额度 + 会话上下文/token 合计），dashboard 上 `/usage` 同样可开该模态（仅 Usage limit tab 有数据）——仍属 xAI 计费面，维持不采纳                                                                                                                                                                                                              | 不采纳 | ➖                                                                                                                 |

## G-9x 基线刷新新增条目（37949780，2026-09-13）

本轮（`72a61251` → `37949780`）上游新增或补登记的交互条目。依据路径相对参考仓库根。

| ID   | 条目                   | 行为要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 依据路径                                                                                                                                                                                                                                                                           | 等级 | 状态                                                                                                                                      |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| G-91 | 鼠标上报开关           | `[ui] mouse_reporting_toggle`（env `GROK_MOUSE_REPORTING_TOGGLE`，默认关）开启后，**scrollback 聚焦时 `Ctrl+R` 切换终端鼠标捕获**（原生复制/粘贴），该和弦从会话选择器（G-34）借用——prompt 聚焦时 `Ctrl+R` 仍是会话选择器；cheatsheet 归 Panels 分类（opt-in）。补登记：该配置在旧基线已存在，首轮文档漏收                                                                                                                                                                                                                            | `crates/codegen/xai-grok-pager/src/actions/defaults.rs`、`crates/codegen/xai-grok-pager/src/app/mod.rs`、`crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md`（`ui.mouse_reporting_toggle`）                                                                     | 必刻 | ⬜（归存：P9 后另行排期——无 `[ui] mouse_reporting_toggle` 配置与鼠标捕获切换；`Ctrl+R` 已被 G-34 会话选择器占用，接线前须先裁决窗格限定） |
| G-92 | Terminal 原生主题      | 第六个内置主题 `terminal`（别名 `terminal-default`/`transparent`/`native`）：不画任何表面背景（终端画布/半透明/背景图透出）、正文用终端默认前景、选中/悬停行用**反显**（reverse video）、装饰用 ANSI 亮黑、不改光标色；不要求 truecolor。受 rollout 门控：`GROK_TERMINAL_THEME=1` 或 `[features] terminal_theme = true` 之前在 `/theme`、`/settings` 隐藏且名称不可解析（配置回落默认主题）                                                                                                                                           | `crates/codegen/xai-grok-pager-render/src/theme/mod.rs`（`ThemeKind::Terminal`）、`crates/codegen/xai-grok-pager-render/src/theme/terminal_default.rs`、`crates/codegen/xai-grok-pager/src/slash/commands/theme.rs`、`crates/codegen/xai-grok-pager/docs/user-guide/06-theming.md` | 必刻 | ⬜（归存：P9 后另行排期——主题面已落（G-84 ✅，`tui/next/theme.ts`）；第六个 `terminal` 原生主题（不绘背景/反显/rollout 门控）未落）       |
| G-93 | hook 运行时状态面      | hook 批次（PreToolUse/UserPromptSubmit/Stop 门）阻塞回合约 300ms 后，回合状态行显示 `Running <event> hook…` / `Running <N> <event> hooks…`；滚动区注解**只留两类**：deny 一行（含原因；managed 配置的 hook 匿名显示为 "a managed policy hook"）、失败一行 `<event> hook (<name>) failed, ignored: <reason>`（fail-open，回合照常继续）；allow 的 hook 无痕、stdout 不展示。denied/失败行带与工具行同款圆点                                                                                                                            | `crates/codegen/xai-grok-pager/src/acp/tracker.rs`（`WaitingReason::Hooks`）、`crates/codegen/xai-grok-pager/src/app/acp_handler/session_notification.rs`（`failed_hook_line`）、`crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md`                                       | 必刻 | ⬜（归存：P9 后另行排期——本仓 `packages/core/src` 无 hook 执行面（无 hooks 模块），hook 运行时状态行无从接线；`/hooks`（G-78 内）同归存） |
| G-94 | dashboard 头部与动作行 | Agent Dashboard 顶部**头部**显示新 agent 将运行的 git 分支 + 工作目录，右侧 ◆/⋮/◇ 状态计数 chips（与行同 glyph 同色）；点击位置或 `Ctrl+L` 换目录，dispatch 框里 `/cd <path>` 同效（`/cd` 仅 dashboard 可见）。其下**动作行**：`+ New Agent`（无选中行时的默认光标）、`Open Previous`（会话选择器，仅 workspace dashboard）、worktree 切换（`Ctrl+W`）；列表聚焦时 `→`/`←`（vim `l`/`h`）沿动作行移动光标到端点即停，`Enter` 等价点击，`Esc` 退回 `+ New Agent`；worktree 开启时标签变 `+ New Agent in Worktree` / `Disable Worktree` | `crates/codegen/xai-grok-pager/docs/user-guide/23-dashboard.md`、`crates/codegen/xai-grok-pager/src/slash/commands/cd.rs`、`crates/codegen/xai-grok-pager/src/views/dashboard/`                                                                                                    | 参考 | ⬜（归存：P9 后另行排期——无 agents dashboard（与 G-41/G-56 同因）；无 `/cd` 命令）                                                        |
| G-95 | 实验性 dock            | prompt 上方的**合并停靠区**（`dock_enabled` remote 门控，实验性）：Subagents / Tasks / Watchers / Queued 四区，每非空区一行 header（chevron + 标题 + 计数 + 横线）；行可内联展开并带右对齐 `[stop]` 按钮（含鼠标命中/悬停区域），Queued 区内嵌队列面板；静息高度上限 `MAX_DOCK_ROWS=8`，`show N more` 抬升上限；全零 dock 不渲染。补登记：dock 在旧基线已存在（`views/dock.rs`），本轮扩为 `dock/mod.rs` + `dock/layout.rs` 并大幅增强                                                                                                | `crates/codegen/xai-grok-pager/src/views/dock/mod.rs`、`crates/codegen/xai-grok-pager/src/views/dock/layout.rs`                                                                                                                                                                    | 参考 | ⬜（归存：P9 后另行排期——无 prompt 上方合并停靠区；队列 pane 走 G-29 独立面板，Tasks/Watchers 区无数据源）                                |

## 归存汇总（2026-09-14 P9）

本小节为硬规则 #2（每条 G-/D-/H- 编号必须有归存）在本文档的收口登记，供 `docs/issue-log/OPEN.md` 交叉引用。口径与 `docs/refs/README.md` §3 一致：已完成 = ✅（有证据）；部分完成待续 = 🟡（剩余部分有明确接收方或明确条件）；未排期 = ⬜（能力未实现、且不在本轮十阶段内）；不采纳 = ➖（含事实理由）。

### ① 已完成（✅ 44 条）

G-04 布局区域清单、G-08 焦点环、G-10 滚动粒度、G-13 终端能力依赖；G-14/G-15/G-17/G-18/G-19/G-20（Esc 语义表除 G-16 外全部，P2）；G-21/G-25（permission 卡与卡内焦点，P3）；G-26～G-30（队列/转向/中断全组，P3）；G-31/G-33/G-34/G-38/G-39（Agent 级键位中已接线者，P3/P3-F）；G-42～G-49（状态行契约全组，P3）；G-50/G-51/G-54/G-55/G-57～G-61/G-63/G-70/G-75/G-84/G-85（命令面已实现者：菜单机制、会话与历史主力命令、模式真开关、渲染模式切换、主题、doctor）。

### ② 部分完成待续（🟡 43 条）

- **G-1x 渲染与布局（5）**：G-01/G-02（minimal 实体切换仍为降级指引，待真机）、G-03（门控已落，`/dashboard` 等命令本身未实现）、G-05（folds 已接，配置面未落）、G-06（复制/全屏查看器部分接线）。
- **G-2x 输入与焦点（4）**：G-07（vim 模式未接）、G-09（`g`/`Shift+G` 未落）、G-11（`{!cmd}` 多行未落）、G-12（真机透传待验）。
- **G-4x 卡片（3）**：G-22/G-23/G-24——渲染层与优先级已落，**均缺真实来源**（取消直连 Esc/Ctrl+C、`ask_user_question` 未提供、MCP elicitation 通道未实现）。
- **G-6x Agent 键位（6）**：G-32/G-35/G-36/G-37/G-40/G-41——键位已在 `tui/input/keymaps.ts` 的 `AGENT_CHORD_TABLE` 登记占用，动作无落点（模型选择器、todos/tasks 数据源、extensions 模态、TaskCoordinator、设置面板、多 agent dashboard）。
- **G-8x 命令面（25）**：G-52/G-53（技能升命令、限定名）、G-56（dashboard）、G-62/G-64/G-65/G-66/G-67（copy/delete/rename/history/home）、G-68/G-69（model/effort）、G-71～G-74/G-76（plan/multiline/vim/compact-mode/edit-prompt/timestamps）、G-77～G-82（memory 子系/extensions 模态/loop/goal/workflow/deep-research）、G-86～G-89（docs/settings/mcps 组/btw+feedback）。

**接收方口径（P9 统一）**：以上 43 条的剩余部分**均归「P9 后另行排期」**——P3 时期写的「下放 P7」随 P7 结束而悬空，P9 按事实重述：核心能力未实现（非被否决），启动前须按 `docs/refs/README.md` §2 重新拉取上游判定过期。

**待同步项（不阻塞）**：`packages/cli/src/tui/input/keymaps.ts` 内 `AGENT_CHORD_TABLE` 的 `note` 仍写「归存 P7」（P3-F 产物）；文档口径以本节为准，代码注释待下次动键位时同步（本批只改三份 refs 文档，未动 `keymaps.ts` 与 `OPEN.md`，建议由编排者在 OPEN.md 补登记一行）。

### ③ 未排期（⬜ 5 条）

G-91 鼠标上报开关（`Ctrl+R` 与 G-34 撞位待裁决）、G-92 `terminal` 原生主题（主题系统已落，缺此第六主题）、G-93 hook 运行时状态面（本仓无 hook 执行模块）、G-94 dashboard 头部与动作行、G-95 实验性 dock。五条均属「基线刷新新增条目」（G-92 宿主面存在但该主题未落），整批未开工——计划文件旧注「属下一批 P4+」已失真，P4～P8 均未承接。

### ④ 不采纳（➖ 3 条）

G-16 取消中重发取消（上游已移除该路径）、G-83 `/imagine` `/imagine-video`（依赖 xAI 多模态端点）、G-90 `/login` `/logout` `/usage` `/privacy` `/import-claude`（绑定 xAI 账号与计费体系）。理由同「不采纳清单」。

### ⑤ 待人类决策（0 条）

本文档无待拍板条目（CLI 交互为「完全复刻」口径，不存在范围拍板）。

## 与 harness2 当前实现的差距

> **口径提示（2026-09-14 P9）**：下表为 2026-09-13 首版快照（P2 之前），**未随 P2～P8 实施结果刷新**（例如双渲染模式基座、palette、卡片层、队列面板、状态行、主题均已落地）。本表刷新归存「P9 后另行排期」，当前判断以各条目表状态列为准，不以本表为准。

| 维度       | harness2 现状（`packages/cli`）                                                                                                                                     | 目标                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 渲染模式   | 单一全屏，无 minimal 模式                                                                                                                                           | G-01～G-03 双模式                  |
| 斜杠命令   | 13 条（`/new` `/sessions` `/resume` `/fork` `/undo` `/redo` `/help` `/exit` `/mode` `/context` `/compact` `/reasoning` `/tasks`）                                   | G-54～G-90（数十条，含分组与别名） |
| 命令发现   | 前缀补全，无 palette、无 badge、无模糊匹配                                                                                                                          | G-31、G-50～G-53                   |
| 焦点与 Esc | 2026-09-13 P2 已接线：焦点环、Esc 新规格（永不取消/双击 stash/宽限/rewind picker）、Ctrl+S stash（对齐上游 StashPrompt）；历史：无焦点环、无双击 Esc 语义、无 stash | G-07～G-08、G-14～G-20             |
| 阻塞卡片   | 无统一卡片层与优先级                                                                                                                                                | G-21～G-25                         |
| 队列/转向  | 有 steer 内核，但无队列面板、无 send-now 和弦                                                                                                                       | G-26～G-30                         |
| 状态行     | 无                                                                                                                                                                  | G-42～G-49                         |
| 主题       | 无主题系统                                                                                                                                                          | G-84、G-92                         |

## 不采纳清单

| 项                                                                                                                                             | 理由                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/login` `/logout` `/usage` `/privacy`                                                                                                         | 绑定 xAI 账号与计费体系，本项目用本地/自定义网关                                                         |
| `/imagine` `/imagine-video`                                                                                                                    | 依赖 xAI 多模态端点，与当前目标无关                                                                      |
| `/import-claude`                                                                                                                               | 导入特定竞品配置，无需求                                                                                 |
| `/voice`（`voice/`）                                                                                                                           | 语音链路，本轮不做，后续可重评                                                                           |
| DotSlash / `protoc` 链路                                                                                                                       | Rust 构建体系专有                                                                                        |
| Grove 体系（`cli.grove_worktree` / `grok clone` / `grove` daemon）                                                                             | xAI 基础设施专有（NFS/FUSE 挂载、独立凭证域），harness2 用原生 git worktree（2026-09-13 登记于基线刷新） |
| 组织策略层（`requirements.toml` / `managed_config.toml` / Claude `managed-settings.json`、`marketplace.require_sha`、`grok inspect` 策略区块） | 企业分发专有，单机项目无管控面需求（2026-09-13 登记于基线刷新）                                          |

## 本轮更新记录

| 日期       | 执行者                        | 上游 commit | 变更摘要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-13 | 编排会话（Notion AI）         | `72a61251`  | 首版：建立 G-01～G-90 复刻矩阵，含双渲染模式、Esc 语义表、阻塞卡片优先级、队列/转向、状态行契约、斜杠命令全集                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-13 | 开发子代理 P0-A（编排者派工） | `37949780`  | 基线刷新 `72a61251`→`37949780`（上游 8 天 2 个 monorepo 同步提交）：Esc 语义大改——回合中 Esc 永不取消、改弹 `Ctrl+C` 提示、取消中吞掉并废除重发路径（修正 G-14/G-15、➖ G-16，G-19 宽限期改由 mid-turn Esc 武装）；会话选择器 `F3`→`Ctrl+R`（修正 G-34）；vim `J`/`K` 改视口顶 turn 跳转（修正 G-09）；`/loop` 触发改独立后台子代理（修正 G-79）；`/theme` 键入别名过滤（修正 G-84）；`/feedback` 重写为独立模态+模型回合（修正 G-89）；`G-38` 补「唯一取消键」；新增 G-91 鼠标上报开关（补登记）、G-92 Terminal 原生主题、G-93 hook 运行时状态面、G-94 dashboard 头部/动作行、G-95 实验性 dock（补登记）；G-90 补注 `/usage` 会话内模态（维持不采纳）；不采纳清单补 Grove 体系与组织策略层；`SOURCE_REV` 更新为 `c4ea71cf` |
| 2026-09-14 | 编排会话（P9 收口 A）         | `37949780`  | **硬规则 #2 收口：G-91～G-95 补归存（原理由只在计划文件的「属下一批 P4+」已失真）+ 43 条 🟡 逐条重述（P3 时期「下放 P7」随 P7 结束悬空，统一改「P9 后另行排期」并写明已落部分/剩余部分）**；新增「归存汇总（2026-09-14 P9）」小节（✅44 · 🟡43 · ⬜5 · ➖3，合计 95）；索引摘要表按正文实际统计重算（旧表「合计 ⬜92 · ➖3」→ 新表 44 ✅ · 43 🟡 · 5 ⬜ · 3 ➖）；补「差距表为 P2 前快照」口径提示；登记代码侧 `keymaps.ts` 的 `AGENT_CHORD_TABLE` note 仍写「归存 P7」待同步。**状态符号无变更**（G-91～G-95 维持 ⬜ + 归存说明，不虚标 ✅）                                                                                                                                                                               |
