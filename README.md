# harness2

自研跨端 AI agent harness（CLI / 桌面 / IM 网关多形态）。**M1（v0.1）= 终端里接真实模型干活**：流式对话、读写文件、跑命令、`/undo` `/redo`、轨迹可查、审批可控。

- **新维护者/AI 入口：`docs/HANDOFF.md`**
- 路线图与功能清单：`docs/ROADMAP.md` · 变更记录：`CHANGELOG.md`
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

chat 内常用命令：`/new`、`/sessions [关键字]`、`/resume <id>`、`/undo [n] [--dry-run]`、`/redo`、`/exit`。
`/redo` 会恢复到撤销前状态，撤销之后新输入的消息将被移出当前上下文（仍保留在日志中，可用 `traj` 查看）。
审批 ask 提示中的 `[a] 本会话总是` = 该工具后续所有调用不再询问（仅进程内会话级缓存，不落盘）。
会话存储在 `~/.harness2/sessions/<工作目录编码>/<会话id>/`；`harness2 traj <会话目录>` 查看轨迹。

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

结构：`packages/core`（会话内核 + agent loop + 工具系统 + Provider 缝，npm: `@harness2/core`）、`packages/cli`（npm: `harness2`）、`packages/desktop`、`packages/gateway`（占位）。

## License

MIT
