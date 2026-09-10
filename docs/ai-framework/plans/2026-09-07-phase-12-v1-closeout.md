# 阶段 12：1.0 收口 → M4 发布

> **状态：** 计划已就绪（总控计划 Ph12 / 里程碑 M4，2026-09-07 起草；基线 = 阶段 11 处置后验收线；ROADMAP 26/26 ✅ 已达成，本阶段为发布收口，无新功能清单项）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 面向公开发布的 1.0 收口：API 稳定承诺（semver 政策 + 公开导出面钉死）、迁移指南、文档站（GitHub Pages）、全面回归汇总、v1.0.0 发布物料。
**Architecture:** 稳定承诺 = 导出面快照测试（加性变更不红、删改导出即红）+ 政策文档；文档站 = docsify 零构建静态方案（docs/ 直接服务，Pages job 待远程验证）；迁移 = 实事求是盘点（0.6→1.0 若无 breaking 如实声明零迁移）。
**Tech Stack:** 现有栈；文档站不引入构建工具链（docsify CDN 单页）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| P0     | 本文件、`packages/core/src/index.ts`（公开导出面现状）、`CHANGELOG.md`（0.1→0.6 变更史——迁移指南素材）                   |
| P0     | `README.md`、`architecture.md`（导出/Skills/子会话语义终稿口径）、`docs/issue-log/OPEN.md`（全部手工清单——回归汇总素材） |
| P1     | `.github/workflows/ci.yml`（Pages job 落点）、`AGENTS.md`                                                                |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 master 拉 `feat/phase-12-v1-closeout`

---

## Global Constraints（冲突时以本节为准）

1. **零功能新增**：1.0 收口不改运行时行为（测试发现真缺陷则修复并单独提交说明）；版本号与物料是主要产出。
2. **公开面快照只钉 `@harness2/core` 的 `src/index.ts` 导出**：新增导出允许（minor），删除/改名/签名变更触发快照红（breaking 走 major 的政策）；internal 深路径不承诺、文档明示。
3. **文档站零构建工具链**：docsify CDN 单页（index.html + docs/ 现有 md 直接服务）；不引 vitepress/mkdocs。
4. **迁移指南实事求是**：逐节核对 0.1→1.0 实际行为变化（CHANGELOG + git log），无 breaking 就写「零迁移」+ 变更索引；禁止编造迁移步骤。
5. **密钥三不**；发布动作（tag/npm/Pages 开启）仍待人类授权，物料就绪即可。
6. **Git：** 每 Task 一提交；禁止 push。

---

## File Structure（预期变更）

| 文件                                                | 动作      | 职责                                                              |
| --------------------------------------------------- | --------- | ----------------------------------------------------------------- |
| `docs/API-STABILITY.md`                             | 新建      | semver 政策、公开面范围声明、internal 不承诺声明                  |
| `packages/core/test/api-surface.test.ts`            | 新建      | 导出面快照（从 dist/index.d.ts 提取导出清单 vs 基线快照 fixture） |
| `docs/MIGRATION.md`                                 | 新建      | 0.6→1.0（含 0.1→0.6 历史变更索引）                                |
| `docs/site/index.html` + `.github/workflows/ci.yml` | 新建/修改 | docsify 单页 + Pages 部署 job                                     |
| `docs/RELEASE-CHECKLIST.md`                         | 新建      | 发布前全面回归汇总（自动化覆盖声明 + OPEN 全部手工清单索引）      |
| `CHANGELOG.md`、四包 `package.json`、`README.md`    | 修改      | 1.0.0 物料                                                        |
| `docs/ROADMAP.md`                                   | 修改      | v1.x 下一周期 backlog 草案（标注未批准）                          |

---

## Task 1：API 稳定承诺

- 盘点 `packages/core/src/index.ts` 全部导出 → 生成基线快照 fixture（导出名 + 类型签名摘要）；测试从构建产物 dist 提取比对：**新增导出通过、删除/改名/签名变更失败**（失败消息指引走 major 或更新快照的决策）。
- `docs/API-STABILITY.md`：政策（1.0 后 breaking 只进 major；minor 可加性扩展；`@harness2/core` 承诺，CLI 输出格式/桌面 protocol 声明为 best-effort）+ internal 路径不承诺 + 快照更新流程。
- 测试 ≥3 例（基线比对通过 / 模拟删除导出红 / 新增导出绿——后两例用临时 fixture 验证比对器逻辑）。
- Commit：`✅test(core): 公开导出面快照钉死 + API-STABILITY semver 政策`

## Task 2：迁移指南 + 文档站

- `docs/MIGRATION.md`：0.6→1.0 逐项核对（预计零 breaking → 零迁移声明 + auth.json/config schema 演进索引 + 行为变化引用 CHANGELOG）；历史 0.1→0.6 变更表（从 CHANGELOG 提炼）。
- 文档站：`docs/site/index.html`（docsify CDN，侧栏 = README/architecture/API-STABILITY/MIGRATION/RELEASE-CHECKLIST/ROADMAP/HANDOFF）；ci.yml 加 `pages` job（部署 docs/ 至 GitHub Pages，标待远程验证——Pages 开启需仓库设置，OPEN 登记）。
- Commit：`📝docs: 迁移指南 + docsify 文档站（Pages job）`

