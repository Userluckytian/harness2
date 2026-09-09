# 阶段 11：稳定化 + 分发

> **状态：** 计划已就绪（总控计划 Ph11，2026-09-07 起草；基线 = 阶段 10 验收线，测试 579 passed + 1 skipped；ROADMAP 26/26 已 ✅，本阶段为质量/发布工程，无新功能清单项）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 把 v0.6 的功能质量抬到可发布稳定性：性能预算落地（消化审查 P2-4 大日志留档）、子会话口径统一（消化 OPEN 两行留档）、三平台安装包 CI 矩阵、崩溃恢复演练 + `doctor` 自检、测试抖动根治。
**Architecture:** 稳定化 = 测量驱动（先基线后优化，不为优化而优化）；口径统一 = 以 architecture.md 已声明的 serve 语义为准（子会话 = 隔离工作空间）；分发 = CI 产物矩阵（unsigned，macOS 签名公证初期跳过——总控计划已定）；错误处理 = 本地落盘（无遥测后端，opt-in = 用户手动提供报告文件）。
**Tech Stack:** 现有栈；不新增运行时依赖（zip 上限用 fflate 已有能力 + 前置校验）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0     | 本文件、`docs/issue-log/OPEN.md`（本阶段消化多行留档）、`packages/core/src/session/reader.ts`（computeProjection——性能测量对象）、`packages/core/src/session/export.ts`（importReplay 上限落点） |
| P0     | `packages/core/src/agent/subagent.ts`（口径统一落点）、`packages/cli/src/chat.ts` 与 `packages/core/src/server/sessions.ts`（两端装配对照）                                                      |
| P1     | `architecture.md`（P2-4 性能口径、子会话语义声明）、`packages/desktop/electron-builder.yml`、`.github/workflows/{ci,release}.yml`、`AGENTS.md`                                                   |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 master（≥324c8c9）拉 `feat/phase-11-stabilization`

---

## Global Constraints（冲突时以本节为准）

1. **测量先于优化**：性能基线数据（脚本可复跑）先行；只有基线暴露 >3s 级痛点才做低风险优化，且每项优化附前后对比数据；禁止无数据的大重构。
2. **口径统一单向**：子会话语义统一到 architecture.md 既有声明（不继承 per-session 绑定类工具）；skills 注入对子会话为**加性**能力（新增，非削减）。
3. **零新增事件类型**；密钥三不；doctor/崩溃报告输出必须过既有 redactSecrets 出口。
4. **错误处理无遥测**：崩溃报告仅写本地 `~/.harness2/crash/`，README 如实声明"无自动上报"；不做任何网络发送。
5. **分发产物 unsigned**：macOS dmg / Linux AppImage 构建产物上传 artifact/Release，不签名不公证（总控计划既定）。
6. **Git：** 每 Task 一提交；禁止 push。

---

## File Structure（预期变更）

