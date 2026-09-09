# 阶段 15-质量收口 · 轨道 B：工程化与产品面（B1–B6）

> **状态：** 计划已就绪（2026-09-09），待执行者认领
> **总纲（必读在先）：** `docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md`
> **验收登记：** `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`
> **对侧轨道：** 轨道 A（运行时与后端）`…-track-a.md`——**不要动** `packages/core/src/{tools,agent,provider,server,doctor}`、`packages/gateway`
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 把仓库从「靠人肃清」拉到「靠工具与文档兵役」：lint/CI 基建落地、R2 两轨即将重度改动的 cli/desktop 大文件提前拆开、两份规范文档从空白模板变成真约束、文档与形式验收欠账清零。
**实施档位：** 全能（开发 + 测试 + 代码审查）；B6 发布为豪华档端到端，由人类执行。
**子代理：** 启用（代码审查 + 验收）；另由轨道 A 执行者做人工交叉审查。
**worktree / 分支：** 从当前 `main`（tip `b5a702d`）建 `chore/engineering-health`。

---

## 前置阅读

| 优先级 | 文件 |
|--------|------|
| P0 | 总纲 + 本文件 + acceptance.md |
| P0 | `AGENTS.md`、`CODE_REVIEW.md`、`coding-standards.md`（重点看「项目专属约定」空白节） |
| P0 | `docs/issue-log/OPEN.md`（31KB，本轨第一个要改的文件）、`docs/HANDOFF.md` |
| P1 | `packages/cli/src/index.ts`、`packages/desktop/src/renderer/App.tsx` |
| P1 | `docs/RELEASE-CHECKLIST.md`、`docs/API-STABILITY.md`、`README.md` |
| P2 | `docs/diary/2026-09-06.md`、`2026-09-07.md`（release note 素材） |

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `docs/issue-log/OPEN.md` | 重构 | B1：只留真实待办 |
| `docs/issue-log/DECISIONS.md` | 新建 | B1：已关闭 / 不修 / 口径登记迁入 |
| `eslint.config.js`、`.prettierrc`、`.prettierignore` | 新建 | B2 |
| 根 `package.json` | 修改 | B2：新增 `lint` script（**单独提交，与甲的版本号提交错开**） |
| `.github/workflows/**` | 修改 | B2：lint 入 CI |
| `packages/cli/src/index.ts` | 拆分 | B3：命令注册 + 各子命令分文件 |
| `packages/desktop/src/renderer/App.tsx` | 拆分 | B3：分栏 / 会话列表 / 消息流 |
| `packages/desktop/src/renderer/components/SettingsDialog.tsx` | 拆分 | B3（评估后决定） |
| `coding-standards.md` | 修改 | B4-1：填实项目专属约定 |
| `CODE_REVIEW.md` | 修改 | B4-2：增补 harness2 专属红线 |
| `README.md` | 修改 | B4-3 插件边界声明、B5-2 三张截图 |
| `docs/ai-framework/plans/*-accept-*.md`（或现有验收位置） | 新增 | B5-1：阶段 5/6/8 形式验收 + 归位甲的阶段 9 结论 |
| `docs/HANDOFF.md` | 修改 | B5-3：状态快照更新 |
| `docs/RELEASE-CHECKLIST.md` | 勾选 | B6 |

---

## 任务

### B1 — OPEN.md 拆分（Day 1 上午 · 同步点 S0 · 最先做）

**为什么最先：** `docs/issue-log/OPEN.md` 开头写着「已关闭项不在此文件」，但 31KB 里塞满了「已关闭 / 已评估不修 / 口径登记」，真正待办不到三分之一。它是所有人交接时第一份读的文件，**而且接下来两条轨道都要往里面追加**，不先修就是持续冲突源。

- **Files：** `docs/issue-log/OPEN.md`、新建 `docs/issue-log/DECISIONS.md`
- **行为：**
  1. OPEN.md 只留**真实待办**；
  2. 已关闭 / 已评估不修 / 口径登记迁到 `DECISIONS.md`（保留原文与日期，不得删信息）；
  3. OPEN.md 顶部加索引链接指向 DECISIONS.md；
  4. 顶部声明本轮双轨分工与四份计划文档的位置。
