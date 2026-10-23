# 阶段 ZS6：收尾与切换（C 类清单执行 / 品牌 / 打包 / 旧壳退役 / 发版）

> **状态：** 计划已就绪（2026-10-23，用户已授权开工）  
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。  
> **交接提示词**见文末。  
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 新壳（ZCode 壳 + harness2 内心）成为**唯一可交付桌面产品**：假入口清零、品牌落定、安装包产出、旧壳去留有决议、上游同步流程成文。  
**Architecture:** 隐藏/降级一律走**装配层与数据形状**（C 类桩返回真·空态使 UI 自然隐藏，或 desktop main 菜单/快捷键装配点），不改 vendored UI 源码（红线⑩+patch 纪律）；打包走 scratch desktop `electron-builder` 正常通道（本机 `cmd.exe` 已恢复，实证 2026-10-23——U1 时代 `manual-pack.mjs` 变通通道留作备份）；发版动作全部人类执行或逐项授权。  
**Tech Stack:** electron-builder（win NSIS + portable）、feature-gate/服务数据形状、ZS1–ZS5 全部门禁体系（adapter 测试/e2e 五轮/soak/prettier/CI）。  
**实施档位：** 全能（默认，沿用 ZS5 口径）  
**子代理：** 启用（实现/测试/审查；§14 纪律：声称改文件必过编排者 `git diff` 独立核验）

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md` + 本文件                                                                           |
| P0     | `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md`（ZS6 行）                                                 |
| P0     | `docs/ai-framework/plans/zs5-inventory.md`（装配区现状事实）                                                                 |
| P0     | `docs/refs/README.md` §2 六步（refs 四仓 2026-10-23 已拉：ZCode 3c5b2276 未动/其余见更新记录）                               |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`、`docs/ai-framework/plans/2026-10-14-phase-U1-desktop-parity-fixes.md` §T8（打包变通通道历史） |

**仓库路径：** `D:/AI_Projects/harness2`；scratch `D:/AI_Projects/harness2-zs1-build/ZCode`  
**基线分支：** 从 `main`（含 ZS5 全量 + core 提案实施合入后）拉 `feat/phase-zs6-finalization`

---

## Global Constraints（冲突时以本节为准）

1. **UI patch 基线=2 处**（P1 desktopRuntimeEnv / P2 ProviderCardSections）。本阶段允许新增 patch 的范围**仅限品牌与隐藏所需的装配点**（desktop main / 构建配置 / index.html 壳），每处照 ZS1 法登记进本计划执行记录；`packages/ui` 源码**零新改动**。隐藏不得用 CSS 全局硬藏（脆弱），优先数据形状/feature-gate。
   > **执行期偏离登记（2026-10-23 T1）**：实证核查（zs5-inventory/审计探针）发现「零 patch 通道」在本阶段隐藏面上**不成立**——usage/remoteDevices 分区（`HIDDEN_SETTINGS_SECTIONS`）、Z.ai/Start Plan 预设卡（`PRESET/CODING_PLAN_PROVIDER_SPECS`）、Help 运营外链（`WorkspaceHelpMenuButton` 硬编码）**均为 packages/ui 内静态渲染，无 adapter 数据形状或 services feature-gate 可外部驱动**。故改走**唯一可用且 ZCode 自家既有的隐藏机制**（同 automations/plugins 的静态集合 + 数据表置空 + 常量门），登记为 **P3–P6，UI patch 基线 2→6**；全部为「不渲染假入口」，**零改任何交互组件行为**，与 P2（加新交互）性质不同。总纲 ZS6 行「C 类隐藏清单执行」即授权此动作；红线⑩为全程序硬约束，不留可点必炸入口。完整 diff 落 `docs/patches/zs-shell-patches.patch`，运行态回归 `scripts/zs6/t1-verify.cjs` GATE=PASS。
2. **发版红线**：`git tag`、GitHub Release、安装包对外分发=**人类亲手或逐次明确授权**；代理只做到「产物就绪+校验报告」。
3. **零遥测/密钥/红线⑩纪律不变**；假入口判据=用户在 UI 能看到并可点击的每个功能入口，其后端要么真实、要么该入口消失（不是「点了弹报错」）。
4. **旧壳六包（desktop 旧 renderer/ui-shared/web/cli/gateway）** 退役决策=**人类拍板门**（T4），本阶段之前维持冻结现状。
5. **core/gateway 冻结**不变；core 提案窗口已于 ZS5 后获批实施（locate 校验+deleteSession 告警），本阶段无新 core 窗口。
6. e2e 走 runbook；9229 单实例串行；provider 写探针 fake-home。
7. **明确不做（本阶段）**：❌ macOS/Linux 打包（win 优先，跨平台另立）❌ 自动更新链路（updater 属运营向，参考 ZS5 判定不采纳）❌ 任何新 feature 面（ZS6=收尾，不是加法）。