## Task 3：全面回归汇总

- `docs/RELEASE-CHECKLIST.md`：①自动化覆盖声明（607+ 项测试 / typecheck / bench 基线 / crash-drill / 口径统一断言——命令级清单）；②手工清单索引（从 OPEN.md 汇总：真实 key 三端 chat、桌面 GUI、nsis 实机、QQ/飞书真机、MCP/插件实测、skill 体验、doctor/崩溃报告实机、真实大会话 bench——逐项链接 OPEN 行）；③发布动作 checklist（tag/NPM_TOKEN/Pages/npm 包名占用）。
- 回归执行：全量 `pnpm test` 连续 2 次全绿 + `harness2 doctor` 本机实跑输出入档。
- Commit：`📝docs: 发布前回归汇总清单（RELEASE-CHECKLIST）`

## Task 4：v1.0.0 物料 + 整备交接

- CHANGELOG 1.0.0（M1-M4 里程碑总述——从四本 diary 提炼亮点）；四包版本 0.6.0 → 1.0.0；README 终稿（功能矩阵/三端形态/快速开始核对——命令与实际输出逐条对过）。
- ROADMAP 尾部加「v1.x 展望（草案，未批准）」：候选 = 任务排队与并行会话编排、Web UI、遥评估算、worker 隔离插件、更多 IM——**标注未批准，仅 backlog**。
- HANDOFF 快照（1.0 就绪态）、diary 追加、OPEN（新增：Pages 开启、v1.0.0 tag 待授权、README 截图占位待补）。
- Commit：`🔧chore(release): v1.0.0 物料 + 文档整备`

---

## 验收标准总表

| #   | 标准      | 通过条件                                                            |
| --- | --------- | ------------------------------------------------------------------- |
| 1   | API 快照  | 快照测试通过；模拟破坏导出可红                                      |
| 2   | 迁移指南  | 逐项有据（CHANGELOG/git log 引用），无编造步骤                      |
| 3   | 文档站    | docsify 页本地可开（file:// 或 http-server）；Pages job YAML 校验过 |
| 4   | 回归汇总  | RELEASE-CHECKLIST 覆盖自动化+手工+发布动作三层；连续 2 次全量全绿   |
| 5   | 物料      | CHANGELOG 1.0.0 / 四包版本 / README 终稿核对通过                    |
| 6   | 红线      | 零功能新增（types.ts 零 diff）；密钥三不                            |
| 7   | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0                             |

---

## 风险与降级

| 风险                               | 缓解                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| 导出面快照过脆（类型签名摘要抖动） | 只钉导出名 + 存在性，签名摘要宽松匹配；快照更新流程写进 API-STABILITY |
| Pages 本地不可验证                 | YAML 语法校验 + docsify 本地 file:// 冒烟；待远程登记                 |
| 迁移指南变「编造文章」             | 硬约束 4：每节必须引用 CHANGELOG 条目或提交号                         |
| 1.0 前发现真缺陷                   | 修复单独提交并在 CHANGELOG 标注；不影响收口结构                       |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 12 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:\AI_projects\harness2`（Windows，Git Bash，pnpm monorepo，Node ≥22）；从 master 创建并切换 `feat/phase-12-v1-closeout`
- 已完成勿重做：阶段 1-11 全部验收闭环（ROADMAP 26/26 ✅ + 稳定化/分发完成）；基线测试以开工日 `pnpm test` 实跑为准（预期 610+ 项，1 skipped 为 H2_GEN_LOOP_DEMO 门控非失败）
- 唯一实施计划：`docs/ai-framework/plans/2026-09-07-phase-12-v1-closeout.md`
- 必读：本计划、`packages/core/src/index.ts`、`CHANGELOG.md`（0.1→0.6 全部——迁移指南素材）、`docs/issue-log/OPEN.md`、`README.md`、`architecture.md`、`AGENTS.md`

### 做

1. 严格按 Task 1→4 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：零功能新增（types.ts 零 diff）；快照只钉导出名级别；迁移指南逐项有据；文档站零构建工具链
3. Task 4 更新 CHANGELOG/版本/README/ROADMAP 草案/HANDOFF/diary/OPEN

### 不做

- 任何运行时行为变更（真缺陷除外，单独提交说明）；vitepress/mkdocs 等构建链；发布动作执行；任何 `git push`

### 工作方式

1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷

分支名、提交列表、验收总表逐项自评（带命令与真实结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 4。

---

## 残留手工验收清单

1. （CI 远程）Pages 首次部署（需仓库设置开启 Pages）
2. （用户）v1.0.0 发布动作：tag 推送 / NPM_TOKEN / release 核对