- **当天合入 main**。之后你是 OPEN.md 与 DECISIONS.md 的**唯一维护人**；轨道 A 的条目由他写在 issue-log，你负责同步。
- **Commit：** `📝docs(issue-log): OPEN.md 只留待办，决策与已关闭项迁入 DECISIONS.md（B1）`
- **验收：** OPEN.md 逐条都是待办；行数显著下降；无信息丢失（diff 可核）。

---

### B2 — lint/format 基建 + CI（Day 1–2）

**现状：** `coding-standards.md` 写着「格式化交给工具」，但仓库里**没有任何 lint/format 配置**，全靠人肃自觉。

1. 引入 ESLint（flat config）+ Prettier，新增 `pnpm lint`，接进 CI。
2. 首轮**放宽 warning**，只把明显错误（未使用变量、`any` 泄漏、floating promise 等）设为 error，**存量正常代码不得因新规则误标红**；新规则先 `warn` 后视情况收紧，避免引入即全量爆红。
3. 根 `package.json` 加 script **单独一次提交**（甲在 A0 改版本号，两次错开）。
4. **全量格式化必须独占一个 `🎨style` 提交，不掺任何逻辑改动。**

**格式化执行顺序（关键，别搞错）：**

| 时机 | 允许格式化的范围 |
|------|------------------|
| Day 1–5 | 仅 `packages/{cli,desktop,gateway}` |
| 甲的 A1 合入 main 后（**S1**） | 才允许碰 `packages/core/**` |
| Day 6 格式化窗口（**S2**） | 全量格式化，提交后**立即通知甲 rebase** |

- **Commit：** `🔧chore(repo): 引入 ESLint(flat) 与 Prettier 并接入 CI（B2）` / `🎨style(repo): 全量格式化（B2 · 无逻辑改动）`
- **验收：** 本地 `pnpm lint` 干净；CI 上 lint 为必过项且绿；格式化提交 diff 中无逻辑变更（审查方抽查）。

---

### B3 — cli / desktop 大文件拆分（Day 2–4）

**为什么现在做：** 违反自家编码规范「单文件保持合理长度」，而且这两个文件正是 R2 终端轨 T0–T5 与桌面轨 D0–D6 要重度改动的地方，先拆开后面才好并行。

| 文件 | 当前 | 拆分方向 |
|------|------|----------|
| `packages/cli/src/index.ts` | 39KB | 命令注册 + 各子命令分文件 |
| `packages/desktop/src/renderer/App.tsx` | 31KB | 分栏 / 会话列表 / 消息流 组件 |
| `packages/desktop/src/renderer/components/SettingsDialog.tsx` | 30KB | 评估后决定是否拆 |

- **要求：纯搬运不改行为**；一次只拆一个；每次跑全量 `pnpm test` + `pnpm -r typecheck`。
- 如果动到 `@harness2/core` 的导出面：**同一提交**更新 api-surface fixture，并**提前在群里跟甲打招呼**。
- **审查：** 甲 + 只读子代理，重点验证「零行为变更」（拆分前后同一组测试结果对比）。
- **验收：** 三个文件都降到 20KB 以内；桌面 smoke 通过；CLI 主要子命令手工走一遍。
- **Commit：** `♻️refactor(cli): 拆分 index.ts 为命令注册与子命令模块（B3-1）` / `♻️refactor(desktop): 拆分 App.tsx 为分栏与会话组件（B3-2）`

---

### B4 — 规范文档补齐（Day 4–5）

#### B4-1 `coding-standards.md` 的「项目专属约定」
整节还是 `____________` 空白模板（技术栈、构建命令、包管理器、测试命令、分层结构、lint 配置全空）。这是 AI 子代理协作的地基，必须按 B2 落地的真实配置填实。
- **Commit：** `📝docs(standards): 填实项目专属约定（B4-1）`

#### B4-2 `CODE_REVIEW.md` 增补 harness2 专属红线
现在这份是通用清单，对本项目零针对性。需增补：
- 四条不变量（Model-visible ⟺ logged / append-only 单写者 / core 与 UI 解耦 / 文件快照独立于 git）
- 密钥脱敏闸门
- 快照范围（bash 副作用不入快照）
- 审批机制不得弱化
- 导出面变更必须同步 api-surface 快照
- 顺手修掉「缓存在的使用」这个错字
- **Commit：** `📝docs(review): 增补 harness2 专属审查红线（B4-2）`

