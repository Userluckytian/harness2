# 阶段 ZS4：侧栏全功能 + 设置页可用（task 索引/归档/批量删除 / provider 写路径 / 周边读面）

> **状态：** 实施中（2026-10-21 用户批准「开始吧」开工；T0–T4 已入库，T5 实施中）
> **前置：** ZS3（`bd18a75`）与 ZS3.5（附件/cwd/缩略图，`6be7e4d`/`e9f7362`）已合 main；`AskUserQuestion` producer 已在 adapter 落地（ZS3 登记的「elicitation 接线」在此对账为已完成）
> **元规范：** `docs/ai-framework/phased-plan-driven.md` · **总纲：** `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md`

**Goal:** 一句话——侧栏从「只读列表」变成「全功能管理」，设置页从「必炸」变成「可用」：

1. 任务索引真实化：**置顶 / 归档 / 物理删除 / 重命名 / 批量「删除其他」「归档其他」**（Z-50/Z-51 语义；用户 2026-10 明确需求「快速删除对话」在本阶段终结）；
2. **provider 写路径**：设置页添加/编辑/删除模型供应商与模型（`createPersonalProvider` 等十投），密钥写 `~/.harness2/auth.json`（0600，密钥不进 git/日志）；
3. 周边读面按证据接线：轨迹 `getModelTrajectory` → core trajectory；commands/skills/memory/hooks/subagents/automations/MCP 状态——有能力则真映射，无能力如实空态（红线⑩，不造假入口）。

**Architecture:** 延续 ZS1–ZS3.5 链路（桌面 main → utilityProcess host → MessagePort → renderer；进程内 core；ZCode UI 零改动）。三根支柱：
① **task 索引单一源** = 磁盘会话日志（`SessionManager.list()`）+ `title.json` + 新增 `session-meta.json` 侧车（pinned/archived 状态）；
② **core 加性窗口 = 计划内唯一**：`deleteSession`（物理删除，锁目录安全 + 不可恢复需注释明示）；
③ **写路径全部过校验再落盘**（provider config / auth.json），错误出口 `redactSecrets`。

**Tech Stack:** TypeScript / Electron / vitest（service 层直调）/ CDP e2e（`scripts/zs2/run-e2e.ps1` 模式扩展）。
**实施档位：** 全能 · **子代理：** 尝试 cat-jam（通道近期多次 provider 5xx，失败即编排者直连，如 ZS3/ZS3.5 先例）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 本文件、`docs/ai-framework/phased-plan-driven.md`、ZS3 与 ZS3.5 计划执行记录                                                                                                                                                                       |
| P0     | ZCode 源只读调用面：`refs/ZCode/packages/ui/src/project-sidebar/task-mutation.ts`、`useArchiveManagement.ts`、`ArchiveGroupCard.tsx`；`packages/services/src`（`ITaskGroupService`/`IProviderSettingsService` 契约与消费方）；`settings/models` 页 |
| P0     | `docs/refs/README.md` §2 六步（AGENTS 强制第 7 条）：先核对 `refs-zcode.md` 是否过期，补 Z-50/Z-51 交互条目再写代码                                                                                                                                |
| P1     | 映射详表 `docs/research/2026-10-20-zs-a-class-mapping.md`；`packages/core/src/session/titles.ts`、`config/auth.ts`、`config/schema.ts`                                                                                                             |

**仓库路径：** `D:/AI_Projects/harness2`（main ≥ `e9f7362`）· ZCode 源只读 `D:/AI_Projects/refs/ZCode`（`3c5b2276`）· scratch `D:/AI_Projects/harness2-zs1-build/ZCode`
**基线分支：** 从 `main` 拉 `feat/phase-zs4-sidebar-and-settings`

---

## Global Constraints（冲突时以本节为准）

