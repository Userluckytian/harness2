# harness2 架构说明

> 跨端 AI agent harness（CLI / 桌面 / IM 网关多形态）
> 状态：随阶段推进持续更新（当前：阶段 2 —— Agent loop + 工具系统 + MockProvider + CI 骨架）
> 决策依据：`docs/ROADMAP.md` D1–D6 · `docs/research/2026-09-06-reference-analysis.md`

## 技术栈（2026-09-06 确认）

| 分类 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 语言 | TypeScript（strict） | 5.x | 全栈同语言 |
| 运行时 | Node.js | ≥22 | LTS |
| 包管理 | pnpm workspaces | 11.x | 备选 npm workspaces（Windows 符号链接异常时降级） |
| 测试 | vitest | 3.x | 含快照回放测试 |
| CLI 框架 | commander | 14.x | 轻量命令解析 |
| 桌面端（P1） | Electron + React | — | WebContentsView 内嵌浏览器 |
| 存储 | JSONL（会话事件）+ SQLite（索引/FTS，后期） | — | 事件日志为唯一事实源 |
| IM 网关（P2） | Node 常驻进程 + QQ 官方 Bot API v2 | — | 用户已在 QQ 开放平台注册 |

## 目录结构（四包位形）

```
packages/
├── core/      # 会话内核 + agent loop + 工具系统 + Provider 缝（事件日志、投影、轨迹渲染）
├── cli/       # 终端入口：harness2 命令（traj / 后续 chat 等）
├── desktop/   # Electron 桌面端（P1，先占位）
└── gateway/   # IM 网关与定时任务（P2，先占位）
```

## 核心设计不变量

1. **Model-visible ⟺ logged**（自 deepseek-harness）：任何将发往模型的内容，必须可从事件日志完整重建；运行时与测试断言此不变量。
2. **Append-only**：会话日志只追加，不修改不删除；撤回/分叉都是追加标记事件；代际文件（`session.vN.jsonl`）不可变。
3. **会话内核与 UI 解耦**（决策 D5）：core 是单写者事件记录器；CLI/桌面/IM 网关都是消费者（投影）。多会话并行时后台会话只记事件不渲染。
4. **独立文件快照**（决策 D6）：文件回滚不依赖 git（学习 grok rewind 的 before/after 双快照 + 冲突检测）。

## Provider 缝（阶段 2 交付，Ph3 接真实厂商）

- `ChatProvider.streamChat(req, {signal}) → AsyncIterable<StreamChunk>`：流式块为
  `text-delta` / `tool-call` / `usage` / `done`；`ChatMessage` 与日志事件的映射规则
  写死在 `provider/types.ts` 注释（user/assistant 消息、tool 结果回传、toolCalls 归属）。
- 阶段 2 唯一实现是脚本化确定性 `MockProvider`（可编排 tool_calls、流式分片、错误注入、
  记录每次 ChatRequest 供不变量断言）；真实 provider 与 `{channelId, model}` 配置是 Ph3 范围。

## Agent loop（阶段 2 交付）

- `runTurn(session, options)`：turn/step 状态机。每 step：`step/start` → 从日志投影组装
  ChatRequest → `provider.streamChat` → `assistant/message` 落盘 → 有 toolCalls 则
  `tool/call` × n → 执行器波次 → `tool/result` × n → `step/end` → 循环；无 toolCalls /
  达 maxSteps / 取消 / 模型出错则结束 turn（stopReason：end_turn / max_steps / cancelled / error）。
- **Model-visible ⟺ logged 的结构性保证**：loop 的模型请求上下文唯一来源是
  `buildChatMessages(loadSession(dir))`（投影 + 活动工具事件重建），无内存旁路；
  不变量测试用独立回放断言 `mock.requests` 与日志逐步重建序列完全一致。
- **append-only**：取消与失败都是追加事件——模型失败/取消记 `assistant/attempt`，
  被取消的工具调用记 `ok:false` 的 `tool/result`；无任何 update/delete 路径。
- 用户输入同样 logged：`userText` 由 loop 先写 `user/message` 再进循环。

## 工具系统（阶段 2 交付）

- `ToolRegistry`：注册即返回 disposer（D4「注册即可逆」）；重名/非法名抛错。
- `ToolExecutor`：审批管线（`allow`/`deny`/`ask` 回调缝，缺省 allow-all，`ask` 无
  `onAsk` 按拒绝）→ 超时（`AbortSignal.timeout` 与外部 signal 组合，不依赖工具自觉）→
  统一结果 `{ok, output?, error?, durationMs}`。执行器不写日志（单一写者是 loop）。
- 并发波次 `runWave`：按提交顺序——unsafe（默认）独占执行；连续 safe 并行；
  批内 `lockKey` 相同按键串行；结果与请求顺序一一对应。
- 基础工具集：bash / read / write / edit / glob / grep（全部 Windows 兼容，`node:path`
  解析；write/edit 原子写 tmp+rename 且按路径 lockKey 串行；grep 优先 spawn ripgrep、
  ENOENT 回退纯 JS 扫描，无条件跳过 node_modules/.git 与二进制文件）。

## 会话事件日志（阶段 1 交付）

- 每会话一个目录，主文件 `session.v1.jsonl`，一行一个 JSON 事件，行尾 `\n`。
- 单写者：`SessionWriter` 持有目录锁，写入即 fsync（可配置批量窗口）；崩溃残行由 reader 跳过并告警。
- 事件类型 v1（字段命名对齐 deepseek-harness `known-event-types.ts`，留 `v` 版本字段）：
  `session/header`、`user/message`、`assistant/message`、`assistant/attempt`（失败尝试）、
  `step/start`、`step/end`、`tool/call`、`tool/result`、`rewind/marker`。
  阶段 2 增量：`tool/result` 增加可选 `turnId`（渲染 turn 标头用，旧日志兼容）；
  `rewind/marker.rewindToSeq` 写入口强校验 `1..lastSeq`，读侧对越界旧数据告警容错。
- 投影语义：`rewind/marker` 之前的活动事件构成当前会话投影；被 rewind 的"影子事件"保留在日志中可导出，但不进当前上下文。
- 密钥红线：API key 等凭证不落事件日志、不进 git。

## 撤回/分叉路线（决策定案）

- P0/P1：`/undo` `/redo`（opencode 语义：投影截断 + 文件快照恢复）→ P1：分叉（dsh 语义：header 血缘 parentSession）→ P1 增强：grok 三模式 rewind。

## 插件机制（决策 D4，后期公开）

自研轻量总线：事件 emit/waterfall + 注册返回 disposer（学 dsh"注册即可逆"，不引 Cordis）。阶段 1–3 仅内部使用，P2 公开化。

## 不做

见 `docs/ROADMAP.md`「明确不做」：闭源逆向、个人号逆向协议、Cordis 引入、Rust/Tauri、UI 一次做全。