#### B4-3 插件边界如实声明
v1 插件是**同进程非隔离**，manifest 权限只是 API 层约束。在 README、文档站、`plugin list` 输出三处显著位置写明，避免用户默认有沙箱。（`plugin list` 输出文案落点在 core，**找甲确认后由甲改**。）
- **Commit：** `📝docs(plugins): 声明 v1 插件同进程非隔离边界（B4-3）`

---

### B5 — 文档与验收欠账（Day 6）

1. 补形式验收 `/accept-phase`：**阶段 5、6、8**（当时按档位跳过，属「未执行」而非「不通过」）；并归位甲产出的**阶段 9 网关复审结论**。
2. README 三张截图：终端 chat 流式与工具行、桌面多会话分屏、traj 时间线；补完**删掉 HTML 占位注释**。
3. `docs/HANDOFF.md` 状态快照更新到当前（含本轮双轨进展与四份计划文档索引）。
4. 汇总两条轨道的 `docs/diary/` 记录。
- **验收：** 三份 accept-phase 四段结论落盘；README 图可见；HANDOFF 读完能零上下文接手。
- **Commit：** `📝docs(plans): 补齐阶段 5/6/8 形式验收与交接快照（B5）`

---

### B6 — v1.0.0 发布准备（Day 7 · **逐项等人类授权，不要自行执行**）

1. `npm view harness2` / `npm view @harness2/core` 包名占用检查（**只读，可先做**，结果告知人类）。
2. `NPM_TOKEN` secret 由人类配置；你把需要的字段与步骤列清单给他。
3. tag `v1.0.0` **等明确授权后再推**；release note 说明 M1/M2/M3 合并进 1.0.0 的对应关系（素材取自 `docs/diary/`）。
4. 对照 `docs/RELEASE-CHECKLIST.md` ③ 逐项打勾，把勾好的清单发人类。
- **发布后核对：** release workflow 全绿；npm 两包可安装；干净机器上 `npm i -g harness2` 后 `harness2 config check` 可跑。

---

## 代码审查（阶段级，验收前）

**审查方：** 轨道 A 执行者（人工）+ 独立只读子代理。
**审查面：** 拆分零行为变更 / lint 规则合理性（不该把合法写法判死）/ 格式化提交无逻辑变更 / 文档与实际实现一致（特别是插件边界声明不得夸大安全性）/ 信息不丢失（OPEN.md 迁移）。
**结论：** ✅ / ⚠️（问题进验收表）/ ❌（阻塞，下放）

---

## 验收标准总表（轨道 B）

| # | 标准 | 通过条件 | 验证责任 |
|---|------|----------|----------|
| B-1 | OPEN.md 只剩待办 | 逐条为待办；DECISIONS.md 保留全部历史信息 | 人工审阅 diff |
| B-2 | lint 可跑 | `pnpm lint` 本地干净 | 自动化 |
| B-3 | lint 入 CI | CI 中 lint 为必过项且绿 | 自动化 |
| B-4 | 格式化提交干净 | `🎨style` 提交无逻辑变更（审查抽查） | 甲 |
| B-5 | 同步点遵守 | core 格式化晚于 A1 合入；全量格式化在 S2 窗口 | 双方确认 |
| B-6 | cli 拆分 | `cli/src/index.ts` < 20KB，子命令手工走通 | 自动化 + 手工 |
| B-7 | desktop 拆分 | `App.tsx` < 20KB，桌面 smoke 通过 | 自动化 + 手工 |
| B-8 | 拆分零行为变更 | 拆分前后同组测试结果一致 | 甲复核 |
| B-9 | coding-standards 无占位 | 项目专属约定全部填实且与实际命令一致 | 人工 |
| B-10 | CODE_REVIEW 红线 | 六项专属红线落地 | 人工 |
| B-11 | 插件边界声明 | README / 文档站 / `plugin list` 三处可见 | 人工 |
| B-12 | 形式验收补齐 | 阶段 5/6/8 + 甲的阶段 9 结论均落盘 | 独立角色 |
| B-13 | README 三图 | 图可见且占位注释已删 | 人类 |
| B-14 | HANDOFF 更新 | 零上下文可接手 | 人工 |
| B-15 | 全量回归 | `pnpm test` 真实命中全绿 | 自动化 |
| B-16 | 代码审查 | 两份报告，P0/P1 清零 | 甲 + 子代理 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 全量格式化与甲的改动大面积冲突 | 严格按 S1/S2 窗口；格式化独占提交；提交后立即通知甲 rebase |
| lint 规则太严导致 CI 长期红 | 首轮只把明显错误设 error，其余 warning；阅一段时间后再收紧 |
| 拆分引入行为变更 | 纯搬运；一次一个；拆前拆后跑同一组测试对比；甲复核 |
| OPEN.md 迁移丢信息 | 只搬不删；保留原文与日期；diff 逐段人工核 |
| 插件边界声明润色过头 | 实事求是，不得暗示有沙箱；甲审查把关 |
| 发布误操作 | tag / publish / secret 全部等人类逐项授权 |

