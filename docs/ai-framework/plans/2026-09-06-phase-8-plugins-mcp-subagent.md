# 阶段 8：插件总线公开化 + MCP + Subagent

> **状态：** ✅ 已完成——2026-09-06 编排者验收通过（独立审查 pass-with-fixes → 4 P1 + 6 P2 全部修复（`5e9f048`，修复代理被并发限制打断于交卷前、实际已完成提交）：MCP scheduleRestart 幂等闸门堵竞态僵尸、maxTurns 1..200 解除契约矛盾、插件抢名降级不崩 chat、子会话独立快照兑现红线。重跑证据：pnpm test **527 项（526 passed + 1 skipped）**、typecheck 3 包 Done、P1 抽查属实、0 敏感文件。真实 MCP server 实测与第三方插件样例待用户环境，见 OPEN.md）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

---

## 形式验收（/accept-phase，2026-09-09 补 · B5-1）

> 阶段 12 收口时，本阶段的独立验收环节（`/accept-phase`）按档位确定为跳过项、登记为「未执行 ➖」。本次补形式验收记录，**不改变既有状态**（阶段实现与自动化验证早已完成并通过既有验收，此处补的是被跳过的独立验收环节记录）。

**① 结论（补登记 · 形式验收通过 ≠ 完整验证）**

本阶段列为「未执行 ➖（档位跳过）」（阶段 12 收口登记），本次补形式验收记录，不改变既有状态。形式验收通过 ≠ 完整验证，**不构成「已验证 ✅ 通过」声明**：本阶段未做真实 MCP server 实测与第三方插件样例验证（当时依赖用户环境，见 ③）。

**② 依据**

- 跳过项登记来源：阶段 15 计划「阶段开头：上阶段遗留」——「阶段 5 / 6 / 8 未做形式验收 · 阶段 12 收口 · 当时按档位跳过，登记为『未执行』」（⬜ B5-1）。
- 本次补登记所依据的既有验收证据（2026-09-06）：编排者验收通过（独立审查 pass-with-fixes → 4 P1 + 6 P2 全部修复 `5e9f048`：MCP scheduleRestart 幂等闸门堵竞态僵尸、maxTurns 1..200 解除契约矛盾、插件抢名降级不崩 chat、子会话独立快照兑现红线；修复代理被并发限制打断于交卷前、实际已完成提交）；重跑证据 `pnpm test` **527 项（526 passed + 1 skipped）**、typecheck 3 包 Done、P1 抽查属实、0 敏感文件。
- **未做端到端真机**：真实 MCP server 实测与第三方插件样例装载当时待用户环境（清单见 ③）。

**③ 遗留与边界（真机 / 外部依赖清单）**

1. 真实 MCP server 实测（阶段 8 遗留）——阶段 15 A2-1 第 3 批已在本地统一网关补做真机验证（filesystem server 探测 + `mcp__filesystem__*` 真实调用，2026-09-09）
2. 第三方插件样例装载（阶段 8 遗留）——阶段 15 A2-1 第 3 批从零写 `a2demo` 插件真实装载/事件订阅/工具调用已验证（2026-09-09）
3. 插件 UI 扩展点、MCP resources/prompts（仅 tools）、worker/isolate 隔离——阶段 8 明确不做，留档评估
4. 沙箱边界如实声明（v1 同进程非隔离，manifest 权限仅 API 层约束）——已由阶段 15 B4-3 在 README / 文档站 / `plugin list` 三处强化（2026-09-09）

**④ 附带说明**

- 本阶段真机/外部依赖项均已登记在 `docs/issue-log/OPEN.md`。本次补记仅新增本小节，不改动顶部「状态」行既有内容（仍为「✅ 已完成」）；本补记不构成新的「验证通过 ✅」声明。

---

