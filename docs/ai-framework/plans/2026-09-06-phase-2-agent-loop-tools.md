# 阶段 2：Agent loop + 工具系统 + Mock Provider + CI 骨架

> **状态：** 计划已就绪（总控计划 Ph2，2026-09-06 批准）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 让会话内核"活"起来——真实 agent loop 驱动工具调用，全程落事件日志（Model-visible ⟺ logged 结构性成立），用 MockProvider 在 CI 零 API key 下验证全部循环语义。
**Architecture:** Provider 是可替换缝（Ph3 接真实厂商）；loop 只从事件日志投影读取上下文、只通过写入器追加，使"发给模型的内容"天然可从日志重建；工具系统按注册即返回 disposer 的轻量总线思想（D4）。
**Tech Stack:** TypeScript/Node ≥22/pnpm/vitest；新增运行时依赖仅 `fast-glob`。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件、`docs/MASTER-PLAN.md`（Ph2 定位） |
| P0 | `architecture.md`（不变量）、`docs/ROADMAP.md`（D1–D6） |
| P0 | `packages/core/src/session/{types,writer,reader}.ts` 与其测试（内核 API，禁止破坏 append-only 语义） |
| P1 | `docs/issue-log/OPEN.md`（本阶段需消化 P2-1/P2-3/P2-5）、`CODE_REVIEW.md` |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`，当前 tip 含已验收的阶段 1）
**基线分支：** 从 `master` 拉 `feat/phase-2-agent-loop-tools`

---

## Global Constraints（冲突时以本节为准）

1. **Model-visible ⟺ logged**：loop 构造的每一次模型请求的消息列表，必须与"从日志投影重建的消息列表"完全一致（结构上保证：loop 的上下文唯一来源是 SessionWriter 投影，禁止内存旁路）。
2. **append-only 红线**：不新增任何 update/delete 路径；取消/失败都是追加事件。
3. **不接真实模型 API**（Ph3 范围）；Provider 接口按契约定义，MockProvider 是唯一实现。
4. **明确不做（本阶段）**：CLI chat 命令（Ph4）、审批 UI（Ph4 只留回调缝）、真实 provider、Electron、插件公开 API（Ph8）。
5. **Git：** 每 Task 一提交，格式 `<gitmoji><type>(<scope>): <中文描述>`；**禁止 push**。
6. 密钥不进 git；fixture 无真实凭证。

---

## 与前后阶段

| 阶段 | 状态 | 交付 |
|------|------|------|
| 上阶段 Ph1 | ✅ 已验收 | 会话内核 + traj |
| **本阶段** | ⬜ | agent loop + 工具系统 + 基础工具 + MockProvider + CI 骨架 + 消化审查 P2-1/P2-3/P2-5 |
| 下阶段 Ph3 | | Provider 真实实现 + 配置体系 + 审批策略细化（勿塞进本阶段） |

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/core/src/provider/types.ts` | 新建 | Provider 缝：`ChatProvider` 接口、`StreamChunk`、`ToolCallRequest`、`ChatMessage`（与 session 投影消息映射） |
| `packages/core/src/provider/mock.ts` | 新建 | 脚本化确定性 MockProvider（流式 chunk、可编排 tool_calls、可注入错误、记录每次请求输入） |
| `packages/core/src/agent/loop.ts` | 新建 | turn/step 状态机：投影读上下文 → 模型调用 → 工具执行 → 追加事件 → 循环/终止 |
| `packages/core/src/agent/types.ts` | 新建 | TurnOptions（maxSteps、signal、approval、tools）、TurnResult（stopReason 等） |
| `packages/core/src/tools/types.ts` | 新建 | ToolDefinition（name/description/parameters JSON Schema/execute/concurrencySafe/lockKey/timeoutMs） |
| `packages/core/src/tools/registry.ts` | 新建 | 注册表：register 返回 disposer；重名注册抛错 |
| `packages/core/src/tools/executor.ts` | 新建 | 执行器：审批管线（allow/deny/ask 回调缝）→ 并发波次（safe 并行/unsafe 串行）→ 超时 → 写 tool/call+result 事件 |
| `packages/core/src/tools/predefined/{bash,read,write,edit,glob,grep}.ts` | 新建 | 基础工具集（Windows 兼容） |
| `packages/core/src/index.ts` | 修改 | 导出新增模块 |
| `packages/core/test/{loop,mock,tools,executor}.test.ts` | 新建 | 见各 Task |
| `packages/core/test/fixtures/tool-tree/` | 新建 | glob/grep 测试夹具 |
| `.github/workflows/ci.yml` | 新建 | 三平台 matrix CI |
| `packages/core/src/session/{types,writer}.ts`、`packages/core/src/trajectory/view.ts`、`packages/cli/src/index.ts` | 修改 | 消化审查 P2 项（见 Task 6） |