1. **ZCode UI 零改动**：UI patch 仍仅 ZS1 的 `desktopRuntimeEnv.ts` 一处；不得为批量菜单改 UI。
2. **core 解冻纪律**：默认零改动。**计划内唯一窗口 = deleteSession**（提案先行：函数签名 + 锁/竞态处理 + 测试清单，编排者批准后实施；被否 → 批量删除降级为「归档隐藏」并如实登记，物理删除归 ZS5+）。`packages/gateway` 零改动。
3. **红线⑩**：写路径十投逐个真实现或保持显式 throw（不许假成功）；pinned/archived 状态读面与写面对称；commands/skills 等若无 core 能力 → C 类静默空态而非假列表。
4. **密钥与数据安全**：auth.json 写 0600 + `redactSecrets` 出口；**deleteSession 物理删除不可恢复**——UI 已有确认弹窗（ZCode 原生），我方不得跳过确认路径；测试只删临时目录内会话。
5. **无登录门**：账号区（login-trigger/升级/奖励）保持 ZS6 隐藏清单口径，本阶段不接。
6. **验证缝分层**：service 层直调 + 状态断言为主；e2e 只做出口（删除后列表/投影一致、设置页保存闭环），判据可区分失败段。
7. **明确不做（本阶段）**：❌ 观测性/崩溃报告/监控卡片（ZS5）❌ 打包发版/品牌切换/C 类隐藏清单执行（ZS6）❌ 旧壳任何改动 ❌ MCP 服务器增删（只读状态展示，写路径如实 throw 并登记）。

---

## 阶段开头：上阶段遗留

| 项                                    | 来源         | 状态                                                  |
| ------------------------------------- | ------------ | ----------------------------------------------------- |
| ZS2 P2：e2e composer 选择器精确度     | ZS2 审查     | ⬜ 本阶段 e2e 扩展时顺手                              |
| ZS3 P2：长会话>60 行视觉刷新/上滚 e2e | ZS3 登记     | ⬜ T5 一并补                                          |
| ZS3 偏差⑥「分组操作失败」toast        | ZS3 执行记录 | ⬜ task 索引真实化后应自然消失，T7 复验               |
| ZS3 T6：elicitation 端到端            | ZS3 计划     | ✅ 已由 ZS3.5 `askuserquestion` 覆盖，对账即闭        |
| 会话标题「New task」常驻              | 用户观感     | ⬜ T2 接线 auto title（rename/titles 已存在）顺带解决 |

---

## File Structure（预期变更）