**Goal:** 打开扩展生态的三扇门——第三方插件（轻量总线公开化 + 声明式权限）、MCP 工具接入（官方 SDK）、subagent（独立会话子任务）。核心不变量与既有测试零破坏。
**Architecture:** 插件 = 经总线注册能力（工具/事件监听/定时任务）的 ESM 模块，manifest 声明式权限 + 装载审批（v1 进程内、非隔离，如实声明）；MCP 服务器经官方 SDK 桥接为 namespaced 工具；subagent 是一个工具（unsafe），在**独立子会话**跑完整 runTurn（天然继承事件溯源/轨迹/undo 隔离），父子以 header 血缘 + tool/result 关联——**零新增事件类型**。
**Tech Stack:** 现有栈；新增运行时依赖 `@modelcontextprotocol/sdk`（MCP 官方 TS SDK）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 本文件、`docs/ROADMAP.md`（D4、P2-20/24/25）                                                                                                         |
| P0     | `packages/core/src/tools/{types,registry,executor}.ts`（总线先例：注册返回 disposer）、`server/sessions.ts`（装配层）、`session/fork.ts`（血缘先例） |
| P1     | MCP 官方文档（Model Context Protocol spec，SDK 用法以当期版本 README 为准）、`docs/issue-log/OPEN.md`                                                |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-8-plugins-mcp-subagent`

---

## Global Constraints（冲突时以本节为准）

1. **零新增事件类型**：subagent 全程复用 tool/call + tool/result（args/result 里带 childSessionId）；MCP 工具调用同普通工具。
2. **沙箱边界如实声明**（v1 进程内，非隔离）：manifest 声明式权限（tools/events/cron/fs 范围）+ 装载审批（首次启用需用户确认，config 记录）；代码隔离（worker/isolate）评估后留档，不冒进。
3. **MCP 边界**：MCP 工具名空间化 `mcp__<server>__<tool>`，与本地工具冲突时本地优先 + 装载告警；MCP 服务器崩溃不拖垮主进程（子进程生命周期管理 + 重启退避上限 3）。
4. **subagent 红线**：深度限制默认 1（子会话内不再注册 subagent 工具，可用 config.subagent.maxDepth 调）；子会话独立目录/独立快照/独立审批（上抛同一审批缝）；取消传播（父 abort → 子 abort）。
5. **明确不做（本阶段）**：插件市场/远程分发、插件 UI 扩展点、MCP resources/prompts（仅 tools）、worker 隔离。
6. **Git：** 每 Task 一提交；禁止 push。

---

## 配置契约（本阶段冻结新增段）

```jsonc
"plugins": {
  "enabled": true,
  "allow": ["demo-plugin"]          // 已批准装载的插件名（装载审批结果记录处）
},
"mcpServers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  "remote": { "url": "http://127.0.0.1:8802/mcp" }
},
"subagent": { "maxDepth": 1, "maxTurns": 25 }   // roles.subagent 复用既有配置
```

---

## File Structure（预期变更）

| 文件                                                | 动作 | 职责                                                                                                                  |
| --------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/plugins/{types,loader,bus}.ts`   | 新建 | definePlugin 契约、目录扫描 + manifest 校验 + 装载审批、总线（ctx：registerTool/on/config/logger，全部返回 disposer） |
| `packages/core/src/mcp/client.ts`                   | 新建 | SDK 集成：连接（stdio/url）、工具枚举、namespaced 注册、断线退避重启、崩溃不拖垮                                      |
| `packages/core/src/agent/subagent.ts`               | 新建 | subagent_start/continue 工具（独立子会话 + runTurn + 深度/取消传播）                                                  |
| `packages/core/src/server/sessions.ts`              | 修改 | 装配层接入插件/MCP/subagent（模式开关透传）                                                                           |
| `packages/cli/src/index.ts`                         | 修改 | `harness2 plugin list/enable/disable`、`harness2 mcp list`                                                            |
| `packages/desktop`                                  | 修改 | 插件/MCP 工具行渲染（名称前缀区分）、subagent 工具行（子会话 id 可跳转 traj）                                         |
| `packages/core/test/{plugins,mcp,subagent}.test.ts` | 新建 | 见各 Task                                                                                                             |
| 文档（architecture/ROADMAP/HANDOFF/diary/OPEN）     | 修改 | 整备                                                                                                                  |

---

## Task 1：插件总线

**Files:** `plugins/*`、`test/plugins.test.ts`

**行为:**

- 插件形态：`~/.harness2/plugins/<name>/manifest.json`（`{name, version, permissions: {tools?: true|string[], events?: string[], cron?: true}}`）+ `index.js`（默认导出 `definePlugin({name, setup(ctx)})`）。
- `PluginContext`：`registerTool(def)`（进 ToolRegistry，重名拒绝）、`on(event, handler)`（hub 事件总线）、`log()`（带插件前缀）、`config()`（只读）。**全部返回 disposer**；卸载插件 = 依序展开。
- 装载审批：manifest 合法 + `config.plugins.allow` 含该名 → 装载；不在 allow → 跳过并告警（`plugin enable <name>` 走审批：CLI 打印权限清单要求确认后写入 allow）。
- 测试：装载/权限拒绝/重名拒绝/disposer 逆序展开/manifest 非法跳过（≥10 例，fixture 插件写临时目录）。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core): 插件总线（manifest 权限/装载审批/disposer 逆序展开）`

## Task 2：MCP 客户端

**Files:** `mcp/client.ts`、`test/mcp.test.ts`

**行为:**

- 依赖 `@modelcontextprotocol/sdk`；config.mcpServers 每项连接（stdio：spawn 子进程；url：HTTP）→ `listTools` → 以 `mcp__<server>__<tool>` 注册（schema 透传、unsafe=true 默认走审批）。
- 生命周期：连接失败/中途断开 → 退避重启（上限 3）→ 该 server 工具全部下线（disposer）+ 告警，**不拖垮主进程**；`harness2 mcp list` 显示各 server 状态与工具数。
- 测试：用 SDK 起一个**本地内存 MCP server**（同一 SDK 的 server 端）覆盖：枚举注册/工具调用往返（echo 工具）/断线重启/名称冲突告警。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core): MCP 客户端（stdio/url/断线退避/namespaced 工具）`

