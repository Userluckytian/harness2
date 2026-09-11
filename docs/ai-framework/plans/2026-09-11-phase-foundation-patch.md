# 阶段 16-地基补丁与并行开工闸门（P0–P4）

> **状态：** 计划已就绪（2026-09-11）
> **来源：** 阶段 15 质量收口验收表 `2026-09-09-phase-quality-closeout-acceptance.md` §6「不通过项与下放」全部条目；`docs/issue-log/OPEN.md`
> **角色：** **单人串行前置**阶段，由**独立的第三人**执行（2026-09-11 定），与终端 T 轨、桌面 D 轨的两位实施者**互不兼任**。本阶段合入 main 并宣布冻结之前，T 轨（T0–T5）与 D 轨（D0–D6）**都不得开工**。
> **为什么必须串行：** §6 下放的缺陷里有 3 项是**跨包**的（serve token 要同时改 core + cli + desktop + gateway）。若放进并行窗口，两个人必然在同一批文件上对撞——这正是上一次「穿插」的根因。把跨包改动集中在一个串行窗口内做完，后面的并行才成立。
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 一次性修完阶段 15 下放的跨端缺陷，然后**冻结 `packages/core` 与 `packages/gateway` 的对外契约**，给终端与桌面两轨提供一个「两边只读同一份 core」的稳定基线；同时把两轨的文件所有权、共享文档写入规则、合入纪律定死。
**Architecture：** 只修缺陷与接线，不引入新架构；不新增事件类型；不改 agent 内核编排；`turn-end` 语义不变；不破坏轨迹不变量。
**Tech Stack：** TS · vitest · Electron（仅 main 进程接线）
**实施档位：** 全能（开发 + 测试 + 自评 + 独立只读子代理审查）
**子代理：** 启用（阶段级代码审查；并补派阶段 15 欠的 A4/B3 拆分类审查）

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`、`coding-standards.md`                |
| P0     | `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`（§6 下放表、§7 未执行、§8 手工清单） |
| P0     | `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-rework.md`（§10 R7–R9、§11 R10 闭环记录）           |
| P1     | `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md`（§A3 安全、§A5 网关复审）          |
| P1     | `packages/core/src/server/security.ts`、`server/http.ts`、`packages/core/test/serve-security.test.ts`          |
| P1     | `packages/desktop/src/main/serve-manager.ts`（`waitForHealth`，约 L96–110）                                    |
| P1     | `packages/gateway/src/router.ts`（会话解析）、飞书适配器与 `startGateway`（路径以实际为准）                    |
| P1     | `docs/issue-log/OPEN.md`、`docs/issue-log/DECISIONS.md`                                                        |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 从当前 `main`（≥ `5a5984d`）建 `fix/foundation-patch`。别在主工作树切分支；不删他人 worktree；git 不 reset/clean。

---

## Global Constraints（冲突时以本节为准）

1. **本阶段是唯一允许跨包改动的窗口**：`core` / `cli` / `desktop` / `gateway` 都可以改。P4 冻结后这个窗口关闭，两轨各自只能动自己的包。
2. **不新增事件类型、不改内核编排**：`turn-end` 语义不变；不破坏轨迹不变量；Model-visible ⟺ logged 不变。
3. **先失败用例再修**：每个缺陷都必须有一条**先红后绿**的自动化用例；禁止只改文档宣布修好；禁止注释或删除失败用例。
4. **不重构、不升级依赖**（修复必需的除外）；不做任何 T/D 的 UI 工作。
5. Git：只显式 `git add` 本任务文件（**禁 `git add -A`**）；小步 commit；提交格式 `<gitmoji><type>(<scope>): <中文描述>`；禁 force push；禁在 main 上试错；禁 `--passWithNoTests`。
6. **合入闸门**：合入 main 前 `fix/foundation-patch` 分支 CI 必须 **windows / ubuntu / macos 三平台全绿**，并以 `--no-ff` 合入。
7. 密钥不进 git；本地模型 key 只写隔离 `--home` 下的 `auth.json`。

---

## 阶段开头：上阶段遗留（抄自阶段 15 验收表 §6，逐条）

| 遗留项                        | 原因摘要                                                                                                                        | 本阶段动作                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A3 P1-1                       | serve 一次性 token 默认「兼容回退」；严格模式又因 desktop/CLI/gateway 不带 token 不可用（两半互斥）                             | **P2 闭环**                          |
| A3 P1-2                       | `serve-manager.ts` 的 `waitForHealth` 把 `401` 当健康（`res.status > 0`）→ 桌面显示已连接但全部失败                             | **P2 闭环**                          |
| A3 P2-3                       | playwright 缺失时 `require.resolve` 直接抛 `MODULE_NOT_FOUND` 走 crash reporter，而非「先装」指引                               | **P3 闭环**                          |
| A3 P2-1 / P2-2                | Windows 实测锁文件权限 `644`；覆盖已存在锁文件时 `writeFileSync` 的 `mode` 不生效                                               | **P3 闭环**（含文档如实改写）        |
| A5 P1-1                       | 飞书适配器 webhook 端口冲突（EADDRINUSE）时 `startGateway` 永久挂死，CLI `harness2 gateway` 假死                                | **P1 闭环**                          |
| A5 P1-2                       | 同一新 chat 并发消息建双会话：`router.ts` 的 get-check 与 `await createSession` 之间无在途去重                                  | **P0 闭环**                          |
| A5 P1-3                       | 阶段 9 修复提交几乎零新增测试；断线重连/msg_seq/startGateway 生命周期/飞书策略/QQ 心跳均无回归覆盖                              | **P1 闭环**（5 条）                  |
| 无独立人工审查（R7）          | 阶段 15 的专职人工审查经人类豁免，`git worktree` 只读审查树未建立                                                               | 本阶段派独立只读子代理审查           |
| A4/B3 拆分类独立审查未派      | `sessions.ts` 拆分与 cli/desktop 拆分未派独立子代理审查                                                                         | 本阶段一并补派，或人类明示接受风险   |
| CI 首跑 POSIX 两平台红（R10） | 已于 2026-09-11 闭环：四处真因修复，main [run #44](https://github.com/Userluckytian/harness2/actions/runs/34555011219) 7/7 全绿 | ✅ 无需处理；纪律沿用「CI 红即停线」 |

> 另有两条**契约层**遗留（非 §6，但 T/D 都会消费，必须在冻结前定死）：
>
> 1. network 错误收尾时 `finalText` 为空——「无最终文本但有可行动结果」的展示语义（S7 契约 L124）。
> 2. assistant / attempt 半截文本的展示语义（原计划下放到 D 阶段确认，但终端同样要渲染）。
>
> 二者归 **P3**，一次定义、两端共用，避免两轨各自发明一套。

---

## 跳过项（本阶段不做，**非缺陷**）

| 跳过项                                                                                      | 原因                  | 待补做                      |
| ------------------------------------------------------------------------------------------- | --------------------- | --------------------------- |
| A-6 Windows 真机联网验证、B-13 三张真机截图、§8 六项手工清单                                | 需人类实机            | ⬜ 人类待办                 |
| B6 发布（npm 双包 / tag v1.0.0）                                                            | 待人类授权            | ⬜ 另行；CI 已绿，只差授权  |
| 剩余 node20 actions（upload-artifact / configure-pages / deploy-pages / download-artifact） | P2，与本阶段目标无关  | ⬜ 登记，择期统一升         |
| core `vitest.config.mts` 的 `include` 未含 `.tsx`                                           | 当前 core 无 tsx 测试 | ⬜ 登记；若本阶段新增则同步 |

---

## File Structure（预期变更）

| 文件                                                                         | 动作 | 职责                                                |
| ---------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| `packages/gateway/src/router.ts`                                             | 修改 | P0：per-key in-flight promise 去重                  |
| 飞书适配器 + `startGateway`（`packages/gateway/src/**`，路径以实际为准）     | 修改 | P1：`listen` 错误路径 reject，不再挂死              |
| `packages/gateway/test/**`                                                   | 新增 | P0/P1：去重、listen 错误、重连、msg_seq、心跳回归   |
| `packages/core/src/server/security.ts`、`server/http.ts`                     | 修改 | P2：默认严格模式开关与判定                          |
| `packages/cli/src/**`（serve / gateway 客户端，路径以实际为准）              | 修改 | P2：CLI 侧携带 token                                |
| `packages/desktop/src/main/serve-manager.ts`、`main/bridge.ts`、`preload/**` | 修改 | P2：token 注入 + `waitForHealth` 区分 `2xx` / `401` |
| 锁文件写入处（`packages/core/src/server/**`，路径以实际为准）                | 修改 | P3：POSIX `chmod 0600`（或先 unlink 再写）          |
| playwright 解析处（`packages/core/src/tools/**`，路径以实际为准）            | 修改 | P3：catch 后复用既有降级文案                        |
| `packages/core/src/agent/loop.ts` 及相关契约文件                             | 修改 | P3：`finalText` 空收尾 / 半截文本展示语义           |
| `packages/core/test/**`                                                      | 新增 | P2/P3：token 三端、401 健康、finalText、半截文本    |
| `docs/API-STABILITY.md`、`docs/issue-log/OPEN.md`、`docs/HANDOFF.md`         | 修改 | P4：冻结公告与边界表生效声明                        |

---

## 任务

### P0 — 网关会话在途去重（A5 P1-2，P1 级）

- `router.ts` 的 resolve 增加 **per-chatKey 在途 promise map**（或对 chatKey 串行化）：get-check 与 `await createSession` 之间不得有并发窗口。
- 必须覆盖：同一新 chat **并发两条消息** → 只建 1 个会话、两条消息进同一会话、`routes.json` 与实际一致、无孤儿会话。
- 测：`gateway-router-inflight`（先红后绿，断言 `created === 1`）。
- Commit：`🐛fix(gateway): 同一 chat 并发消息在途去重，杜绝双会话（P0）`

### P1 — 网关启动错误路径 + 回归测试补齐（A5 P1-1 / P1-3，P1 级）

- **P1-a**：`listen` 错误路径 reject（`once('error')` → reject），端口冲突时如实报错退出，不再让 `await adapter.start()` 永不落定。
- **P1-b**：补 5 条回归 —— ① 断线重连 + 重订阅 ② `msg_seq` 递增（含并发） ③ `startGateway` 确实调用 `adapter.start` ④ 飞书策略 / `verificationToken` 校验 ⑤ QQ WS 心跳 / op7 / op9 / 退避。
- 测：`gateway-listen-error` + 上述 5 条。
- Commit：`🐛fix(gateway): 端口冲突如实失败而非挂死（P1）` / `✅test(gateway): 补齐重连・msg_seq・生命周期・策略・心跳回归（P1）`

### P2 — serve token 三端贯通 + 默认严格模式（A3 P1-1 / P1-2，P1 级）

- **core**：保留 `x-harness2-token` > `Authorization: Bearer` > `?token=` 的既有优先级；把「无 Origin 即放行」的兼容回退改为**默认严格**，并保留显式关闭开关（供本地调试，关闭时必须有明确告警）。
- **desktop**：main 进程经 env 注入或读 `serve.lock` 拿 token 并带上；`waitForHealth` **区分 `2xx` 与 `401`** —— 401 不得判为健康，要么继续等待要么明确报错，禁止「显示已连接但全部失败」。
- **cli / gateway**：客户端一律携带 token。
- 验收硬条件：**默认配置下**（不设任何 env）桌面能起、CLI 能连、网关能连，且**不带 token 的第三方进程连不上 WS**。
- 测：`serve-security.test.ts` 扩充 + `desktop-health-401` + CLI/gateway 冒烟。
- Commit：`🔒fix(core): serve 默认严格鉴权，三端贯通一次性 token（P2）`

### P3 — 契约收尾与 P2 级小缺陷（跨端语义，冻结前必须定死）

- **P3-a（契约）**：network 错误收尾 `finalText` 为空时的展示语义 —— 明确「无最终文本但有可行动结果」如何表达（字段 / 状态 / 原因），写进 S7 契约与测试，**终端和桌面共用同一语义**。
- **P3-b（契约）**：assistant / attempt 半截文本的展示语义（是否保留、如何标注中断）同样一次定死。
- **P3-c**：playwright 缺失 → catch `MODULE_NOT_FOUND` 后复用既有降级文案（指向 `harness2 browser install`），不走 crash reporter。
- **P3-d**：锁文件权限 —— POSIX 写入后 `chmodSync(0o600)`（或先 unlink 再写）；文档如实改写为「POSIX 0600 / Windows 继承目录 ACL」，同步修正验收表 A-8 的措辞。
- 测：`core-finaltext-network`、半截文本投影用例、playwright 降级用例、锁权限用例（POSIX 断言 + Windows 跳过并注明）。
- Commit：分 3–4 个小提交，`✨feat(core)` / `🐛fix(core)` / `📝docs` 按实际类型。

### P4 — 契约冻结与并行闸门（本阶段出口）

1. 全量：`pnpm lint` / `pnpm -r typecheck` / `pnpm test` 三条 **exit 0**（贴实际命令与输出）。
2. 推分支 → CI **三平台全绿** → `--no-ff` 合入 main。
3. 确认 `packages/core/test/fixtures/api-surface-baseline.json` 已更新且与实际导出一致（J-4 口径）。
4. 在 `docs/issue-log/OPEN.md` 与 `docs/HANDOFF.md` 写入**冻结公告**：冻结 commit、冻结范围（`packages/core`、`packages/gateway`）、生效时间、解冻方式（只能由编排者在 main 上开窗）。
5. 从冻结 commit 建两条分支：`feat/notion-i1-tui`（甲）、`feat/notion-i1-desktop`（乙），并通知两轨开工。
6. Commit：`🔀chore(repo): 地基补丁合入并冻结 core/gateway 契约（P4）`

---

## 代码审查（阶段级，验收前）

**审查方：** 独立只读子代理（非实现者）。
**面：** 风格 / 测试完整性（是否先红后绿、是否真实命中）/ 依赖 / 架构红线（不新增事件类型、不破坏轨迹不变量、桌面仍只是观察者）/ API 契约一致性 / 安全（token 严格模式是否真闭环、密钥脱敏）。
**附加：** 补派阶段 15 欠的 **A4（`sessions.ts` 拆分）与 B3（cli/desktop 拆分）** 只读审查各一份；若人类明确接受风险可豁免，但须在验收表登记。
**结论：** ✅ 通过 / ⚠️ 有条件通过 / ❌ 不通过

---

## 验收标准总表

| #   | 标准           | 通过条件                                                                 | 验证责任人 |
| --- | -------------- | ------------------------------------------------------------------------ | ---------- |
| 1   | 网关不建双会话 | 并发用例断言 `created === 1`，无孤儿会话，`routes.json` 一致             | 自动化     |
| 2   | 网关不挂死     | EADDRINUSE 时进程如实失败退出，promise 落定；用例覆盖                    | 自动化     |
| 3   | 网关回归覆盖   | 5 条回归全部存在且真实命中（重连 / msg_seq / 生命周期 / 策略 / 心跳）    | 自动化     |
| 4   | 鉴权默认闭环   | 默认配置下三端可用、无 token 的进程连不上；`serve-security` 扩充用例全绿 | 自动化     |
| 5   | 健康检查不误报 | 401 不判健康；桌面不再出现「已连接但全部失败」                           | 自动化     |
| 6   | 跨端语义已定死 | `finalText` 空与半截文本语义写入契约 + 用例；T/D 两轨引用同一处定义      | 自动化     |
| 7   | 全量回归       | `pnpm lint` / `pnpm -r typecheck` / `pnpm test` 均 exit 0（真实命中）    | 自动化     |
| 8   | CI 三平台      | 分支 CI windows / ubuntu / macos 全绿后方可合入                          | 自动化     |
| 2b  | 代码审查       | ✅ / ⚠️；❌ 下放。含 A4/B3 补派或人类明示接受                            | 独立角色   |
| 9   | 冻结公告       | OPEN.md / HANDOFF.md 写明冻结 commit、范围、解冻方式；两条分支已建       | 编排者     |
| 10  | 红线/密钥      | 无禁止项；`git ls-files` 无敏感文件                                      | 自动化     |

---

## 并行开工守则（T / D 两轨共同遵守；本节是两轨的上位规则）

### 1. 时间线（这是并行成立的前提）

```
P0-P4（单人串行，本文档）─→ 合入 main ─→ 宣布 core/gateway 冻结
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
              甲：feat/notion-i1-tui                         乙：feat/notion-i1-desktop
              （T0-T5，只动 packages/cli）                （D0-D6，只动 packages/desktop）
                    └─────────────────────────┬─────────────────────────┘
                                     各自 CI 三平台全绿
                                              ↓
                              先后 --no-ff 合入 main（后合者先并 main 再全量验一次）
```

P 阶段由独立第三人执行；期间 T 轨与 D 轨的两位**不空等也不动手**：读计划与研究文档、设计 fixture、草拟失败用例，**但不提交、不合入任何代码**，也不提前建分支。

### 2. 文件所有权表（红线）

| 范围                                                                                    | 甲（T / 终端）   | 乙（D / 桌面）      | 规则                                                   |
| --------------------------------------------------------------------------------------- | ---------------- | ------------------- | ------------------------------------------------------ |
| `packages/cli/**`                                                                       | **独占**         | 禁止                | —                                                      |
| `packages/desktop/**`                                                                   | 禁止             | **独占**            | —                                                      |
| `packages/core/**`、`packages/gateway/**`                                               | 只读             | 只读                | 需改→**停手**，登记 + 上报编排者，不得自行修改         |
| `packages/core/test/fixtures/api-surface-baseline.json`                                 | 禁止             | 禁止                | 冻结后不应变化；一旦变化即越界信号                     |
| 根 `package.json`、`pnpm-lock.yaml`                                                     | 加依赖前报备     | 加依赖前报备        | 后合入者**重跑 `pnpm install` 重新生成**，不手工解冲突 |
| `tsconfig.base.json`、`.github/workflows/**`、eslint / prettier 配置                    | 禁止             | 禁止                | 只能由编排者在 main 上统一改                           |
| `docs/issue-log/<日期>.md`                                                              | 写 `<日期>-T.md` | 写 `<日期>-D.md`    | **分文件**，杜绝同日同文件冲突                         |
| `OPEN.md`、`DECISIONS.md`、`HANDOFF.md`、`MASTER-PLAN.md`、`CHANGELOG.md`、`ROADMAP.md` | 阶段内不改       | 阶段内不改          | 各自记在自己计划文档里，合入后由编排者统一回填         |
| 各自阶段计划文档                                                                        | 独占 T 文件      | 独占 D 文件         | —                                                      |
| `docs/screenshots/**`                                                                   | `cli-chat.png`   | `desktop-multi.png` | 图槽分开；`traj-timeline.png` 归乙                     |

**「不得复制绕过」条款：** 禁止因为 core 只读，就把 core 的逻辑复制一份到自己的包里改。那是更坏的结果。

### 3. 合入纪律

1. 合入前：`git fetch origin && git merge origin/main`（**不 rebase 已推送的分支**）。
2. 本地三条命令 exit 0 → 推分支 → **CI 三平台全绿**。
3. `--no-ff` 合入 main；合入后立刻确认 main 的 CI 也绿。
4. **后合入者**必须重新并 main 再跑一次全量（因为两轨的验收标准都要求 `pnpm -r test` 全绿，对方的包也在里面）。
5. **谁把 main 弄红谁负责回滚或立即修复**，另一轨在 main 红期间不得合入。

### 4. 冲突升级路径（出现下列任一情况→停手上报，不要自己决定）

- 需要改 `core` / `gateway` / 对方的包；
- 需要改根级配置、CI、lockfile 之外的共享文件；
- 发现契约本身有缺陷（例如 `finalText`、半截文本语义不够用）；
- 两轨对同一契约的理解不一致。

编排者的处理只有两种：**① 在 main 上开一个小补丁窗口**（改完通知两轨各自并 main），**② 记为下阶段遗留**。不允许两轨各自在自己分支上改共享代码。

### 5. 低成本同步

每轨每个 Task 结束时，在自己的 `docs/issue-log/<日期>-{T|D}.md` 追加四要素（需求描述 / 处理过程 / 修改结果 / 遗留风险）。两人不需要开会，编排者按日读两份日志即可发现越界。

---

## 风险与降级

| 风险                                    | 缓解                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| token 默认切严格后老流程断              | 三端必须在**同一分支内**一起改；`serve-security` 扩充 + 桌面/CLI/网关冒烟才算过 |
| P 阶段拖长，挡住两人                    | P 限时 1–2 天；T/D 两位同期做**只读预研**（fixture、失败用例草案），不合入      |
| lockfile 冲突                           | 加依赖先报备；后合入者重跑 `pnpm install` 重新生成，禁止手工合并 lock           |
| 两轨互相被全量回归挡住                  | 合入前 CI 硬闸门；main 红时冻结合入；谁弄红谁修                                 |
| 「只读 core」被绕过（复制逻辑到自己包） | 审查面明确检查；`api-surface-baseline.json` 变化即越界信号                      |
| 契约不够用导致两轨各自发明              | P3 一次定死并写入测试；不够用时走升级路径，不允许本地发明                       |

---

## 给接手 AI 的完整提示词

> 复制以下整段给实施/审查子代理：

```
你是 harness2「地基补丁与并行开工闸门（P0-P4）」的实现者。这是一个单人串行前置阶段，
做完并合入 main 之后，终端 T 轨和桌面 D 轨才会同时开工。先完整读：
- docs/ai-framework/phased-plan-driven.md（元规范）
- docs/ai-framework/plans/2026-09-11-phase-foundation-patch.md（本计划）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md（§6 下放表 = 你的任务来源）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md（§A3 安全、§A5 网关复审）
- AGENTS.md、CODE_REVIEW.md、coding-standards.md

目标：修完 §6 下放的跨端缺陷（网关双会话、网关挂死、网关测试缺口、serve token 三端贯通、
401 误判健康、playwright 降级、锁文件权限），并把两条跨端展示语义（network 错误收尾 finalText 为空、
assistant/attempt 半截文本）一次定死；然后冻结 core/gateway 契约。

Global Constraints 优先级最高：
- 本阶段是唯一允许跨包改动的窗口；不新增事件类型、不改内核编排、turn-end 语义不变、不破坏轨迹不变量。
- 每个缺陷先写失败用例（先红后绿）再修；禁止注释/删除失败用例；禁止 --passWithNoTests 假绿。
- 不重构、不升级依赖（修复必需除外）；不做任何终端/桌面 UI 工作。
- 命令 PowerShell 5.1 分行，每条查 $LASTEXITCODE；测试名真实命中 >0。
- Git：只显式 add 本任务文件（禁 git add -A），小步 commit，提交格式 <gitmoji><type>(<scope>): <中文描述>；
  可 push 分支 fix/foundation-patch；合入 main 前 CI 必须三平台全绿，--no-ff 合入；禁 force push；禁在 main 上试错。

本地真实模型（联调用，不进 git）：base URL http://127.0.0.1:40080/v1、key sk-unified-local、
模型 big-pickle（200K 上下文、纯文本）；用隔离 --home，key 只写该目录下的 auth.json。

每 Task：先写失败用例 → 最小实现 → 跑对应包测试 → 贴「实际命令 + 输出」。
最后跑 pnpm lint / pnpm -r typecheck / pnpm test 全量，并推分支等 CI 三平台绿。
完成后给出：分支名、commit 清单、逐 Task/验收结果、真实测试输出、CI run 链接、已知风险、
以及 P4 的冻结公告内容（冻结 commit、范围、解冻方式）。
每个 Task 结束在 docs/issue-log/<日期>.md 追加四要素：需求描述 / 处理过程 / 修改结果 / 遗留风险。
```

---

## 残留手工验收清单

1. Windows 真机：桌面在**默认严格鉴权**下正常启动并连上 serve；故意改坏 token 时提示明确（不再显示「已连接」）。
2. Windows 真机：`harness2 gateway` 在端口被占用时**立即如实报错退出**，不挂死。
3. 人类待办（沿用阶段 15）：A-6 联网验证、B-13 三张真机截图、验收表 §8 六项手工清单、B6 发布授权。
