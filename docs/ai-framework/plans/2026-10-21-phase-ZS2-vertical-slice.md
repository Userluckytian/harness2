# 阶段 ZS2：垂直切片——新壳跑通第一轮真实 harness2 会话

> **状态：** 计划已就绪（ZS 总纲获批 + ZS1 完成合入 main 基础上编写）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`
> **总纲:** `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md` · **施工地图:** `docs/research/2026-10-20-zs-a-class-mapping.md`（方法级映射）+ `docs/research/2026-10-20-zs-first-paint-contract.md`（首帧契约/启动 RPC 清单）

**Goal:** 一句话——在 ZCode 壳（ZS1 空态）里完成**一轮真实的 harness2 对话**：用户在新壳输入 → 内心 = harness2 core（进程内）驱动 agent loop → 流式渲染回复 → 会话以 JSONL 事件日志落盘 `~/.harness2` 并可被 CLI/loadSession 完整重放。**本阶段证明「换心」架构成立**，不追求功能完整（审批/工具细节/附件归 ZS3）。
**Architecture:** 桌面链路不变（main → utilityProcess host → MessagePort → renderer）；host 内装配从「纯桩」升级为**真实 core 进程内集成**（SessionManager + runTurn，同 CLI chat 的用法，**不引入 serve 子进程**——spike 结论：进程内实现 IServiceAccessor 是最省事路线）。核心新组件 = **v4 投影层**：core 扁平事件/hub 回调 → ZCode v4 conversation 帧（snapshot/delta rows）。水位机制两侧结构同源（seq/epoch），直接复用 core seq 空间（映射详表 §3 结论）。
**Tech Stack:** TypeScript / Electron / vitest（投影层单测 + adapter 集成测）/ CDP e2e（`scripts/zs1/cdp-page-capture.cjs` 基础上扩展）。
**实施档位：** 全能 · **子代理：** 启用（cat-jam；编排者验收）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
| ------ | ---- |
| P0 | `docs/ai-framework/phased-plan-driven.md`、本文件 |
| P0 | ZS 总纲（硬线）+ 映射详表（§1.2/§1.3 v4 与 task 面、§3 词表主表）+ 首帧契约表 |
| P0 | ZS1 计划执行记录（路线 B / 隔离 env 三件套 / CDP 通道——本阶段沿用） |
| P1 | `AGENTS.md`、`CODE_REVIEW.md`、`docs/core` 侧：`packages/core/src/session/`、`interaction/delivery.ts`、`server/sessions-types.ts`（SessionHubHooks） |

**仓库路径：** `D:/AI_Projects/harness2`（main = `7f1531b`，v1.0.2 已发布）· ZCode 源只读：`D:/AI_Projects/refs/ZCode`（`3c5b2276`）· scratch：`D:/AI_Projects/harness2-zs1-build/ZCode`
**基线分支：** 从 `main`（`7f1531b`）拉 `feat/phase-zs2-vertical-slice`

---

## Global Constraints（冲突时以本节为准）

1. **ZCode UI 零改动**：沿用 ZS1 patch 清单（仅 `desktopRuntimeEnv.ts` hostModulePath 注入一处）；本阶段不得新增 UI patch。
2. **core 逐个解冻纪律（用户 2026-10-20 指示）**：本阶段**目标 = core 零改动**（现有导出够用：SessionManager/runTurn/provider factory/tools）。若实施中确有必要新增：一次只提**一个**最小加性点 → 独立 commit + 测试 → 编排者验收 → 才允许下一个；`api-surface-baseline.json` 同步；0 removed / 0 kindChanged。`packages/gateway` 零改动。
3. **进程内集成，不引 serve**：host bundle 经 esbuild 打 core dist（CJS 桥沿用 `createRequire` 手法，desktop `src/main/core.ts` 有先例）；**不得**在 host 里 spawn serve。
4. **真实数据根**：本阶段起 adapter 写真实 `~/.harness2`（sessions/、auth.json 只读、zs-settings 归 `~/.harness2/zs/`）；**启动测试必须带隔离 env 三件套**防污染用户真实 ZCode `~/.zcode`（ZS1 血泪，见执行记录）；对真实 harness2 库的测试一律临时目录。
5. **红线⑩**：投影层未覆盖的事件类型按契约表**如实降级**（可丢弃不可伪造）；「No model available」横幅在 T4 前维持真实现状（空 providers = 真话），不得用假 provider 消横幅。
6. 密钥不进 git（provider key 只从 `~/.harness2/auth.json`/env 读）；错误消息出口过 `redactSecrets`。
7. **明确不做（本阶段）**：❌ 审批/elicitation（ZS3）❌ 附件/图片管线（ZS3）❌ 工具进度/入参流式投影（ZS3，切片只投影 tool/call+result 的静/动两态）❌ task 索引状态 pinned/archived（ZS4）❌ mid-session setModel（ZS4 解冻窗口）❌ 列表虚拟化/性能专项 ❌ 打包发版。

---

## 阶段开头：上阶段遗留

| 项 | 来源 | 状态 |
| --- | --- | --- |
| ZS1 观察项①radix 遮罩自动开（Esc 可关） | ZS1 验收记录 | ⬜ 本阶段 T1 顺路定位（疑与 onboarding/引导链或焦点桩有关），修不掉则登记归 ZS6 隐藏清单 |
| ZS1 观察项②「No model available」横幅 | 同上 | ✅ 归 T4（真实 provider 视图落地后自然消失） |
| 并行满载 core 1 文件 / desktop 2 文件 flaky | OPEN.md 已知限制 | ⬜ 不修（CI 逐包口径已规避）；本阶段 CI 全绿即可 |

---

## File Structure（预期变更）

| 文件/目录 | 动作 | 职责 |
| ---- | ---- | ---- |
| `packages/zcode-adapter/src/core-bridge.ts` | 新建 | core 进程内装载（esbuild 外部化策略 + createRequire 桥 + 临时/真实 root 切换） |
| `packages/zcode-adapter/src/real/session-service.ts` | 新建 | `IZCodeSessionService`/`IZCodeAgentService` 会话面真实现（create/resume/list/read* → SessionManager/loadSession/computeProjection；快照形状按映射详表 §1.1 五段重组） |
| `packages/zcode-adapter/src/real/task-service.ts` | 新建 | `IZCodeTaskService` 切片面：initialize/createTask/sendPrompt/stopGeneration/listTasks/listTaskList + 事件桥（hub hooks → onDynamicStreamEvent/onDynamicTaskEvent/terminal） |
| `packages/zcode-adapter/src/real/v4-projection.ts` | 新建 | **核心**：core 事件→v4 rows/state 帧（turnHeader/userInput/assistantText/reasoning/toolCall + control/usage/meta 状态键；rowId 空间；snapshot/delta；seq 水位） |
| `packages/zcode-adapter/src/real/file-service.ts` | 新建 | IFileService 最小集：ensureConversationWorkspace/createDefaultWorkspace/readdir/stat/readTextFile/checkFilesExist/resolvePath（其余保持 B-throw） |
| `packages/zcode-adapter/src/real/provider-views.ts` | 新建 | modelSelection/providerSettings getView 从 config roles+auth.json 投影（映射详表 §1.5 形状） |
| `packages/zcode-adapter/src/createHarness2Services.ts` | 修改 | 上述真实现替换对应桩（EXPLICIT_STUBS 扩注册；替换清单见各 Task） |
| `packages/zcode-adapter/src/settings-store.ts` | 新建 | AppSettings 持久化到 `~/.harness2/zs/setting.json`（CAS 语义仿 ZCode settingService） |
| `packages/zcode-adapter/test/v4-projection.test.ts` 等 | 新建 | 投影层逐事件型断言 + 集成测（临时 root 真 core） |
| `scripts/zs2/cdp-e2e.cjs` | 新建 | e2e 验收器：启动 → CDP Input 在 composer 打字/回车 → 轮询 DOM 出现回复文本 → 截图留证 |
| `docs/ai-framework/plans/2026-10-21-phase-ZS2-vertical-slice.md` | 修改 | 执行记录回填 |

---

## Task 0：composer 发送调用面探针（先探后建，零桩改动）

**Files:** `scripts/zs2/probe-send.cjs`（新建）；执行记录登记

**行为:** ZS1 空态下 composer 已可见（e2e 截图见 `Ask ZCode`），但**「按下发送」会调用哪些 RPC 尚未实测**——投影与写路径的实现顺序必须以实测为准，禁止凭想象排任务。本任务：以 ZS1 桩启动新壳（隔离 env），CDP `Input.insertText` 输入文本 + 回车（或 Enter 等效键），从两路收割调用面：①host 侧 B 类桩 `not implemented` throw 清单（stderr/日志）；②CDP 侧 DOM 错误 toast 文本。产出「发送路径 RPC 清单」（方法名 × 出现顺序）写进执行记录，作为 T1-T4 实现顺序的输入。**预期会看到**：`zcodeAgent.sendPrompt`/v4 `sendText` 命令、`ensureConversationWorkspace`（已真 T1 化）、`title` 相关、credential/models——以实测为准。

**Steps:**
1. 写探针脚本（复用 `scripts/zs1/cdp-page-capture.cjs` 的连接逻辑 + `Input.dispatchKeyEvent`）。
2. 跑一次，输出清单贴执行记录；若 DOM 无任何反应（发送被前端校验拦截）→ 调整输入形状（工作区/模型选择前置状态），仍不通则登记并给 T1 增加对应真实现项。
3. Commit：`📝docs(zs2): T0 探针——composer 发送调用面实测清单`

---

## Task 1：core 进程内集成骨架（无 UI 行为变化）

**Files:** `core-bridge.ts`、`settings-store.ts`、`file-service.ts`、`real/session-service.ts`（list/create/read* 部分）、相关测试

**行为:** adapter host 能真实调用 core：SessionManager 指向 root（测试=临时目录，运行=`~/.harness2`）；`ensureConversationWorkspace` 返回真实存在的目录（`~/.harness2/zs/workspace/default`）；`settingService` 读写落 `zs/setting.json`（不再回退桩）。listSessions → core.list 投影为 ZCodeSessionInfo（mode/status/model/title 缺字段按映射详表默认值填充）。

**Steps:**
1. 实现 + 单测（临时 root：造 2 会话 → adapter.list 返回 2 条、字段形状过类型）。
2. 跑：`pnpm --filter @harness2/zcode-adapter test`（守卫通道）全绿；`pnpm -r typecheck` 不回归。
3. 冒烟：重启新壳（隔离 env），侧栏应列出 `~/.harness2/sessions` 真实会话（当前空库=空列表；用 CLI 造 1 条演示会话验证出现）。
4. 顺路定位 ZS1 观察项①（radix 遮罩），结论进执行记录。
5. Commit：`✨feat(zcode-adapter): core 进程内集成——会话读面与工作区/设置真实化（ZS2-T1）`

---

## Task 2：v4 投影层（本阶段核心，先行单测后可接线）

**Files:** `real/v4-projection.ts`、`test/v4-projection.test.ts`

**行为:** 输入 = core 落盘事件流 + `SessionHubHooks` 回调；输出 = v4 `TopicFrame`（snapshot / deltas：row.appended/upserted/delta + state.updated）。范围（契约表 §3.2 主表的切片子集）：
- rows：`turnHeader`（由 user/message + turn 生命周期合成）、`userInput`、`assistantText`（流式 row.delta path=text，终态 upserted complete/interrupted/failed）、`reasoning`（拆 message 内字段为独立 row）、`toolCall`（call→running，result→success/error 两态；progress/inputStreaming 不做——ZS3）。
- state：`control.phase`（running/completedSuccess/completedInterrupted/error ← onTurnEnd.stopReason）、`usage`（TokenUsage 累计）、`meta.title`（titles）。
- 水位：rowId 空间 = `seq` 单调（resume=lastSeq+1 语义对齐 `ResumeSubscriptionRequest`）；断线 resync 最小面 = 重发 snapshot。
- 未覆盖事件（memory/snapshot、nudge、step/*）按映射详表 §3.5「可丢弃」清单处理，代码注释指回契约表。

**Steps:**
1. 纯函数投影 + 单测：逐事件类型≥1 断言（assistant/attempt 的 interrupted/failed 分支、approval 联动 pendingInteractions 只留数据结构不实现应答）；**变异验证**：破坏一条映射 → 对应用例必红，登记后回退。
2. 跑：`vitest run test/v4-projection.test.ts` 全绿。
3. Commit：`✨feat(zcode-adapter): v4 conversation 投影层——core 事件到 rows/frames（ZS2-T2）`

---

## Task 3：写路径打通——新壳内一轮真实对话（mock provider）

**Files:** `real/task-service.ts`、`createHarness2Services.ts` 接线、`scripts/zs2/cdp-e2e.cjs`

**行为:** `createTask` → SessionManager.create；`sendPrompt` → 进程内 runTurn（provider=**mock 脚本**：回显式长文本 ≥3 段 + 1 次工具调用 write 临时文件）；hub hooks → T2 投影 → `onDynamicTaskEvent`/v4 帧推给 UI。`stopGeneration` → core cancel（AbortController）。事件与 UI 之间**只走 T2 投影**，禁止旁路私造帧。

**Steps:**
1. 集成测（临时 root + mock provider）：createTask→sendPrompt→事件序列断言（delta×N→assistantText complete→toolCall success→turn-end）+ JSONL 落盘可 `loadSession` 完整重放。
2. **e2e 验收（本阶段核心出口）**：`node scripts/zs2/cdp-e2e.cjs`——隔离 env 启动新壳 → CDP `Input.insertText`+回车 → 轮询 DOM 出现 mock 回复文本 → 断言流式增量（两次采样文本长度递增）→ 截图 `docs/screenshots/zs2/t3-stream.png` + 会话目录路径打印。
3. 变异验证：摘掉投影接线 → e2e 应停在「无回复」；恢复复绿。
4. Commit：`✨feat(zcode-adapter): 写路径与 v4 事件桥——新壳跑通真实一轮会话（ZS2-T3）`

---

## Task 4：provider/模型视图真实化（消横幅）

**Files:** `real/provider-views.ts`、测试

**行为:** `modelSelectionService.getView`/`providerSettingsService.getView` 从 `~/.harness2` config（roles + providers + auth.json key 存在性）投影：`providers[]` 至少含 roles.main 对应提供方，`executable` = 有可用 key；无 key 时如实空态。写路径（createPersonalProvider 等）保持 B-throw（ZS4）。**真模型一轮（可选，如实登记）**：若 auth.json 存在可用提供方 → 在 e2e 里追加一条真实模型对话用例；无 key/网络不通 → 标 `➖ 待环境`，不得用 mock 冒充。

**Steps:**
1. 单测：config 三态（有 key/无 key/多提供方）投影形状断言；密钥值绝不出现在返回形状与错误消息（redactSecrets 覆盖断言）。
2. e2e：横幅消失（DOM 无 "No model available"）；模型选择器出现真实模型名。
3. Commit：`✨feat(zcode-adapter): provider/模型视图从 core 配置投影（ZS2-T4）`

---

## Task 5：收口核查（编排者亲验）

1. 六包基线：`pnpm -r build && pnpm -r --no-bail run test` ≥ core 1625+2 / gateway 40 / web 150 / cli 1575+2 / ui-shared 776 / desktop 1289+1（zcode-adapter 新基线另计）。
2. `pnpm -r typecheck`、`pnpm lint`（eslint 0 error + prettier 全绿）。
3. 冻结纪律：`git diff --stat main..HEAD -- packages/desktop packages/cli packages/gateway packages/web packages/ui-shared` = 0；core diff 逐个核对（目标 0；若解冻窗口发生 → 单独 commit + 基线同步 + 验收记录）。
4. UI patch 清单仍仅 ZS1 那一处（scratch git diff 复核）。
5. 分支 push → CI 三平台绿 → 交用户真机点验（残留手工清单）。

---

## 代码审查（全能档含）

独立只读子代理（非实现者），按 `CODE_REVIEW.md`。审查面：投影层语义正确性（对照契约表 §3）/ core 使用是否越界（禁 import 内部未导出件）/ 密钥出口 / 红线⑩降级诚实性 / 临时目录卫生 / 测试断言非空转（抽 3 例变异推演）。

---

## 验收标准总表

| # | 标准 | 通过条件 | 验证人 |
|---|------|----------|--------|
| V1 | 一轮真实会话 | e2e：输入→流式增量→终态；截图留证；DOM 断言文本 | 自动化+编排者复跑 |
| V2 | 事件日志唯一事实源 | 会话 JSONL 落 root，`loadSession`+投影完整重放（集成测） | 自动化 |
| V3 | 投影层质量 | 逐事件型用例全绿 + 变异验证记录 + 未覆盖事件按「可丢弃」清单如实注释 | 自动化+审查 |
| V4 | 横幅消除与真话 | "No model available" 消失仅在真有 provider 时；无 key 时空态如实 | e2e+审查 |
| V5 | 冻结纪律 | 六包零改动 / core 0 或逐个解冻窗口全留痕 / gateway 0 | 编排者 |
| V6 | 测试与闸门 | 六包基线不回退 + typecheck/lint 全绿 + 分支 CI 三平台绿 | 自动化 |
| V7 | 代码审查 | ✅ 或 ⚠️（P1 修后复验）；❌ 阻塞 | 独立子代理 |
| V8 | 用户真机 | 新壳里亲自发一条消息看到回复；确认可用性 | 用户 |

---

## 风险与降级

| 风险 | 缓解 |
| ---- | ---- |
| v4 帧形状细节与 UI 消费不匹配（snapshot 字段缺） | T2 单测以 ZCode `ConversationSnapshot` 类型为准编译期对齐；e2e 兜底；缺字段按契约表补，**禁止改 UI** |
| runTurn 在 utilityProcess 内行为差异（信号/stdout 假设） | T3 集成测跑同进程；异常走 cancel 路径如实登记 |
| mock 脚本回合与 UI 状态机死锁（如永远等 control.phase） | 投影层用例覆盖 end_turn→completedSuccess；e2e 超时报错并截 DOM 状态 |
| 真模型不可用（网关 key 问题） | mock 为硬门槛、真模型为可选门（➖ 如实登记，不冒充） |
| core 需要解冻 | 「一次一个」纪律；每个解冻=独立小 commit+测试+验收记录 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理，执行 **ZS2 阶段**（垂直切片：新壳跑通一轮真实会话）。完整执行，不要只写方案。

### 基线

- 目录 `D:/AI_Projects/harness2`；从 `main`（≥`7f1531b`）创建并切换 `feat/phase-zs2-vertical-slice`
- 唯一实施计划：`docs/ai-framework/plans/2026-10-21-phase-ZS2-vertical-slice.md`
- 必读：本计划 + ZS 总纲 + 映射详表（`docs/research/2026-10-20-zs-a-class-mapping.md`）+ 首帧契约表 + ZS1 计划执行记录（隔离 env/CDP 通道/patch 清单）
- ZCode 源（**只读**）：`D:/AI_Projects/refs/ZCode`；scratch：`D:/AI_Projects/harness2-zs1-build/ZCode`（其 UI 零改动纪律延续）
- **环境**：cmd.exe 缺失 → pnpm 直调：`node "D:/.pnpm-store/v11/links/@/pnpm/11.13.0/d11795881783aa51f96a2d2a2c920d8e31138fac1136d44bf46998e29eab8385/node_modules/pnpm/bin/pnpm.mjs" ...`；启动测试壳**必须带 ZS1 隔离 env 三件套**（ZCODE_DESKTOP_HOME_DIR/HOME/USERPROFILE/APPDATA/LOCALAPPDATA + ZS1_HOST_MODULE_PATH + ZCODE_DATA_BASE_DIR，值见 ZS1 计划）；CDP 探针 `scripts/zs1/cdp-page-capture.cjs`（9229 端口）
- **杀进程红线**：只杀 `ExecutablePath like 'D:\AI_Projects\harness2-zs1-build*'` 的 electron，严禁碰 `ZCode.exe`（用户客户端）

### 做

1. Task 1→5 顺序执行；每 Task 真实证据后 commit（gitmoji+中文）。
2. T2 投影层是本阶段心脏：以映射详表 §3 词表为准；单测逐事件型；变异验证留痕。
3. T3 的 e2e（`scripts/zs2/cdp-e2e.cjs`）：CDP Input 在 composer 输入 → DOM 断言流式增量 → 截图 `docs/screenshots/zs2/`。
4. core 目标零改动；确需新增加性能力时**一次只提一个**（独立 commit+测试+执行记录），不得批量。
5. 密钥不进 git；auth.json 只读；错误出口 redactSecrets。

### 不做

审批/elicitation、附件管线、工具进度流、task 索引状态、setModel 会话中切换、serve 子进程、打包发版、修改 ZCode UI、修改 refs 仓。

### 交卷

分支/提交列表、验收表自评（V1–V8）、e2e 真实输出+截图路径、core diff 审计结论、测试真实输出、残留风险。

现在开始：读完四份文档，从 Task 1 执行到最后。

---

## 残留手工验收清单

1. 用户真机：新壳里亲手发一条消息、看流式回复（V8）。
2. 用户确认 ZS2 观感后，ZS3（对话区完整）计划起草。
