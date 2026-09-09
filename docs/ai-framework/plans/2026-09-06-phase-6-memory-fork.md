# 阶段 6：记忆系统（开关三态）+ 会话分叉

> **状态：** ✅ 已完成——2026-09-06 编排者验收通过（独立审查 pass-with-fixes → 2 P1 装配漏传 + 6 P2 已修复（`0ecccdc`）+ 覆盖缺口补测；重跑证据：pnpm test **397 passed + 1 skipped**、typecheck 3 包 Done、chat mock 冒烟 exit 0；契约扩展确仅两处、记忆红线通过；真实模型记忆三态行为待用户 key，见 OPEN.md）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 交付用户点名的记忆开关（off / 每次询问 / 自动）——hermes 实证方案落地：文件记忆 + 硬预算 + 写入 gate 三态 + nudge 后台复盘；同时交付分叉（fork）：从任意事件点派生新会话（血缘入 header）。
**Architecture:** 记忆是"会话开始时冻结进 system 的快照 + 每轮动态检索暂不引入（P2 前不做语义检索）"；分叉 = 复制活动事件到新会话 + header 血缘，原会话零改动。全部遵守 Model-visible ⟺ logged（记忆快照作为 `memory/snapshot` 事件落盘）。
**Tech Stack:** 现有栈；新增运行时依赖 0。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                  |
| ------ | ------------------------------------------------------------------------------------- |
| P0     | 本文件、`docs/research/2026-09-06-reference-analysis.md` §2.2（hermes 记忆实证）      |
| P0     | `packages/core/src/{provider/types.ts,agent/loop.ts,agent/types.ts,session/types.ts}` |
| P1     | `docs/issue-log/OPEN.md`、`CODE_REVIEW.md`                                            |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-6-memory-fork`

---

## Global Constraints（冲突时以本节为准）

1. **契约扩展仅限两处**（均加性可选）：①`ChatRequest` 增 `system?: string`（openai→system 消息 / anthropic→system 顶层参数）；②`SessionEventType` 增 `memory/snapshot`（payload 含 `content: string`，kv 校验为非空字符串）。其余 provider/loop 语义不动。
2. **密钥/隐私三不**：记忆内容不进 git、不出现在错误消息；`MEMORY.md` 属用户私有数据（~/.harness2），测试全用临时目录。
3. **记忆预算硬上限**：MEMORY.md 2200 字符 / USER.md 1375 字符（模型无关，对照 hermes）；超限由模型"删旧加新"整合，写入器强制拒绝超限单条。
4. **明确不做（本阶段）**：语义检索/向量库、记忆访问统计（Tokeny 式，后期）、记忆衰减评分、桌面端记忆管理 UI（仅 CLI 命令 + 服务 API）、跨会话记忆检索。
5. **Git：** 每 Task 一提交；禁止 push。

---

## 配置契约（本阶段冻结新增段）

```jsonc
// config.json 增段（缺省 = off，尊重用户默认隐私）
"memory": {
  "mode": "off",            // off | ask | auto —— 用户点名的开关
  "nudgeInterval": 10       // 每 N 个用户 turn 触发一次后台复盘（mode != off 时生效）
}
// 存储：~/.harness2/memories/MEMORY.md（agent 笔记）、USER.md（用户画像）、pending/（ask 模式暂存）
```

---

## File Structure（预期变更）

| 文件                                               | 动作 | 职责                                                                                                          |
| -------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/provider/types.ts`              | 修改 | ChatRequest.system（加性）；openai/anthropic 映射 + stub 测试                                                 |
| `packages/core/src/provider/{openai,anthropic}.ts` | 修改 | system 参数映射                                                                                               |
| `packages/core/src/memory/{store,tool}.ts`         | 新建 | MEMORY.md/USER.md 读写（§ 分隔、锁/原子写/漂移检测、§注入扫描）、`memory` 工具（add/replace/remove/批量原子） |
| `packages/core/src/memory/nudge.ts`                | 新建 | nudge 计数器（turn 末触发，模型调过 memory 工具即重置）+ 后台复盘 turn（roles.small）                         |
| `packages/core/src/session/types.ts`               | 修改 | `memory/snapshot` 事件类型 + 校验                                                                             |
| `packages/core/src/agent/loop.ts`                  | 修改 | 首个 user turn 前落 memory/snapshot + ChatRequest.system 注入（会话内冻结：后续轮复用快照不重读）             |
| `packages/core/src/session/fork.ts`                | 新建 | `forkSession(manager, id, {atSeq?})` → 新会话（header 血缘）+ 活动事件复制                                    |
| `packages/cli/src/{index,chat,commands}.ts`        | 修改 | `harness2 memory`（show/clear/pending/approve/reject）、REPL `/fork [seq]`、`harness2 chat --fork <id>`       |
| `packages/core/src/server/{http,sessions}.ts`      | 修改 | `POST /api/sessions/:id/fork {atSeq?}`（WS op 同步加）                                                        |
| `packages/core/test/{memory,fork,loop}.test.ts` 等 | 新建 | 见各 Task                                                                                                     |
| 文档（architecture/ROADMAP/HANDOFF/diary/OPEN）    | 修改 | 整备                                                                                                          |