| 文件                                                                               | 动作 | 职责                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/session/bench.ts` 或 `scripts/bench-session.mjs`                | 新建 | 性能基线：合成 N=10 万事件日志（user/assistant/tool 混合 + 若干 rewind），测 loadSession/computeProjection/list/search/export/replay 耗时，输出表 |
| `packages/core/src/session/export.ts`                                              | 修改 | importReplay 解压总体积上限（默认 256MiB，可参覆盖）+ 超限友好报错                                                                                |
| `packages/core/src/agent/subagent.ts` + `cli/chat.ts` + `server/sessions.ts`       | 修改 | 子会话口径统一（见 Task 2）                                                                                                                       |
| `packages/core/src/doctor/index.ts`                                                | 新建 | `harness2 doctor`：node 版本 / config+auth 校验（脱敏）/ 目录可写 / mcp 探测（`--probe` 可选）/ 会话库完整性扫描（坏行统计）/ skills 扫描报告     |
| `packages/cli/src/index.ts`                                                        | 修改 | `doctor` 命令接线；chat/serve 顶层 uncaughtException → `~/.harness2/crash/<ts>.log`（redact 后）+ 控制台打印路径                                  |
| `.github/workflows/ci.yml`、`release.yml`、`packages/desktop/electron-builder.yml` | 修改 | 桌面构建矩阵 win/nsis + mac/dmg + linux/AppImage，artifact 上传；release 附加产物                                                                 |
| `packages/core/test/{bench,doctor}.test.ts`、`packages/cli/test/doctor.test.ts`    | 新建 | 见各 Task                                                                                                                                         |

---

## Task 1：性能基线与预算（消化 P2-4）

- 合成日志生成器（10 万事件量级，含 20% tool 事件 + 若干 rewind/marker）→ 计时 loadSession / computeProjection / 会话 list / 搜索 / exportSession / importReplay；结果写入 architecture.md「性能预算」节（表格式：操作 × 10 万事件 × 本机数据），标注测量环境（Windows/Node 版本）。
- **预算判定**：任一操作 >3s 视为痛点 → 做且仅做该点的低风险优化（候选：投影跳过遮蔽段早退、search 流式化）；每项优化附 before/after 数据。无痛点则如实记录"基线达标，不优化"。
- importReplay 解压上限：累计解压字节 > 上限即抛错（消息含上限值与建议）；测试：正常包通过 / 超限包报错（小上限注入测）。
- 测试：合成生成器确定性（同 seed 同日志）；上限两例。≥4 例。
- Commit：`⚡perf(core): 大日志性能基线与预算落地 + 回放解压上限`

## Task 2：子会话口径统一（消化 OPEN 两行）

- **统一到 serve 语义**（architecture.md P2-4 既声明）：子会话工具集 = 宿主集 − subagent 工具 − **memory/browser**（per-session 绑定类）；CLI 侧在装配 subagent 时剔除二者（chat.ts 现为共享注册表直通）。
- **子会话补 skills 注入**（加性）：subagent runTurn 传 `skills`（宿主同款 SkillStore），子会话 system 亦得 `[Skills 可用]` 列表——消除"继承 skill 工具但盲调"缺口。
- architecture.md 子会话小节更新为统一口径（两端一致），OPEN 两行关闭。
- 测试：CLI 子会话无 memory/browser 工具（防回归钉死）；CLI/serve 两端子会话工具集**相等**断言；子会话 skills 注入与宿主一致。≥4 例。
- Commit：`♻️refactor(core,cli): 子会话口径统一——剔除 per-session 工具 + 补 skills 注入`

## Task 3：分发矩阵（unsigned）

- electron-builder：mac（dmg，arm64+x64）、linux（AppImage）target 补齐（win/nsis 已有）；CI 增 `build-desktop` matrix job（三平台各自构建 + artifact 上传，构建失败即红）；release.yml 把三平台产物附加到 GitHub Release。
- macOS 无证书：显式 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名（构建日志声明 unsigned）。
- npm 发布物料复核（files/engines/bin），**发布动作本身仍待 NPM_TOKEN（人类操作，不阻塞）**。
- 验证：本地 Windows 构建 nsis 一次通过即可（mac/linux 依赖 CI，标注待远程验证）；workflow YAML 语法校验。
- Commit：`🔧chore(ci): 三平台桌面包构建矩阵（unsigned）+ Release 产物附加`

## Task 4：崩溃恢复演练 + doctor

- **演练测试**（整合为 crash-drill）：①writer append 中途模拟截断（写半行 + 断电式进程结束语义）→ recoverTruncatedTail → 重开追加，既有事件无损；②serve 子进程 kill -9 → serve-manager 退避重启恢复（桌面逻辑已有单测，补 CLI serve 层面演练或声明复用）；③export 出的 zip 经 importReplay 往返（与 Task 1 基线共用合成日志）。
- **`harness2 doctor`**：分节报告（OK/WARN/FAIL + 明细）：node 版本 ≥22；config 可解析 + auth key 存在（脱敏显示来源）；~/.harness2 目录可写；mcp servers 配置探测（默认仅列出，`--probe` 实连，超时 5s）；会话库完整性（逐会话 parse，坏行/告警统计）；skills 扫描摘要。exit 0（无 FAIL）/ 1（有 FAIL）。
- **崩溃报告**：CLI 顶层 uncaughtException → `~/.harness2/crash/<ISO时间>.log`（版本/平台/栈/当前会话 id，redactSecrets 过滤）+ 控制台打印路径与"手动反馈"指引；测试用注入 throw 验证落盘与脱敏。
- 测试 ≥8 例。
- Commit：`✨feat(core,cli): doctor 自检 + 崩溃报告本地落盘 + 崩溃恢复演练`

## Task 5：抖动根治 + 整备交接

- **抖动**（OPEN 并案行）：定位 loop.test/tools.test 残余墙钟断言与浏览器用例并发交互——最小干预（拆文件/降并发/放宽余量并注释依据）；本地连续 3 次全量 `pnpm test` 全绿为过关线；OPEN 行更新处置结果。
- **整备**：architecture（性能预算表/子会话统一口径/doctor/分发矩阵小节）、HANDOFF 快照、diary（2026-09-07 追加）、OPEN 清理（关闭 Task 1/2/5 消化的行，新增"三平台 CI 产物待远程验证""真实大会话 bench 数字待用户环境复核"）。
- Commit：`✅test: 抖动根治 + 📝docs: 阶段11整备`（可拆两提交）

---

## 验收标准总表

| #   | 标准        | 通过条件                                                                     |
| --- | ----------- | ---------------------------------------------------------------------------- |
| 1   | 性能基线    | 架构文档含可复跑脚本产出的基线表；痛点项要么有前后数据优化、要么如实记录达标 |
| 2   | 回放上限    | 超限包友好报错测试通过                                                       |
| 3   | 口径统一    | 两端子会话工具集相等断言 + 无 memory/browser 防回归 + skills 注入测试通过    |
| 4   | 分发        | 三平台 builder 配置 + CI matrix 就绪；Windows 本地构建通过；YAML 校验过      |
| 5   | 演练+doctor | crash-drill 测试通过；doctor 命令实测输出 OK/FAIL 正确；崩溃报告落盘且脱敏   |
| 6   | 抖动        | 连续 3 次全量 `pnpm test` 全绿                                               |
| 7   | 红线        | 零新增事件类型；密钥三不；无遥测发送                                         |
| 8   | 单测/构建   | `pnpm test && pnpm -r typecheck` exit 0                                      |

---

## 风险与降级

| 风险                          | 缓解                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| 10 万事件合成日志测试过慢     | 生成器放 fixture 脚本（非每测运行），测试用小样本 + 采样校验  |
| mac/linux 构建本地无法验证    | YAML 语法 + 本地 win 构建 + CI 标注待远程；失败留 OPEN        |
| 口径统一破坏既有 CLI 用户习惯 | 行为变化在 CHANGELOG 显著声明；防回归测试钉死新口径           |
| 抖动无法根治                  | 3 次全绿过关线达不到则如实降级为"缓解维持 + 继续留档"，不虚报 |
| doctor 误报                   | 各检查项独立 try/catch，单项失败不拖垮整份报告                |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 11 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:\AI_projects\harness2`（Windows，Git Bash，pnpm monorepo，Node ≥22）；从 master 创建并切换 `feat/phase-11-stabilization`
- 已完成勿重做：阶段 1-10 全部验收闭环（ROADMAP 26/26 ✅），基线测试 **579 passed + 1 skipped**（1 skipped 为 H2_GEN_LOOP_DEMO 门控 fixture 生成器，非失败）
- 唯一实施计划：`docs/ai-framework/plans/2026-09-07-phase-11-stabilization-distribution.md`
- 必读：本计划、`docs/issue-log/OPEN.md`（本阶段消化多行留档——先读）、`session/reader.ts`、`session/export.ts`、`agent/subagent.ts`、`cli/chat.ts` 与 `core/server/sessions.ts`（两端装配）、`architecture.md`、`AGENTS.md`、`coding-standards.md`
- 已知偶发抖动：全量测试单例失败先重跑甄别（Task 5 会根治它，甄别流程照旧）

### 做

1. 严格按 Task 1→5 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：**测量先于优化**（无数据不重构）；口径统一单向（统一到 architecture 既有 serve 语义 + skills 加性）；零新增事件类型；崩溃报告只落盘零遥测
3. Task 5 更新 architecture/HANDOFF/diary/OPEN，并把消化掉的 OPEN 行关闭

### 不做

- 大规模性能重构（除非基线数据支持）；遥测/自动上报；macOS 签名；任何 `git push`

### 工作方式

1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷

分支名、提交列表、验收总表逐项自评（带命令与真实结果）、新增测试数、性能基线表（若产出）、残留风险与未关闭项。

现在开始：读完本阶段计划与 OPEN.md，从 Task 1 执行到 Task 5。

---

## 残留手工验收清单

1. （CI 远程）mac dmg / linux AppImage 构建产物与 Release 附加——push 后看 Actions
2. （用户环境）真实大会话跑 bench 脚本复核基线数字；`harness2 doctor` 实机输出
