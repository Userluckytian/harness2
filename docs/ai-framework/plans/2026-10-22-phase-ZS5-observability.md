# 阶段 ZS5：观测性与监控（崩溃归因 / 运行日志 / 启动计时 / 资源监控 / soak）

> **状态：** **收口（2026-10-23）**——T0–T9 全落地；e2e 五轮矩阵+soak PASS；V8 双审查（ZS5 分支+ZS4 补账欠账）P0=0 且 P1 全清偿；core 根治提案待人类批准；V9 交用户真机
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。  
> **交接提示词**见文末「给接手 AI 的完整提示词」。  
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 崩溃可归因、运行日志可查、资源占用可视化（优先复用 ZCode 原生资源管理器），soak 判据过，并清掉 ZS4 带来的观测噪声（sessions-index FAIL 重试）。  
**Architecture:** 观测实现尽量落在**我方资产**（`packages/zcode-adapter`、`packages/core` 既有面）与 **scratch 装配区既有能力**（desktop main 原生 `resourceManagerWindow` / `logger`），scratch UI 零新改；唯一新增 UI patch 的可能性（悬浮卡片形态）设人类拍板门。core 已有 `doctor/crash.ts`（零遥测、redact 出口）→ 本阶段**只接线不造轮子**。  
**Tech Stack:** Electron 主进程/utility host、`@zcode/shared` HostMessageTypes 采样协议、Node `process.memoryUsage/cpuUsage`、CDP e2e（既有 runbook）、PowerShell 采样（soak）。  
**实施档位：** 全能（默认）  
**子代理：** 启用（审查 + 验收；**教训约束：子代理声称写文件必须编排者 git diff 独立核验，见 issue-log 2026-10-22 §14**）

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`                                                 |
| P0     | 本文件                                                                                    |
| P0     | `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md`（ZS5 行=需求来源）     |
| P0     | `docs/refs/README.md` §2（六步流程；refs 三仓已 2026-10-22 重析到位）                     |
| P1     | `docs/refs/refs-hermes-agent.md`（新增 H-80～H-98 观测能力面）                            |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`                                                             |
| P1     | `docs/ai-framework/plans/2026-10-21-phase-ZS4-sidebar-and-settings.md` §收口（遗留 3 条） |

**仓库路径：** `D:/AI_Projects/harness2`（scratch 装配区 `D:/AI_Projects/harness2-zs1-build/ZCode`）  
**基线分支：** 从 `main`（≥`refs 重析提交`）拉 `feat/phase-zs5-observability`

---

## Global Constraints（冲突时以本节为准）

1. **UI patch 基线 = 2 处**（P1 desktopRuntimeEnv / P2 ProviderCardSections，ZS1 计划登记）。本阶段目标 **仍 2 处**；任何 scratch `packages/ui`、`desktop/main` 新功能改动 = patch #3+，**必须先人类拍板**再动。
2. **零遥测红线**：崩溃报告/日志/指标**只本地落盘**，无网络发送（hermes H-88 产品遥测整包不采纳；core `doctor/crash.ts` 现契约即此口径）。
3. **密钥红线**：观测出口全过 `redactSecrets`（崩溃报告已内建；日志行新增者须断言）。
4. **core 冻结**：默认零改动。获批窗口（提案先行）：a) 崩溃接线若需 core 导出补充——预期不需要（`reportCrash`/`crashReportDir` 已导出，index.ts:87）。b) `subscribeSessionsIndexV4` 若需 core 会话枚举能力——先提案。
5. **旧壳（`packages/desktop`、`ui-shared`、`cli`、`gateway`、`web`）零改动**；`packages/gateway` H-47 冻结不变。
6. **e2e 只走 runbook**（fake-home）；provider 写探针禁真 home；9229 单实例，禁并发轮。
7. **明确不做（本阶段）**：❌ OTLP/网络导出（H-82 延后）❌ 安装身份/伪匿名（H-86 运营向）❌ 悬浮卡片若原生资源管理器已满足则不另造 ❌ cron/流监控（H-85/H-98 面，core 无对应物）❌ ZS6 范围（打包/品牌/C 类清单/旧壳退役）。
8. **Git**：小步 commit；push 仅限 ZS 程序既定 main 通道（沿用授权）。

---

## 阶段开头：上阶段遗留（ZS4 验收表 ⚠️/⬜ + V9 反馈处置）

