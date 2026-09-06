# harness2

<!-- 截图占位（待补，见 docs/issue-log/OPEN.md）：终端 chat 流式/工具行、桌面端多会话分屏、traj 时间线 -->

自研跨端 AI agent harness（CLI / 桌面 / IM 网关多形态）。**M1（v0.1）= 终端里接真实模型干活**：流式对话、读写文件、跑命令、`/undo` `/redo`、轨迹可查、审批可控。**M2（v0.3）= 桌面可用**：多会话并行分屏、上下文压缩、浏览器工具、定时任务。**M3（v0.6）= 连接外部**：插件 / MCP / 子代理、QQ/飞书机器人、轨迹导出回放、项目级 Skills。**M4（v1.0.0）= 公开发布收口**：API 稳定承诺（semver + 导出面快照）、迁移指南、文档站、发布回归汇总——首个公开发布版本（发布动作待授权，见 `docs/RELEASE-CHECKLIST.md`）。

- **新维护者/AI 入口：`docs/HANDOFF.md`**
- 路线图与功能清单：`docs/ROADMAP.md` · 变更记录：`CHANGELOG.md`
- API 稳定承诺：`docs/API-STABILITY.md` · 迁移指南：`docs/MIGRATION.md` · 发布回归汇总：`docs/RELEASE-CHECKLIST.md`
- 文档站：`docs/site/index.html`（docsify 零构建单页；GitHub Pages 开启后经 CI `pages` job 部署）
- 调研报告：`docs/research/` · 阶段计划：`docs/ai-framework/plans/`
- 每日日志：`docs/diary/`（发版 release note 素材来源）
- 问题日志：`docs/issue-log/`（OPEN.md 为未关闭事项索引）
- 协作规范：`AGENTS.md`（工作模式：编排者/子代理分工 + 阶段化计划驱动 + 提交前审查）

## 30 秒快速开始

```bash
# 1. 安装（发布授权后可用；当前可从仓库 pnpm install && pnpm build 自行构建）
npm i -g harness2

# 2. 体检配置：channels/roles/审批规则/key 来源（永不打印明文 key）
harness2 config check
#   报 **missing**？写入 ~/.harness2/auth.json：
#   { "channels": { "deepseek": { "apiKey": "sk-..." } } }

# 3. 配置 ~/.harness2/config.json（全局）或 <项目>/.harness2/config.json：
# {
#   "providers": { "deepseek": { "protocol": "openai",
#     "baseUrl": "https://api.deepseek.com/v1", "envKey": "DEEPSEEK_API_KEY" } },
#   "roles":    { "main": { "channel": "deepseek", "model": "deepseek-chat" } },
#   "approval": { "mode": "default" }
# }

# 4. 开聊（或先零 key 玩 mock 演示）
harness2 chat --provider mock   # 内置演示：写文件 + 读回，试试 /undo --dry-run、/undo、/redo
harness2 chat                   # 接真实模型（roles.main）
```

chat 内常用命令：`/new`、`/sessions [关键字]`、`/resume <id>`、`/fork [seq]`、`/undo [n] [--dry-run]`、`/redo`、`/exit`。
`/redo` 会恢复到撤销前状态，撤销之后新输入的消息将被移出当前上下文（仍保留在日志中，可用 `traj` 查看）。
审批 ask 提示中的 `[a] 本会话总是` = 该工具后续所有调用不再询问（仅进程内会话级缓存，不落盘）。
会话存储在 `~/.harness2/sessions/<工作目录编码>/<会话id>/`；`harness2 traj <会话目录>` 查看轨迹。

## 记忆与分叉（阶段 6）

- **记忆开关三态**（`config.json` 的 `"memory": {"mode": "off|ask|auto", "nudgeInterval": 10}`，缺省 `off`）：
  `auto` = 模型可直接把长期记忆写入 `~/.harness2/memories/MEMORY.md`（agent 笔记，2200 字符硬预算）与
  `USER.md`（用户画像，1375 字符硬预算），新会话开始时冻结注入；`ask` = 写入先进待审批暂存，用
  `harness2 memory pending` → `approve <id>` / `reject <id>` 处置（只延迟、不静默丢弃）；`off` = 模型完全
  看不到记忆工具、零读写。`harness2 memory show/clear` 管理现有记忆；手工改坏 `§` 条目结构会被
  漂移检测拒绝写入并自动备份 `.bak`。每 `nudgeInterval` 个用户 turn 会在后台用小模型复盘一次对话
  （不阻塞主对话；serve 模式下发 `nudge-started/finished` 提示帧）。
- **会话分叉**：REPL `/fork [seq]` 从当前会话派生新会话（`harness2 chat --fork <id> [--at <seq>]` 亦同），
  血缘记录在新会话 header（`parentSession`/`isSeeded`）。分叉 = 复制活动事件到新会话，原会话零改动；
  **新会话的 undo 从零开始（文件快照不随分叉复制）**，如需恢复文件请回到原会话操作。

