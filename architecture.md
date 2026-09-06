# harness2 架构说明

> 跨端 AI agent harness（CLI / 桌面 / IM 网关多形态）
> 状态：随阶段推进持续更新（当前：阶段 4 —— CLI 完整体验 → M1 v0.1：chat REPL + 文件快照 + undo/redo + 会话管理）
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

## Provider 缝（阶段 2 交付，阶段 3 落地真实厂商）

- `ChatProvider.streamChat(req, {signal}) → AsyncIterable<StreamChunk>`：流式块为
  `text-delta` / `tool-call` / `usage` / `done`；`ChatMessage` 与日志事件的映射规则
  写死在 `provider/types.ts` 注释（user/assistant 消息、tool 结果回传、toolCalls 归属）。
- 阶段 3 实现（协议手写 fetch，无 SDK；全部经 127.0.0.1 stub server 测试，CI 零 API key）：
  - `provider/openai.ts` OpenAI-compatible（DeepSeek/智谱 GLM 等）：`POST {baseUrl}/chat/completions`
    （stream:true），`delta.tool_calls` 按 index 增量组装、`delta.reasoning_content` →
    `reasoning-delta`、usage 帧、HTTP 非 2xx 与断流（未收到 `[DONE]`，code `stream_truncated`）
    均抛脱敏 ProviderError；abort → ProviderError('cancelled')。
  - `provider/anthropic.ts` Anthropic Messages API：`POST {baseUrl}/v1/messages`（baseUrl 不含
    `/v1`），`x-api-key` + `anthropic-version` 头、`max_tokens` 必填；SSE 事件映射
    `text_delta`/`input_json_delta`/`thinking_delta`（→ reasoning-delta）/`message_delta`
    （stop_reason/usage）/`error`（脱敏抛出）；`tool_result` 块按连续 tool 消息合并进 user 消息。
  - `provider/factory.ts` `createProvider(config, role)`：roles → channel → key 解析
    （auth.json > env，见配置体系）→ 协议分派；provider 标识（写入 assistant/message.model）
    为 `channel/model`；key 缺失抛脱敏 ConfigError。
- **阶段 3 契约加性扩展（唯一一处，经批准的最小扩展）**：`StreamChunk` 新增
  `{type:'reasoning-delta', text}` 变体；loop 汇总进 `assistant/message.reasoning`
  （session 事件加性可选字段，代际不变）。既有块的语义与 loop 其余行为完全不变。
- 思考内容（reasoning）只进日志展示，不回传模型（多轮上下文重建不含 reasoning）。

## Agent loop（阶段 2 交付）

- `runTurn(session, options)`：turn/step 状态机。每 step：`step/start` → 从日志投影组装
  ChatRequest → `provider.streamChat` → `assistant/message` 落盘 → 有 toolCalls 则
  `tool/call` × n → 执行器波次 → `tool/result` × n → `step/end` → 循环；无 toolCalls /
  达 maxSteps / 取消 / 模型出错则结束 turn（stopReason：end_turn / max_steps / cancelled / error）。
- **Model-visible ⟺ logged 的结构性保证**：loop 的模型请求上下文唯一来源是
  `buildChatMessages(loadSession(dir))`（投影 + 活动工具事件重建），无内存旁路；
  不变量测试用独立回放断言 `mock.requests` 与日志逐步重建序列完全一致。
- **不变量边界**：Model-visible ⟺ logged 当前覆盖 **messages**（user/assistant/tool 消息）；
  `ChatRequest.tools`（工具 schema 列表）暂不在日志重建范围内——阶段 2 工具集固定，
  工具配置化时再评估是否把 tools 也纳入重建。阶段 3 起该不变量通过真实 provider 的
  wire 请求验证：E2E 测试断言 stub server 捕获的请求体与日志投影重建后的 wire 消息全等。
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
  解析；write/edit 原子写 tmp+rename，unsafe 独占执行天然串行——lockKey 为 Ph3 预留，
  当前不声明；bash 超时/取消按平台杀整棵进程树（Windows `taskkill /T /F`、POSIX
  进程组击杀，守护进程化进程除外）；grep 优先 spawn ripgrep、ENOENT 回退纯 JS 扫描，
  两条路径无条件跳过 node_modules/.git、隐藏文件/目录（含 .env*）与二进制文件；
  glob 同样排除 node_modules/.git）。
- **审批策略配置化（阶段 3 交付，`approval/policy.ts`）**：`createApprovalPolicy(config.approval)`
  产出 Ph2 的 `ApprovalHandler`。三 mode（default：safe=allow/其余 ask；acceptEdits：
  write/edit=allow 其余同 default；bypass：全 allow）+ per-tool 规则（allow|ask|deny，
  优先级高于 mode 推导）；未列出的工具按安全集判定（缺省安全集 = read/glob/grep）。