| 文件/目录                                                                                           | 动作      | 职责                                                                                                            |
| --------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/session/manager.ts`                                                              | 加性窗口  | `deleteSession(id)`（唯一 core 改动，提案先行）                                                                 |
| `packages/zcode-adapter/src/real/task-index.ts`                                                     | 新建      | pinned/archived 侧车（`<sessionDir>/session-meta.json`）读写 + 校验 + 迁移默认                                  |
| `packages/zcode-adapter/src/real/project-service.ts`                                                | 大改      | readTree 接 task-index（pin 排序/归档过滤/删除）；`ITaskGroupService` 桩 → 真实现（移动/重命名/归档/删除/批量） |
| `packages/zcode-adapter/src/real/session-service.ts`                                                | 修改      | deleteSession/rename/archive 命令面（若 UI 走 session 频道则按实测落点）                                        |
| `packages/zcode-adapter/src/real/provider-settings-service.ts`（并入 `provider-views.ts` 或新文件） | 大改      | 十投写路径：config.json 原子写（temp+rename）+ auth 0600 + 校验；`testModelConnectivity` 真探一次               |
| `packages/zcode-adapter/src/real/trajectory-service.ts`                                             | 新建/接线 | `getModelTrajectory` → core trajectory 视图（映射详表核对）                                                     |
| `packages/zcode-adapter/test/*`                                                                     | 扩        | 逐能力 service 层断言（批量删除、归档恢复、provider 保存回读、密钥脱敏）                                        |
| `scripts/zs4/*.cjs` + runbook                                                                       | 新建      | 侧栏删除轮 / 设置页保存轮（exit 语义延续）                                                                      |
| 本计划文件                                                                                          | 修改      | 执行记录回填                                                                                                    |

---

## Task 0：调用面盘点（file:line 证据，不改代码）

摸清并入库（映射详表附录或执行记录）：
① `ITaskGroupService` 全方法 + UI 消费点（`task-mutation.ts`/`useArchiveManagement` 各调哪些、期望返回形状）；
② 批量「删除其他/归档其他」在 ZCode 的真实入口（右键菜单项 → 服务方法链）；
③ pinned/archived 的权威归属（task 索引字段 vs 独立 meta；我们选侧车文件的兼容性论证）；
④ `IProviderSettingsService` 十投的入参形状（`PersonalProviderInput`/model draft 形状）+ UI 表单字段对照；
⑤ `getModelTrajectory` 的 UI 消费形状 → core `trajectory/view.ts` 的映射差；
⑥ commands/skills/memory/hooks/subagents/cron/MCP 各频道：**core 有对应能力？**（有=接线；无=C 类空态，逐条登记）。
产出：`docs/research/2026-10-XX-zs4-call-surface-inventory.md`。**先补 refs 条目再进 T1**（AGENTS §7）。

## Task 1：core `deleteSession` 加性窗口（提案 → 批准 → 实施）

- 提案：`SessionManager.deleteSession(id: string, opts?: {dir?: string}): boolean`——resume 定位目录（合法 id 校验复用 `SESSION_ID_PATTERN`，防穿越）；持 writer 锁则 fail-closed 抛错；否则 `rmSync(dir,{recursive})`；顺带删 title/searchIndex 产物。测试：删存在/不存在/被锁三态；重放/列表不再出现。
- 独立 commit + `api-surface-baseline.json` 同步 + 编排者（= 主会话）验收。**提案被否 → 本阶段批量删除降级为归档隐藏，登记归后续。**

## Task 2：task 索引真实化（pin/archive/重命名/删除 + 自动标题）

- 侧车 `session-meta.json`：`{pinned, archived, renamed?}`；readTree 排序 = pinned 优先 → mtime；archived 默认过滤、归档视图读取时包含；删除走 T1。
- 自动标题：会话落 `title.json` 前显示首条用户消息截断（`firstUserText` 已有），消灭「New task」。
- service 层断言：批量删除只留目标、归档后主列表消失/归档视图可见、pinned 恒前。

## Task 3：ITaskGroupService 全量真实现（含 Z-50/Z-51 批量语义）

- 逐个方法按 T0 清单实现；「删除其他/归档其他」经 UI 原生确认弹窗；错误用 `fault.*`/`guard.*` 字面量词表。
- 变异验证：摘掉一个批量方法 → e2e 侧栏轮必红。

## Task 4：provider 写路径（设置页可用）

- 十投按契约实现：入参校验（模型 id 正则/必填）→ config.json 原子写 → auth 通道写（0600）；`testModelConnectivity` 真发一次最小请求（密钥脱敏错误）。
- 安全测试：密钥值不出现在任何返回值/日志/错误 message；删除 provider 不隐式删 auth（登记语义）。
- e2e 出口轮：设置页添加一个本地假 provider → 保存 → 重开可见 → 测试连通失败提示正确 → 删除。

## Task 5：轨迹 + 周边读面

- `getModelTrajectory` → core trajectory 映射（形状差则如实降级投影，不造假）；
- T0 ⑥ 表逐条执行：有则接线（含 cron 最小状态），无则显式 C 类空态并注释登记；
- ZS2/ZS3 遗留 e2e（composer 选择器精确度、>60 行上滚视觉轮）在本任务补。

## Task 6：收口（编排者亲验）

1. 六受保护包 diff=0；core diff 仅 T1 批准窗口；UI patch 仍 1 处；
2. 七包逐包测试 + `pnpm -r typecheck` + `eslint .` 0 error + `prettier --check .` 绿；
3. e2e 双轮（普通对话回归 + 侧栏删除 + 设置页保存）+「分组操作失败」toast 复验消失；
4. 分支 push → CI 绿 → `--no-ff` 合 main → 台账（OPEN/日志/计划执行记录）→ 交用户 V9 真机清单。

---

## 代码审查（全能档含）

独立只读 cat-jam（通道可用时）：批量删除的确认路径与不可逆性、侧车状态与列表一致性、config/auth 写入原子性与密钥出口、deleteSession 锁竞态、红线⑩、core 越界。

## 验收标准总表

| #   | 标准          | 通过条件                                                                              | 验证                                       |
| --- | ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| V1  | 批量删除/归档 | 右键「删除其他/归档其他」真生效；删除后 JSONL 目录消失、列表/投影一致；有原生确认弹窗 | e2e+测试                                   |
| V2  | 置顶/重命名   | 跨重启保持；标题不再恒「New task」                                                    | e2e                                        |
| V3  | 设置页写路径  | 添加/编辑/删除 provider+模型闭环；错误脱敏；重开持久                                  | e2e+审查                                   |
| V4  | 轨迹/周边     | 映射表逐条对账：接线项有数据、空态项如实空、无假入口                                  | 审查+测试                                  |
| V5  | core 边界     | 仅 deleteSession 批准窗口；api-surface 同步                                           | 编排者                                     |
| V6  | 冻结纪律      | 六包 0 diff；UI patch 1 处                                                            | 编排者                                     |
| V7  | 闸门          | 逐包绿 + typecheck/lint/prettier + 双 CI                                              | 自动化                                     |
| V8  | 独立审查      | P0=0；P1 闭环；P2 登记                                                                | 子代理（通道不可用则如实登记欠账，如 ZS3） |
| V9  | 用户真机      | 批量删除一轮 / 设置页加一个真供应商一轮 / 归档恢复一轮                                | 用户                                       |

## 风险与降级

| 风险                                      | 缓解                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| deleteSession 提案被否                    | 降级归档隐藏；物理删除登记 ZS5+                                 |
| 侧车 meta 与 ZCode 云端 task 索引语义漂移 | 侧车仅本机可见字段；盘点文档记录偏差                            |
| provider 表单形状猜错                     | T0 先盘 UI 字段；实现后 e2e 走真表单不猜                        |
| 批量删除误删用户真实会话                  | 测试全在 `HARNESS2_HOME` 临时根；真机数据根仅经用户确认路径操作 |
| 子代理通道不稳                            | 编排者直连（ZS3/ZS3.5 先例），V8 欠账如实登记                   |

## 给接手 AI 的完整提示词（零上下文）

你是 harness2 实现代理，执行 **ZS4**（侧栏全功能 + 设置页可用）。基线 `main` ≥ `e9f7362`，分支 `feat/phase-zs4-sidebar-and-settings`。唯一计划=本文件；先读 ZS 总纲、映射详表、ZS3/ZS3.5 执行记录、`docs/refs/README.md` §2。顺序 T0→T6；T1 core 窗口**必须提案先行等编排者批准**；UI 零改动、六包冻结、密钥不进 git/日志；pnpm 直调 `node "D:/.pnpm-store/v11/links/@/pnpm/11.13.0/d117958…/pnpm.mjs"`；e2e 走 `scripts/zs2/run-e2e.ps1` 模式（9229 实例锁定、只杀 scratch 进程）；每 Task 完成即 commit（gitmoji+中文，只 add 明确路径）。交卷：提交列表、V1–V9 自评、真实命令输出、P2 对账、残留风险。

## 残留手工验收清单（V9，交用户）

1. 右键「删除其他会话」→ 确认 → 列表与磁盘目录一致；
2. 归档一批 → 归档视图恢复一条 → 主列表回来；
3. 设置页添加真实供应商（含密钥）→ 连通测试 → 新会话选用；
4. 轨迹页打开一轮（如已接线）；
5. 提醒：测新壳时旧壳 `pnpm dev` 保持关闭（9229 共享）。

---

## 执行记录（2026-10-21 回填）

**分支偏差（如实登记）**：实际在 `main` 上直接顺序提交（与 ZS3.5 收口后的并行代理共处模式一致），未拉 `feat/phase-zs4-sidebar-and-settings`。

| Task               | 提交                          | 实施者                | 证据                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0 盘点            | `1506ba6`                     | cat-jam               | `docs/research/2026-10-21-zs4-call-surface-inventory.md`（file:line 全量）                                                                                                                                                                                                                                                   |
| T1 deleteSession   | `616113a`                     | 编排者直做            | core 1638+2s 绿；锁目录 fail-closed 测试；`SESSION_ID_PATTERN` 防穿越                                                                                                                                                                                                                                                        |
| T2 task 索引侧车   | `29c83a4`                     | cat-jam               | `task-index.ts` 原子读写；readTree pinned→mtime；title.json 优先（「New task」消失）；11 新测试                                                                                                                                                                                                                              |
| T3 任务写面        | `2f2daf5`                     | cat-jam               | 十法全真实现 + `scripts/zs4/cleanup-sessions.cjs`（默认 dry-run）；78 测绿；task-groups 保持桩不造假（红线⑩）                                                                                                                                                                                                                |
| T4 provider 写路径 | `81efdb3`                     | 编排者直做            | 十投+connectivity+onDidChange；`absorbSecrets` 就地剥密钥（P0 自纠：原实现不回写 cleaned，密钥会进 config）；auth 0600；revision 冲突拒绝；86 测绿                                                                                                                                                                           |
| T5 轨迹+周边       | `5f69994`+`e1aa66e`+`6d0ba97` | cat-jam + 编排者补测  | 轨迹 `available:false` 降级（不造假）；skills 接 SkillStore；OffPeak fail-closed；memory 盘读；hooks/commands 空态。**T5 引入 P0**：a-class-stubs 静态 import core → jsonc-parser 内联断链 → host 启动即崩（真机才暴露）；`72a9359` 走 core-bridge 动态加载 + `smokeBundle` 门。代理 0 新增测试=违约，编排者补 6 测（92 绿） |
| T6a 全仓门         | —                             | 编排者                | 逐包 core1638/adapter92/gateway40/web150/ui-shared776/cli1575 绿；`-r typecheck` 0；eslint 0 err；prettier 绿；冻结通过。desktop 满载 flaky（隔离绿+零 diff）非回归                                                                                                                                                          |
| T6b e2e（阻塞）    | `3418bf7`+`55e03b9`           | cat-jam 探针 + 编排者 | 两探针轮入库未真跑；**冷启动首轮发送不渲染**（后端全成功/点侧栏快照正常/热态正常/pre-ZS4 同坏但未碰帧代码）——诊断代理定位中                                                                                                                                                                                                  |

## T6 收口执行记录（2026-10-22 回填）

| 项                    | 提交                                                                                 | 证据（实际命令输出）                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 冷启动首轮不渲染 P0   | `e22c24c` + 回归钉 `a25ac43` + 根因修订报告                                          | 根因=**createSession 用 process.cwd() 而 UI prepareSession 用 workspacePath**（组目录劈叉，67ce1e4 引入）；修后 `-Fresh` 双跑 exit=0                                                                                                            |
| hover 归档/删除不生效 | `01de328`（window-controller.mutateTask 接 IZCodeTaskService）                       | UI 行悬停归档/删除走 window-controller 而非 task 服务；原 B 桩 throw。接线 rename/pin/archive/delete/delete-archived/mark-read/open/resume；`task-service-write.test.ts` 新 42 行测（归档→listArchived 真值、删除→getTaskMeta null）            |
| 设置页写面契约缺口    | `6cfc206`（嵌套↔扁平翻译层+内存草稿）+ `7e563cd`（revisionClock+resolveModelConfig） | e2e 实证三连坑：①UI 回传嵌套形 ProviderConfigObject 被扁平校验拒；②草稿视图不推 revision 被 UI 快照守卫吞（providerSettingsSnapshot.ts:45-46）；③缺 resolveModelConfig → 添加模型对话框读 null.inheritedConfig 炸。adapter 98 测绿              |
| e2e 双轮真跑绿        | `4df22d3`（探针重写+runbook fake-home 种子）                                         | `-SidebarDelete` 磁盘真删+UI 一致+截图；`-SettingsProvider` 建卡→导航→表单→密钥进 auth 不进 config→加模型→连通测试显失败→删除闭环，RESULT pass。两轮各 ≥2 次连续绿                                                                              |
| 四轮回归矩阵          | 同上                                                                                 | `-Fresh -Approval`=0 / `-Fresh -SidebarDelete`=0 / `-Fresh -SettingsProvider`=0 / `-Fresh`（真机渠道真实模型回复）=0，顺序单实例跑                                                                                                              |
| 真机配置污染事件      | —                                                                                    | 探针曾用 launch-manual.ps1（真 home）建草稿写坏 `C:\Users\ASUS\.harness2\config.json`（4 空 provider）；当场清理+备份，本收口又剥净 enabled/_h2Revision 漂移键，loadConfig warnings=[] 验证。教训登记：provider 写探针只走 runbook（fake-home） |

**如实偏差登记（全能档验收口径）**：

1. T5 子代理 0 新增测试（违约），编排者补 6 测——已录 T5 行。
2. 两枚 ZS4 探针初版选择器抄旧壳 `ui-shared`（运行时实际渲染 scratch `packages/ui`），全线打空；重写以运行时 DOM dump 为准。
3. **e2e 轮一律 fake-home**：`-Approval` 原走真 home（依赖用户渠道可用性），收口时改种 mock config——轮子不再被真机状态假红；provider 由 `ZS3_E2E_APPROVAL` 强制 MockProvider，判定强度不变。
4. **产品缺口（不带入收口判定，归 ZS5 输入）**：①adapter 不推 window-controller 帧 → mutate 后 UI 行移除靠刷新时机（探针以磁盘为真相+ui-stale 分类）；②`subscribeSessionsIndexV4` 未实现（host log 每 20s FAIL 重试）；③deletePersonalProvider 不清 auth 密钥（保守）。
5. 批量删除入口=原生归档区（`archive-delete`/deleteAllArchived），「删除其他」右键菜单不做（UI 零改动）。

**V1–V8 自评**：V1 ✅（侧栏轮：hover 归档→归档视图→恢复→再归档→删除→磁盘消失，`docs/screenshots/zs4/sidebar-delete-round.png`）；V2 ✅（T2 自动标题+pin 排序，task-service 测）；V3 ✅（设置轮全链路+密钥红线断言）；V4 ✅（T5 盘点映射对账+降级如实）；V5 ✅（仅 deleteSession 窗口+api-surface 同步）；V6 ✅（六包 diff=0、UI patch=1）；V7 ✅（本收口重跑 adapter 全绿+buildAll+smokeBundle；全仓门=T6a）；V8 ⚠️ 挂账（子代理通道 5xx 累计，收口后再试）。V9 → 交用户真机清单（见上节）。

**决策登记**：

1. **批量入口落点（盘点决策点 2）= 选项 1「原生路径 + 脚本」**：ZCode UI 零改动约束下，批量删除走原生归档区（`ArchiveGroupCard` unarchiveAll/deleteAll + `DeleteAllArchivedTasksButton`，服务端 `deleteArchivedTasks` T3 已实现）；「删除其他/归档其他」右键菜单项**不做**（不造 UI patch）；兜底 `scripts/zs4/cleanup-sessions.cjs`（默认 dry-run）。命令面板/快捷键入口列为后续升级。
2. **renamePersonalModel 已实现**（盘点决策点 4：原 throws 列表未含、契约含——补齐，键序保持）。
3. **deletePersonalProvider 不隐式删 auth 密钥**（上游是否清凭据无证据，保守保留，注释登记）。
4. **task-groups 保持空态桩**（cat-jam 决策：落盘语义无证据对齐，宁 throw 不造假；ZS3 偏差⑥ toast 复验归 T6）。
5. **轨迹降级口径**（盘点决策点 5）：`available:false` + 空 records + 真实 `sourceFiles`（locate 目录），会话不存在也不抛。
6. **V8 独立审查**：cat-jam 通道 ZS3/V8 已累计 5 次 provider 5xx；本阶段完成后再试，失败继续如实挂账。
