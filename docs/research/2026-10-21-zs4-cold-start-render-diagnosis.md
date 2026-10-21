# ZS4 冷启动首轮发送不渲染——根因诊断报告（2026-10-21 深夜）

> **⚠️ 本报告初版（诊断代理）的「命令面板 landing 盖视图」主因判断被后续修复实证推翻。最终根因与证据链见文末 §修订。修复=`e22c24c`，双跑 exit=0。**

## 现象复述（编排者实测 4 组）

1. 冷启动 composer 发送 → 磁盘 JSONL 五事件完整（真实 MiniMax 回复）、host `sendConversationCommandV4 OK`、renderer `subscribe started/acknowledged/activated + store connect completed mode=snapshot`——但 `[data-testid^="v4-row-"]`=0、`chat-empty` 常驻、页面顶部「命令面板」视图。
2. 点侧栏任务行（`task-item-*`）→ 快照路径 rows=2 正常渲染。
3. 热态（会话已打开过）第二轮发送 → ROWS=4 正常增量渲染。
4. wipe fake-home 真·首启复跑同坏；pre-ZS4（`e9f7362` src 重建 bundle）亦同坏——但 ZS4 全部提交未触碰 agent-service/v4-projection/session-service，「同坏」只排除帧代码改动本身，不排除 ZS4 数据面变更引入的状态差异。

## 根因结论（诊断代理）

**主因 = 候选 A**：冷启动后 UI 激活视图是「命令面板 landing」而非会话视图；发送成功创建的会话没有让壳自动切回会话视图，DOM 上会话行自然为 0。Esc 关不掉（与 ZS1 观察「Esc 可关」不符——当时是 radix 遮罩 dialog，本次形态是视图级 landing，二者可能不同源，修复时需一并钉清）。

**次因 = 候选 B（加速器）**：突发帧下 ProxyChannel 有丢帧观测（adapter `emitToSession` N 次 vs renderer `handleFrame` 仅 3–4 帧），即使视图正确也会拖慢首帧；但非主因（点行快照路径全好）。

**候选 D**：`subscribeSessionsIndexV4` 全天 14 FAIL/0 OK = adapter 未实现该方法（factory 兜底 throw）。代理判与主故障无关——**存疑**，UI 的会话切换/侧栏实时性可能依赖此频道，修复阶段必须先查消费链再定（若 UI 靠 sessionsIndex 帧把新会话顶到前台，则 D 就是 A 的触发链）。

**候选 C**：adapter 单测同进程直调不经 ProxyChannel/Emitter = 覆盖缺口，登记为后续加固项，非根因。

## 修复边界（红线约束下的选项空间）

诊断代理原始建议含「改壳 landing/发送链路」——**违反 ZS4 Global Constraints #1（ZCode UI 零改动）**，不采纳原样。合规路径按优先级：

1. **adapter 实现 `subscribeSessionsIndexV4`**（若证实 UI 消费链依赖它触发视图切换/新会话上屏）——合法接线，本就欠实现。
2. **adapter 返回数据塑形**：readTree/tasks-index 影响 UI landing 状态（如 recent session、空树降级 landing）——查 ZCode renderer 决定 landing 的数据条件后对症。
3. **探针/runbook 适配**：冷启动发送后显式打开会话（模拟用户点行）——治标，仅当判定「命令面板 landing 是 ZCode 原生行为且真机用户会自然点进会话」时可接受。
4. 以上皆不通 → 上报编排者+用户决策是否破例 UI patch（ZS2 以来 patch 计数纪律：1 处）。

## 严重级

**P0**：冷启动首轮发送后用户看不到自己的消息与回复，核心对话流不可用；V9 真机必现，阻塞 ZS4 收口。

## 修复验证门（任一方案）

- `run-e2e.ps1 -Fresh` 双跑 exit=0（不靠点行兜底，若走方案 3 需同时有 adapter 侧证据说明真机可接受）。
- adapter 回归测试全绿 + 新行为有测试钉住。
- 六包冻结 diff=0 复验。

---

## §修订（编排者，修复实证后）

**最终根因 = 会话组目录分裂（工作区不匹配），非命令面板 landing。**

修复代理（cat-jam `agent_ea1d29de`，会话在 -Fresh 验证前中断）实际落下的改动 = `agent-service.ts` 两处 `manager.create(process.cwd())` → `manager.create(params?.workspacePath ?? process.cwd())`（`e22c24c`）。编排者独立复核其因果：

1. **机制**：`67ce1e4`（ZS3.5，16:05）给 `prepareSession` 返回 `ZCODE_DATA_BASE_DIR/.zcode/workspace/default`。冷启动 UI 先 `prepareSession` 得工作区 W，再 `sendText` → adapter `createSession` 却建在 **process.cwd()**（=desktop 包目录），会话落进错误组目录。UI 按 workspaceKey=W 订阅/投影，看不见这个会话（磁盘 JSONL 完整、host 一切 OK——正是「后端全成功 UI 空」的原因）；点侧栏行后 UI 按 taskId 直接订阅该会话才渲染出来。**命令面板只是当时可见的噪音，不是原因**（诊断代理把它当成了主因）。
2. **时间线闭环**：14:2x 双跑绿 = `67ce1e4` 之前（两侧都 process.cwd()，天然一致）；16:05 起潜伏；21:0x 冷启动实测必现。「pre-ZS4 bundle 同坏」因代理 checkout 的是 `e9f7362`（**已含** 67ce1e4 分裂）——当时解释不了的反常，如今自洽。热态正常 = 会话已在正确组里 resume。
3. **为何单测拦不住**：adapter 帧测试同进程直调、workspacePath 参参一致，不模拟 UI prepareSession→sendText 的双路径来源差异。**登记为测试缺口**（V8 复审项）：补一条「createSession 必须落在 sendText 携带的 workspacePath」的 service 层断言（已随修复可行：agent-service.test 已有 createSession→sendText 链，只差断言组目录）。
4. 诊断代理的候选 B（ProxyChannel 突发帧丢帧）与 D（subscribeSessionsIndexV4 未实现）仍为**未闭环观察项**：修复后 -Fresh 双跑 + 审批轮全绿说明即使存在也非 P0 阻塞；D 是诚实的未实现（factory throw），登记 ZS5+。

**门禁实测（修复后）**：`-Fresh` 双跑 exit=0（USER_ROW_SEEN + FINAL_REPLY 真实文本）；`-Fresh -Approval` exit=0（PERMISSION_OPTIONS 三选 → 拒绝 → DIALOG_CLEARED → DENIED_MARKER，顺带修了 approval-round 缺 composer 清空导致的草稿污染 `b93f73f`）；adapter 92 测绿 + buildAll 冒烟 OK。

**教训登记**：①诊断代理口头结论与实改不一致时必须以实改+独立复核为准；②探针留下的会话/草稿是 e2e 污染源，approval-round 补了清空，runbook 草稿清理口径（-Fresh）不含 AppData leveldb——已登记观察，必要时收紧；③修复代理中断留下的未提交改动，编排者接手前必须 `git diff` 全量审查，不得默认其为「正确方向」。
