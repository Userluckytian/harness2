# refs-grok-build —— CLI 交互完全复刻规格

> 定位：**CLI 交互的权威规格。复刻等级默认「必刻」**（逐键位、逐文案、逐状态）。
> 本项目 CLI 出现的任何交互，都必须能在本文找到 `G-*` 编号。

## 分析基线

| 项目         | 值                                         |
| ------------ | ------------------------------------------ |
| 本地路径     | `D:/AI_Projects/refs/grok-build`           |
| 远程         | `https://github.com/xai-org/grok-build`    |
| 分析 commit  | `72a61251`                                 |
| 上游提交时间 | `2026-09-01T22:20:33Z`                     |
| 分支         | `main`                                     |
| `SOURCE_REV` | `a549186d9d39311f2d3ee4208db62af8c65aa476` |
| 分析日期     | 2026-09-13                                 |
| 分析者       | 编排会话（Notion AI）                      |

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

## G-1x 渲染模式与布局区域

| ID   | 条目         | 行为要点                                                                                                                                                                 | 等级 | 状态 |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- |
| G-01 | 双渲染模式   | `fullscreen`（默认，接管屏幕）与 `minimal`（原生 scrollback，不接管屏幕）两套完整 UI                                                                                     | 必刻 | ⬜   |
| G-02 | 进程内切模式 | `/minimal` / `/fullscreen`（`/full`）当场切换不重启；配置 `[ui] screen_mode`；`GROK_SCREEN_MODE_SWITCH=exec` 改为重执行                                                  | 必刻 | ⬜   |
| G-03 | 模式限定命令 | 仅 fullscreen：`/find` `/jump` `/timeline` `/theme` `/tutorial` `/dashboard`；仅 minimal：`/expand`；`/workflow runs` 在 minimal 降级为纯文本                            | 必刻 | ⬜   |
| G-04 | 布局区域清单 | scrollback（主区）· prompt（输入）· status line（可选）· shortcuts bar（焦点提示）· queue pane · todos pane · tasks pane · overlay modal（命令面板/模型/会话/扩展/设置） | 必刻 | ⬜   |
| G-05 | 块折叠与视图 | `h`/`l`（或 `←`/`→`）折叠展开·`e` 切折叠·`Shift+E` 全展·`Ctrl+E` thinking 块·`r` 原始 markdown；`[scrollback.scroll] respect_manual_folds` 控制自动折叠是否覆盖手动折叠  | 必刻 | ⬜   |
| G-06 | 块内容操作   | `y` 复制正文·`Shift+Y` 复制含元数据·`Enter` / `Ctrl+F` 全屏查看器                                                                                                        | 必刻 | ⬜   |

## G-2x 输入与焦点模型

| ID   | 条目         | 行为要点                                                                                                                    | 等级 | 状态 |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| G-07 | 两种输入模式 | `simple`（默认）与 `vim`（`[ui].vim_mode` 或 `/vim-mode`）；两套键位表并行存在                                              | 必刻 | ⬜   |
| G-08 | 焦点环       | `Tab` 在 prompt / scrollback 间切换；simple 下 `Space` 亦可，vim 下 `i` 回输入；**`Esc` 不是焦点键**                        | 必刻 | ⬜   |
| G-09 | 导航键位     | `j`/`k` ↔ `↓`/`↑`·`Shift+L`/`Shift+H` ↔ `Shift+→`/`Shift+←`（按 turn）·`Shift+J`/`Shift+K`（按助手回复）·`g`/`Shift+G` 首尾 | 必刻 | ⬜   |
| G-10 | 滚动粒度     | `Ctrl+K`/`Ctrl+J` 行滚动·`PageUp`/`PageDown` 整页·`Ctrl+U`/`Ctrl+D` 半页                                                    | 必刻 | ⬜   |
| G-11 | Shell 模式   | 行首 `!` 进入 shell 模式直接执行命令                                                                                        | 必刻 | ⬜   |
| G-12 | 图片粘贴     | Windows 用 **`Alt+V`**（`Ctrl+V` 被终端占）；Linux 区分 PRIMARY / CLIPBOARD，`Shift+Insert` 走 PRIMARY；拖拽亦可            | 必刻 | ⬜   |
| G-13 | 终端能力依赖 | WezTerm 需 `enable_kitty_keyboard = true` 才能收到全量和弦；终端族差异在 `21-terminal-support.md`                           | 必刻 | ⬜   |