## 配置体系（阶段 3 交付，`config/`）

- **两级加载**（`load.ts`）：全局 `~/.harness2/config.json` + 项目 `<root>/.harness2/config.json`，
  深合并（对象递归、数组/标量项目覆盖全局）；JSONC 宽松解析（注释/尾逗号）；任一存在的
  文件解析失败即致命错误（不静默丢配置）；`${VAR}` 展开缺失 env 时保留原样并告警
  （`envKey` 是变量名引用、不展开）。
- **schema 校验**（`schema.ts`）：providers（protocol 枚举 / baseUrl / envKey / models 容量
  元数据）、roles（channel+model，交叉引用必须存在）、approval（mode 枚举 + per-tool 规则）；
  未知字段忽略并告警；错误消息出口统一过 `redactSecrets`（不回显疑似密钥内容）。
- **密钥分离**（`auth.ts`）：key 只存 `~/.harness2/auth.json`（`channels.<id>.apiKey`，读损坏
  = 空表 + 一行错误；写入尽力 chmod 600，Windows 依赖目录 ACL）与环境变量（`envKey` 指定
  变量名，解析顺序 auth.json > env）。config 契约里没有任何 key 字段（类型层面钉死）。
- **脱敏**（`redact.ts`）：`redactSecrets`/`redactedSummary`/`redactObject`——错误消息、HTTP
  body 摘要（≤200 字符、先脱敏再截断）、任意对象出口前的最后闸门。
- **CLI**：`harness2 config check [--root <dir>] [--home <dir>]`——校验合并配置，脱敏打印
  providers（baseUrl/protocol/models）、roles、approval 与 key 来源（`auth.json` /
  `env:XXX` / `**missing**`，永不打印明文）；任何错误一行输出 exit 1。

## 会话事件日志（阶段 1 交付）

- 每会话一个目录，主文件 `session.v1.jsonl`，一行一个 JSON 事件，行尾 `\n`。
- 单写者：`SessionWriter` 持有目录锁，写入即 fsync（可配置批量窗口）；崩溃残行由 reader 跳过并告警。
- 事件类型 v1（字段命名对齐 deepseek-harness `known-event-types.ts`，留 `v` 版本字段）：
  `session/header`、`user/message`、`assistant/message`、`assistant/attempt`（失败尝试）、
  `step/start`、`step/end`、`tool/call`、`tool/result`、`rewind/marker`。
  阶段 2 增量：`tool/result` 增加可选 `turnId`（渲染 turn 标头用，旧日志兼容）；
  `rewind/marker.rewindToSeq` 写入口强校验 `1..lastSeq`，读侧对越界旧数据告警容错。
  阶段 3 增量：`assistant/message` 增加可选 `reasoning`（思考文本汇总，v1 加性字段，
  旧日志兼容）。
- 投影语义：`rewind/marker` 之前的活动事件构成当前会话投影；被 rewind 的"影子事件"保留在日志中可导出，但不进当前上下文。
  阶段 4 增量（redo 链，向后兼容）：`reason` 以 `redo` 开头的标记按「undo/redo 约定」精确中立化
  `seq = rewindToSeq + 1` 处的被重做 undo 标记（恢复其遮蔽的事件）；n 级 undo/redo 链每次 redo 只复活一层；
  非 redo 标记语义不变（只遮蔽、不复活），旧日志行为完全一致（见 `reader.computeProjection` 与 reader 测试）。
- 密钥红线：API key 等凭证不落事件日志、不进 git。

## 文件快照与 undo/redo（阶段 4 交付）

- **独立文件快照**（决策 D6，`session/snapshots.ts`）：辅助文件 `rewind_points.jsonl` 位于会话目录内，
  一行一条 `{v, seq, file, before, after}`（file 恒为绝对路径；null = 文件不存在）；绝不回改 session.v1.jsonl。
- 写入协议由 agent loop 驱动（执行器 `ExecutionEnv` 的 `onBeforeExecute`/`onAfterExecute` 钩子）：
  write/edit 执行前 capture（键 = tool/call 事件 seq）、成功后 commitAfter 落盘整条；
  失败/取消不记 after（未完成的修改没有恢复点）；捕获失败该调用直接失败（undo 完整性优先）。
  bash/read 等工具不参与（**bash 副作用不进快照**，已在 chat /help 与 README 如实声明）。
