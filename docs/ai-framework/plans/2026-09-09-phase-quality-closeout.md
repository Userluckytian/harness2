# 阶段 15-质量收口：1.0 发布与 R2 开工前欠账清理（双轨并行 · 总纲）

> **状态：** 计划已就绪（2026-09-09），待两名执行者认领
> **来源：** 2026-09-09 全仓静态审计；对照 `CODE_REVIEW.md`、`coding-standards.md`、`docs/issue-log/OPEN.md`、`docs/HANDOFF.md`、`docs/RELEASE-CHECKLIST.md`
> **角色：** 本文件是**总纲与协作契约**。两条轨道的执行者**都必须先读完本文件**，再读各自任务书。
> **子文档：**
> - 轨道 A（运行时与后端）：`docs/ai-framework/plans/2026-09-09-phase-quality-closeout-track-a.md`
> - 轨道 B（工程化与产品面）：`docs/ai-framework/plans/2026-09-09-phase-quality-closeout-track-b.md`
> - 跨轨验收与证据登记：`docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 在 R2 激进-终端（T0–T5）与激进-桌面（D0–D6）大规模开工、以及 v1.0.0 正式发布之前，清掉四类欠账：**Windows 可用性 P0**、**三端真实模型零验证**、**serve 发布前安全加固**、**工程规范与文档空账**。
**Architecture：** 不引入新架构。全部为既有模块内的修复、加固、等价拆分与文档补齐。
**Tech Stack：** TS · vitest · pnpm workspace · ESLint(flat) + Prettier（本阶段新引入）
**实施档位：** 全能（开发 + 测试 + 代码审查）。其中 A2 三端真机、A6 发布属**豪华档端到端**，由人类执行，**永远不交子代理**。
**子代理：** 启用（代码审查 + 验收）。另加硬性要求：**两条轨道互为人工审查方**。
**基线：** `main` tip `b5a702d`（工作树干净，本地领先 `origin/main` 25 commit）。仓库路径 `D:/AI_Projects/harness2`。

---

## 前置阅读（两轨都必须）

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件 + 自己那一轨的任务书 + `…-acceptance.md` |
| P0 | `AGENTS.md`、`CODE_REVIEW.md`、`docs/ai-framework/phased-plan-driven.md` |
| P0 | `docs/HANDOFF.md`、`docs/issue-log/OPEN.md` |
| P1 | `architecture.md`、`coding-standards.md`、`docs/API-STABILITY.md` |
| P1 | `docs/ai-framework/plans/2026-09-08-phase-aggressive-core-foundation.md`（下游 R2 底座，避免改到它的契约）|
| P2 | `docs/RELEASE-CHECKLIST.md`、`docs/MIGRATION.md` |

---

## 阶段地图

| 位置 | 内容 |
|------|------|
| 上游 | 阶段 1–12（v1.0.0 物料就绪，发布待授权）；阶段 14 共享底座 S0–S7 已验收合并 main |
| **本阶段** | 质量收口双轨：轨道 A 运行时与后端 / 轨道 B 工程化与产品面 |
| 下游 | R2 激进-终端 T0–T5、激进-桌面 D0–D6；v1.0.0 正式发布 |
| 明确不做 | ❌ T/D 两轨任何新交互功能 ❌ 修改共享底座已冻结契约 ❌ 架构重构（只做行为等价的文件拆分）❌ 新增依赖除 lint/format 工具链 |

---

## 分工

| 轨道 | 执行者 | 阶段序列 |
|------|--------|----------|
| **A · 运行时与后端** | 甲 | A0 仓库卫生 → A1 Windows 可用性 P0 → A2 三端真机验证 → A3 serve 安全加固 → A4 core/server 大文件拆分 → A5 阶段 9 网关复审 |
| **B · 工程化与产品面** | 乙 | B1 OPEN.md 拆分 → B2 lint/CI 基建 → B3 cli/desktop 大文件拆分 → B4 规范文档补齐 → B5 文档与验收欠账 → B6 发布准备 |

### 目录归属（越界前先在群里说一声）

| 路径 | 归属 |
|------|------|
| `packages/core/src/{tools,agent,provider,server,doctor}/**` | 甲 |
| `packages/core/test/**` 中对应新增/回归用例 | 甲 |
| `packages/gateway/**` | 甲 |
| `architecture.md` 的 Provider / Server 小节 | 甲 |
| 根 lint / prettier 配置、`.github/workflows/**` | 乙 |
| `packages/cli/**`、`packages/desktop/**` | 乙 |
| `coding-standards.md`、`CODE_REVIEW.md`、`README.md` | 乙 |
| `docs/**`（OPEN.md、DECISIONS.md、HANDOFF.md、accept 结论、diary 汇总） | 乙 |

### 交界文件三条硬规则

1. **`packages/core/src/index.ts` 导出面与 api-surface fixture**：谁改谁在**同一提交**内更新快照（`H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`），改之前先在群里喊，**当天必须合流**。
2. **根 `package.json`**：甲在 A0 一次性改完版本号；乙加 `lint` script 时单独一次提交，两次时间错开。
3. **`docs/issue-log/<日期>.md`**：同一文件按 `## 轨道A` / `## 轨道B` 二级标题分区，**只追加不重排**，冲突时双方内容都保留。

---

## 分支与合流

- 各建独立 worktree：甲 `feat/runtime-hardening`，乙 `chore/engineering-health`。**别在主工作树切分支打断对方**；不删对方 worktree；git 不 reset/clean。
- 每天上班第一件事：`git pull --rebase origin main`；每天下班前至少合流一次到 `main`。
- 提交规范：`<gitmoji><type>(<scope>): <中文描述>`；只显式 `git add` 本任务文件，**不用 `git add -A`**；小步 commit。
- **push**：备份性 push 已授权（见 OPEN.md）。**打 tag、npm publish、删分支、reset、force push 一律先问人类。**

---

## 三个强制同步点

| 同步点 | 时机 | 内容 | 为什么 |
|--------|------|------|--------|
| **S0** | Day 1 上午，两人同时在场 | 甲执行 A0 并 push；乙同时完成 B1（OPEN.md 拆分）并合入 main | 提前清掉全程最大的两个冲突源，做完再各自开工 |
| **S1** | 甲的 A1 合入 main 之后 | 乙才可以对 `packages/core/**` 执行 Prettier 格式化；在此之前只格式化 cli/desktop/gateway | 全量格式化会和进行中的逻辑改动大面积打架 |
| **S2** | Day 6 的格式化窗口 | 全量格式化独占一个 `🎨style` 提交，不掺任何逻辑改动；提交后两人立即 rebase | 同上；这条被破坏，两人要花半天解冲突 |

---

## 代码审查（阶段级，验收前）

**审查方：** ①对方轨道的人（人工，按 `CODE_REVIEW.md`）②独立只读子代理（非实现者）。两份都要，**安全类（A3）与拆分类（A4/B3）改动一份都不能省**。
**审查面：** 风格 / 测试完整性 / 依赖合理性 / 架构红线（四条不变量、密钥脱敏、快照范围、审批不得弱化、导出面快照同步）/ 安全 / API 契约一致性。
**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表）/ ❌ 不通过（阻塞，按元规范 §4.1 下放）

### 每个阶段「完成」的统一定义

1. `pnpm -r typecheck` 与 `pnpm test` **实跑并贴输出**（禁止「应该能过」；测试名必须真实命中 >0，不得 `--passWithNoTests` 造假绿）
2. 两份审查报告 P0/P1 清零
3. 同步 `docs/issue-log/<日期>.md`（描述/分析/修改结果/状态四要素）、OPEN.md（乙统一维护）、`docs/diary/`
4. 在 `…-acceptance.md` 对应行填状态、证据命令、日期

---

## Global Constraints（冲突时以本节为准）

1. **四条不变量不得破坏**：Model-visible ⟺ logged；永久会话事件 append-only + 同会话单写者；core 与 UI 解耦；文件快照独立于 git（bash 副作用不入快照）。碰到这四条先停下来问人类。
2. **保留已有安全边界**：`provider/openai.ts` 的 `[DONE]` 检查与「半截工具参数不能执行」；`tools/executor.ts runWave` 的 safe 并发 / unsafe 独占 / 同 lockKey 串行；审批机制不得弱化。
3. **公共事件类型变更须同步** parser/projector/export/replay/fixture 与迁移策略。
4. **不动阶段 14 已冻结的 S0–S7 契约**（`submit/resumeSubscription/approval/cancel/task/steer`、`protocolVersion=2`、`runtime.v1.jsonl`）。
5. 改动前先读对应测试：`agent/loop.ts`→loop.test.ts；`tools/*`→tools.test.ts；`session/reader.ts`→reader 与 undo/redo 测试；`trajectory/export.ts`→export.test.ts；`core/src/index.ts` 导出面→api-surface.test.ts。
6. 密钥/真实用户会话/附件/prompt 日志**不上传、不入库**；测试一律用本地 stub + 临时 HOME/cwd；**不改人类的全局配置、`~/.harness2/auth.json` 与审批模式**。
7. 命令用 PowerShell 5.1 分行写（不连 `&&`），每条查 `$LASTEXITCODE`。
8. **YAGNI**：本阶段只清欠账，不顺手加功能；拆分类改动必须是行为等价的纯搬运。

---

## 阶段开头：上阶段遗留（元规范 §4.1）

| 遗留项 | 来源 | 未通过/未做原因 | 承接 |
|--------|------|----------------|------|
| 阶段 5 / 6 / 8 未做形式验收 | 阶段 12 收口 | 当时按档位跳过，登记为「未执行」 | ⬜ B5-1 |
| 阶段 9（IM 网关）曾判 fail，修复后未复审 | 阶段 9 验收 | 修复后无独立复审 | ⬜ A5 |
| serve 本地信任域加固（M2 发布前项） | OPEN.md | 一路顺延至 M4 仍未做 | ⬜ A3-1 |
| 三端真实模型端到端零验证 | OPEN.md「待 key」 | 缺 API key | ⬜ A2 |
| `coding-standards.md`「项目专属约定」整节空白 | 静态审计 | 从未填写 | ⬜ B4-1 |
| Windows bash 工具不可用导致空回复（会话 `20260907-032949-546d13`） | issue-log | 定位后未修 | ⬜ A1 |

---

## 验收标准总表（明细见两轨任务书；证据填 `…-acceptance.md`）

| # | 标准 | 通过条件 | 责任 |
|---|------|----------|------|
| 1 | Windows 四类缺陷闭环 | `windows-bash`、`tool-failure-circuit`、编码与参数示范用例全绿 | A |
| 2 | 三端真机清单 | DeepSeek / GLM / Anthropic 六项清单逐项 pass 或已登记缺陷 | A（人类签收） |
| 3 | serve 越权被拒 | `serve-security` 全绿 + 手工 curl 输出 | A |
| 4 | core/server 拆分零行为变更 | `sessions.ts` < 25KB 且拆分前后同组测试结果一致 | A |
| 5 | 阶段 9 网关复审结论落盘 | 四段结论 + 复跑输出 | A |
| 6 | OPEN.md 只剩真实待办 | 逐条为待办，已决策项迁入 DECISIONS.md | B |
| 7 | lint 进 CI 且绿 | `pnpm lint` 本地与 CI 均通过 | B |
| 8 | cli/desktop 拆分零行为变更 | 三个目标文件 < 20KB + 桌面 smoke 通过 | B |
| 9 | 两份规范文档无空白占位 | `coding-standards.md`、`CODE_REVIEW.md` 项目专属内容落地 | B |
| 10 | 文档欠账清零 | accept-phase 5/6/8 落盘 + README 三图 + HANDOFF 更新 | B |
| 11 | 全量回归 | `pnpm test` 真实命中全绿（两轨各自合流前跑一次，最终合流后再跑一次） | 双轨 |
| 12 | 阶段级代码审查 | 每阶段两份报告，结论 ✅/⚠️；❌ 下放 | 互审 + 子代理 |
| 13 | 红线 | 无密钥入库；`git ls-files` 无敏感文件；未改人类全局配置 | 双轨 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| Prettier 全量格式化与进行中改动大面积冲突 | 锁死 S1/S2 两个窗口；格式化独占提交；提交后立即双方 rebase |
| A2 依赖人类提供 key | 无 key 则整轨顺延到 A3，**不得用 stub 冒充真机验证**，在验收表登记「未执行」 |
| 拆分意外引入行为变更 | 纯搬运；一次一个文件；拆分前后跑同一组测试并贴对比；对方轨道人工复核 |
| 两人同时改 api-surface fixture | 改前群里喊 + 当天合流；冲突时以 `H2_UPDATE_API_SNAPSHOT=1` 重新生成为准 |
| 安全加固把桌面/CLI 自己挡在门外 | A3 完成后由乙跑一遍 desktop smoke 与 CLI serve 冒烟才算通过 |
| 双轨同日写 issue-log 冲突 | 二级标题分区、只追加不重排 |

---

## 给接手 AI 的完整提示词（总纲级 · 两轨通用）

> 两条轨道的执行者都先复制这一段，再复制自己任务书文末的专属提示词。

```
你是 harness2「阶段 15-质量收口」双轨并行中的一名执行者。仓库 D:/AI_Projects/harness2。

先完整读（缺一不可）：
- docs/ai-framework/phased-plan-driven.md（元规范）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md（本总纲：分工/目录归属/同步点/全局约束）
- 自己那一轨的任务书（track-a 或 track-b）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md（验收登记表，你要往里填证据）
- AGENTS.md、CODE_REVIEW.md、docs/HANDOFF.md、docs/issue-log/OPEN.md

基线：main tip b5a702d，工作树干净。从当前 main 建自己的独立 worktree，别在主工作树切分支，
不动对方 worktree，不读取/覆盖对方轨道的文件（目录归属见总纲）。

铁律：
- 四条不变量不得破坏：Model-visible ⟺ logged / 永久事件 append-only 且单写者 / core 与 UI 解耦 /
  文件快照独立于 git。碰到就停下来问人类。
- 不修改阶段 14 已冻结的 S0-S7 交互契约与 protocolVersion=2。
- 改 core/src/index.ts 导出面必须在同一提交更新 api-surface fixture，并提前在群里通知对方轨道。
- 密钥/真实会话/附件/prompt 日志不入库；测试用本地 stub + 临时 HOME/cwd；不改人类全局配置与审批模式。
- 命令用 PowerShell 5.1 分行（不连 &&），每条查 $LASTEXITCODE。
- Git：只显式 add 本任务文件，小步 commit；备份 push 已授权，但 tag/publish/reset/force push/删分支必须先问人类。
- 测试名必须真实命中 >0，禁止 --passWithNoTests 造假绿。

每个 Task：先写失败用例 → 最小实现 → 跑对应包测试 → 贴「实际命令 + 真实输出」→ 小步 commit。
每个阶段收尾：跑 pnpm -r typecheck 与 pnpm test → 请对方轨道人工审查 + 只读子代理审查 →
在 acceptance.md 填状态/证据/日期 → 更新 docs/issue-log/<日期>.md（按轨道二级标题追加）。

验收只认证据，禁止「应该能过」。P0/P1 未闭环就给「不通过/明确阻塞」，不宣称完成。
完成后交付：worktree 名、commit 清单、逐 Task 与逐验收项结果、真实测试输出、已知风险、已启动进程的 PID 归属。
```

---

## 残留手工验收清单（人类执行）

1. **三端真机体验签收**（A2）：DeepSeek / 智谱 GLM / Anthropic 各一轮真实对话 + 工具调用 + undo/redo + 审批。
2. **Windows 真机手感**（A1）：重跑一个联网检索类任务，确认不再出现空回复。
3. **发布授权**（B6）：NPM_TOKEN 配置、tag v1.0.0 推送、发布后 24h 观察。
4. **README 截图**（B5）：三张图由人类确认是否真实反映当前 UI。