## G-3x Esc 语义状态表（最易做成半成品的一块，逐行复刻）

| ID   | 场景                         | 行为                                                             | 等级 | 状态 |
| ---- | ---------------------------- | ---------------------------------------------------------------- | ---- | ---- |
| G-14 | 回合运行中（非 vim）         | `Esc` 立即取消当前回合，**保留草稿**                             | 必刻 | ⬜   |
| G-15 | fullscreen + vim             | `Esc` 为 no-op（留给 vim 模式），取消用 `Ctrl+C`                 | 必刻 | ⬜   |
| G-16 | 正在取消中                   | 再按 `Esc` 重发取消（硬中断）                                    | 必刻 | ⬜   |
| G-17 | 空闲 + 草稿非空              | **800ms 内双击 `Esc`** 清空草稿并 stash；`Ctrl+S` / `Alt+S` 恢复 | 必刻 | ⬜   |
| G-18 | 空闲 + 草稿为空 + 有历史消息 | 双击 `Esc` 打开 rewind picker                                    | 必刻 | ⬜   |
| G-19 | 取消后宽限期                 | 取消后约 **1 秒** grace 内不武装 rewind（避免误开 picker）       | 必刻 | ⬜   |
| G-20 | 阻塞卡片打开时               | `Esc` 逐级退出卡片，退到最后把焦点 park 到 scrollback 并给提示   | 必刻 | ⬜   |

## G-4x 阻塞卡片（四件套）

| ID   | 卡片              | 来源                     | 交互                                         | 等级 | 状态 |
| ---- | ----------------- | ------------------------ | -------------------------------------------- | ---- | ---- |
| G-21 | permission prompt | 工具/命令权限请求        | 优先级最高，遮盖其他卡片                     | 必刻 | ⬜   |
| G-22 | cancel-turn panel | 取消确认                 | 优先级次于 permission                        | 必刻 | ⬜   |
| G-23 | question card     | `ask_user_question` 工具 | 选项 + 自由文本                              | 必刻 | ⬜   |
| G-24 | MCP elicitation   | `x.ai/mcp/elicit`        | 优先级最低                                   | 必刻 | ⬜   |
| G-25 | 卡片内焦点        | 四类共用                 | `Tab` / `Shift+Tab` 卡内环走（不泄漏到全局） | 必刻 | ⬜   |

优先级固定：`permission > cancel-turn > question > elicitation`。

## G-5x 运行中回合（队列 / 转向）

| ID   | 条目           | 行为要点                                                                                                | 等级 | 状态 |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------- | ---- | ---- |
| G-26 | 普通 Enter     | 回合运行中 `Enter` **入队**（不打断）；`[ui].follow_up_behavior = queue \| steer` 切换为队列或实时转向  | 必刻 | ⬜   |
| G-27 | 空输入再 Enter | composer 为空时再 `Enter` 发送队首一条                                                                  | 必刻 | ⬜   |
| G-28 | send-now 和弦  | `Ctrl+Enter` / `Ctrl+I` = **取消当前回合并立即发送**；Apple Terminal 用 `Ctrl+O`，VS Code 族用 `Ctrl+L` | 必刻 | ⬜   |
| G-29 | 队列面板       | `Ctrl+;`（备用 `Ctrl+'`，macOS VS Code 系 `Ctrl+4`）打开；`↑` 在队列/历史间转焦点                       | 必刻 | ⬜   |
| G-30 | 阻塞等待中     | 卡片等待时 `Enter` 直送（不入队）                                                                       | 必刻 | ⬜   |

## G-6x Agent 级键位