---

## Task 1：Provider 缝 + MockProvider

**Files:** `provider/types.ts`、`provider/mock.ts`、`test/mock.test.ts`

**行为:**
- `ChatProvider`: `streamChat(req: ChatRequest, opts?: {signal?}): AsyncIterable<StreamChunk>`；`ChatRequest = { messages: ChatMessage[]; tools?: ToolSpec[] }`；`ChatMessage = { role: 'user'|'assistant'|'tool'; content: string; toolCalls?: ToolCallRequest[]; toolCallId?: string; name?: string }`（tool 结果回传消息的形态，注释写清映射规则）。
- `StreamChunk`: `{ type: 'text-delta', text }` | `{ type: 'tool-call', call: ToolCallRequest }` | `{ type: 'usage', usage }` | `{ type: 'done', stopReason }`。
- `MockProvider(script: MockScript)`：脚本数组逐次消费；每次回复 = `{ text?, toolCalls?, usage?, error? }`；支持 `textChunks` 拆分成多个 text-delta（流式）；**记录每次收到的 ChatRequest 到 `requests` 数组**（供不变量断言）；error 时 streamChat 抛 ProviderError。超出脚本长度抛错。

**Steps:**
1. 实现并测试：脚本消费顺序、流式分片、requests 记录、错误注入、signal 提前取消（AsyncIterable 短路）。
2. 跑：`pnpm --filter @harness2/core test` exit 0
3. Commit：`✨feat(core): Provider 缝与脚本化 MockProvider`

## Task 2：工具系统（契约/注册表/执行器）

**Files:** `tools/{types,registry,executor}.ts`、`test/{tools,executor}.test.ts`

**行为:**
- `ToolDefinition`：`name`（^[a-z0-9_]+$）、`description`、`parameters`（JSON Schema 对象，可为 none）、`execute(args, ctx: ToolContext)`、`concurrencySafe?: boolean`（默认 false）、`timeoutMs?`、`lockKey?(args): string`（可选锁键）。
- `ToolContext = { signal: AbortSignal; cwd: string }`。
- registry：`register(def)` 返回 disposer；重名抛错；`get/list`。
- executor 执行管线（每个工具调用）：approval 决策（`ApprovalInput {tool,args}` → `'allow'|'deny'|'ask'`；ask 时调 `approval.onAsk` 异步回调，默认策略 allow-all）→ deny 直接 `ok:false, error:'denied by approval policy'` → 执行（超时用 AbortSignal.timeout 组合）→ 结果统一 `{ok, output?, error?, durationMs}`。**executor 本身不写日志事件**（loop 负责，保持单一写者清晰）——但导出执行结果供 loop 写。
- 并发波次：`runWave(calls)`——safe 调用并行、unsafe 串行；有 lockKey 的按键串行。

**Steps:**
1. 测试：注册/disposer/重名；审批三态；超时中断；波次调度（safe 并行总时长 < 串行）；deny 路径。
2. 验证同 Task 1 命令；Commit：`✨feat(core): 工具契约、注册表与执行器（审批缝/并发波次）`

## Task 3：基础工具集

**Files:** `tools/predefined/*.ts`、`test/tools.test.ts`、`test/fixtures/tool-tree/**`