| 遗留项                                                                                                 | 来源                  | 原因/现状                                                                                       | 本阶段处置                                |
| ------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `subscribeSessionsIndexV4` 未实现                                                                      | ZS4 收口 V9 产品缺口② | host log 每 20s FAIL 重试，观测噪声源；分组实时推送依赖它                                       | **T3 内修**（观测面前置条件）             |
| adapter 不推 window-controller 帧（ui-stale）                                                          | ZS4 收口 V9 缺口①     | mutate 后 UI 行移除靠刷新时机                                                                   | T3 一并解决（同一订阅面）；e2e 侧栏轮复验 |
| `deletePersonalProvider` 不清 auth 密钥                                                                | ZS4 收口 V9 缺口③     | 保守遗留                                                                                        | **T5 卫生项**（adapter 面，含测试）       |
| 手填对话框「无基线提示文案」体验（V9①残）                                                              | 2026-10-22 日志 §8    | 若改 UI 文案=patch #3 → 不做；改走 `resolveModelConfig.issues`（UI 已渲染 issues？T0 盘点决定） | T0 盘点 + 若零 patch 可达则 T5 附带       |
| ZS4 本体 V8 独立审查（6×5xx 阵亡未补）                                                                 | ZS4 收口 V8           | 通道历史故障；ZS4.5f 已首达一份                                                                 | **T7 统一复审**补 ZS4/ZS4.5 全量          |
| ZS4.5f P2 尾巴（discover 出口 redact 风格、savedProvider 轮询、富化失败/并发覆盖、探针 send() reject） | 2026-10-22 日志 §11   | 择要修后登记                                                                                    | T5/T6 内小项                              |

---

## 跳过项（因档位未做）

| 跳过项 | 原因      | 待补做 |
| ------ | --------- | ------ |
| 无     | 档位=全能 | —      |

---

## 与前后阶段

| 阶段                    | 状态 | 交付                                                                            |
| ----------------------- | ---- | ------------------------------------------------------------------------------- |
| 上阶段 ZS4（含 4.5 系） | ✅   | 侧栏操作全链 + 设置写面 + 获取模型勾选流（用户真机复验 2026-10-22「现在对了」） |
| **本阶段 ZS5**          | ⬜   | 崩溃归因 / 运行日志 / 启动计时 / 资源监控 / soak / 遗留清理                     |
| 下阶段 ZS6              |      | 打包发版、品牌、C 类清单、旧壳退役（勿塞进本阶段）                              |

---

## 关键事实（T0 之前已侦察，防重复劳动）

- **ZCode 原生资源管理器已存在**：scratch `packages/desktop/src/main/resourceManagerWindow.ts`（独立 BrowserWindow + `preload/resourceManager.cjs`；main 只采 `app.getAppMetrics`+os 总量；**外部进程（host/utility）经 `resourceManagerHostSampling.ts` 的 requestId fan-out 向 Host 要**，超时 900ms 用上一轮兜底）。协议类型在 `@zcode/shared` `HostMessageTypes`。**我们 scratch 桌面壳大概率直接能开这个窗口——入口路径待 T0 实探**（菜单/命令面板？ZS1 装配是否隐藏？）。
- **我方 adapter host 不应答采样协议**：`packages/zcode-adapter/src/host-entry.ts` 只讲 DatabaseStartupState + ChannelServer → 原生资源管理器里 host 行会永远兜底/缺失 = **T1 核心缺口**。
- **core 崩溃报告已存在**：`packages/core/src/doctor/crash.ts`（`~/.harness2/crash/`、零遥测、redact 闸门、`noteCrashSessionId`），cli `chat-setup.ts` 已接；**desktop/host 进程未接** = T2。
- **scratch desktop 原生有 `logger`**（`src/main/logger.ts` 引用可见）→ 运行日志优先复用，不自造（T4 盘点落点=ZCODE_DATA_BASE_DIR 即 `zs1-data` 下何处）。
- **参考**：hermes 崩溃四件套 H-89～H-92（crash-forensics/lag-watchdog/renderer-crash-metrics/consent 计数）与 H-93/94（轮转/集中日志）为设计蓝本，等级=参考。

---

## File Structure（预期变更）