| ID   | 键位                | 功能                                                                         | 等级 | 状态 |
| ---- | ------------------- | ---------------------------------------------------------------------------- | ---- | ---- |
| G-31 | `Ctrl+P` / `?`      | 命令面板（palette）                                                          | 必刻 | ⬜   |
| G-32 | `Ctrl+M`            | 模型选择器；**prompt 聚焦时改为多行切换**（双语义）                          | 必刻 | ⬜   |
| G-33 | `Shift+Tab`         | 模式循环 Normal → Plan → Auto → Always-approve；`Ctrl+O` 直切 always-approve | 必刻 | ⬜   |
| G-34 | `F3`                | 会话选择器                                                                   | 必刻 | ⬜   |
| G-35 | `Ctrl+T` / `Ctrl+G` | todos 面板 / tasks 面板（minimal 下 `Ctrl+G` 改为外部编辑器）                | 必刻 | ⬜   |
| G-36 | `Ctrl+L`            | extensions 模态（VS Code 族下改为 interject）                                | 必刻 | ⬜   |
| G-37 | `Ctrl+B`            | 当前回合转后台                                                               | 必刻 | ⬜   |
| G-38 | `Ctrl+C`            | 取消/退出（与 Esc 语义不同，见 G-14～G-19）                                  | 必刻 | ⬜   |
| G-39 | `Ctrl+.` / `Ctrl+X` | 快捷键帮助                                                                   | 必刻 | ⬜   |
| G-40 | `F2` / `Ctrl+,`     | 设置面板                                                                     | 必刻 | ⬜   |
| G-41 | `Ctrl+\`            | agents dashboard（`GROK_AGENT_DASHBOARD=0` 可关）                            | 参考 | ⬜   |

## G-7x 状态行契约（`[ui.status_line]`）

| ID   | 条目       | 行为要点                                                                                                                                                                            | 等级 | 状态 |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| G-42 | 三种类型   | `type = builtin / command / disabled`，默认 `disabled`（`off` `none` `hidden` 同义）                                                                                                | 必刻 | ⬜   |
| G-43 | builtin 项 | `items` 默认 `[cwd, model, context]`；可选 `cost`（低于 $0.005 隐藏）、`turn-timer`、`session-name`                                                                                 | 必刻 | ⬜   |
| G-44 | 省略规则   | 目录与会话名在 40 列以下省略；模型名在 30 列以下省略                                                                                                                                | 必刻 | ⬜   |
| G-45 | command 型 | 外部命令走 stdin JSON：`workspace.repo_root`、`context_window.context_tokens`、`context_window.session_usage`、`transcript_path`、`prompt_id`、`trigger = state / refresh_interval` | 必刻 | ⬜   |
| G-46 | 刷新策略   | 事件驱动 + 300ms 防抖（紧急 100ms）；`refresh_interval` 1–86400 秒；`padding` 上限 16                                                                                               | 必刻 | ⬜   |
| G-47 | 输出限额   | 最多 5 行、每行 1024 字符、stdout 超 64KiB 截断、超时 10s 显示 `[status line: timed out]`                                                                                           | 必刻 | ⬜   |
| G-48 | 失败降级   | 失败写 `~/.grok/logs/unified.jsonl`；**连续三次失败**才在状态行画错误                                                                                                               | 必刻 | ⬜   |
| G-49 | 子进程环境 | `COLUMNS` / `LINES` 给的是状态行自身尺寸；`GIT_OPTIONAL_LOCKS=0`；清空 `BASH_ENV` / `ENV`                                                                                           | 必刻 | ⬜   |

## G-8x 斜杠命令全集（依据 `04-slash-commands.md`）

基础机制（均必刻）：

| ID   | 条目         | 行为要点                                                              | 状态 |
| ---- | ------------ | --------------------------------------------------------------------- | ---- |
| G-50 | 命令来源分裂 | shell builtins 与 pager builtins 两类，**合并进同一个菜单**，模糊匹配 | ⬜   |
| G-51 | 菜单行为     | 输入 `/` 弹菜单，模糊筛选，回车直执行                                 | ⬜   |
| G-52 | 技能升为命令 | skill 可声明 `user-invocable`，自动出现在菜单                         | ⬜   |
| G-53 | 名字冲突     | 冲突时用 `/plugin-name:login` 形式限定，并在菜单打 badge 区分来源     | ⬜   |

### 会话与历史

| ID   | 命令                                            | 要点                                                                         | 等级 | 状态 |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ---- | ---- |
| G-54 | `/new`（`/clear`）                              | 新会话                                                                       | 必刻 | ⬜   |
| G-55 | `/resume`                                       | 恢复会话选择器                                                               | 必刻 | ⬜   |
| G-56 | `/dashboard`（`/agents-dashboard` `/sessions`） | agents 仪表盘，`Ctrl+\` 开，仅 fullscreen                                    | 参考 | ⬜   |
| G-57 | `/compact [说明]`                               | 人工压缩；**自动压缩阈值 85%**（`[session] auto_compact_threshold_percent`） | 必刻 | ⬜   |
| G-58 | `/context`                                      | 上下文分类占用明细                                                           | 必刻 | ⬜   |
| G-59 | `/session-info`（`/status` `/info`）            | 会话详情；`c` 复制会话 id，`y` 复制整块                                      | 必刻 | ⬜   |
| G-60 | `/fork`                                         | 分叉会话                                                                     | 必刻 | ⬜   |
| G-61 | `/rewind`（`/undo`）                            | 回退选择器（与双击 Esc 同入口，见 G-18）                                     | 必刻 | ⬜   |
| G-62 | `/copy [n 或 path]`                             | 复制回复；备份到 `~/.grok/last-copy.txt`，`GROK_COPY_FILE` 可改              | 必刻 | ⬜   |
| G-63 | `/export`                                       | 导出会话                                                                     | 必刻 | ⬜   |
| G-64 | `/delete`                                       | 删会话；选择器内 `d` 后 `y` 确认，仪表盘 `Ctrl+X` 两次                       | 必刻 | ⬜   |
| G-65 | `/rename`（`/title`）                           | 重命名，支持 `--auto`                                                        | 必刻 | ⬜   |
| G-66 | `/history`                                      | 历史浏览                                                                     | 必刻 | ⬜   |
| G-67 | `/home`（`/welcome`） · `/quit`（`/exit`）      | 首屏与退出                                                                   | 必刻 | ⬜   |

### 模型与模式

| ID   | 命令                            | 要点                                                   | 等级 | 状态 |
| ---- | ------------------------------- | ------------------------------------------------------ | ---- | ---- |
| G-68 | `/model`（`/m`）                | 模型选择器，可带 effort 参数                           | 必刻 | ⬜   |
| G-69 | `/effort low/medium/high/xhigh` | 推理强度（按模型能力）                                 | 必刻 | ⬜   |
| G-70 | `/auto` · `/always-approve`     | **真开关**（非一次性命令），与 `Shift+Tab` 循环同源    | 必刻 | ⬜   |
| G-71 | `/plan [描述]` · `/view-plan`   | 计划模式与计划查看（`/show-plan` `/plan-view`）        | 必刻 | ⬜   |
| G-72 | `/multiline`（`/ml`）           | 多行输入开关                                           | 必刻 | ⬜   |
| G-73 | `/vim-mode` · `/compact-mode`   | 输入模式与紧凑渲染                                     | 必刻 | ⬜   |
| G-74 | `/edit-prompt`                  | 外部编辑器写 prompt，顺序 `$VISUAL` → `$EDITOR` → `vi` | 必刻 | ⬜   |
| G-75 | `/minimal` · `/fullscreen`      | 渲染模式切换（见 G-02）                                | 必刻 | ⬜   |
| G-76 | `/timestamps`                   | 时间戳显示开关                                         | 必刻 | ⬜   |

### 记忆 · 扩展 · 调度 · 其他

| ID   | 命令                                                                                                    | 要点                                                                                                                              | 等级   | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| G-77 | `/memory`（`/mem` on/off） · `/remember` · `/flush` · `/dream`                                          | 记忆子系；需 `GROK_MEMORY=1` 或 `[memory] enabled`                                                                                | 补齐   | ⬜   |
| G-78 | `/hooks` `/plugins` `/marketplace` `/skills` `/workflows`                                               | **同一个 extensions 模态的 5 个 tab**（不是 5 个独立窗口）                                                                        | 必刻   | ⬜   |
| G-79 | `/loop [间隔] <prompt>`                                                                                 | 定时自循环；间隔 `Ns`（≥60）/`Nm`/`Nh`/`Nd`，7 天过期                                                                             | 补齐   | ⬜   |
| G-80 | `/goal <目标> [--budget tokens]` + `status/pause/resume/clear`                                          | 长期目标与预算                                                                                                                    | 补齐   | ⬜   |
| G-81 | `/workflow <name>` + `runs/pause/resume/stop/save`                                                      | `.grok/workflows/*.rhai` 与 `~/.grok/workflows/*.rhai`；`agent_budget` 默认 128、范围 1–1024、并发上限 32；详情页 `p`/`r`/`x`/`s` | 补齐   | ⬜   |
| G-82 | `/deep-research <query>`                                                                                | 深度研究流                                                                                                                        | 补齐   | ⬜   |
| G-83 | `/imagine` · `/imagine-video`                                                                           | 图像/视频生成                                                                                                                     | 不采纳 | ➖   |
| G-84 | `/theme`（`/t`）                                                                                        | 主题切换（仅 fullscreen）                                                                                                         | 必刻   | ⬜   |
| G-85 | `/doctor [fix]`                                                                                         | 终端自检；别名 `/terminal-setup` `/terminal-check` `/terminal-info`                                                               | 必刻   | ⬜   |
| G-86 | `/docs`（`/howto` `/guides`） · `/tutorial`（`/tour` `/onboarding`） · `/release-notes`（`/changelog`） | 内置文档与引导                                                                                                                    | 参考   | ⬜   |
| G-87 | `/settings`（`/config` `/preferences` `/prefs`）                                                        | 设置面板（与 `F2` 同源）                                                                                                          | 必刻   | ⬜   |
| G-88 | `/mcps` · `/config-agents`（`/agents`） · `/personas`                                                   | MCP 与子代理/人格配置                                                                                                             | 补齐   | ⬜   |
| G-89 | `/btw` · `/feedback`                                                                                    | 旁路输入与反馈                                                                                                                    | 参考   | ⬜   |
| G-90 | `/login` `/logout` `/usage`（`/cost`） `/privacy` `/import-claude`                                      | xAI 账号/计费/导入专有                                                                                                            | 不采纳 | ➖   |

## 与 harness2 当前实现的差距

| 维度       | harness2 现状（`packages/cli`）                                                                                                   | 目标                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 渲染模式   | 单一 Ink 全屏，无 minimal 模式                                                                                                    | G-01～G-03 双模式                  |
| 斜杠命令   | 13 条（`/new` `/sessions` `/resume` `/fork` `/undo` `/redo` `/help` `/exit` `/mode` `/context` `/compact` `/reasoning` `/tasks`） | G-54～G-90（数十条，含分组与别名） |
| 命令发现   | 前缀补全，无 palette、无 badge、无模糊匹配                                                                                        | G-31、G-50～G-53                   |
| 焦点与 Esc | 无焦点环、无双击 Esc 语义、无 stash                                                                                               | G-07～G-08、G-14～G-20             |
| 阻塞卡片   | 无统一卡片层与优先级                                                                                                              | G-21～G-25                         |
| 队列/转向  | 有 steer 内核，但无队列面板、无 send-now 和弦                                                                                     | G-26～G-30                         |
| 状态行     | 无                                                                                                                                | G-42～G-49                         |
| 主题       | 无主题系统                                                                                                                        | G-84                               |

## 不采纳清单

| 项                                     | 理由                                             |
| -------------------------------------- | ------------------------------------------------ |
| `/login` `/logout` `/usage` `/privacy` | 绑定 xAI 账号与计费体系，本项目用本地/自定义网关 |
| `/imagine` `/imagine-video`            | 依赖 xAI 多模态端点，与当前目标无关              |
| `/import-claude`                       | 导入特定竞品配置，无需求                         |
| `/voice`（`voice/`）                   | 语音链路，本轮不做，后续可重评                   |
| DotSlash / `protoc` 链路               | Rust 构建体系专有                                |

## 本轮更新记录

| 日期       | 执行者                | 上游 commit | 变更摘要                                                                                                      |
| ---------- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-09-13 | 编排会话（Notion AI） | `72a61251`  | 首版：建立 G-01～G-90 复刻矩阵，含双渲染模式、Esc 语义表、阻塞卡片优先级、队列/转向、状态行契约、斜杠命令全集 |