---

## 阶段开头：上阶段遗留（ZS5 验收表状态）

| 遗留项                                                                                               | 来源            | 现状                                                                  | 本阶段处置                                   |
| ---------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| V9 用户真机三项                                                                                      | ZS5 验收表      | **✅ 2026-10-23 用户反馈「没问题」**（host 行/崩溃/实时）             | 关闭                                         |
| core 提案（locate 校验+deleteSession 异常区分）                                                      | ZS5 T8          | **✅ 用户批准**，实施中（`fix/zs5-core-session-validation` 并行分支） | 合入 main 后本阶段基线含之                   |
| ZS5 P2 尾巴：sessions-index 订阅 TTL、ZS5_TEST_CRASH 显式守卫、secret 形态测试夹具与 CI 扫描共存说明 | zs5-review-t1t5 | 登记未修（判非缺陷）                                                  | **T1 打包前顺手清**（全在 adapter，小面）    |
| 旧供应商真机全量模型清理                                                                             | ZS4.5g 遗留     | 用户未点名要批量入口                                                  | 保持不做；OPEN.md 挂账到 T4 退役决策一并处理 |

---

## 与前后阶段

| 阶段           | 状态                                 | 交付                                                     |
| -------------- | ------------------------------------ | -------------------------------------------------------- |
| 上阶段 ZS5     | ✅（V1–V9 全绿，CI run 39827943602） | 观测性四件套 + soak PASS + 双审查清偿                    |
| **本阶段 ZS6** | ⬜                                   | 假入口清零 / 品牌 / win 安装包 / 旧壳决议 / re-sync 文档 |
| 下阶段         | —                                    | ZS 程序终结；后续按 ROADMAP 另立项                       |

---

## File Structure（预期变更）

| 文件                                                                      | 动作          | 职责                                                                                  |
| ------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `docs/ai-framework/plans/zs6-hide-audit.md`                               | 新建          | T0 审计表：24 频道 × UI 入口 × 可见性实证 × 处置                                      |
| `packages/zcode-adapter/src/real/*`（少量）                               | 修改          | 数据形状使假入口自然隐藏（如 account/plan 返回 null 使 login 组件不渲染——以实证为准） |
| scratch `packages/desktop/src/main/desktopApplicationMenu.ts` 等装配点    | 修改=新 patch | 品牌词/图标/菜单项隐藏（逐处登记 P3/P4/…）                                            |
| scratch `packages/desktop/electron-builder 配置`（package.json build 段） | 修改=patch    | 产品名/图标/安装器元数据（构建配置不属 UI patch 口径，单独列表）                      |
| `packages/zcode-adapter/scripts/zs6-pack.ps1`                             | 新建          | 打包编排：buildAll→scratch desktop dist:win（镜像 env）→产物校验→smoke                |
| `docs/ai-framework/upstream-resync.md`                                    | 新建          | 上游 re-sync 六步流程文档化（含本次 ZS 全程实操教训：fetch 通道/flaky 定性/§14 纪律） |
| `docs/ai-framework/plans/zs6-retirement-proposal.md`                      | 新建          | T4 旧壳退役提案（人类拍板材料：现状/影响面/迁移注意/两案利弊）                        |

---

## Task 0：C 类假入口全量审计（无代码，只出表）

**行为:** 对 `channel-registry.ts` 现存 24 个 C 类频道（OAuth/CodingPlan/OffPeak/Highspeed/UsageStats/Feedback/ClientConfig/ClientScenes/CloudContent/MarketingTouch/Bots/Cua×2/RemoteProject/SourceServer×2/SkillSync/McpSync/PluginSync/WindowProject 族/ProviderProvisioning/OnboardingRecord），逐一在**运行中的真壳**（launch-manual + CDP 遍历：侧栏、设置全分区、命令面板、欢迎屏、任务头区）实证：入口可见吗？可点吗？点后什么表现（空态/报错/无反应）？判定三档：`已自然隐藏`/`需处置`（=T1 输入）/`真实无需动`（有 harness2 对应物）。**方法禁猜**：全部 DOM/testid 证据入表。

**Steps:** CDP 探针脚本化遍历（新 `scripts/zs6/audit-sweep.cjs`，抄 zs4 探针模式）→ 出 `zs6-hide-audit.md` → commit `📝docs(zs6): T0 C 类入口全量审计表`。

---

## Task 1：假入口处置（隐藏执行）+ ZS5 P2 尾巴

