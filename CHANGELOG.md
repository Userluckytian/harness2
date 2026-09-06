# Changelog

本文件记录面向使用者的显著变更。发布素材源自 `docs/diary/`（每日日志的 Release note 段）。

## 0.6.0 — M3「连接外部」（2026-09-06，代码就绪；发布待授权）

M3 里程碑（Ph8–Ph10）达成：在 M1「CLI 可用」+ M2「桌面可用」的能力累积上（流式对话/工具/undo/轨迹/记忆/压缩/浏览器/cron/桌面多会话），接通外部生态——插件、MCP、子代理、QQ/飞书机器人、轨迹资产化与 Skills。版本号沿用总控计划的里程碑编号（无 0.4/0.5 独立发布）。

### 阶段 11 稳定化 + 分发

- **行为变化（显著声明）**：CLI 侧子会话不再继承 memory/browser 工具——子会话语义统一到 serve 口径（子会话 = 隔离工作空间，per-session 绑定类工具不继承）；同时子会话新增「[Skills 可用]」列表注入（与宿主同一 skills 目录，加性能力）。
- **新增 `harness2 doctor`**：环境自检分节报告（node 版本 / config+auth 脱敏 / 目录可写 / MCP 探测 `--probe` / 会话库完整性 / skills 摘要）；崩溃报告本地落盘 `~/.harness2/crash/`（内容脱敏）——**无遥测零自动上报**，需要反馈时手动提供报告文件。
- **回放安全**：`harness2 replay` 增加解压总体积上限（默认 256 MiB，超限友好报错）。
- **性能基线达标声明**：10 万事件合成日志基准下全部操作 <3s（实测 <1.5s），不做性能优化；预算表见 architecture.md「性能预算」节，可 `pnpm bench` 复跑。
- **三平台桌面包**：CI 构建矩阵补齐 mac dmg（arm64+x64）与 linux AppImage（win nsis 已有），全部 unsigned；产物附加到 GitHub Release。

### 轨迹导出与回放（阶段 10）

- `harness2 export <会话目录> [-o <zip>]`：只读打包会话轨迹为 ZIP——主日志 `session.v1.jsonl` 必含，`rewind_points.jsonl`、`snapshots/` 存在即含，**子代理会话**（全库扫描 `header.parentSession` 匹配）递归入 `subagents/<id>/`；默认输出 `<当前目录>/<sessionId>.zip`。固定条目时间戳，同目录同内容两次导出得到逐字节相同的 zip（幂等）。
- `harness2 replay <zip>`：回放校验——逐事件解析（坏行计数与明细告警）+ 投影摘要（events/messages/lastSeq）；空包/非 harness2 导出 exit 1。**CI 零 key 可跑：轨迹即测试夹具**。
- 导出全程只读：不修改会话目录任何文件；目录锁等进程状态永不入包。

### 项目级 Skills（阶段 10）

- 文本指令型 skill：markdown + YAML 简表 frontmatter（`name`/`description` 必填），**无可执行脚本**。
- 两级目录：项目 `.harness2/skills/` 优先于全局 `~/.harness2/skills/`（同名项目覆盖 + 告警）；上限 50 个；坏文件跳过 + 告警。`harness2 skill list` 查看合并后的列表。
- 注入模型：每个 turn 从磁盘重扫，仅「[Skills 可用] 名称: 描述」列表追加进 system（同一 turn 内冻结）；**全文经 `skill` 工具按需加载**（现读磁盘），不占 system 预算。
- `harness2 skill list`：展示两级扫描合并结果（来源标注 project/global + 覆盖告警）。

### 插件 / MCP / 子代理（阶段 8）