- 恢复语义：`restore(toSeq)`（undo）对 `seq > toSeq` 的条目**按文件取最早一条**恢复 before（创建→删除），
  冲突基准 = 该文件在被撤操作中最新 after；`restoreAfter(fromSeq)`（redo）取最新一条恢复 after，
  冲突基准 = 最早 before。当前内容 ≠ 基准 → `externallyModified`（dryRun 列出；实际恢复报告后仍执行）。
  单文件恢复失败转 `item.error` 不中断整体；崩溃残行按「换行即提交」策略容错。
- **undo/redo 内核**（`session/undo.ts`）：全部是 append-only 日志上的投影操作 + 快照恢复联动，无内存旁路。
  - `undoLastTurn`：最近一条**活动** user/message 的 seq U → 目标 U-1；追加 `rewind/marker{rewindToSeq:U-1, reason:'undo'}`
    + `snapshots.restore(U-1)`；无活动 user 或目标越界（撤到 seq 0）→ 明确错误。
  - `redoLastUndo`：回放 undo 栈（undo 入栈；redo 按其 `rewindToSeq+1` 弹出它重做的 undo）→ 取栈顶 M，
    目标 = M.seq-1；追加 `rewind/marker{rewindToSeq:M.seq-1, reason:'redo'}` + `snapshots.restoreAfter(M.rewindToSeq)`。
  - `dryRun` 只预览（消息数/文件清单/冲突标记），不追加 marker、不写文件。
  - 与 writer 侧 `rewindToSeq ∈ 1..lastSeq` 校验天然兼容；目标恒在界内。

## 会话管理器（阶段 4 交付，`session/manager.ts`）

- 全局集中布局：`~/.harness2/sessions/<encoded-cwd>/<sessionId>/session.v1.jsonl`（grok 式按 cwd 归组）。
  cwd 编码（`encodeCwd`，纯字符串逐字符映射、跨平台一致）：字母/数字/`.`/`_`/`-` 保留；盘符冒号丢弃；
  `\` 与 `/` → `--`；其余不安全字符 → `-`（如 `D:\a\b` → `D--a--b`）；>120 字符截断 + sha1 前 8 位。
  编码不保证双射，cwd 真值以 header.cwd 为准。
- `create`（自动创建 `~/.harness2` 链；id = UTC 时间戳 + 随机后缀，全库查重）、`list(cwd?)`
  （mtime 倒序；首条活动用户消息摘要 ≤60 字、活动消息数、lastSeq）、`search(cwd?, text)`
  （活动消息子串命中、大小写不敏感、≤3 条摘要片段——SQLite/FTS 明确不做）、`resume(id, {cwd?})`
  （打开 writer，崩溃残行恢复语义沿用）。

## chat REPL（阶段 4 交付，packages/cli）

- `harness2 chat [--session <id>] [--provider mock] [--root <dir>] [--home <dir>]`：无 --session 时
  恢复 cwd 最近会话或新建；提示符 `> `。`--provider mock` 用内置演示脚本（两轮工具调用：write+read），
  不加载配置、不触发审批，零 key 可用。
- 流式渲染（`render.ts`）：text-delta 直写 stdout 不换行拼流；工具调用/结果单行（`> tool (args摘要)` /
  `< ok|FAILED [callId]`）；turn 结束摘要行；reasoning 不渲染。核心 loop 增加最小观察缝
  `TurnOptions.onStream`（text-delta/tool-call/tool-result 三类事件，纯渲染用，不参与上下文组装）。
- 命令集（`commands.ts`）：`/new` `/sessions [关键字]` `/resume <id>` `/undo [n] [--dry-run]` `/redo`
  `/help` `/exit`（或 Ctrl+C 两次 / 空行 Ctrl+D）；Ctrl+C 在 turn 进行中 = 取消当前 turn（AbortController）。
- 审批交互：config.approval 判定 ask 时 REPL 内联提问 `允许执行 <tool>? [y]本次 [a]本会话总是 [n]拒绝`；
  "总是"仅存进程内会话级缓存（不落盘）。渲染与输入交错策略：turn 期间不写提示符、渲染器独占输出。

## 撤回/分叉路线（决策定案）

- ✅ P0/P1（阶段 4 交付）：`/undo` `/redo`（opencode 语义：投影截断 + 文件快照恢复，含冲突检测与 dry-run）→ P1：分叉（dsh 语义：header 血缘 parentSession）→ P1 增强：grok 三模式 rewind（对话/文件/全部独立撤回）。

## 插件机制（决策 D4，后期公开）

自研轻量总线：事件 emit/waterfall + 注册返回 disposer（学 dsh"注册即可逆"，不引 Cordis）。阶段 1–3 仅内部使用，P2 公开化。

## 不做

见 `docs/ROADMAP.md`「明确不做」：闭源逆向、个人号逆向协议、Cordis 引入、Rust/Tauri、UI 一次做全。