## Task 3：Subagent

**Files:** `agent/subagent.ts`、`test/subagent.test.ts`

**行为:**

- `subagent_start {prompt, cwd?}`：SessionManager.create 子会话（header：parentSession=父会话 id、isSeeded=true、subagent=true）→ runTurn（roles.subagent、工具集=父集**减去** subagent 工具——深度 1 的实现方式；maxTurns=config.subagent.maxTurns）→ result 带 `{childSessionId, finalText, stopReason}`（tool/result.output）。父取消 → 子 AbortController.abort（事件照常落盘）。
- `subagent_continue {childSessionId, message}`：向子会话追加用户消息并 runTurn（复用 hub 排队语义或直调，取简）。
- 深度控制实现：工具集构造时按 `depth < maxDepth` 条件注册 subagent 工具（hub/CLI 装配层传 depth）。
- 测试：子会话独立落盘/血缘/取消传播/深度 1 时子内无 subagent 工具/continue 往返/子失败不影响父（≥10 例，mock provider）。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core): subagent 工具（独立子会话/深度限制/取消传播）`

## Task 4：装配层与端侧集成

**Files:** `server/sessions.ts`、cli、desktop、测试

**行为:** hub 装配链 = 本地工具 + 插件工具 + MCP 工具 + subagent（按 config/模式开关）；serve/CLI 同构；desktop 渲染区分 `mcp__/subagent` 工具名前缀与子会话跳转。测试：装配顺序与冲突、disable 开关、REPL 内 subagent 调用端到端（mock）。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core,cli,desktop): 插件/MCP/subagent 装配与端侧渲染`

## Task 5：整备与交接

architecture（插件/MCP/subagent 小节）、ROADMAP（P2-20/24/25 → ✅）、HANDOFF、diary、OPEN（真实 MCP server 实测与第三方插件样例待用户环境验证）。

---

## 验收标准总表

| #   | 标准      | 通过条件                                                      |
| --- | --------- | ------------------------------------------------------------- |
| 1   | 插件总线  | 装载/权限/disposer/非法 manifest 测试通过                     |
| 2   | MCP       | 本地 server 枚举/调用/断线重启/冲突告警测试通过               |
| 3   | Subagent  | 独立会话/血缘/取消/深度限制/continue 测试通过；零新增事件类型 |
| 4   | 装配集成  | 四类工具来源共存、冲突优先级、开关生效测试通过                |
| 5   | 红线      | 无新增事件类型；沙箱边界如实声明；密钥三不                    |
| 6   | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0                       |

---

## 风险与降级

| 风险              | 缓解                                                     |
| ----------------- | -------------------------------------------------------- |
| MCP SDK API 变动  | 锁定版本；适配层薄封装（只依赖 listTools/callTool 两面） |
| 插件进程内无隔离  | manifest 权限 + 装载审批 + 如实声明；worker 隔离留档评估 |
| subagent 递归失控 | 深度默认 1 + maxTurns + 独立会话成本可见（traj）         |
| 三类工具来源冲突  | 注册冲突策略：本地 > 插件 > MCP（冲突告警不中断）        |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 8 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-8-plugins-mcp-subagent`
- 已完成（勿重做）：阶段 1-7 均验收（内核/loop+工具/Provider+配置/CLI+undo/服务化+桌面/记忆+分叉/浏览器+压缩+cron）
- 唯一实施计划：`docs/ai-framework/plans/2026-09-XX-phase-8-plugins-mcp-subagent.md`（以仓库内实际文件为准）
- 必读：本计划、`tools/{types,registry}.ts`、`session/fork.ts`、`server/sessions.ts`、`AGENTS.md`

### 做

1. 严格按 Task 1→5 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：零新增事件类型；沙箱边界如实声明；MCP 崩溃不拖垮主进程；subagent 深度/取消红线
3. Task 5 更新 architecture/ROADMAP（P2-20/24/25 → ✅）/HANDOFF/diary/OPEN

### 不做

- 插件市场、插件 UI 扩展点、MCP resources/prompts、worker 隔离
- 提交密钥；任何 `git push`

### 工作方式

1. 先跑基线 `pnpm test` 确认全绿再动工
2. MCP 测试用同一 SDK 起本地内存 server（零外部依赖）
3. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
4. 简体中文回复；代码标识符原样

### 交卷

分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 5。

---

## 残留手工验收清单

1. （用户环境）真实 MCP server（如 filesystem）接入与工具调用
2. 第三方插件样例从零装载全流程（含审批）
3. 桌面端 subagent 子会话跳转 traj 体验