**行为:** 按 T0 表逐条处置「需处置」项，优先级：①数据形状（服务返回使 UI 条件渲染自然消失——ZS1「无登录门直达空态」已证 login-trigger 可数据驱动）；②desktop main 装配点（菜单/快捷键/IPC 注册处摘除，登记 patch）；③都不行才提 UI patch 人类拍板门。同 Task 修 ZS5 三小尾巴。

**Steps:** 每项处置配 adapter 单测（形状断言）；处置后 T0 探针复跑（`scripts/zs6/audit-sweep.cjs` 判据反用=入口消失断言）；门全绿 + e2e `-Fresh` 基础轮回归；commit 按项拆。

---

## Task 2：品牌装配（人类已授权 ZS6 开工=含品牌落地方向；**具体命名以 `docs/BRAND.md` 用户填空为准，未定则用 `harness2-desktop` 工作名并留 TODO**）

**行为:** 产品名/窗口标题/任务栏名/安装器名/图标：electron-builder 配置段 + desktop main 品牌字符串（grep `productName`/`ZCode` 于 desktop main 与 build 配置，逐处清单化）+ `index.html` 壳标题。图标：`docs/refs/` 无关——用 harness2 现有素材或占位（正式 logo 属人类供给面，登记待供）。**每处 scratch 改动=登记 patch P3/P4…（品牌类，装配点）**。

**Steps:** 改动清单先出（`zs6-brand-checklist.md`）再动手；起壳肉眼验证任务栏/标题/关于页=V3 证据（截图）；commit。

---

## Task 3：win 安装包（正常通道恢复 + 备份通道保活）

**行为:** scratch desktop `pnpm --filter desktop dist:win`（electron-builder 26，镜像 env 照 U1 T8 记录：`ELECTRON_MIRROR`/`electron_builder_binaries_mirror`）→ 产物 NSIS exe + portable；`cmd.exe` 已恢复为前提，若 builder 收集器仍异常→回退 `manual-pack.mjs` 通道（其脚本在旧壳 `packages/desktop/scripts/`，scratch 侧对齐移植）。smoke：产物解包关键文件清单 + `--smoke` 自检（如可用）+ 编排者装机试跑一次。**产物不进 git**（`release/` gitignore 确认）。

**Steps:** 打包脚本入库 `scripts/zs6-pack.ps1`（幂等、无危险动作、不删仓外文件）；跑通出产物清单+大小+哈希；commit `🐳ci(zs6): win 安装包通道（正常/回退双轨）`。

---

## Task 4：旧壳退役与 web 去留提案（**人类拍板材料，不执行删除**）

**行为:** `zs6-retirement-proposal.md`：六旧包现状（谁还引用/desktop 新旧对比/测试资产价值）、两案（A 全删归档=B 保留 cli/gateway 删旧桌面壳层）各自影响面与迁移注意、web 壳单独论（ZCode 有 web build 能力 vs 旧 `packages/web`）、红线⑩自查现状；`docs/HANDOFF.md`/ROADMAP 指针同步。

**Steps:** 纯文档+引用扫描证据（`grep -rl "@harness2/ui-shared" packages/` 等）；commit `📝docs(zs6): 旧壳退役与 web 去留提案（待人类拍板）`。

---

## Task 5：上游 re-sync 流程文档化

**行为:** `docs/ai-framework/upstream-resync.md`：六步流程实操版（拉取→判活→定向增量→条目维护→闸门→commit），含本程序实证细节（refs 四仓 URL/基线锚点 3c5b2276、scratch 同步法、patch 重放清单=P1–Pn、§14 子代理核验纪律、flaky 定性法）。

**Steps:** 文档+按文档走一遍「零变更演练」（拉取→判定无需重析→记录）证明可复跑；commit `📝docs(zs6): 上游 re-sync 流程文档（ZS 全程实操沉淀）`。

---

## Task 6：收口（编排者亲验）

1. 红线⑩全量自查=T0 审计表复跑全绿（零假入口）；
2. 全门：六包测试/typecheck/eslint 0 error/`prettier --check .`/e2e 五轮矩阵/adapter buildAll；
3. UI patch 清单复核：`diff -rq` 实证=登记数一致；
4. 安装包产物就绪报告（不发布）；
5. OPEN.md/issue-log/HANDOFF 终态；push main + CI；
6. 独立审查（cat-jam，本阶段全 diff）；
7. **交人类**：装机验收清单 + 发版授权请求（tag/Release 人类执行）+ 退役案拍板。

---

## 代码审查（档位=全能 → 执行）