| 文件                                                 | 动作 | 职责                                                                       |
| ---------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `packages/zcode-adapter/src/host-entry.ts`           | 修改 | 应答 HostMessageTypes 资源采样（parentPort 监听，纯加性）                  |
| `packages/zcode-adapter/src/real/host-sampling.ts`   | 新建 | 采样实现（process.memoryUsage/cpuUsage 差分）+ 可注入测试缝                |
| `packages/zcode-adapter/test/host-sampling.test.ts`  | 新建 | 协议形状/密钥不出现在采样/超时行为                                         |
| `packages/zcode-adapter/src/host-entry.ts`（同文件） | 修改 | uncaughtException/unhandledRejection → core `reportCrash`（不新造轮子）    |
| `packages/zcode-adapter/src/real/agent-service.ts`   | 修改 | `subscribeSessionsIndexV4` + controller 帧推送（T3，若需 core 窗口另提案） |
| `packages/zcode-adapter/src/real/provider-views.ts`  | 修改 | deletePersonalProvider 清 auth 键（T5）；（若 T0 判定）issues 提示         |
| `scripts/zs5/soak.cjs`（+ ps 采样片）                | 新建 | 30min soak 采集 CSV + 判据断言（T6）                                       |
| `scripts/zs2/run-e2e.ps1`                            | 修改 | 新增 `-Crash` 轮（注入 host 崩溃→报告断言）或独立 `-Soak` 开关             |
| `docs/ai-framework/plans/zs5-inventory.md`           | 新建 | T0 盘点映射表（含决策点登记）                                              |

scratch 侧**零文件预期变更**；若 T0 证明「原生资源管理器入口在我们壳里被隐藏/未注册」且唯一解是 patch → **停下报人类拍板**（patch #3 门）。

---

## Task 0：盘点与入口实探（无代码）

**行为:** 摸清四件事并出 `zs5-inventory.md`：①原生资源管理器**打开路径**（grep `resourceManager` 在 desktop main 注册/菜单/命令面板/testid；scratch 起壳 CDP 实探菜单是否可见）；②`@zcode/shared` `HostMessageTypes` 采样请求/响应**确切形状**（字段/单位/进程标签）；③desktop 原生 `logger` 落盘位置（ZCODE_DATA_BASE_DIR 口径）与现有崩溃/错误处理（crashReporter/unhandled 是否已接）；④`subscribeSessionsIndexV4` 消费方契约（services/ui 的期望形状）+ core 是否已有会话枚举能力可直译。

**Steps:**

1. grep/read 上述四处，映射表逐条编号引用（Z-_/H-_ 或新 `ZS5-*`）。
2. 起一次 scratch 壳（launch-manual）人工/CDP 确认资源管理器窗口可否打开、host 行现状（截图入 `docs/screenshots/zs5/`）。
3. 决策点落纸：悬浮卡片=直接用原生窗口（默认）还是另造（需 patch #3 人类拍板）。
4. Commit：`📝docs(zs5): T0 盘点——原生资源管理器入口/采样协议/logger 现状/sessions-index 契约`

---

## Task 1：host 采样应答（资源监控的后端半）

**Files:** `host-entry.ts`、`src/real/host-sampling.ts`、测试新建。

**行为:** parentPort 收采样请求（形状=T0 实测）→ 回 host 自身进程行（pid/cpu%/memRSS…按协议单位）；未知消息类型保持忽略（不破坏现有 DatabaseStartup 流程）；单测不依赖 Electron（缝=注入 message 端口 mock）。

**Steps:**

1. 实现 + 测试；`--filter @harness2/zcode-adapter test` 期望全绿（130+）。
2. `node scripts/zs1-guard.mjs buildAll`（含 smokeBundle）绿。
3. 真探：起壳开资源管理器 → host 行出现**且数值随负载变化**（跑一轮 e2e 期间观察；截图入库）。
4. Commit：`✨feat(zcode-adapter): host 应答资源采样协议——原生资源管理器 host 行接通（ZS5-T1）`

---

## Task 2：崩溃归因接线（main/host）

**行为:** host 进程 `uncaughtException`/`unhandledRejection` → core `reportCrash`（现函数，**不改 core**）；验证「复现一次崩溃能拿到报告」。desktop main 侧若 T0 证明原生已有等价物→复用只验不改；若没有且需 patch → 停，登记人类拍板门。

**Steps:**

1. 接线 + 单测（注入抛错 → 临时 home `crash/` 出文件、内容含版本/栈、`redactSecrets` 生效即测试里放 SECRET 断言不出现）。
2. e2e runbook 加 `-Crash`：设 env `ZS5_TEST_CRASH=1` 使 host 启动后主动抛 → 断言报告文件 + shell 不连坐崩（窗口仍可 CDP）。
3. 全门 + commit：`✨feat(zcode-adapter): host 崩溃→core 零遥测报告接线（ZS5-T2）`

---