**行为（全部 Windows 兼容，路径用 node:path）：**
- `bash`：`child_process.exec`（shell、cwd、timeout、输出截断上限 32KB、exit code 进结果）；unsafe。
- `read`：`offset/limit` 行读（默认全文件，上限 2000 行）；不存在→error。
- `write`：原子写（tmp+rename），自动建父目录；unsafe，lockKey=file。
- `edit`：唯一子串替换（oldText 出现≠1 次→error）；unsafe，lockKey=file。
- `glob`：`fast-glob`（cwd 限定、上限 1000 条）；safe。
- `grep`：优先 spawn `rg`（--json 不用，用普通输出按行解析），ENOENT 回退纯 JS 扫描（跳过 node_modules/.git/二进制）；safe。
- 新依赖：`fast-glob`（dependencies）。

**Steps:**
1. fixture：`test/fixtures/tool-tree/` 小文件树（含中文内容文件）；每工具至少 2 例（成功+失败/边界）。
2. Commit：`✨feat(core): 基础工具集（bash/read/write/edit/glob/grep）`

## Task 4：Agent Loop（核心）

**Files:** `agent/{types,loop}.ts`、`test/loop.test.ts`

**行为:**
- `runTurn(session: {dir} 或已 open 的 writer, deps: {provider, tools, approval?, maxSteps=25, signal?, cwd})`。
- 流程（每 step）：`step/start` → 组装 ChatRequest（**唯一来源=computeProjection(messages) + tool 结果回传消息**）→ `provider.streamChat`（收集 text-delta 与 tool-call）→ 成功：`assistant/message`（text/usage/model='mock'）→ 有 toolCalls：逐个 `tool/call` + executor 执行 + `tool/result`，并把 tool 结果作为 tool role 消息进入下一请求；无 toolCalls 或达 maxSteps 或取消：`step/end` 结束 turn。
- 模型异常/取消：`assistant/attempt`（error 含 'cancelled'）+ `step/end`（结果含 stopReason='error'|'cancelled'|'max_steps'|'end_turn'）。
- **不变量测试（本阶段最重要）**：跑完含多轮工具调用的 turn 后，`mockProvider.requests` 的每一条消息序列 === 对应时刻 `computeProjection(loadSession(dir)).messages` 构造的请求序列（用户消息/assistant 消息/tool 结果回传全部可从日志重建）。
- 其余测试：纯文本回复；工具调用后继续；并行 safe 工具波次；max_steps 守卫；取消（AbortController 中途触发）；provider 抛错；approval deny 后 loop 继续。
- 生成一个 demo session（fixture 复用 `fixtures/demo-session` 风格，由测试写出）供 Task 5 手工验证。

**Steps:**
1. 实现 + 全部测试。2. 跑全量测试 exit 0。3. Commit：`✨feat(core): agent loop（turn/step 状态机，事件溯源驱动）`

## Task 5：CI 骨架

**Files:** `.github/workflows/ci.yml`

**行为:** push/PR 触发；matrix `[windows-latest, ubuntu-latest, macos-latest]`；步骤：checkout → pnpm/action-setup@v4（版本 11）+ node 22（cache pnpm）→ `pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm test`。concurrency 取消旧 run。

**标记（无法自主验证项）**：Actions 实际运行需远程仓库与 push 授权——在本 Task 完成时于 `docs/issue-log/OPEN.md` 登记「CI 待远程验证（待用户建远程并授权 push）」，HANDOFF.md 已知坑同步。yaml 本地用 node `yaml` 解析校验语法（devDep 可选，用临时脚本校验后不留依赖）。

**Steps:** 1. 写 yaml + 本地语法校验 + OPEN.md 登记。2. Commit：`🐳ci: 三平台 CI 骨架（typecheck+test；待远程验证）`

## Task 6：消化阶段 1 审查 P2 项

**Files:** `session/{types,writer}.ts`、`trajectory/view.ts`、`cli/src/index.ts` 及测试