---

## Task 1：system 缝 + memory/snapshot 事件

**Files:** provider/types、openai、anthropic、session/types、测试

**行为:** ChatRequest.system → openai 首条 `{role:'system',content}` / anthropic 顶层 `system`；`memory/snapshot` 事件加入 KNOWN_EVENT_TYPES + parseEventLine 校验；投影/渲染不特殊处理（正常活动事件，turn 分组归 `── turn -`）。

**Steps:** 1. 实现+测试（两协议 wire 映射、事件解析、旧日志兼容）。2. Commit：`✨feat(core): system 缝与 memory/snapshot 事件`

## Task 2：记忆存储与工具

**Files:** `memory/{store,tool}.ts`、`test/memory.test.ts`

**行为（对照 hermes 实证）:**

- store：`§\n` 分隔条目；字符预算（超限拒绝并报剩余空间）；文件锁 + 原子写（tmp+rename）；**漂移检测**（重写前 round-trip 校验，手工编辑破坏 § 结构 → 拒写并 .bak 备份）；**注入扫描**（条目含典型注入模式——"忽略之前指令/系统提示"类——标记警告仍写入，扫描结果随 tool result 返回）。
- `memory` 工具（注册进 ToolRegistry，unsafe）：`{operation:'add'|'replace'|'remove', target:'memory'|'user', text?, oldText?}` 与 `operations` 批量数组（原子执行：全成或全不成，预算按最终态校验一次——"删旧加新"场景）。
- 测试：预算边界/原子批量/漂移拒写/注入扫描/锁并发（同进程串行断言）。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core): 记忆存储与 memory 工具（预算/漂移检测/注入扫描）`

## Task 3：记忆开关与注入

**Files:** config/schema、agent/loop、测试

**行为:** config.memory 三态；`runTurn` 首个 user turn（且 mode≠off）时：读 store → append `memory/snapshot` 事件 → ChatRequest.system 注入（**会话内冻结**：后续轮检查日志已有 memory/snapshot 则复用其 content，不重读文件——保 prefix cache 语义）；mode=off 完全不注入不落事件。工具注册条件：mode≠off 时才注册 memory 工具（off 时模型根本看不到）。

**Steps:** 1. 实现+测试（off 注入零/ask+auto 注入且事件可重建/wire 含 system/冻结语义/不变量测试扩展：system 也从日志重建——MockProvider 捕获 requests[].system === 日志 memory/snapshot.content）。2. Commit：`✨feat(core): 记忆开关与冻结注入（快照事件化）`

## Task 4：nudge 后台复盘 + pending 审批

**Files:** `memory/nudge.ts`、cli memory 命令、测试

**行为:** SessionHub 持每会话 nudge 计数（用户 turn 完成时 +1；模型 turn 内调过 memory 工具 → 归零）；到 nudgeInterval → 复盘 turn：用 `roles.small` provider、独立 MockProvider 形态的系统提示（"回顾对话，考虑是否有值得长期记住的用户偏好/事实"）、**只挂 memory 工具**、不落主会话日志（复盘的产出 = memory 写入或 pending 暂存）。写入 gate：mode=auto → 直接写；mode=ask → 落 `~/.harness2/memories/pending/<ts>-<id>.json`（记 target/text/来源会话），`harness2 memory pending|approve <id>|reject <id>` 重放执行（只延迟不丢弃）。**复盘在 turn-end 回调后异步进行，不阻塞主对话**；主对话日志完整可见 nudge 触发（`TurnResult.warning`? 否——复盘不落主日志，纳入 hub 事件帧 `type:'event'` 之外的 `nudge-started`/`nudge-finished` 提示帧，UI 自行决定展示）。

**Steps:** 1. 实现+测试（计数/重置/触发/mock small 写记忆/pending→approve 落盘/拒绝丢弃/复盘异常不影响主对话）。2. Commit：`✨feat(core): nudge 后台复盘与记忆 pending 审批`

## Task 5：会话分叉

**Files:** `session/fork.ts`、cli、server、测试

**行为:** `forkSession(manager, id, {atSeq?})`：读原会话活动投影 → 截取 `seq <= atSeq`（缺省=全部活动）的**非 header 事件** → 新会话 writer 按序重放（新 seq）→ 新 header `parentSession: <id>, isSeeded: true` → 返回新会话 id。快照/rewind_points 不复制（新会话 undo 从零开始，README 注明）。入口：`harness2 chat --fork <id> [--at <seq>]`、REPL `/fork [seq]`、`POST /api/sessions/:id/fork` + WS op `fork`。测试：分叉后投影一致（同 atSeq）/原会话零变化（字节级）/血缘字段/影子事件不复制/atSeq 越界。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core,cli): 会话分叉（血缘 header/活动事件重放/三端入口）`