---

## 给接手 AI 的完整提示词（轨道 B 专属）

> 先复制总纲文末的通用提示词，再复制本段。

```
你负责 harness2 阶段 15-质量收口的【轨道 B：工程化与产品面】，按 B1→B6 顺序执行。
只动这些路径：根 lint/prettier 配置、.github/workflows/**、packages/cli/**、packages/desktop/**、
coding-standards.md、CODE_REVIEW.md、README.md、docs/**。
禁止碰：packages/core/src/{tools,agent,provider,server,doctor}/**、packages/gateway/**（属于轨道 A）。

B1（最先做，同步点 S0，当天合入 main）：拆分 docs/issue-log/OPEN.md—31KB 里大部分是已关闭/不修/口径登记，
与文件开头声明矛盾。OPEN.md 只留真实待办，其余只搬不删地迁到同目录 DECISIONS.md，顶部加索引。
之后你是这两个文件的唯一维护人，轨道 A 的条目由他写 issue-log、你同步。

B2：引入 ESLint(flat)+Prettier，新增 pnpm lint 并接入 CI；首轮只把明显错误设 error。
格式化顺序铁律：Day1-5 只格式化 packages/{cli,desktop,gateway}；等轨道 A 的 A1 合入 main 后才能碰 packages/core；
全量格式化放 Day6 窗口、独占一个 style 提交、提交后立即通知对方 rebase。根 package.json 加 script 单独提交，
与轨道 A 的版本号提交错开。

B3：纯搬运拆分 packages/cli/src/index.ts（39KB）与 packages/desktop/src/renderer/App.tsx（31KB），
评估 SettingsDialog.tsx（30KB）；目标各 <20KB；一次一个，每次跑全量 pnpm test 与 typecheck；
若动到 @harness2/core 导出面，同一提交更新 api-surface fixture 并提前通知轨道 A。

B4：填实 coding-standards.md 的「项目专属约定」（现为 ____ 空白模板）；给 CODE_REVIEW.md 增补 harness2 专属红线
（四条不变量、密钥脱敏、快照范围、审批不得弱化、导出面快照同步，并修掉「缓存在的使用」错字）；
在 README/文档站/plugin list 三处如实声明 v1 插件同进程非隔离（plugin list 文案在 core，找轨道 A 改）。

B5：补阶段 5/6/8 的 /accept-phase 形式验收（当时属「未执行」而非「不通过」），归位轨道 A 的阶段 9 复审结论；
补 README 三张截图并删占位注释；更新 docs/HANDOFF.md 状态快照（含本轮四份计划文档索引）。

B6（逐项等人类授权，不自行执行）：只读检查 npm 包名占用；列出 NPM_TOKEN 配置步骤交人类；
tag v1.0.0 等授权；对照 docs/RELEASE-CHECKLIST.md ③ 逐项打勾。

每阶段收尾：pnpm -r typecheck + pnpm test + pnpm lint 贴真实输出 → 轨道 A 人工审查 + 只读子代理审查 →
在 2026-09-09-phase-quality-closeout-acceptance.md 的轨道 B 表格填状态/证据/日期 →
在 docs/issue-log/<日期>.md 的「## 轨道B」小节追加四要素记录，并同步轨道 A 提出的 OPEN.md 变更。
```

---

## 残留手工验收清单（轨道 B）

1. README 三张截图由人类确认是否真实反映当前 UI。
2. 发布三件（NPM_TOKEN、tag、发布后 24h 观察）全由人类执行。
3. 干净机器上 `npm i -g harness2` 后 `harness2 config check` 实跑。