**审查方：** cat-jam 只读，报告落盘 `docs/ai-framework/plans/zs6-review.md`（§14 自证条款照旧）。  
**审查面：** 红线⑩（隐藏=消失非报错）、patch 登记完备性、打包脚本无危险动作、品牌改动无越界进 UI 源码、退役提案证据真实性。

---

## 验收标准总表

| #   | 标准         | 通过条件                                                            | 验证责任人    |
| --- | ------------ | ------------------------------------------------------------------- | ------------- |
| V1  | 假入口清零   | T0 审计表「需处置」项全部转「已自然隐藏」，复跑探针断言原文入库     | 自动化        |
| V2  | 品牌落地     | 任务栏/标题/关于页/安装器名=新品牌（截图）；scratch 改动逐条登记    | 端到端+用户   |
| V3  | 安装包       | win NSIS+portable 产出、哈希入库、编排者装机 smoke OK               | 自动化+编排者 |
| V4  | 冻结纪律     | UI patch=登记数实证一致；core/gateway 仅既有获批窗口；旧壳零改动    | 编排者        |
| V5  | 全门+CI      | 六包绿+矩阵五轮+prettier+push CI 绿                                 | 自动化        |
| V6  | 独立审查     | P0=0/P1 闭环；报告落盘经 git 核验                                   | 子代理        |
| V7  | 退役提案     | 两案利弊证据完整，人类可读                                          | 编排者        |
| V8  | re-sync 演练 | 按新文档零变更演练走通                                              | 自动化        |
| V9  | 发版（人类） | 装机验收 + tag/Release 授权——**代理不执行，材料就绪即达本阶段出口** | 人类          |

---

## 风险与降级

| 风险                                                       | 缓解                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| electron-builder 在新环境仍有隐性依赖问题（cmd 恢复≠必好） | 双轨：正常通道失败即切 manual-pack 移植版；两轨均实证                 |
| 「隐藏」某入口唯一解=改 UI 源码（patch #3+）               | 停，出人类拍板门（ZS4.5f 流程先例：AskUserQuestion+登记）             |
| 品牌未定名                                                 | 工作名 `harness2-desktop` 先行，正式名=替换清单一遍（字符串集中面小） |
| 退役案人类长期未拍板                                       | 不阻塞出口判据（V7=材料就绪即算交付）                                 |
| 子代理虚报（§14 前科两例）                                 | 每交付必过编排者 git diff/命令重跑                                    |

---

## 给接手 AI 的完整提示词

---

你是负责 **harness2** 的实现代理。请**完整执行 ZS6 阶段**（按计划 Task 顺序，T2 品牌/T3 打包/T4 退役/T5 文档可由编排者分派单人并行，T0/T1 为主线串行）。

### 基线

- 目录 `D:/AI_Projects/harness2`；scratch `D:/AI_Projects/harness2-zs1-build/ZCode`（改动=patch 登记纪律，UI 源码零改）
- 从 `main`（含 ZS5+core 提案合入）创建：`feat/phase-zs6-finalization`
- 已完成：ZS1–ZS5 全绿收口（勿重做；OPEN.md 前 8 行必读）
- 唯一计划：`docs/ai-framework/plans/2026-10-23-phase-ZS6-finalization.md`
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`zs5-inventory.md`

### 做

1. T0 审计**必须运行态实证**（launch-manual + CDP 探针遍历），禁止凭 registry note 猜 UI 表现。
2. T1 处置按「数据形状→装配点→人类门」优先级；每项带单测与复跑证据。
3. T3 打包产物只入 `release/`（gitignore 核对），哈希与清单入文档，**绝不 git add 安装包本体**。
4. pnpm 直调（无 cmd 依赖）：`node "D:/.pnpm-store/v11/links/@/pnpm/11.13.0/d11795881783aa51f96a2d2a2c920d8e31138fac1136d44bf46998e29eab8385/node_modules/pnpm/bin/pnpm.mjs" <args>`；e2e `scripts/zs2/run-e2e.ps1`（9229 串行）。
5. 改文件必自证 `git diff --stat` 粘报告（§14 纪律，两例谎报前科）。

### 不做

- `git tag` / GitHub Release / 对外分发（人类专属）；删旧壳六包任何文件；改 `packages/ui` 源码；未登记 patch；遥测/网络出口；真 home 写入。

### 交卷

分支/提交列表、V1–V8 自评（V9=材料就绪声明）、审计表复跑原文、打包哈希、残留风险。

---

## 残留手工验收清单

1. 人类装 NSIS 包跑一轮真实对话（真网关 key 在本机 `~/.harness2`）。
2. 人类拍板：正式品牌名（含 logo 供给）/旧壳退役案/web 壳去留/发版授权。
3. 假入口清单肉眼复核（对照 `zs6-hide-audit.md` 的处置后列）。
