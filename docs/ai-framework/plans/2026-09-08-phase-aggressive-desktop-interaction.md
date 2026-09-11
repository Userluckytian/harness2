# 阶段 14-激进-桌面：功能优先桌面 Harness（D0–D6，Electron React）

> **状态：** 计划已就绪（2026-09-08，修订 R2）；**修订 R3（2026-09-11）：并行双轨开工版 —— 本轨为「乙」，与终端 T 轨同时进行**
> **来源：** `docs/research/notion-ai-20260908-0056/04-implementation-plan.md`（I1 R2）§5.2/§5.3/§7 的 D0–D6。本文档是其一**正式阶段化落地**。
> **方向变更（R2，用户确认）：** 桌面**不再复刻 CodexMonitor 界面**，改为**功能优先的 coding-agent harness**。**不验收视觉相似度 / 布局 / 配色 / 动画 / 截图相似度**；普通表单、列表、日志、Diff 即可交付。`02-codexmonitor-research.md` 只作历史参考，不再作桌面产品规格或必读移植清单。
> **角色：** 激进版「桌面 harness」owner。**依赖共享底座 S0–S7（尤其 S7 桌面功能契约）冻结后才能真实联调**；未冻结前可在 mock adapter 上隔离开发 D1/D2/D5，但真实模型/工具执行、变更、恢复、任务/审批必须与共享实现联调，不能用 mock 冒充端到端。
> **开工闸门（R3 新增）：** 共享底座 S0–S7 已于 2026-09-08 完成；阶段 15 质量收口已于 2026-09-11 验收（CI 三平台 7/7 全绿）。本轨开工的硬前置是 **`docs/ai-framework/plans/2026-09-11-phase-foundation-patch.md`（地基补丁 P0–P4）合入 main 并宣布 core/gateway 冻结**。冻结后本轨对 `packages/core`、`packages/gateway`、`packages/cli` 一律只读；边界与合入纪律以该文档「并行开工守则」小节为准。
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 让桌面成为能**真正完成**「选项目 → 配模型/上下文 → 计划确认 → agent 读改代码/跑测试 → 审查实际变更/安全撤销 → 继续恢复」闭环的 coding-agent harness。输入不丢、执行可控、过程可见、结果可核验、会话可恢复。**先功能后美观，不评视觉。**
**Architecture：** 桌面是**控制与观察入口**（UI 是投影，不是第二个模型上下文来源）；通过受限 Electron preload + serve HTTP/WS 消费共享底座契约（D0 适配映射）；用 typed timeline / store 局部 selector 减少无关 pane 重算。**复用既有渲染原语与内核能力**（SnapshotStore/undo/分屏/设置/MCP/插件/记忆），不为视觉全面重做，不建第二套工具执行器或配置存储。
**Tech Stack：** TS（core）· Electron + React · vitest（jsdom）· ws
**实施档位：** 全能（开发 + 测试 + 代码审查；DPI/通知/中文路径/关窗口行为属手工项）
**子代理：** 启用（代码审查 + 验收独立角色）

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`                                                                                                        |
| P0     | `docs/research/notion-ai-20260908-0056/04-implementation-plan.md`（I1 R2 §5.2/§5.3/§7）                                                                                         |
| P0     | `docs/research/notion-ai-20260908-0056/03-harness2-core-audit.md`（sessions 队列底座、subagent 观察缝、H 缺口）                                                                 |
| P1     | `docs/research/notion-ai-20260908-0056/02-codexmonitor-research.md`（**仅历史参考**，不作产品规格）                                                                             |
| P1     | `packages/desktop/src/renderer/store.ts`、`app-controller.ts`、`components/**`；`src/preload/**`、`src/main/bridge.ts`                                                          |
| P1     | 共享底座契约（S0–S7：`interaction/types.ts`、`runtime-journal.ts`、`run-config.ts`、`plan-state.ts`、`execution-view.ts`、`change-review.ts`、`task-coordinator.ts`，S 冻结后） |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支 / worktree：** **从地基补丁阶段（P0–P4）的冻结 commit** 建 `feat/notion-i1-desktop`。**别在主工作树切分支**；不删他人 worktree；git 不 reset/clean。**可 push 本分支**；合入 main 前该分支 CI 必须三平台全绿，并以 `--no-ff` 合入。

---

## Global Constraints（冲突时以本节为准）

1. **桌面只是观察者（红线）**：不成为第二个模型上下文来源；不改 agent 内核编排；不新增事件类型；`turn-end` 语义不变；不破坏轨迹不变量。
2. **渲染端不直接读写文件**：一律走现有 `contextIsolation` IPC 桥；**不暴露通用 shell / 任意 fs** 给 renderer；引用路径做 realpath 校验。
3. **先功能后美观**：普通 tabs/面板组织即可；**不做**左树右栏硬要求、新面板拖调、主题、动画、像素复刻。但**可用性不可省**：IME 不误发、草稿隔离、长输出折叠、稳定滚动、加载失败入口、键盘焦点、关窗口前提示正在运行的任务。
4. **真实执行必须联调**：不得拿 fixture/mock 成功冒充端到端。
5. 密钥不进 git；只显式 add 本任务文件（**禁 `git add -A`**）；改同一文件前检查并发变化。**可 push 自己的分支 `feat/notion-i1-desktop`；合入 main 前该分支 CI 必须三平台全绿，并以 `--no-ff` 合入；禁 force push、禁在 main 上试错。**
6. **并行边界（R3 新增，红线）**：本轨独占 `packages/desktop/`；`packages/core/`、`packages/gateway/`、`packages/cli/` 一律**只读**。需要改动它们时**停手**，在 `docs/issue-log/<日期>-D.md` 登记并上报编排者裁决，不得自行修改，也不得把 core 逻辑复制进 desktop 绕过。根级 `pnpm-lock.yaml`、`package.json`、`tsconfig.base.json`、`.github/workflows/`、eslint / prettier 配置禁止擅改（新增依赖须先报备）。共享文档（`OPEN.md` / `DECISIONS.md` / `HANDOFF.md` / `MASTER-PLAN.md` / `CHANGELOG.md` / `ROADMAP.md`）阶段内不改，各自记在本计划文档里、合入后由编排者统一回填；日志只写 `docs/issue-log/<日期>-D.md`。完整边界表见 `2026-09-11-phase-foundation-patch.md` 的「并行开工守则」小节。
7. **明确不做（本阶段）**
   - ❌ 不迁移 Tauri / 不启动第二套 Codex 后端
   - ❌ 不新增完整 IDE / Git 工作台 / 交互式 PTY 终端 / codemap / 语音 / 移动端（但**必须能显示真实 shell、cwd、输出、退出码、取消状态**，缺命令执行闭环不行）
   - ❌ 不把「取消当 undo」「重连当重发」；不对 shell/MCP 承诺 exactly-once；不默认自动 retry 工具
   - ❌ 不把 plan/ask 包装成 OS 沙箱；未提供 OS 隔离必须明示
   - ❌ 不摆可点击假入口；无后端能力如实 disabled 并解释

---

## 阶段开头：上阶段遗留（必填）

> 上阶段（阶段 12/桌面 + 设置面板）已并入 main。审计确认的桌面侧缺口须在本阶段闭环。
>
> **R3 补充（2026-09-11）：** 直接上阶段为**阶段 15 质量收口**（验收结论「✅ 有条件通过」，CI 三平台 7/7 全绿）。其验收表 §6 要求下一阶段逐条抄入，见下表。

### 阶段 15 遗留（抄自 `2026-09-09-phase-quality-closeout-acceptance.md` §6）

| 遗留项                                                       | 处理方                        | 本轨动作                                                                       |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------ |
| A3 P1-1：serve token 三端贯通 + 默认严格模式                 | 地基补丁 **P2**（开工前完成） | 开工后桌面已带 token；本轨**不得再改鉴权逻辑**，但 D0 能力盘点须按严格模式验证 |
| A3 P1-2：`serve-manager.ts` 的 `waitForHealth` 把 401 当健康 | 地基补丁 **P2**               | **已修**；D1 真机复验「serve 未就绪竞态」时以修复后行为为准，不得回退          |
| A3 P2-3 / P2-1 / P2-2：playwright 降级、锁文件权限           | 地基补丁 **P3**               | core 侧，与本轨无关                                                            |
| A5 P1-1 / P1-2 / P1-3：网关挂死、双会话、测试缺口            | 地基补丁 **P0–P1**            | gateway 侧，与本轨无关                                                         |
| 「按 key 解析或新建会话必须做 in-flight 去重」               | 地基补丁 **P0** 定口径        | 本轨若引入任何「按 key 取或建」的会话/缓存逻辑，**必须同样做在途去重**         |
| network 错误收尾 `finalText` 为空的展示语义                  | 地基补丁 **P3** 一次定死      | **D2 必须消费 P3 的定义，不得自行发明**                                        |
| assistant / attempt 半截文本展示语义                         | 地基补丁 **P3** 一次定死      | 原计划下放到本阶段确认，**改为 P3 统一定义**；D2 按定义渲染                    |
| 无独立人工审查（R7）、A4/B3 拆分类审查未派                   | 地基补丁阶段补派              | 本轨阶段末**仍需**派独立只读子代理审查                                         |
| CI 首跑 POSIX 两平台红（R10）                                | ✅ 已闭环（main 7/7 全绿）    | 纪律沿用：**本轨分支 CI 红即停线**，不得合入                                   |

### 阶段 12 桌面侧遗留（原表）

| 上阶段遗留项                                   | 来源                   | 未通过原因                                       | 状态                                    |
| ---------------------------------------------- | ---------------------- | ------------------------------------------------ | --------------------------------------- |
| 桌面启动竞态：serve 未就绪 / `fetch failed`    | 阶段 13 计划遗留       | 渲染端在 serve 端口就绪前调用了需 baseUrl 的命令 | ⬜ D1 前后真机确认；复现则优雅返回/重试 |
| 任务完成系统通知真机验收（B7 移交缺陷）        | 阶段 12 计划           | 需 Windows 实机                                  | ⬜ 留「残留手工验收清单」               |
| 每会话执行 cwd 取了 hub 全局 cwd（A/B 项目串） | 03-harness2-core-audit | `sessions.ts:384-394,456-465`                    | ⬜ 共享 S1 封闭；D5 验证 workspace 不串 |

---

## 跳过项（因档位未做，**非缺陷**）

| 跳过项                                                         | 原因                                              | 待补做                    |
| -------------------------------------------------------------- | ------------------------------------------------- | ------------------------- |
| 界面美化（主题/动画/像素复刻/面板拖调）                        | R2 明确不列为桌面交付、不阻塞                     | ⬜ 独立后续版本           |
| 完整 Git/PTY 工作台 / codemap                                  | 本阶段明确不做                                    | ⬜ 另行立项               |
| Windows 真机（分屏拖拽/DPI/中文路径/通知定位/断线重启/关窗口） | 需用户实机                                        | ⬜ 留「残留手工验收清单」 |
| steer（S6）对桌面的增强                                        | 仅 S6 交付后启用可靠排队；不阻塞基础 harness 验收 | ⬜ S6 到位后接入          |

---

## File Structure（预期变更）

| 文件                                                                                                                                                                                                                                                                                                 | 动作 | 职责                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/shared/protocol.ts`                                                                                                                                                                                                                                                            | 新建 | D0：adapter 映射新契约（调用 getInput）                                                                                 |
| `packages/desktop/src/preload/**`、`main/bridge.ts`                                                                                                                                                                                                                                                  | 修改 | D0：盘点真实后端能力、维护订阅集合、按 epoch 补状态、ack 后更新 UI、无配置/连接失败可处理；**不暴露通用 shell/任意 fs** |
| `packages/desktop/src/renderer/controller.ts`、`store.ts`                                                                                                                                                                                                                                            | 修改 | D0/D1/D2：store 局部 selector、session-draft                                                                            |
| `packages/desktop/src/renderer/features/composer/*`                                                                                                                                                                                                                                                  | 新增 | D1：自动高度/IME/@file 引用/可见队列                                                                                    |
| `packages/desktop/src/renderer/features/timeline/*`、`features/execution/*`                                                                                                                                                                                                                          | 新增 | D2：chat-model 增量投影、真实 tool/命令日志、大输出/退出码、DiffCard                                                    |
| `packages/desktop/src/renderer/features/workspace/*`、`features/changes/*`                                                                                                                                                                                                                           | 新增 | D5：工作区选择/文件浏览/按任务聚合变更                                                                                  |
| `packages/desktop/src/renderer/components/PlanPanel.tsx`、`TaskPanel.tsx`、`ApprovalCenter.tsx`                                                                                                                                                                                                      | 新增 | D3：计划/任务/审批（有证据，非状态卡）                                                                                  |
| `packages/desktop/src/renderer/components/SettingsDialog.tsx`、`CommandPalette.tsx`                                                                                                                                                                                                                  | 修改 | D6：有效配置/上下文面板                                                                                                 |
| 测试新增：desktop-composer、desktop-queue、desktop-draft、desktop-scroll、desktop-stream、desktop-reconnect、desktop-child-approval、desktop-run-config、desktop-plan-boundary、desktop-command-exit、desktop-change-review、desktop-undo-external、desktop-workspace-switch、harness-workflow-F1-F8 | 新增 | 全覆盖                                                                                                                  |

---

## 任务

### D0 — 协议适配 + 订阅/恢复 + 能力盘点（依赖 S0/S3；S7 接线可分步）

- 盘点真实后端能力并绑定受限 adapter；恢复订阅/ack；暴露**有效配置、工具、执行结果、变更查询**；无配置/连接失败可处理（可行动提示）。renderer 仍零 Node、不暴露 fs/shell。
- 测：`desktop-stream`、`desktop-reconnect`、`desktop-run-config`。Commit：`✨feat(desktop): 新契约适配与订阅/恢复/能力盘点（D0）`

### D1 — Composer 与草稿/引用（依赖 D0）

- 自动高度、IME 不误发、session 草稿/附件持久、可见 queue、原始输入与模型上下文分离、项目指令/文件引用来源可见；路径边界/字节预算/二进制测试。修复启动竞态（serve 未就绪优雅返回）。
- 测：`desktop-composer`、`desktop-queue`、`desktop-draft`。Commit：`✨feat(desktop): Composer 增强与草稿/引用/可见队列（D1）`

### D2 — 时间线与命令/变更日志（依赖 D0/S7）

- chat-model 增量投影、store 局部 selector；**真实 tool/命令日志**：参数/shell/cwd/输出/exit code/取消状态；大输出范围读取、复制、错误详情；稳定滚动与局部更新达性能预算；DiffCard 用真实快照 before/after。复用渲染原语，不为样式全面重做。
- 测：`desktop-stream`、`desktop-scroll`、`desktop-command-exit`。Commit：`✨feat(desktop): 时间线渲染与真实命令/变更日志（D2）`

### D3 — PlanPanel / TaskPanel / ApprovalCenter（依赖 D1/D2 + S2/S5/S7）

- 计划/执行状态**有证据**（planId/步骤/证据 ID）；模式切换明确且**不自动提权**；主子审批、早期任务发现、等待/继续/停止可用；只读并发（K=2）与写互斥真实生效；不是只有状态卡。
- 测：`desktop-plan-boundary`、`desktop-child-approval`、`desktop-task`。Commit：`✨feat(desktop): 计划/任务/审批中心（有证据，非状态卡，D3）`

### D4 — 错误/重试/恢复/通知 + 能力门控（依赖 D3/S4）

- F4/F6/F7 闭环；不永久 loading、不假报停止；断线补任务/审批/队列；**关窗口行为明确**（提示运行中任务，选择保持后台或请求停止，不能关 UI 就宣称已停）；steer 仅 S6 交付后启用，可靠排队可独立验收。
- 测：desktop 错误/重试/通知/关窗口单测。Commit：`✨feat(desktop): 错误/重试/恢复/通知与能力门控（D4）`

### D5 — 工作区 / 变更审查与撤销（依赖 D0/S1/S7；可与 D1–D4 并行）

- **F1/F5**：选择项目/新建恢复分叉、文件浏览搜索引用、按任务聚合变更、实际 diff、可支持粒度 undo/redo；保留用户脏改动、外部改动冲突阻止覆盖；A/B 项目不串 cwd/草稿；**不做完整 Git/PTY 工作台**。
- 测：`desktop-workspace-switch`、`desktop-change-review`、`desktop-undo-external`。Commit：`✨feat(desktop): 工作区与变更审查/安全撤销（D5）`

### D6 — 有效配置 / 上下文面板 + F1–F8 端到端证据（依赖 D1–D5/S7）

- 复用 SettingsDialog/CommandPalette；补有效配置/上下文面板；**F1–F8 e2e fixtures 与执行证据**：桌面选模型配置真正生效，plan→执行→修改→失败测试→修复重跑→变更审查→恢复可完整操作；工具/MCP/skills/预算诊断可见，禁止只接 mock。全 F 流程通过才交桌面。
- 测：`harness-workflow-F1-F8`。Commit：`✅feat(desktop): 有效配置/上下文面板 + F1-F8 端到端证据（D6）`

---

## 代码审查（阶段级，验收前）

**审查方：** 独立子代理（非实现者）；面：风格/测试完整性/依赖/架构红线（桌面只观察者、不暴露任意 fs、不破坏轨迹不变量）/API 契约一致性/安全（密钥脱敏）。
**结论：** ✅ 通过 / ⚠️ 有条件通过 / ❌ 不通过

---

## 验收标准总表（桌面用 F1–F8 功能流程，不评视觉相似度）

| #   | 标准         | 通过条件                                                                                                                                                                         | 验证责任人        |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| F1  | 项目与会话   | 打开 A 引用 README 问结构，切 B 再恢复 A、分叉；root/cwd/模型/指令来源可见；文件读取确在各自目录；草稿/历史不串；分叉不改原会话                                                  | 自动化 + 临时项目 |
| F2  | 只读计划     | plan 模式要求改文件+危险写命令，先出计划再用户切执行模式；plan 阶段无写副作用；切权限是显式动作；UI 显示本轮回实际生效配置                                                       | 自动化            |
| F3  | 修改并测试   | agent 改临时函数、跑测试、制造失败、修复重跑；有 tool 参数/命令/shell/cwd/output/退出码；失败真实显示；修复后以新测试结果判定；最终摘要链接真实 diff 和测试记录                  | 自动化 + 临时仓库 |
| F4  | 审批与拒绝   | 写/命令及子任务同时 ask，拒绝一项；中途断线、重复点击响应；全部待批可见、拒绝项未执行、ack 前不消失；作用域授权不泄漏到 B 会话                                                   | 自动化            |
| F5  | 变更与撤销   | 起始有用户未提交改动；agent 改另一处；用户 agent 后再改文件，然后 undo/redo；展示任务变更与既有改动区别；无冲突路径可复原；外部修改冲突被提示并阻止静默覆盖                      | 自动化 + 临时仓库 |
| F6  | 子任务控制   | 派 2 个只读任务，看子进度/审批；停止一个继续另一个；重叠、父子归属清楚；停止不误伤兄弟；结果状态可恢复；失败不冒充完成                                                           | 自动化            |
| F7  | 断流与队列   | 发送后丢 ack、途中断 WS、provider 中途 EOF、取消退避、重启 UI/serve；不重复提交/工具副作用；重订阅恢复；预算耗尽有明确停因；服务死亡任务标中断/unknown；未启动队列恢复 paused    | 故障注入          |
| F8  | 配置与上下文 | 选可用模型、注入文件/指令/skill、触发压缩；模拟 provider/MCP 不可用；请求实际用选定配置、运行中配置不突变；输入可追溯；压缩状态与失败可见、密钥脱敏；无配置/连接失败有可行动提示 | 自动化            |
| 9   | 全量回归     | `pnpm -r test` 全绿（真实命中，非 `--passWithNoTests`）                                                                                                                          | 自动化            |
| 2b  | 代码审查     | ✅ / ⚠️；❌ 下放                                                                                                                                                                 | 独立角色          |
| 10  | 红线/密钥    | 无禁止项、不暴露任意 fs、`git ls-files` 无敏感文件                                                                                                                               | 自动化            |
| 11  | 并行边界     | 未改 core/gateway/cli 与根级配置；`api-surface-baseline.json` 无变化；日志只写 `<日期>-D.md`                                                                                     | 自动化 + 编排者   |
| 12  | 真实模型联调 | D6 的 F1–F8 用本地 `http://127.0.0.1:40080/v1`（`big-pickle`）跑真实往返，禁止只接 mock                                                                                          | 自动化 + 人工     |

---

## 风险与降级

| 风险                   | 缓解                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| 依赖共享底座/S7        | 未冻结用 mock adapter 隔离开发 D1/D2/D5；真实执行/变更/恢复/任务/审批必须联调 |
| 渲染隔离               | 保持 contextIsolation + preload 白名单；不暴露节点能力                        |
| 「看似有功能实为空壳」 | 禁止只画状态卡/假入口；无后端能力如实 disabled 并解释；F 流程必须真实执行证据 |
| 长历史/多 pane 性能    | store 局部 selector + 虚拟列表；1000 消息/多 pane 压力 trace                  |
| 桌面被用户实测冲突     | 独立 worktree；合并前与主会话/用户协调                                        |

---

## 给接手 AI 的完整提示词

> 复制以下整段给实施/审查子代理：

```
你是 harness2 激进版「桌面功能优先 harness（D0-D6）」的实现者。先完整读：
- docs/ai-framework/phased-plan-driven.md（元规范）
- docs/ai-framework/plans/2026-09-08-phase-aggressive-desktop-interaction.md（本计划）
- docs/ai-framework/plans/2026-09-11-phase-foundation-patch.md（开工闸门 + 【并行开工守则】，边界以它为准）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md 的 §6（上阶段遗留）
- docs/research/notion-ai-20260908-0056/04-implementation-plan.md（I1 R2 §5.2/§5.3/§7）
- docs/research/notion-ai-20260908-0056/03-harness2-core-audit.md（队列底座/观察缝/缺口）

重要：桌面【不再复刻 CodexMonitor 界面】。以 §5.2 的最小 harness 能力与 §5.3 的 F1-F8 为目标：
选项目 → 配模型/上下文 → 计划与权限确认 → agent 读改代码/跑测试/修复 → 审查实际变更/安全撤销 →
会话/任务恢复。先功能后美观，普通列表/表单/日志/Diff 即可；不评视觉相似度、不做主题/动画/像素。
02-codexmonitor-research.md 仅历史参考，不按它做产品规格。

前提：共享底座 S0-S7 已完成（2026-09-08），阶段 15 质量收口已验收（2026-09-11，CI 三平台 7/7 全绿）。
开工闸门＝地基补丁阶段 P0-P4 已合入 main 并宣布 core/gateway 冻结；本计划从该冻结 commit 建分支
`feat/notion-i1-desktop`。终端 T 轨由另一人同期并行，两轨只经 main 交汇。
真实模型/工具执行、变更、恢复/任务/审批必须真联调，不能拿 mock 冒充端到端。

Global Constraints 优先级最高：
- 桌面只是观察者：不成为第二模型上下文来源；不改 agent 内核编排；不新增事件类型；turn-end 语义不变；
  不破坏轨迹不变量。
- 渲染端不直接读写文件，一律走 contextIsolation IPC 桥；不暴露通用 shell/任意 fs；引用路径 realpath 校验。
- 先功能后美观：可用性不可省（IME 不误发、草稿隔离、长输出折叠、稳定滚动、加载失败入口、键盘焦点、
  关窗前提示运行中任务）；不摆可点击假入口、无能力如实 disabled 并解释；不得把 plan/ask 包装成沙箱。
- 不做：Tauri；第二套 Codex 后端；完整 Git/PTY 工作台/codemap；把取消当 undo、把重连当重发、
  承诺 shell/MCP exactly-once；自动 retry 工具；Steer 仅 S6 交付后启用，可靠排队可独立验收。
- 命令 PowerShell 5.1 分行，每条查 $LASTEXITCODE；测试名真实命中 >0，禁止 --passWithNoTests 假绿。
- Git：只显式 add 本任务文件（禁 git add -A），小步 commit，提交格式 <gitmoji><type>(<scope>): <中文描述>；
  可 push 自己的分支 feat/notion-i1-desktop；合入 main 前该分支 CI 必须三平台全绿并 --no-ff 合入；
  禁 force push、禁在 main 上试错、禁 --passWithNoTests、禁注释或删除失败用例。
- 并行边界（红线）：本轨独占 packages/desktop。packages/core、packages/gateway、packages/cli 只读；
  根级 pnpm-lock.yaml、package.json、tsconfig.base.json、.github/workflows、eslint/prettier 配置禁止擅改。
  需要改这些时停手，在 docs/issue-log/<日期>-D.md 登记并上报编排者，不得自行修改，
  也不得把 core 逻辑复制进 desktop 绕过。新增依赖须先报备。
- 日志分文件：本轨只写 docs/issue-log/<日期>-D.md（四要素：需求描述/处理过程/修改结果/遗留风险）；
  不改 OPEN.md、DECISIONS.md、HANDOFF.md、MASTER-PLAN.md、CHANGELOG.md、ROADMAP.md（阶段末由编排者统一回填）。
- 本地真实模型（D6 的 F1-F8 用）：base URL http://127.0.0.1:40080/v1、key sk-unified-local、模型 big-pickle
  （200K 上下文、纯文本）；用隔离 --home，key 只写该目录下的 auth.json，不进 git。

每 Task：先写失败用例 → 最小实现 → 跑 `pnpm --filter @harness2/desktop test` → 贴「实际命令+输出」。
最后跑 `pnpm -r test` 全量回归。完成后给出：worktree 名、commit 清单、逐 Task/逐 F 项结果（真实执行
证据，非截图/状态卡）、已知风险（P0/P1 未闭环给「不通过/明确阻塞」）、残余真机项。
```

---

## 残留手工验收清单

1. 真机：serve 未就绪竞态是否复现（D1）、DPI 100-125-150%、中文路径/空格/junction、通知点击定位、断线重启、关窗口提示后台任务。
2. 真实模型端到端：F1–F8 完整工作流在 Windows 实机跑通，命令退出码/真实 diff/安全撤销可见。
