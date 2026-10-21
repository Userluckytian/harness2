# 阶段 ZS3：对话区完整——审批流 / 工具卡保真 / 附件管线 / resume 与分页

> **状态：** 计划起草（2026-10-21，基于 ZS3 调用面盘点报告·Explore 代理 file:line 级证据；待用户审阅）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`
> **总纲:** `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md` · **施工地图:** 映射详表 `docs/research/2026-10-20-zs-a-class-mapping.md` + 首帧契约 `docs/research/2026-10-20-zs-first-paint-contract.md` + **本阶段前置：ZS3 调用面盘点（未入库，全文见本计划各 Task 引用；报告要点已逐条并入）**

**Goal:** 一句话——把 ZS2 的「能对话」升级为「对话区完整可用」：工具卡全生命周期保真（入参流式/结果/错误/reasoning）、permission 审批端到端闭环、本地附件管线打通、断线 resume 真续传 + 历史真分页。**用户此前「输入框难用」的抱怨在此终结**（composer 全交互 = 附件四路采集 + 回显 + 不炸）。
**Architecture:** 延续 ZS2 链路（桌面 main → utilityProcess host → MessagePort → renderer；进程内 core；v4 投影）。本阶段三根支柱：①**投影单一化**——消灭 `agent-service.ts` 内联投影与 `v4-projection.ts` 双轨（字段名与协议名对齐）；②**ACK 词表纪律**——白名单外命令显式 `rejected`，禁止假 `accepted`；③**service 层直调测试**为默认验证缝（帧序列断言），CDP e2e 只做出口验收——ZS2 血泪：作者环境能绿不算数，判据必须可区分失败段。
**Tech Stack:** TypeScript / Electron / vitest（service 层帧对拍）/ CDP e2e（`scripts/zs2/run-e2e.ps1` + `e2e-round.cjs` 扩展）。
**实施档位：** 全能 · **子代理：** 启用（cat-jam；编排者验收）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`、本文件                                                                                              |
| P0     | ZS 总纲（硬线）+ 映射详表 §1.2/§1.3/§3 + 首帧契约表 + **ZS2 计划执行记录**（含「假通过」拦截两案——本阶段测试缝纪律的出处）                     |
| P0     | ZCode UI 证据锚点（本计划各 Task 内联 file:line，只读）：`refs/ZCode/packages/ui/src/v4/**` + `packages/shared/src/zcode-protocol-v4/**`       |
| P1     | `AGENTS.md`、`CODE_REVIEW.md`、core 侧：`packages/core/src/interaction/`（ApprovalQueue/types）、`server/sessions-types.ts`（SessionHubHooks） |

**仓库路径：** `D:/AI_Projects/harness2`（main = `c0d0d3e`，ZS2 已合并、双 CI 绿）· ZCode 源只读：`D:/AI_Projects/refs/ZCode`（`3c5b2276`）· scratch：`D:/AI_Projects/harness2-zs1-build/ZCode`
**基线分支：** 从 `main` 拉 `feat/phase-zs3-conversation-parity`

---

## Global Constraints（冲突时以本节为准）

1. **ZCode UI 零改动**：沿用 ZS1 唯一 patch（`desktopRuntimeEnv.ts` hostModulePath 注入）；本阶段不得新增 UI patch。
2. **core 逐个解冻纪律（用户 2026-10-20 指示）**：默认 core 零改动。**唯一预期例外 = T6 elicitation**（core 无交互请求类型往返，属映射表 3.5 定性 B 类缺口）：动手前必须先出「core 最小加性面」小提案（一次一个：独立 commit + 测试 + `api-surface-baseline.json` 同步 + 编排者验收）；提案不过 → T6 如实登记归 ZS4，不硬造。`packages/gateway` 零改动。
3. **红线⑩（无假入口）**：UI 有消费路径的命令必须真实现或显式 `rejected`（附 reasonCode），**禁止回假 `accepted`**；UI 无消费路径的（如旧 `respondPermission`/`respondElicitation`——盘点实测 ui/src 零命中）维持现状不实现。
4. **数据与密钥**：真实数据根 `~/.harness2`（ZS2 口径）；启动测试必须带隔离 env 三件套（ZS1 血泪）；密钥只从 `~/.harness2/auth.json` 读，出口过 `redactSecrets`。
5. **fault 字符串纪律**：我方 service 抛错/降级消息必须使用 UI 按字面量路由的词表（`fault.subscription.*`、`proto.commandUnsupported` 等；出处 `conversationProjectionStore.ts:507/:957`、`wire-fault.ts:31-32`）。
6. **验证缝分层**：单元/集成 = service 层直调 + 帧序列断言（`test/v4-integration.test.ts` 模式）；e2e = 仅出口验收，每条 e2e 判据必须**容器级可区分失败段**（ZS2 沉淀②）。
7. **明确不做（本阶段）**：❌ task 索引状态 pinned/archived 与侧栏批量删除（ZS4）❌ provider 写路径 `createPersonalProvider` 等十投（ZS4）❌ 会话中 setModel/switchModel（ZS4）❌ `workspaceHookReview` 三命令（UI 无触发路径）❌ 列表虚拟化/性能专项 ❌ 打包发版 ❌ 修改 ZCode UI / refs 仓。