## Task 3：sessions 索引订阅 + controller 帧（清噪声 + 补实时）

**行为:** 实现 `subscribeSessionsIndexV4`（契约=T0④）+ 变更后推帧（消 ZS4 缺口①②）；host log 的 20s FAIL 重试消失=可断言信号。core 若缺枚举/事件原语 → **提案窗口**（签名+测试清单，编排者批准后实施）。

**Steps:**

1. 实现 + adapter 单测；跑壳 40s 采样 log 断言 FAIL 计数=0。
2. e2e 侧栏轮复跑（删除/归档后 UI 即时一致，不靠手动刷新）。
3. Commit：`✨feat(zcode-adapter): subscribeSessionsIndexV4+变更帧——清 20s FAIL 噪声补侧栏实时（ZS5-T3）`

---

## Task 4：运行日志与启动计时（复用原生，零自造）

**行为:** T0③ 若原生 logger 已落盘（大概率）→ 本 Task 收缩为：a) 确认我们 host 的 console/log 汇入路径可读；b) 启动分段计时一行（InitLocal→database ready→root mount→首帧，来源=既有 log 时间戳差分；能纯 adapter 侧做则做，否则降级为「文档化的 log 行读取脚本」，不碰 scratch）。c) 日志轮转仅当实测日体量 >50MB 才引（红线：不为假想需求造轮子）。

**Steps:** 按 T0 结果裁剪，产物=脚本或 ≤15 行接线 + 证据 log 文件；commit `⚡perf(zcode-adapter): 启动分段计时日志（ZS5-T4）`（标题随实际 type）。

---

## Task 5：遗留卫生（auth 清理 / P2 尾巴 / 手填提示）

**行为:** ①`deletePersonalProvider` 同步删 auth.json 该 provider 键（测试钉）；②ZS4.5f P2 尾巴（discover 出口 redact 风格统一、savedProvider 轮询化、并发 addDiscoveredModels 测试）；③若 T0 证明 UI 渲染 `resolveModelConfig.issues` → 空基线时给真实提示文案（纯 adapter 返回值，零 patch）。

**Steps:** 小步三 commit，均 `fix(zcode-adapter)`/`test`。

---

## Task 6：soak ≥30min（内存曲线判据）

**Files:** `scripts/zs5/soak.cjs`。  
**行为:** 起壳（fake-home）→ 30min 空闲 + 中途自动发 3 轮对话（复用 e2e 探针片段）→ 每 10s PowerShell `Get-Process`（仅 scratch 路径进程）采 WS 记 CSV → 判据：后 10min 均值 ≤ 前 10min 均值 ×1.25 且无 scratch 进程数单调增长（泄漏子进程）且 `crash/` 零新文件。阈值数字 T0 后与用户一次确认再定稿。  
**Steps:** 脚本 + 实跑一次出报告（`docs/screenshots/zs5/soak.csv` 或 md 摘要）；commit `✅test(zs5): soak 30min 采集与判据（ZS5-T6）`。

---

## Task 7：收口（编排者亲验 + 独立复审补账）

1. 全门：adapter/六包测试、typecheck、eslint 0 error、**prettier --check . 全绿**（CI 教训）；
2. e2e 矩阵四轮 + 新 `-Crash` 轮全绿；
3. **ZS4/ZS4.5/V8 欠账独立复审**（cat-jam；报告必须落盘 `docs/ai-framework/plans/zs5-review-*.md` 且编排者 git 核验存在——§14 教训）；
4. UI patch 清单复核 =仍 2 处（`diff -rq` 对照 refs，ZS1 §V4 法）；
5. OPEN.md/issue-log 收口；push + CI。

---

## 代码审查（档位=全能 → 执行）

**审查方：** cat-jam 独立只读；**审查面：** 红线（零遥测/密钥/patch 计数）、协议接线正确性、soak 判据可证伪性、测试完整性。结论进验收表 V8 行。

---

## 验收标准总表

