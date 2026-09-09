# 阶段 14-激进-共享底座：交互复刻地基（S0–S7，动 core）

> **状态：** 计划已就绪（2026-09-08，修订 R2：桌面改为功能优先 harness、底座加 S7）
> **来源：** `docs/research/notion-ai-20260908-0056/04-implementation-plan.md`（I1 R2）§6/§7 的 S0–S7；本文档是其**正式阶段化落地**之一。
> **角色：** 激进版「共享底座」owner。**只有本底座冻结后，激进-终端（T0–T5）与激进-桌面（D0–D6）才能开工。**
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 为「Grok 终端复刻 + 功能优先桌面 harness」建立**共享运行契约与内核能力**：提交/去重/订阅恢复/审批/任务生命周期/有界重试/安全 steer，以及桌面功能闭环契约（有效配置 / 计划 / 命令执行 / 变更审查）。这不是换皮肤，是要保留 harness2 的事件溯源/快照/undo，同时补上「取消、交付、恢复、审批、每会话 cwd」这些交互底座。
**Architecture：** 新增版本化 `runtime.v1.jsonl` 运行账本（非第二套对话正文）+ 一套结构化契约（`submit/resumeSubscription/approval/cancel/task/steer`）+ `task-coordinator`（子代理可后台并发）；契约在 WS 层协商（`protocolVersion=2`）。**不动** agent 内核的「每 step 由日志投影重建请求」不变量。
**Tech Stack：** TS（core）· vitest（stub 精确断流/429/503/丢ack/重复帧）· ws
**实施档位：** 全能（开发 + 测试 + 代码审查 + 故障注入；真实模型体验留用户真机签收）
**子代理：** 启用（代码审查 + 验收独立角色）

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`                                                                |
| P0     | `docs/research/notion-ai-20260908-0056/04-implementation-plan.md`（I1 全文，本阶段唯一契约来源）                                        |
| P0     | `docs/research/notion-ai-20260908-0056/03-harness2-core-audit.md`（已确认的机制 + 差距 H1/H2/H3）                                       |
| P1     | `packages/core/src/agent/loop.ts`、`provider/openai.ts`、`tools/executor.ts`、`agent/subagent.ts`、`server/sessions.ts`、`server/ws.ts` |
| P2     | `docs/research/notion-ai-20260908-0056/01-grok-build-research.md`、`02-codexmonitor-research.md`                                        |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支 / worktree：** 从当前已核对的 `main`（业务研究基线 `b1c2d815`，packages 无 diff）建 **独立 worktree**：`feat/notion-i1-runtime`。**别在主工作树切分支打断他人**；不删他人 worktree；git 不 reset/clean；**默认不 push**。

---

## Global Constraints（冲突时以本节为准）

1. **不破坏事件溯源/轨迹不变量**：永久会话事件继续 append-only、同会话单写者；模型可见输入仍由 session 日志投影生成；**临时 delta 不成为下一轮模型上下文**。
2. **已有安全边界必须保留**：`openai.ts` 的 `[DONE]` 检查与「半截工具参数不能执行」；`executor.ts runWave` 的 safe 并发/unsafe 独占/同 lockKey 串行。
3. **公共事件类型变更须同步** parser/projector/export/replay/fixture 与迁移策略；不允许旧 reader 静默丢 steer。
4. 密钥/实际用户会话/附件/prompt 日志不上传；测试用本地 stub + 临时 HOME/cwd；不改用户全局配置或审批模式。
5. **Git**：只显式 `git add` 本任务文件，不用 `git add -A`；改同一文件前检查并发变化；小步 commit；**默认不 push**。
6. **明确不做（本阶段）**
   - ❌ 不整体移植 Grok 认证/云端/遥测/更新；不启动第二套 Codex 后端；不迁移 Tauri
   - ❌ 不新增完整 Git 工作台/集成 shell/codemap/语音/移动端
   - ❌ 不把「取消当 undo」「重连当重发」；不对 shell/MCP 承诺 exactly-once；不默认自动 retry 工具
7. **YAGNI**：契约按 I1 冻结，不作无谓扩展；错误码分类覆盖常见错误即可。

---

## 阶段开头：上阶段遗留（必填）

> 上阶段（阶段 12/终端/桌面）已并入 main；本阶段为新地基，无功能性上阶段遗留。但**审计已确认的源码缺陷必须在本阶段闭环**（H1 取消接线 / H3 无有界重试 —— H2 属终端界面层，归激进-终端）。

| 上阶段遗留项                                                                          | 来源                   | 未通过原因                                      | 状态                                     |
| ------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------- | ---------------------------------------- |
| H1：TUI 忙时输入/取消未接线（`Composer` `if(busy)return`、`submit` 未调 `abortTurn`） | 03-harness2-core-audit | 内核有 `abortTurn`，缺 UI 接线                  | ⬜ 由激进-终端 T0 承接（本底座提供契约） |
| H3：provider 失败立即结束，无有界重试                                                 | 03-harness2-core-audit | `openai.ts` 单次 fetch、`loop.ts` 出错即 return | ⬜ 本底座 S4 闭环                        |

---

## 跳过项（因档位未做，**非缺陷**）

| 跳过项                                                | 原因                   | 待补做                    |
| ----------------------------------------------------- | ---------------------- | ------------------------- |
| 端到端真机（Windows IME/滚动/中断手感、录屏 12 场景） | 需用户真机，底座不替代 | ⬜ 留「残留手工验收清单」 |
| Grok 完整熔断器 / CodexMonitor 活动线程出队等「不足」 | I1 明确不照搬          | ⬜ —                      |

---

## 共享契约（冻结目标，抄自 I1 §6，实施须对齐）

- **身份**：`sessionId/turnId/stepId/attemptId/callId/taskId/clientMessageId` 用途分开，禁止取「日志最后 turn」猜终态。
- **`submit`**：`clientMessageId/sessionId/rawText/references/intent(queue|steer)/期望 turnId`；ack=accepted/rejected；超时=unknown（≠rejected）；同 id 同内容返 reply，不同内容拒绝；queue 每 session 上限 20；重启恢复 queue **默认 paused**。
- **`resumeSubscription`**：`lastSeq+epoch`；返回带水位的 replay 范围 + active attempt 快照 + tasks + pending approvals + queue；握手先缓冲后合并，禁 snapshot 与 delta 空窗；旧 epoch/重复 offset 丢弃。
- **`approval`**：requestId/session/parent/task/tool/args/cwd/scope/expiresAt；respond 有 decision ack；失败卡保留；「本会话总是」不得跨 session 泄漏。
- **`cancel`**：requestId+target+expectedId；UI 立即 stopping；确认后 cancelled；不明/不配合=unknown；停父 turn 默认取消其 child 并暂停 queue；单 child 取消不杀兄弟；取消**不撤销**已完成文件变更。
- **`task`**：registered→queued→starting→running/waiting-approval→stopping→completed/failed/cancelled/unknown；终态单调；`background:true` 注册返回 handle。
- **`steer`**：有 capability 才可用，绑定 expectedTurnId+唯一 id；仅在下一安全 model step 边界接受；不能中途改正在执行的工具；轮次已结束返回 stale（保留 draft，不偷偷 abort/resend）。
- **重试默认策略（新产品决定，不照抄上游数字）**：仅模型 step 内、完整工具计划未提交时自动重试；网络/超时/429/可恢复 5xx/stream_truncated，最多 +3 次、2/10/30s 指数+抖动，整 turn 最多 +6 次且累计 ≤120s；Retry-After 超预算则停并告知；401/403/参数错/quota/用户取消/拒绝/内容过滤**不重试**。

---

## File Structure（预期变更）

| 文件                                                                                                                                                                                                                                                                                                           | 动作 | 职责                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `packages/core/src/interaction/types.ts`                                                                                                                                                                                                                                                                       | 新建 | S0：契约类型（冻结）                                                                |
| `packages/core/src/interaction/runtime-journal.ts`                                                                                                                                                                                                                                                             | 新建 | S3：`runtime.v1.jsonl` 单写，accepted queue/去重/task lifecycle/call 状态与恢复水位 |
| `packages/core/src/interaction/delivery.ts`                                                                                                                                                                                                                                                                    | 新建 | S3：submit 幂等、去重、跨进程对账                                                   |
| `packages/core/src/interaction/retry-policy.ts`                                                                                                                                                                                                                                                                | 新建 | S4：有界重试预算与错误码分类                                                        |
| `packages/core/src/tools/executor.ts`                                                                                                                                                                                                                                                                          | 修改 | S1：取消后不执行、执行生命周期观察、每 session 真实 cwd                             |
| `packages/core/src/agent/subagent.ts`                                                                                                                                                                                                                                                                          | 修改 | S2/S5：审批上抛、task-coordinator 接线                                              |
| `packages/core/src/agent/task-coordinator.ts`                                                                                                                                                                                                                                                                  | 新建 | S5：任务生命周期、只读 K=2 并行、共享写全局串行、status/wait/continue/cancel        |
| `packages/core/src/server/ws.ts`、`http.ts`、`sessions.ts`                                                                                                                                                                                                                                                     | 修改 | S2/S3/S6：新契约端点、协议 v2 协商、resumeSubscription/审批/steer                   |
| `packages/core/src/provider/*`、`agent/loop.ts`                                                                                                                                                                                                                                                                | 修改 | S4/S6：retry 分类、step 边界 steer、控制输入                                        |
| `packages/core/src/interaction/run-config.ts`、`plan-state.ts`、`execution-view.ts`、`change-review.ts`                                                                                                                                                                                                        | 新建 | S7：桌面功能闭环契约（有效配置/计划/命令执行/变更审查），最终路径由 S0 确认         |
| `packages/core/test/**`（新增：executor-cancel、approval-queue、delivery-idempotency、runtime-journal-crash、subscription-resume、attempt-retry、task-coordinator、steer-boundary、effective-run-config、plan-execution-boundary、command-output-exit-code、change-review-user-dirty、undo-external-conflict） | 新增 | 全覆盖（见验收）                                                                    |

---

## 任务

### S0 — 冻结契约 + 证据基线（前置）

- 新建 `interaction/types.ts` + 协议 fixtures；核对现有 types/protocol；建本方案专属 evidence 目录。
- 记录 12 场景对照清单 + 基线命令真实结果；显式列旧失败，**不归咎环境后跳过**。
- 测：`pnpm install --frozen-lockfile && pnpm -r build && pnpm -r typecheck` 全绿。Commit：`🔧feat(core): 交互契约类型与协议 fixtures 冻结（S0）`

### S1 — 取消不执行 + 每 session 真实 cwd（`tools/executor.ts`、内置副作用工具、`server/sessions.ts`、执行生命周期观察接口）

- 已取消的 execute 计数 0；审批后竞态不启动第二个 write；不合作工具返回 unknown；每 session 从 header 得真实 cwd，A/B 目录不串。
- 测：`executor-cancel-before-start`、`session-cwd`。Commit：`⚡feat(core): 取消后不执行 + 每会话真实 cwd（S1）`

### S2 — 结构化审批队列（`server/ws`/`sessions`、`agent/subagent.ts`）

- 两并发审批不覆盖；父用户在 child 结束前见审批；response ack/scope/过期/重连恢复；**无授权自动 allow** 必须拒绝。
- 测：`approval-queue`。Commit：`✨feat(core): 结构化审批队列与重连恢复（S2）`

### S3 — 运行时账本 + 幂等交付（`interaction/runtime-journal.ts`、`delivery.ts`、`server/ws/http/sessions`、session 可选元数据）

- 重复 submit 只接受一次；ack 丢失/跨文件崩溃可对账；snapshot+replay+delta 无缺口；queue 可恢复且**重启后不自动执行**。
- 测：`delivery-idempotency`、`runtime-journal-crash`、`subscription-resume`。Commit：`🔧feat(core): runtime 账本与幂等交付（S3）`

### S4 — 有界 attempt 重试（`provider/*`、`agent/loop`、`interaction/retry-policy.ts`）

- 429/503/EOF/401 分开；预算/Retry-After/退避可取消；工具调用半截不执行；已完成工具不重跑；finalText 为空仍有可行动结果。
- 测：`attempt-retry`。Commit：`⚡feat(core): 有界 attempt 重试与错误码分类（S4）`

### S5 — 任务协调器 + 子代理并发（`agent/subagent.ts`、`agent/task-coordinator.ts`、工具注册/资源锁、CLI/server 仅接线）

- 注册 ack 后立即 handle；只读过滤后 K=2 真实重叠；共享写全局串行；status/wait/continue/cancel 与父子隔离、终态单调。
- 测：`task-coordinator`、`subagent-coordinator`。Commit：`✨feat(core): 任务协调器（子代理后台并发，S5）`

### S6 — step 边界 steer + 投影兼容（`loop` 控制输入 + `interaction/types` + 投影兼容测试）

- 安全 step 边界 steer；stale 拒绝且保 draft；重复 id 不双注入；无法取消工具时不强行新 step。
- 测：`steer-boundary`。Commit：`✨feat(core): 安全 step 边界 steer 与投影兼容（S6）`

### S7 — 桌面功能闭环契约（先于桌面联调；复**用既有接口，禁止做第二套工具执行器或配置存储**）

- 核查并补齐 `config/schema/load`、`agent/types/loop`、`tools/types/executor`、`session/snapshots`、`server/http/sessions`；拟新增 `interaction/run-config.ts`、`plan-state.ts`、`execution-view.ts`、`change-review.ts`（最终路径由 S0 确认）。
- 契约：`effectiveRunConfig`（会话 root/cwd、provider/model 与角色、模式/策略、可用工具、连接状态、指令/skill 来源、上下文窗口与预算，只返回脱敏信息；新 turn 记录配置 revision、生效时点明确）；`planState`（planId/目标/步骤/状态/证据 ID，须可重建，确认计划不放宽权限）；`toolExecutionView`（callId/taskId/turnId、tool、参数、cwd、实际 shell、开始/结束、输出引用/截断、exitCode、状态）；`changeReview`（用现有 SnapshotStore 聚合 changeSet，区分拟议与真实 diff，undo/redo 前比对当前版本、外部修改不静默覆盖，不自动 git reset/clean/stash/commit）。
- 测：`effective-run-config`、`plan-execution-boundary`、`command-output-exit-code`、`change-review-user-dirty`、`undo-external-conflict`。Commit：`✨feat(core): 桌面功能闭环契约（有效配置/计划/命令执行/变更审查，S7）`

---

## 代码审查（阶段级，验收前）

**审查方：** 独立子代理（非实现者）；面：风格/测试完整性/依赖/架构红线（不破坏事件溯源、不暴露 shell）/API 契约一致性/安全。
**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表，❌ 下放）/ ❌ 不通过（阻塞）

---

## 验收标准总表

| #   | 标准                                    | 通过条件                                                                                                                            | 验证责任人 |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | 取消后不执行                            | `executor-cancel-before-start`                                                                                                      | 自动化     |
| 2   | 审批并发不覆盖                          | `approval-queue`                                                                                                                    | 自动化     |
| 3   | 交付幂等/崩溃对账                       | `delivery-idempotency` + `runtime-journal-crash`                                                                                    | 自动化     |
| 4   | 订阅恢复无缺口                          | `subscription-resume`                                                                                                               | 自动化     |
| 5   | 有界重试分类                            | `attempt-retry`                                                                                                                     | 自动化     |
| 6   | 任务协调器并发/串行                     | `task-coordinator`                                                                                                                  | 自动化     |
| 7   | step 边界 steer                         | `steer-boundary`                                                                                                                    | 自动化     |
| 7b  | 桌面功能契约（有效配置/计划/命令/变更） | `effective-run-config`、`plan-execution-boundary`、`command-output-exit-code`、`change-review-user-dirty`、`undo-external-conflict` | 自动化     |
| 8   | 投影/replay/undo 一致                   | 全量回归 + 旧 v1 会话可读                                                                                                           | 自动化     |
| 9   | 全量回归                                | `pnpm -r test` 全绿（真实命中，非 `--passWithNoTests`）                                                                             | 自动化     |
| 2b  | 代码审查                                | ✅ / ⚠️；❌ 下放                                                                                                                    | 独立角色   |
| 10  | 红线                                    | 无禁止项、密钥未入库、`git ls-files` 无敏感文件                                                                                     | 自动化     |

---

## 风险与降级

| 风险             | 缓解                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| 动 core 面大     | 严格按 S 顺序；每步独立 commit + 防回归测试；不外包 `runTurn` 无限 retry |
| 公共事件类型变更 | 同步 parser/projector/export/replay/fixture + 迁移策略                   |
| 契约过大         | 按 I1 §6 冻结，YAGNI；新测试名必须真实命中 >0                            |

---

## 给接手 AI 的完整提示词

> 复制以下整段给实施/审查子代理：

```
你是 harness2 激进版「共享底座（S0-S7）」的实现者。先完整读：
- docs/ai-framework/phased-plan-driven.md（元规范）
- docs/ai-framework/plans/2026-09-08-phase-aggressive-core-foundation.md（本计划）
- docs/research/notion-ai-20260908-0056/04-implementation-plan.md（I1 R2，唯一契约来源）
- docs/research/notion-ai-20260908-0056/03-harness2-core-audit.md（已确认机制 + H1/H3 缺口）

基线：仓库 D:/AI_Projects/harness2，当前 main（业务研究基线 b1c2d815，packages 无 diff）。
从当前已核对 main 建独立 worktree `feat/notion-i1-runtime`。别切换/清理别人的 worktree，
不读取/覆盖其他协作者新研究/计划。默认不 push、不改用户配置、不提交密钥。
只用本地 stub 与临时 HOME/cwd 测试，不上传实际用户会话/附件/prompt 日志。

只做 S0-S7，按序。S7 为桌面功能闭环契约，复**用既有接口**，禁止另做一套工具执行器或配置存储。Global Constraints 优先级最高：
- 不破坏事件溯源/轨迹不变量：永久事件 append-only、单写者、模型可见输入仍由日志投影生成；
  临时 delta 不成下一轮模型上下文；公共事件类型变更须同步 parser/projector/export/replay/fixture。
- 保留已有安全边界：openai.ts 的 [DONE] 检查与半截工具不执行；executor.ts runWave 的调度约束。
- 桌面功能契约：仅返回脱敏信息；配置走既有 core 读写校验；计划不自动放权；命令输出/exitCode/变更归属可查询；undo 前比对当前版本、外部修改不静默覆盖；不自动 git reset/clean/stash/commit。
- 不做：Grok 云端/遥测/认证；第二套 Codex 后端；Tauri 迁移；Git 工作台/codemap；把取消当 undo、
  把重连当重发、承诺 shell/MCP exactly-once、默认自动 retry 工具。
- 命令用 PowerShell 5.1 分行（不连 &&），每条查 $LASTEXITCODE；测试名必须真实命中 >0，
  不能用 --passWithNoTests 造假绿。
- Git：只显式 add 本任务文件，小步 commit；***默认不 push***。

每 Task：先写失败用例 → 最小实现 → 跑对应包测试 → 贴「实际命令+输出」。
验收认证据：命令实际跑过，禁止「应该能过」。最后 `pnpm -r test` 全量回归。

完成后给出：worktree 名、commit 清单、逐 Task/逐验收项结果、真实测试输出、源码+许可复制映射、
已知风险（P0/P1 未闭环给「不通过/明确阻塞」，不宣称完成），并列出已启动进程的 PID 归属。
```

---

## 残留手工验收清单

1. 真实模型端到端：断流重试预算生效、撤消/重连不重跑工具、子代理并发调度、审批跨 pane 可见。
2. Windows 真机 IME/滚动/中断手感（留用户）。