---

## 阶段开头：上阶段遗留

| 项                                       | 来源                             | 状态                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZS1 观察项① radix 遮罩自动开（欢迎模态） | ZS1 记录                         | ⚠️ ZS2 未定位根因，仅在 e2e 侧点掉（`7dcbe7a`）。本阶段 T7 定位：全新态首启该模态是 ZCode 原生行为——**观感上「壳冒充正版 ZCode」**，属 ZS6 品牌隐藏清单候选；先登记事实（首启必经一次模态），修/藏随 ZS6 拍板 |
| ZS2 P2×8 登记                            | ZS2 审查（明细 2026-10-21 日志） | ⬜ 随各 Task 顺手消化：帧 schema 校验用例（T0）、composer 选择器精确度（T7）、authPath 硬编码常量（T0）、host-bundle 产物入 git（T7 评估）、投影 Map 无界增长（T4）                                           |
| 并行满载 ui-shared/desktop flaky         | OPEN.md 已知限制                 | ⬜ 不修；CI 逐包口径已规避                                                                                                                                                                                    |

---

## File Structure（预期变更）

| 文件/目录                                                                                           | 动作 | 职责                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/zcode-adapter/src/real/v4-projection.ts`                                                  | 大改 | **唯一投影源**：吸收 agent-service 内联投影；字段名 = 协议名（`status`/`output`/`error`）；新增 pendingInteractions/reasoning/attachments 行与帧合成；投影缓存有界化（P2-1） |
| `packages/zcode-adapter/src/real/agent-service.ts`                                                  | 收敛 | 删内联投影与假 ACK；命令分表白名单化（未知 → `rejected`）；实现 `resolveInteraction`/附件六法/真 resume/rowsRange                                                            |
| `packages/zcode-adapter/src/real/attachment-store.ts`                                               | 新建 | 上传事务状态机（begin/chunk/commit/abort + sha256 + 384KiB 分片暂存于 `~/.harness2/zs/attachments/`）与分块回读                                                              |
| `packages/zcode-adapter/src/real/task-service.ts`                                                   | 修改 | approval 桥：core ApprovalQueue ↔ v4 pendingInteractions（若走任务面）                                                                                                       |
| `packages/zcode-adapter/test/{v4-projection,agent-service,attachment-store,v4-integration}.test.ts` | 扩   | 逐能力帧序列断言                                                                                                                                                             |
| `scripts/zs2/e2e-round.cjs`                                                                         | 扩展 | 复用同一 runbook：新增审批轮/附件轮判据段（或新建 `scripts/zs3/`，以最小改动为准）                                                                                           |
| `docs/ai-framework/plans/2026-10-21-phase-ZS3-conversation-parity.md`                               | 修改 | 执行记录回填                                                                                                                                                                 |

---

## Task 0：投影收敛 + ACK 词表纪律（纯重构，行为不变）

**Files:** `v4-projection.ts`、`agent-service.ts`、`test/v4-projection.test.ts`

**行为:** ①内联投影迁入 `v4-projection.ts` 单一实现（`ProjectedRow` 字段名直接产出协议名，删 `toolStatus`/`toolOutput` 别名；盘点点名 `agent-service.ts:261-299` 与 `:71` pendingInteractions 硬编码空数组两处随迁）；②`sendConversationCommandV4` 命令分表白名单：`createSession`/`sendText`/`stop` 之外一律 `{status:'rejected', reasonCode:'proto.commandUnsupported', revisionAtDecision}`（**这是消灭假 accepted 的第一步，也是后续所有 Task 的安全网**）；③authPath 提为带注释常量（P2-8）。T2 的 `resolveInteraction`、T5 的附件命令届时进白名单。
**Steps:** 1. 迁移 + 现有 42 测全绿（行为不变即等价证据）；2. 新增：未知命令回 rejected 断言 + 帧 schema 校验用例（P2-2：`zcode-protocol-v4` 的 zod schema 在测试里 parse 我方产出帧）；3. `🎨refactor(zcode-adapter): 投影单一源与命令 ACK 白名单（ZS3-T0）`

---

## Task 1：工具卡全生命周期保真 + reasoning 行

**证据锚点:** `rows.ts:205-233`（toolCall 必填 `toolCallId/toolName/status/inputText`；status 闭集 6 值；error 态必带 `error:{code,message}`；`row.upserted` 整行替换 `delta.ts:109-110`）；已知 bug：`agent-service.ts:286-297` upsert 掉 toolName/inputText/output；reasoning row `rows.ts:182-191`，现状 `:259` 丢弃。
**行为:** ①修 upsert 保真：tool-result 时整行仍含入参，附 `output:{text}` 与 `error:{code,message}`；②入参流式：args 增量 → `row.appended{status:'inputStreaming'}` + `row.delta{path:'inputText'}`，终态转 running（MockProvider 分片脚本）；③reasoning：`assistant/message.reasoning` → 独立 row + 流式 delta；④unknown 工具名不处理（UI 兜底卡天然安全，family 映射归后续观察）。
**Steps:** 1. service 层用例：tool 全生命周期帧序列断言（含 upsert 后 row 仍含入参/输出的反向断言）；2. e2e 回归轮不劣化（`run-e2e.ps1 -Fresh` 一跑 exit=0）；3. `✨feat(zcode-adapter): 工具卡保真与 reasoning 行——入参流式/终态保真/思考行（ZS3-T1）`

---

## Task 2：permission 审批端到端闭环（本阶段心脏）

**证据锚点:** 读面 `snapshot.ts:315-355`（pendingInteraction 必填五键 + kind/payload.kind 一致性 superRefine）、`:242-262`（permission payload 必填 `toolCallId/toolName/summary/detail` + options[{optionId,label,kind∈allowOnce|allowAlways|deny|custom}]）；写面单通道 `resolveInteraction`（`command.ts:222-234`；ACK result 必填 `resolvedBy:{clientId,optionId?}` `:399-405`；先到先得，晚到 noop）；UI 消费 `V4InteractionDialogs.tsx:123-237`、`PermissionDialog.tsx:483-647`；超时语义 = autoResolution `deadlineAt` + **服务端**清 pending 重投影（协议无 per-request expiresAt）；core 侧现成：`interaction/types.ts` ApprovalRequest/Response + ApprovalQueue（映射表 §1.3 已核形状对齐）。
**行为:** ①投影：core `onApprovalRequest` hook → `state.updated{pendingInteractions:[permission 项]}` + 对应 toolCall row `status:'pendingApproval'`；②`resolveInteraction` 真实现：查队列 settle（optionId→decision 映射表 §1.3）→ ACK 带 `result.resolvedBy` → 清 pending + row 转 running；deny 的 `answer.freeText` → ApprovalResponse.reason；③重复 resolve → `noop`；deadline 过 → 服务端自动 deny/clear + `state.updated`；④`snoozeInteractionAutoResolution` 先回 noop-accepted（如实注释：ZS3 不实现倒计时暂停语义，登记）。
**Steps:** 1. MockProvider 造必审批工具（write 临时文件路径）→ service 层全序列：请求帧→弹窗数据→resolve→行转态→JSONL 审批事件落盘；2. **e2e 审批轮（出口硬门）**：CDP 在弹窗点 deny → 弹窗消失 + 行转 error/cancelled + 截图 `docs/screenshots/zs3/approval-deny.png`；3. 变异验证：摘掉 resolveInteraction 白名单 → e2e 卡死弹窗（登记）；4. `✨feat(zcode-adapter): permission 审批闭环——pendingInteractions 投影与 resolveInteraction（ZS3-T2）`

---

## Task 3：本地附件主链（拖放/选择器零拷贝路径）

**证据锚点:** `useComposerAttachments.ts:712-1071`（四路采集→MAX 8→`localPath` 有值即**零 RPC ref 直带** `attachmentUpload.ts:53-61`）；发送携带 `sendText payload.attachments: AttachmentRef[]`（`attachment-ref.ts:6-17` strict）；回显 = `userInput` row `attachments`（`rows.ts:160`）；现状 `agent-service.ts:448` 忽略 attachments。
**行为:** ①`sendText` 消费 `payload.attachments`：投影 `userInput` row 带 attachments（chip 回显闭环）；②core 消费面如实降级：core user/message 事件当前无附件槽位 → **本 Task 只做到「进 JSONL 的加性字段登记 + provider 不喂假内容」**（图片进模型消息需 core 多模态支持 → 归 T6 同窗口的解冻提案或 ZS4，禁止 base64 塞文本冒充）；③远端场景防御：`IPromptAttachmentTransferService` 显式本地桩（stage→`{ref:localPath,staged:true}`、adopt/cancel/cleanup no-op——盘点 C3-3）。
**Steps:** 1. service 层：sendText 带 ref 数组 → userInput row 含 attachments 断言；2. e2e：CDP 无法模拟文件选择器 → **登记半自动真机项**（用户 V9 清单：拖一个文件进 composer 看 chip）；3. `✨feat(zcode-adapter): 本地附件回显与显式暂存桩（ZS3-T3）`

---

## Task 4：断线 resume 真续传 + 历史真分页 + logEpoch 代际化

**证据锚点:** 水位机 `conversationProjectionStore.ts:416-542/722-744/918-968`（resume ACK 后期望 `(base.seq, toSeq]` 续传帧；`fromSeq !== snapshot.seq` → 断档 forceSnapshot 乒乓风险——**现状 `agent-service.ts:367-397` 恒发全量 snapshot 即此雷**）；分页 `rowsRange{beforeRowId,limit 60/200}` + `atLogEpoch` 一致性裁决 + snapshot `rows:{window,totalCount,firstRowId}` 三键（`:1058-1097`）；现状 rowsRange 空壳 `:467-469`。
**行为:** ①subscribe with base：seq 可对齐 → `{kind:'deltas', fromSeq:base.seq}` 续传帧；epoch 不符 → `mode:'snapshot'` 合法降级；②resync 实现 forceSnapshot 分支；③rowsRange 从投影 rowId 空间真切页（升序页 + hasMore + 三 at 键）；④logEpoch 绑 session 文件代际（进程重启/会话重开换代）；⑤投影缓存 Map 有界化（P2-1：LRU 上限 + 常驻会话豁免，注释理由）。
**Steps:** 1. 集成测四序列：turn 中途重订阅不重放、断 epoch 回 snapshot、rowsRange 翻页到顶、notOwned 自愈文案；2. e2e：长会话（两轮以上）刷新窗口后历史完整 + 上滚出更早行；3. `✨feat(zcode-adapter): v4 真续传与历史分页——resume/rowsRange/logEpoch（ZS3-T4）`

---

## Task 5：粘贴/无路径附件的上传事务（六法全套）

**证据锚点:** `attachmentUploadTransaction.ts:123-212`（begin→chunk(384KiB, 服务端必须回 `nextChunkIndex===chunkIndex+1`)→commit→ref；异常必 abort；sha256 校验和）；回读 `attachmentReadV4{offset,limit≤512KiB}→{dataBase64,mediaType,totalBytes,nextOffset:null 终止}`（`agentConversationTransport.ts:430-453`）；每 request 物理字节 ≤1MiB。
**行为:** `attachmentBeginV4/ChunkV4/CommitV4/AbortV4/ReadV4`（+`PreviewSourceV4` 若纯本地可桩）真实现：暂存目录 `~/.harness2/zs/attachments/<uploadId>/`；状态机严格校验（乱序 chunk → fault）；commit 校验 checksum 后原子落定、返回 ref 供 sendText；read 分块回读给预览。
**Steps:** 1. 单测：事务全序 + 乱序/超字节/abort/幂等 commit 故障注入；2. e2e：截图粘贴图片 → chip 出现 → 发送 → 历史里图片预览可回读（CDP `Input.dispatchKeyEvent` Ctrl+V 不可靠 → **登记半自动真机项**并入 V9）；3. `✨feat(zcode-adapter): 附件上传事务与分块回读（ZS3-T5）`

---

## Task 6：elicitation（userInput 问询）——core 解冻窗口提案制

**证据锚点:** `userInputRequestPayloadSchema`（`snapshot.ts:281-298`：prompt/options/questions[]/schema|input）；UI 消费 `ElicitationDialog.tsx:26-30` + `V4UserInputDialog.tsx:15`；**core 无对应交互请求往返**（映射表 3.5）。
**行为（提案先行）:** 先交「core 最小加性面」提案文档（一个事件/一个 API：`interaction/request` 落盘事件 + SessionHubHooks 回调 + respond 通道），编排者验收批准后才动 core（一次一个、独立 commit、api-surface 同步）；提案被否 → T6 整体登记 ZS4，**不得在 adapter 侧伪造 core 事件**。批准后 adapter 侧：core 问询 → `pendingInteractions{kind:'userInput'}` 投影 + `resolveInteraction{freeText|optionId}` 回填 + deadline 自动清。
**Steps:** 1. 提案 `docs/research/2026-10-XX-zs3-elicitation-core-proposal.md`；2. 批准后实现 + service 层用例；3. 提交分两笔：core 窗口一笔（`✨feat(core): ...`）、adapter 一笔。

---

## Task 7：收口核查（编排者亲验）

1. 六包基线逐包跑（并行 flaky 按已知限制口径，不作回归判据）：`pnpm.mjs --filter <pkg> test` ×7。
2. `pnpm -r typecheck`、全仓 `eslint .` 0 error、`prettier --check .` 全绿。
3. 冻结纪律：`git diff --stat main..HEAD -- packages/desktop packages/cli packages/gateway packages/web packages/ui-shared` = 0；core diff = 仅 T6 批准窗口（逐个核对）。
4. UI patch 清单仍仅 ZS1 一处（scratch `git diff` 复核）。
5. e2e 全轮：`run-e2e.ps1 -Fresh` 双跑 exit=0 + 审批 deny 轮绿；截图入 `docs/screenshots/zs3/`。
6. P2×8 消化情况逐项对账（闭合/续挂登记）。
7. 分支 push → CI 绿 → 合 main → 交用户 V9 真机清单。

---

## 代码审查（全能档含）

独立只读 cat-jam，按 `CODE_REVIEW.md`。审查面：审批状态机与 ACK 语义（先到先得/noop/晚到）、投影保真（upsert 不丢字段）、附件事务故障注入完备性、resume/epoch 裁决路径、fault 字面量纪律、红线⑩（有无新增假入口）、core 越界、密钥出口。

---

## 验收标准总表

| #   | 标准             | 通过条件                                                                                            | 验证人            |
| --- | ---------------- | --------------------------------------------------------------------------------------------------- | ----------------- |
| V1  | 工具卡全生命周期 | 入参流式→running→success/error 帧序列完整；upsert 后入参/输出不丢；reasoning 行可见                 | 自动化+e2e        |
| V2  | 审批闭环         | e2e：弹窗出现→deny(+理由)→弹窗消、行转 error、JSONL 留痕；重复 resolve=noop                         | e2e+审查          |
| V3  | 附件本地链路     | chip 回显→sendText 携带→历史重显；无路径附件走事务五法；真实数据落 `zs/attachments`；不喂模型假内容 | 自动化+真机半自动 |
| V4  | resume 与分页    | 四序列集成测绿；turn 中重订阅无重放无乒乓；rowsRange 到顶真实                                       | 自动化            |
| V5  | 无假入口         | 白名单外命令全 rejected+reasonCode；T6 未批不伪造 core 事件                                         | 审查              |
| V6  | 冻结纪律         | 六包零改 / core 仅批准窗口 / UI patch 仍 1 处                                                       | 编排者            |
| V7  | 测试与闸门       | 七包逐包绿不回退 + typecheck/lint 全绿 + 分支 CI 绿                                                 | 自动化+编排者     |
| V8  | 代码审查         | P0=0；P1 修后复验；P2 登记                                                                          | 独立子代理        |
| V9  | 用户真机         | 亲手：审批一轮、拖文件一轮、长会话上滚、（可选）粘贴图                                              | 用户              |

---

## 风险与降级

| 风险                                                                                     | 缓解                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 审批弹窗出现但 resolve 形状被 UI zod 拒（盘点不确定项④：result.resolvedBy 强制性未实测） | T2 第一步先真机 CDP 实测弹窗一次完整往返；被拒则按 zod 报错回推形状，禁止改 UI                  |
| resume 真续传改动引发 ZS2 双跑回归                                                       | T4 出口硬门 = runbook 双跑必须复绿后才算过                                                      |
| core elicitation 提案被否                                                                | 预设降级：T6 整体入 ZS4，不阻塞 T1-T5 交付                                                      |
| 附件真机项无法自动化（CDP 文件对话框/剪贴板）                                            | 如实登记 V9 半自动清单；事务五法用 service 层对拍兜底（上传状态机与 UI 传输层同 schema 直调）   |
| file mention chip 是否触达 IFileService 搜索面未核对（盘点不确定项③）                    | T3 顺路用 `createHarness2Services.ts:105-155` 的 ZS2_PROBE 实测一次，结论进执行记录，缺面归 ZS4 |
| 投影 Map 有界化误伤长会话                                                                | T4 常驻会话豁免 + 长会话（≥50 turns）集成测                                                     |

---

## 给接手 AI 的完整提示词（零上下文）

将下面整段粘贴给执行代理即可开工：

---

你是负责 **harness2** 的实现代理，执行 **ZS3 阶段**（对话区完整：工具卡保真/审批/附件/resume 分页）。完整执行，不要只写方案。

### 基线

- 目录 `D:/AI_Projects/harness2`；从 `main`（≥`c0d0d3e`）创建并切换 `feat/phase-zs3-conversation-parity`
- 唯一实施计划：`docs/ai-framework/plans/2026-10-21-phase-ZS3-conversation-parity.md`
- 必读：本计划 + ZS 总纲 + 映射详表 + 首帧契约 + **ZS2 计划执行记录**（尤其「假通过」拦截两案——验证纪律的出处）
- ZCode 源（**只读**）：`D:/AI_Projects/refs/ZCode`；scratch：`D:/AI_Projects/harness2-zs1-build/ZCode`（UI 零改动纪律延续）
- **环境**：cmd.exe 缺失 → pnpm 直调 `node "D:/.pnpm-store/v11/links/@/pnpm/11.13.0/d11795881783aa51f96a2d2a2c920d8e31138fac1136d44bf46998e29eab8385/node_modules/pnpm/bin/pnpm.mjs" ...`；起测试壳必须带隔离 env 三件套（值见 ZS1/ZS2 计划）；e2e 用 `scripts/zs2/run-e2e.ps1`（-Fresh）+ `scripts/zs2/e2e-round.cjs`（9229 CDP，实例锁定）
- **杀进程红线**：只杀 `ExecutablePath like 'D:\AI_Projects\harness2-zs1-build*'` 的 electron，严禁碰用户 `ZCode.exe`；旧壳 dev（packages/desktop）与测试壳共 9229，跑前确认无串台
- **测试缝分层**：默认 service 层直调 + 帧序列断言；e2e 只出口；每条 e2e 判据可区分失败段（exit 码语义延续 ZS2）

### 做

1. Task 0→5 顺序执行（T6 提案先行等编排者批准）；每 Task 真实证据后 commit（gitmoji+中文）。
2. T2 审批是本阶段心脏：动手前先在真实弹窗上做一次 CDP 往返实测（resolve 形状 zod 兼容性），再实现。
3. 白名单外命令一律 `rejected`——任何时候不得回假 accepted（红线⑩）。
4. core 只在 T6 且提案批准后动，一次一个加性点 + api-surface 基线同步。
5. 密钥不进 git；auth.json 只读；错误出口 redactSecrets。

### 不做

task 索引状态/侧栏批量删除、provider 写路径、会话中 setModel、workspaceHookReview、serve 子进程、修改 ZCode UI、修改 refs 仓、打包发版。

### 交卷

分支/提交列表、验收表自评（V1–V9）、e2e 真实输出+截图路径（`docs/screenshots/zs3/`）、core diff 审计结论（应为 T6 批准窗口或 0）、测试真实输出、P2×8 对账、残留风险。

现在开始：读完五份文档，从 Task 0 执行到最后（T6 到提案为止停下等验收）。

---

## 残留手工验收清单（V9，交用户）

1. 审批一轮：带权限工具跑一次，看弹窗、点 deny、确认行状态。
2. 附件一轮：拖一个文件进 composer，看 chip、发送、历史重显。
3. 粘贴图片一轮（T5 后）。
4. 长会话上滚分页一轮。
5. 提醒：测新壳时保持旧壳 `pnpm dev` 关闭（9229 共享）；「添加模型供应商」失败属预期（ZS4）。