| #   | 标准         | 通过条件                                                         | 验证责任人  |
| --- | ------------ | ---------------------------------------------------------------- | ----------- |
| V1  | 崩溃可归因   | `-Crash` 轮：报告落盘、含栈、无密钥、壳不连坐                    | 自动化      |
| V2  | 资源监控可用 | 原生资源管理器 host 行有数且随负载变（截图）；零新 UI patch 路径 | 端到端+用户 |
| V3  | 噪声清零     | 40s 采样 host log FAIL=0；侧栏操作 UI 即时一致（T3）             | 自动化      |
| V4  | 启动计时     | 分段耗时行可读（脚本或 log 断言）                                | 自动化      |
| V5  | soak 判据    | 30min CSV + 阈值断言过；报告入库                                 | 自动化      |
| V6  | 冻结纪律     | UI patch=2（diff 实证）；六受保护包 0 diff；core 仅获批窗口      | 编排者      |
| V7  | 全门+CI      | 测试/typecheck/eslint/prettier/e2e 矩阵 + 双 CI 绿               | 自动化      |
| V8  | 独立审查     | P0=0；P1 闭环；含 ZS4 补账；报告文件真实存在（git 核验）         | 子代理      |
| V9  | 用户真机     | 打开资源管理器看 host 行；制造一次崩溃拿报告；日志位置指认       | 用户        |

---

## 风险与降级

| 风险                                                 | 缓解                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| 原生资源管理器入口在装配区被隐藏，唯一解=UI patch #3 | T0 实探后**人类拍板门**；未批则降级为 CDP/脚本采样（监控卡片列 ZS6+）    |
| `HostMessageTypes` 协议细节与 T0 实测不符            | T1 以**实测抓帧**为准，不凭记忆；红线「禁止凭想象设计」同源              |
| subscribeSessionsIndexV4 需 core 窗口被否            | 降级：adapter 侧轮询 diff 推帧（如实登记机制差异）                       |
| soak 在开发机负载抖动下假红                          | 判据用比值不用绝对值；失败先复跑再定性（CI macos 性能断言 flake 同教训） |
| 子代理虚报落盘（本日 §14 实证 2 例）                 | 一切声称改文件的任务，验收必跑 `git diff --stat` 独立核验                |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行 ZS5 阶段**，不要只写方案。

### 基线

- 目录：`D:/AI_Projects/harness2`；scratch：`D:/AI_Projects/harness2-zs1-build/ZCode`（只读优先，改动=patch 登记+人类拍板）
- 从 `main` 创建并切换：`feat/phase-zs5-observability`
- 已完成：ZS1–ZS4.5 全绿收口（**不要重做**；必读 `docs/issue-log/OPEN.md` 前 6 行）
- 唯一实施计划：`docs/ai-framework/plans/2026-10-22-phase-ZS5-observability.md`
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`docs/refs/README.md` §2

### 做

1. 按 Task 0→7 顺序；T0 盘点先行，其结论若触发人类拍板门（UI patch #3 / core 窗口），**停下报告**，等编排者确认再继续。
2. 每 Task 完成即跑计划内证据命令并 commit（gitmoji 规范）；证据优先，禁止「应该能过」。
3. pnpm 直调（无 cmd.exe）：`node "D:/.pnpm-store/v11/links/@/pnpm/11.13.0/d11795881783aa51f96a2d2a2c920d8e31138fac1136d44bf46998e29eab8385/node_modules/pnpm/bin/pnpm.mjs" --filter @harness2/zcode-adapter test|typecheck`；buildAll=`node scripts/zs1-guard.mjs buildAll`。
4. e2e：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zs2/run-e2e.ps1 -Fresh [-SettingsProvider|-Approval|-SidebarDelete]`；9229 单实例禁并发；provider 写只走 fake-home。

### 不做

- 任何遥测/网络发送；密钥落盘/入日志/进错误消息；scratch UI/desktop 新功能改动（除非人类已批并登记 patch）；core/gateway 未获批改动；旧壳任何改动；`git push`（编排者统一做）。

### 工作方式

1. 先跑基线（adapter test + buildAll）确认干净再动。
2. 严格 Task 顺序；每 Task 测试后 commit。
3. 用简体中文回进度；代码标识符原样；issue-log 按日维护。
4. 改文件后自证 `git diff --stat`，报告原文（防虚报，见 2026-10-22 日志 §14）。

### 交卷

分支名、提交列表、验收表自评（V1–V9 逐行）、测试/构建/e2e 实际输出摘要、残留风险与未决门。

现在开始：读完本阶段计划，从 Task 0 执行到最后。

---

## 残留手工验收清单

1. 用户真机：设置→打开资源管理器（或 T0 探明入口）→ host 行有 CPU/内存数且会动。
2. 用户真机：制造一次崩溃（或执行 `-Crash` 轮）→ 指认 `~/.harness2/crash/` 报告内容可读。
3. 悬浮卡片形态若用户点名要（常驻置顶小窗而非原生窗口）→ 触发 patch #3 拍板流程。
