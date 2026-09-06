# Changelog

本文件记录面向使用者的显著变更。发布素材源自 `docs/diary/`（每日日志的 Release note 段）。

## 1.0.0 — M4「公开发布收口」（2026-09-07，代码就绪；发布待授权）

首个公开发布版本（0.1/0.3/0.6 均为「代码就绪；发布待授权」，从未实际发布到 npm，见 `docs/MIGRATION.md`）。**0.6 → 1.0 无破坏性变更、零迁移**（变更索引逐项引用提交号见 `docs/MIGRATION.md`）。

### 里程碑总述（M1 → M4）

- **M1「CLI 可用」（v0.1）**：事件溯源会话内核（append-only JSONL、单写者、Model-visible ⟺ logged）、agent loop 与工具系统（审批分级/并发波次）、undo/redo + 独立文件快照（不依赖 git）、chat REPL（流式/审批交互/会话管理）、双协议 Provider（OpenAI-compatible / Anthropic，SSE 流式 + 工具增量）、两级配置与密钥分离、`harness2 traj` 轨迹查看器。
- **M2「桌面可用」（v0.3）**：`harness2 serve` 服务化（HTTP 控制面 + WS 事件面、端口锁、信任域加固）、Electron 桌面端（多会话并行切换不断流/分屏拖拽/审批按钮/断线自动重启）、记忆三态（off/ask/auto + nudge 后台复盘 + pending 审批）、会话分叉、上下文压缩（75% 阈值 + 摘要可重建）、浏览器工具（Playwright + 资源管控）、定时任务（at-most-once + 熔断）。
- **M3「连接外部」（v0.6）**：插件总线（manifest 声明式权限 + 装载审批 + disposer 逆序展开）、MCP（官方 SDK，stdio/Streamable HTTP 双传输）、子代理（独立子会话跑完整 runTurn，深度限制/取消传播/独立快照）、QQ/飞书机器人网关（官方 Bot API v2 + 回复式审批）、轨迹导出/回放（ZIP 幂等 + 子代理递归 + 坏行容错）、项目级 Skills（两级目录 + system 列表注入 + 按需加载）；**阶段 11 稳定化**：性能预算（10 万事件全操作 <1.5s）、`harness2 doctor` + 崩溃报告本地落盘（无遥测）、三平台分发矩阵（win nsis / mac dmg / linux AppImage，unsigned）、子会话工具集口径统一（CLI 与 serve 一致）。
- **M4「公开发布收口」（本版）**：API 稳定承诺、迁移指南、文档站、发布回归汇总——见下节明细。

### 阶段 12 明细（M4）

- **API 稳定承诺**（`docs/API-STABILITY.md`）：1.0 起 semver 政策生效——breaking（删除/改名/声明种类变更）只进 major、加性（新增导出/可选字段）进 minor；`@harness2/core` 主入口 **372 个导出**经快照测试钉死（`packages/core/test/api-surface.test.ts`：加性不红、删除/改名/声明种类变更红 + 运行时导出交叉校验防漏报）；`@harness2/core/dist/...` 深路径不在发布映射内、不承诺。
- **迁移指南**（`docs/MIGRATION.md`）：0.6→1.0 零迁移（逐项引用 CHANGELOG 条目与提交号）；auth.json / config schema 演进索引（0.1 起全部加性，旧文件零修改可用）；0.1→0.6 历史变更速览。
- **文档站**：`docs/site/index.html` docsify CDN 零构建单页（README/architecture/API-STABILITY/MIGRATION/RELEASE-CHECKLIST/ROADMAP/HANDOFF/CHANGELOG）；CI 新增 `pages` job（GitHub Pages 部署，开启待仓库设置）。
- **发布回归汇总**（`docs/RELEASE-CHECKLIST.md`）：自动化覆盖声明（**615 项测试 = 614 passed + 1 skipped**、typecheck、bench 基线、API 快照、crash-drill、口径统一断言——命令级）+ 手工清单索引（13 域，逐项链接 OPEN.md）+ 发布动作 checklist（push/NPM_TOKEN/tag/Pages/包名占用）。
- **无运行时行为变更**：`packages/core/src/session/types.ts` 相对 0.6 零 diff；公开导出面零增删（快照基线即 1.0 面）；版本号与文档物料是本版主要产出。

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
