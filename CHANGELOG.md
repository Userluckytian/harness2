# Changelog

本文件记录面向使用者的显著变更。发布素材源自 `docs/diary/`（每日日志的 Release note 段）。

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