- **插件总线**：manifest 声明式权限 + 装载审批（`harness2 plugin list/enable/disable`，allow 名单入全局 config）+ disposer 逆序展开 + 事件总线；v1 与主进程同进程运行（非隔离，如实声明）。
- **MCP**：官方 SDK，stdio 与 Streamable HTTP 双传输，工具以 `mcp__<server>__<tool>` 命名空间接入；断线退避重启（上限 3），单 server 故障不拖垮主进程；`harness2 mcp list` 连接探测。
- **Subagent**：`subagent_start` / `subagent_continue` 工具派发独立子会话（完整 runTurn、零新增事件类型）；深度上限（默认 1）、父取消传播、审批上抛同缝、独立文件快照；桌面端可跳转子会话轨迹。

### QQ / 飞书机器人网关（阶段 9）

- `harness2 gateway`：把 QQ / 飞书消息桥接到本地 serve。QQ 官方 Bot API v2（WS+REST、断线重连重订阅、msg_seq 递增、429 退避、重推去重）；飞书 webhook 挑战 + im/v1 出站。
- 每 chat 串行、频率限制队列、回复式审批（allow/deny 按钮语义）、三态私聊/群策略（open/allowlist/disabled，缺省 allowlist 防滥用）。
- 凭据只存 `auth.json.gateways` 或环境变量；**真机联调待用户开放平台凭据**。

### M1/M2 能力累积概述

M3 发布包含此前全部里程碑能力：M1（v0.1）事件溯源会话内核、流式 chat、工具执行、`/undo` `/redo`、轨迹可查、审批策略、双协议 Provider；M2（v0.3）桌面多会话并行/分屏拖拽/审批按钮、记忆三态、上下文压缩、浏览器工具、定时任务、serve 信任域加固。完整清单见下节与 `docs/ROADMAP.md`。

## 0.3.0 — M2「桌面可用」（2026-09-06，代码就绪；发布待授权）

桌面端第一版 + 三大件。版本号沿用总控计划的里程碑编号（无 0.2 独立发布）。

### 桌面端（Electron，Windows 安装包）

- **多会话并行**：会话内核独立进程（`harness2 serve`，仅 127.0.0.1，端口锁防双实例）；切换会话不断流——后台会话只记事件不渲染，切回时从事件日志快速重放。
- **分屏与拖拽**：1/2/3 分栏，从会话列表拖拽绑定会话；布局持久化（`~/.harness2/desktop-layout.json`）；分栏外会话显示未读徽标。
- **审批按钮**：工具 ask 请求在桌面端以 允许/拒绝 按钮处理（120s 超时按拒绝）。
- 打包：nsis 安装包（unsigned）；服务随应用 spawn/断线退避重启/自动重启上限。

### 上下文压缩

- 长会话超模型窗口 75% 时自动以小模型（`roles.small`）生成对话摘要；`compaction/applied` 事件落盘、可从日志重建（不变量延伸到压缩）；最近 6 条消息始终保留原文；摘要失败自动跳过不中断对话。

### 浏览器工具（agent 可用，需先 `harness2 browser install`）

- `browser_navigate / click / type / snapshot / screenshot / close`（Playwright chromium，headless；ref 引用而非裸 selector）。
- 资源管控：每会话 1 个浏览器上下文、全局并发 2（超限排队）、空闲 5 分钟自动销毁、销毁/崩溃写入轨迹日志。
- 默认审批 ask（unsafe）；`config.browser.enabled=false` 可整体关闭。

### 定时任务

- `harness2 cron add "指令" --every 5m|--at "daily 09:00"`：任务即自然语言指令，到点在独立临时会话执行（复用主 agent 与全部工具），结果写 `~/.harness2/cron/history/`，serve 模式推送通知帧（桌面端后续接入展示）。
- 可靠性：跨进程 tick 文件锁、**先推进 next_run 再执行**（at-most-once，防崩溃连发）、连续 3 次失败自动熔断并标记 incident、上限 50 条；`cron list/remove/run/history` 全套命令。

### 安全加固（M2 发布前项）

- serve 信任域：Origin 白名单（file:// 与本地 http 源）、Host 必须为 `127.0.0.1:<端口>`（阻断 DNS rebinding 与网站探针）、WS 帧上限 1MiB；HTTP 与 WS upgrade 同规则。