**行为:**
- P2-1：`writer.append('rewind/marker')` 校验 `1 <= rewindToSeq <= lastSeq`，越界抛错；reader 对日志中已存在的越界 marker 给 warning（容错旧日志）。
- P2-3（部分）：补 fsync 默认路径（true）冒烟测试；OPEN.md 对应项关闭。
- P2-5：view.ts 的 tool/result 行带 `callId`；turn 标头（每 turnId 首个事件前渲染 `── turn <id>`，无 turnId 的事件归入 `── turn -`）；switch 加 exhaustive 兜底（未知类型渲染 `? unknown event` 而非静默）；CLI 对 loadSession 抛错输出一行友好错误（exit 1，无堆栈）。
- OPEN.md 相应项更新状态（关闭/部分关闭注明剩余），并跑 `node packages/cli/dist/index.js traj packages/core/fixtures/demo-session` 确认渲染变化符合预期（黄金断言同步更新）。

**Steps:** 1. 实现+测试。2. 全量验证。3. Commit：`✨feat(core): 消化阶段1审查P2项（rewind校验/渲染增强/CLI友好错误）`

## Task 7：整备与交接

1. `pnpm test && pnpm -r typecheck` 全绿；`traj` 渲染 demo fixture 正常。
2. 更新 `architecture.md`（Provider 缝/loop 小节）、`docs/issue-log/`、`docs/diary/`（阶段 2 执行记录）、`docs/HANDOFF.md` 快照（阶段 2 完成、33→N 测试数）。
3. 汇总提交列表与验收表自评。

---

## 验收标准总表

| # | 标准 | 通过条件 |
|---|------|----------|
| 1 | Model-visible ⟺ logged | loop 不变量测试通过（mock.requests === 投影重建） |
| 2 | loop 语义 | 纯文本/工具/并行/取消/错误/max_steps 六类场景测试通过 |
| 3 | 工具系统 | 注册-disposer/审批三态/超时/波次调度测试通过；6 个基础工具各≥2 例 |
| 4 | MockProvider | 流式/脚本消费/错误注入/请求记录测试通过 |
| 5 | P2 消化 | P2-1/3/5 测试通过，OPEN.md 状态同步 |
| 6 | CI 骨架 | ci.yml 语法校验通过；远程验证事项已登记 OPEN.md |
| 7 | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0 |
| 8 | 红线 | append-only 无新增破坏路径；密钥/真实 API 不出现 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| grep 回退实现性能/正确性 | 上限截断 + fixture 中文/二进制用例 |
| Windows 下 bash 工具行为差异 | exec shell:true + 显式用例覆盖；输出按 utf8 解码 |
| AsyncIterable 取消语义平台差异 | 用 signal 组合 + 测试覆盖（Task 1/4） |
| CI 无法本地实跑 | yaml 语法校验 + OPEN.md 登记待远程验证（用户授权后） |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 2 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-2-agent-loop-tools`
- 已完成（勿重做）：阶段 1 会话内核（session 事件日志/投影/traj）已验收，33 测试全绿
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-2-agent-loop-tools.md`
- 必读：本计划、`architecture.md`、`AGENTS.md`、`packages/core/src/session/` 现有实现与测试

### 做
1. 严格按计划 Task 1→7 顺序执行；每 Task 跑 `pnpm --filter @harness2/core test`（或全量）通过后按规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：Model-visible ⟺ logged（loop 上下文唯一来源=日志投影）、append-only、不接真实模型 API、不实现 CLI chat
3. Task 5/6 完成后同步更新 `docs/issue-log/OPEN.md`；Task 7 更新 architecture.md/diary/HANDOFF

### 不做
- Electron、真实 provider、CLI chat 命令、插件公开 API
- 提交密钥；任何 `git push`

### 工作方式
1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷
分支名、提交列表（hash+message）、验收表逐项自评（带命令与结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 7。

---

## 残留手工验收清单

1. （远程可用后）GitHub Actions 三平台真实运行绿灯
2. Windows Terminal 实机跑 `traj` 渲染新增 turn 标头无乱码