## Task 6：整备与交接

architecture（记忆/分叉小节）、ROADMAP（P1-14/15 → ✅）、HANDOFF、diary、OPEN（真实模型记忆行为待 key；桌面 fork/memory UI 待后续阶段）。

---

## 验收标准总表

| #   | 标准          | 通过条件                                                        |
| --- | ------------- | --------------------------------------------------------------- |
| 1   | system 缝     | 两协议 wire 映射测试通过；既有测试零破坏                        |
| 2   | 记忆存储      | 预算/原子/漂移/注入扫描测试通过                                 |
| 3   | 开关注入      | off=零注入；ask/auto=注入+事件可重建；冻结语义测试通过          |
| 4   | 不变量扩展    | MockProvider requests[].system === 日志 memory/snapshot.content |
| 5   | nudge/pending | 触发/复位/pending→approve/reject 测试通过；主对话零阻塞         |
| 6   | 分叉          | 投影一致/原会话零变化/血缘/边界测试通过；三端入口可用           |
| 7   | 红线          | 记忆内容不入 git；off 模式下 store 零写入；契约扩展仅两处       |
| 8   | 单测/构建     | `pnpm test && pnpm -r typecheck` exit 0                         |

---

## 风险与降级

| 风险                             | 缓解                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| system 注入破坏既有 prefix 语义  | 冻结快照 + 事件可重建；不变量测试扩展覆盖 system           |
| 复盘 turn 与主 turn 竞争记忆文件 | store 文件锁 + 原子写；复盘失败静默（主对话无感）          |
| 分叉大日志复制耗时               | 活动事件内存重放（阶段 1 已知限制口径内）；OPEN 登记       |
| off→ask/auto 切换后旧会话无快照  | 注入以"会话首个 user turn"为界，老会话首个新 turn 即补快照 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 6 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-6-memory-fork`
- 已完成（勿重做）：阶段 1-5 均验收（内核/loop+工具/Provider+配置/CLI chat+undo-redo/服务化+桌面壳），当前 312 passed + 1 skipped
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-6-memory-fork.md`
- 必读：本计划、`docs/research/2026-09-06-reference-analysis.md` §2.2（hermes 记忆实证）、`agent/loop.ts`、`provider/types.ts`、`AGENTS.md`

### 做

1. 严格按 Task 1→6 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：契约扩展仅两处（ChatRequest.system、memory/snapshot 事件）；记忆预算硬上限；off 模式零写入零注入；记忆内容不入 git
3. 不变量扩展：MockProvider requests[].system 必须可从日志 memory/snapshot 事件重建
4. Task 6 更新 architecture/ROADMAP（P1-14/15 → ✅）/HANDOFF/diary/OPEN

### 不做

- 语义检索/向量库、记忆统计衰减、桌面记忆管理 UI、跨会话检索
- 提交密钥；任何 `git push`

### 工作方式

1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷

分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 6。

---

## 残留手工验收清单

1. （用户 key）真实模型下三态记忆行为：off 无注入 → ask 触发 pending → auto 直接记忆并在新会话生效
2. 分叉会话在桌面端展示与继续对话（fork 的桌面 UI 按钮属后续迭代）
3. 记忆文件手工编辑后的漂移拒写提示（MEMORY.md 用记事本改坏 § 结构）