### 其他

- 会话分叉（REPL `/fork`、`chat --fork`、服务 API）；记忆系统三态开关（详见 README 阶段 6 段）。
- `harness2 traj` 支持新事件类型（压缩/记忆快照/定时任务通知帧）。

## 0.1.0 — M1「CLI 可用」（2026-09-06）

首个可用版本：**终端里接真实模型干活**。npm 包 `harness2`（命令同名），内核包 `@harness2/core` 独立发布。

### 能力总览（三层）

**1. 事件溯源会话内核（@harness2/core）**

- append-only JSONL 事件日志（`session.v1.jsonl`，一行一个事件，代际字段 `v`）；单写者目录锁（陈旧锁接管）、写入即 fsync、崩溃残行「换行即提交」恢复。
- 事件类型 v1：`session/header` / `user/message` / `assistant/message` / `assistant/attempt`（失败尝试单独记录）/ `step/start` / `step/end` / `tool/call` / `tool/result` / `rewind/marker`。
- 投影语义：rewind 标记追溯遮蔽（影子事件保留可全量导出）；`redo` 标记链按 seq 精确中立化被重做的 undo 标记（n 级 undo/redo 自然成立）。
- 核心不变量：**Model-visible ⟺ logged**——发往模型的消息列表可从日志完整重建，无内存旁路。

**2. 轨迹与撤回**

- `harness2 traj <sessionDir>`：时间线渲染（turn/step/tool 树、耗时、token 用量、回退统计），`--json` 结构化输出，`--all` 含影子事件。
- `/undo [n] [--dry-run]` / `/redo`：undo = 投影截断 + 文件快照恢复；redo = 标记链复活 + 快照回放。全程只追加，永不回改日志。
- 独立文件快照（不依赖 git）：write/edit 工具执行前后 before/after 快照（键 = tool/call 事件 seq）；恢复按文件取最早 before / 最新 after；冲突检测（外部修改标记）与 dry-run 预览。
- **如实声明**：bash 命令造成的文件改动不进快照，/undo 无法恢复它。

**3. CLI + 配置 + 双协议 Provider**

- `harness2 chat`：交互式 REPL——流式渲染（text-delta 直写）、工具调用/结果单行、命令集（`/new` `/sessions [关键字]` `/resume` `/undo` `/redo` `/help` `/exit`）、审批内联交互（y 本次 / a 本会话总是 / n 拒绝）、Ctrl+C 取消当前 turn、`--provider mock` 零 key 演示。
- 会话管理：全局布局 `~/.harness2/sessions/<encoded-cwd>/<id>/`（按工作目录归组）；列表（mtime 倒序、首条消息摘要）、子串搜索、恢复续写。
- 配置体系：全局 `~/.harness2/config.json` + 项目 `.harness2/config.json` 两级深合并；JSONC 宽松解析；`${VAR}` 展开；key 只存 `~/.harness2/auth.json` 与环境变量，输出全链路脱敏。
- Provider：OpenAI-compatible（DeepSeek/智谱 GLM 等）与 Anthropic Messages 双协议，SSE 流式、工具调用增量组装、reasoning 字段、`harness2 config check` 脱敏体检。
- 审批策略：default / acceptEdits / bypass 三模式 + per-tool 规则（allow/ask/deny）。

### 质量与工程

- 248 个自动化测试（mock provider 全程，CI 零 API key）；typecheck 全绿。
- GitHub Actions：CI（三平台 matrix build+test）与 release workflow（tag 触发构建 + npm 发布，需配置 `NPM_TOKEN`）。
- Node ≥ 22；运行时零新增第三方依赖（CLI 仅 commander，内核仅 fast-glob/jsonc-parser）。

### 已知限制

- bash 副作用不进快照（见上）。
- 会话搜索为子串匹配（SQLite/FTS 在后续里程碑）。
- 分叉（fork）、/compact、桌面端、IM 网关未包含（见 `docs/ROADMAP.md`）。