## 如实声明（重要）

- **bash 副作用不进快照**：`/undo` 的文件恢复只覆盖 `write`/`edit` 工具的改动（before/after 文件快照）；bash 命令造成的文件改动**无法**通过 `/undo` 恢复。撤回/重做对对话历史的生效则不受影响（日志投影截断）。
- **密钥安全**：API key 只存 `~/.harness2/auth.json` 与环境变量；config、日志、错误消息出口统一脱敏，`config check` 永不打印明文。
- **Windows 注意**：建议 Windows Terminal / 最新 Node 22；piped 场景自动关闭颜色与终端回显；长行在部分终端的折行表现随终端而异。
- 会话搜索为子串匹配（SQLite/FTS 属后续里程碑）；`/undo` `/redo` 全程 append-only，只追加 rewind 标记，不回改会话日志。

## 开发

```bash
pnpm install
pnpm test          # build + 全量测试（mock provider，零 API key）
pnpm -r typecheck
node packages/cli/dist/index.js chat --provider mock   # 本地冒烟
```

结构：`packages/core`（会话内核 + agent loop + 工具系统 + Provider 缝，npm: `@harness2/core`）、`packages/cli`（npm: `harness2`）、`packages/desktop`、`packages/gateway`（QQ/飞书 IM 网关）。

## License

MIT

## 浏览器与定时任务（阶段 7）

- **浏览器工具**（agent 可用，先执行 `harness2 browser install` 安装 chromium）：
  `browser_navigate / click / type / snapshot / screenshot / close`——模型通过 aria snapshot 引用元素操作页面，
  不暴露裸 selector。资源管控：每会话 1 个上下文、全局并发 2、空闲 5 分钟销毁、dispose 写入轨迹。
  `config.browser.enabled=false` 关闭；默认审批 ask。**如实声明**：仅访问用户/模型显式给出的 URL，无自动爬取；
  截图与页面内容属会话数据。
- **定时任务**：`harness2 cron add "每天早上帮我看一下 XXX" --at "daily 09:00"`（或 `--every 5m`）；
  到点在独立会话执行，结果写 `~/.harness2/cron/history/`；`cron list / remove / run / history` 管理。
  连续 3 次失败自动熔断；上限 50 条。

## 插件 / MCP / 子代理 / IM 网关（阶段 8-9）

- **插件**：manifest 声明式权限，装载需审批——`harness2 plugin list` 查看权限清单，`plugin enable <name> [--yes]` 写入全局
  config 的 `plugins.allow`（重启 chat/serve 后装载）；事件总线 + disposer 逆序展开；v1 与主进程同进程运行（非隔离）。
- **MCP**：`config.json` 的 `"mcpServers"` 声明 stdio（command）或 Streamable HTTP（url）服务器，工具以
  `mcp__<server>__<tool>` 命名空间接入；断线退避重启；`harness2 mcp list` 逐 server 连接探测。
- **子代理**：模型可用 `subagent_start` 派发独立子会话跑子任务（独立轨迹/undo，深度默认 1，父取消传播）；
  `subagent_continue` 向既有子会话追加消息。
- **IM 网关**：`harness2 gateway` 把 QQ / 飞书消息桥接到本地 serve（审批回复式处理、每 chat 串行、三态私聊/群策略）；
  凭据只存 `~/.harness2/auth.json` 的 `gateways` 段或环境变量。QQ 真机联调待用户开放平台凭据。

## 轨迹导出/回放与 Skills（阶段 10）

- **轨迹导出**：`harness2 export <会话目录> [-o <zip>]`——只读打包为 ZIP：主日志 + `rewind_points.jsonl`/`snapshots/`（存在时）+
  **子代理会话**（`subagents/<id>/` 递归）。固定条目时间戳，同目录同内容导出得到逐字节相同的 zip（幂等）。
  导出不修改会话目录任何文件。会话轨迹含用户代码与对话（属用户资产），请自行妥善保管，**不会自动上传**。
- **回放校验**：`harness2 replay <zip>`——逐事件解析 + 投影摘要（events / messages / lastSeq / badLines + 坏行明细）；
  空包/非 harness2 导出报错退出。回放无需 API key，**轨迹即测试夹具**（CI 零 key 可跑）。
- **Skills**（文本指令型，无可执行脚本）：把带 YAML 简表 frontmatter 的 markdown 放进项目 `.harness2/skills/` 或全局
  `~/.harness2/skills/`（项目同名覆盖全局 + 告警，上限 50）：

  ```markdown
  ---
  name: commit-fix
  description: 按团队规范写修复类提交信息
  ---

  提交信息使用 <gitmoji><type>(<scope>): <中文描述> 格式……
  ```

  每个 turn 从磁盘重扫，仅「[Skills 可用] 名称: 描述」列表注入 system；模型需要时经 `skill` 工具按需加载全文（现读磁盘）。
  `harness2 skill list` 查看合并后的列表与覆盖告警。
