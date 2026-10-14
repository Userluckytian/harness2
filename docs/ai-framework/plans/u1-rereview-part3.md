# U1 第二轮审查 · 片3（Z-97 域：性能 / 终态）

> 审查人：子代理（片3）；日期：2026-10-14；模式：只读源码（不改 packages/**、不动 git）。
> 规格依据：`docs/refs/refs-zcode.md` Z-97 节；计划：`docs/ai-framework/plans/2026-10-14-phase-U1-desktop-parity-fixes.md` 设计摘要。
> 审查面：1) store.ts 悬挂收敛；2) turn-work.tsx；3) ToolCard 动效；4) perf-replay-b1 测试；5) 只读测试证据。

## 1. store.ts 悬挂收敛（noteActivity / armHungTurnWatch / convergeHungTurn / dropSyntheticEnd / turnEndedAt）

**结论：OK（实现正确；注释与实现有一处口径不符 → P2）**。文件：`packages/ui-shared/src/renderer/store.ts`。

### 1.1 调用点穷举表（全量 grep + 逐处读码核对）

| 点位 | 函数 | 行号 | 语义 |
| --- | --- | --- | --- |
| 帧入口 | `applyFrame` → `noteActivity(stream)` | 701 | 任何有会话归属的帧（含随后被 seq 判重丢弃的 event，704 早退前已刷水位）；置 `lastFrameAt=Date.now()`（284）后对表 |
| markSending | `markSending` → `noteActivity` | 956 | 提交时刻 = 静默起点；此后 957 notify |
| delta 复活 | `applyFrame` delta 分支 → `dropSyntheticEnd` + `armHungTurnWatch` | 717-718 | running=true（714）后删合成、重挂表 |
| text/reasoning-delta | `applyFrame` → `dropSyntheticEnd(frame.turnId)` + `armHungTurnWatch` | 724-725 | 水位判重 return（734）前先摆正计时（注释 723） |
| turn-end 真帧 | `applyFrame` → `turnEnds[turnId]=`整体覆盖 + `turnEndedAt[turnId]=Date.now()` | 752-762 | 真终态对象替换（synthetic 一并消失）；running=false（764）、审批清空（768） |
| absorbEvent 翻转 | `user/message` → `armHungTurnWatch` | 937-940 | running 帧内翻转（入口对表见旧值），补挂表 |
| resume-snapshot | `applyResumeSnapshot` → `armHungTurnWatch` | 883, 887 | PD2 权威翻转 + P1-1 修复（断线重连补到的悬挂回合可收敛） |
| clearRunning | `armHungTurnWatch` | 966 | running=false → 291-295 clearTimeout 撤表 |
| removeApproval | `armHungTurnWatch` | 979 | P1-1：审批「让路」后清卡时刻重新对表（此刻起算静默） |
| 对表本体 | `armHungTurnWatch` | 289-309 | 先清旧定时器（291-294）→ running=false 撤表返回（295）→ `idle = now − (lastFrameAt ?? now)`（296）→ remain≤0 就地 `convergeHungTurn`（298-301，不 notify，由调用方负责）→ 否则挂**单次** setTimeout（302-308，回调先 delete 自身再按返回值决定 notify） |
| 收敛本体 | `convergeHungTurn` | 316-330 | running 假→false 短路（317）；**审批豁免**：`stream.approvals.length > 0` → 不合成不撤表（319）；写 `turnEnds[turnId]={stopReason:'interrupted',synthetic:true}` + `turnEndedAt[turnId]`（321-324，仅当该 turnId 无真终态）；清 running/live/liveAttemptId/activeAttempt（325-328） |
| 撤表（视图移除） | `removeSessionFromView` | 410-414 | P1-2：清 `hungTimers` 该项，防 ≤30s 窗口内对已删流触发合成 + 空转 notify |

`turnEndedAt` 读写：声明 121-127（与纯协议事实的 `turnEnds` 刻意分表）；初始 468；写 = 合成 323 / 真帧 762；读 = `chatItems` 注入 `TurnWorkContext`（633-636）→ `chat-model.ts:229` 算锁定 `workDurationMs`。

### 1.2 两竞态推演

- **真帧覆盖合成**：合成后真 turn-end 到达 → 752-760 对象整体赋值，`synthetic` 标志随对象替换消失；762 重写 `turnEndedAt`（锁定时刻=真终态到达，符合「完成态取协议事实」口径）；投影 `chat-model.ts:228` 复读 `end.synthetic` 为假 → 文案回「已工作/已停止」。✓ 两表归属推导同口径（均 `lastTurnId(stream.events)`：320 vs 750）。
- **合成后真 delta 复活**：delta（714-718）/text-delta（722-725）先到 `running=true`、再 `dropSyntheticEnd`（336 仅删 `synthetic===true` 记录，真终态永不误删）、再重挂全新 30s 表。UI 回「工作中」，起点仍取事件 ts（重放不重置）。✓ 若 turn 真已结束而服务端补发陈旧 delta 致复活，属事件流自身矛盾，store 无从分辨——可接受。

### 1.3 专项核对

- **审批豁免判据真实**：读的是 `SessionStream.approvals` 数组本体（78-88 声明，approval-request 786-799 增、resume-snapshot 871-880 权威替换、turn-end 768 清、removeApproval 975 滤）——真实结构，非臆造标志。豁免后「让路」语义（定时器到点返回 false、不重挂）成立的原因：后续收敛时机由三条真路补——①再有活帧（noteActivity 重挂）②removeApproval 重挂（979；若审批挂起期 WS 已死，lastFrameAt 陈旧 → 此刻**就地同步收敛**，正是同步收敛分支的真实可达场景）③turn-end 清卡+running=false。✓
- **每会话单计时器**：`hungTimers: Map<id, timer>`（277），arm 先 clearTimeout 旧项（291-294），回调自删（305），removeSessionFromView 撤表（410-414）。任意时刻每会话至多一个定时器。✓
- **lastFrameAt 缺省**：296 `?? Date.now()` → idle=0 → 挂满 30s 新表（缺省=「刚有活动」，绝不误即时收敛）。所有 running=true 路径（markSending/applyFrame 各分支）都先经 noteActivity 刷新水位，该兜底实际不可达，纯防御，方向正确。✓
- **同步收敛的 notify 责任**：6 个直调 arm 点位——applyFrame 分支内（701/718/725/887/940 同帧 825 notify）、clearRunning（967）、removeApproval（982）、markSending（957）均有 notify 覆盖。但见 P2-1（event 判重早退 704 路径）。

## 2. conversation/turn-work.tsx（tick 双门 / clearInterval / 锁值 / role=status）

**结论：OK**。证据（`packages/ui-shared/src/renderer/conversation/turn-work.tsx`）：
- tick 双门：`ticking = running === true && startedAt !== undefined`（:52）；effect 仅 ticking 时 `setInterval(..., WORK_TICK_MS=1_000)`（:20/:57），cleanup `clearInterval(id)`（:58），依赖数组 `[ticking]` → 终态翻转/卸载即停表，无常驻。
- 锁值不漂移：完成态走 `workDurationMs`（store 注入的 `turnEndedAt−startedAt` 派生值），文案「已工作 {formatWorkDuration}」；用例 b 钉「无 running 不起表、不随 tick 变」（`test/turn-work-duration.test.tsx:138`）。
- 无 ts 防御：startedAt 缺省 → ticking=false → 不渲染秒表（三态优先级末路，数据不足返回 null 路径见 :60-70）。
- memo/now 不入父链：`WorkIndicator = memo(...)`（:44），`now` 是内部 useState（:53）只重渲染本叶子；用例含父渲染计数断言（`parentRenders===1` 于 tick 推进时，见测试 17 例中渲染层组）。
- `role="status"` + `data-running`（:70）。

## 3. tool/ToolCard.tsx + styles.css（running 动效降级）

**结论：OK**。证据：
- `ToolCard.tsx` grep `animate-spin` = **0 命中**；运行态标题行挂 `.tool-running-shimmer`（测试正向钉 `tool-card-shimmer.test.tsx:20-27`：running 全卡无 animate-spin + 标题行有扫光类 + 图标静态；completed 恢复静态；failed 无扫光）。
- `styles.css:503-522`：`@keyframes harness-tool-running-shimmer` 只动 background-position（注释 :498 明示与 Z-92 `.reasoning-shimmer-text` 同源手法）；:525 起局部 `prefers-reduced-motion` 降级块（animation:none+还原继承色），另有全局 :447 兜底。**`.reasoning-shimmer-text`（:467-486）未被误动**（测试含反向钉：两 keyframes 独立）。

## 4. test/perf-replay-b1.test.ts（生成器钉死 / 中位耗时 / 投影断言）

**结论：OK**。证据（文件头注释 :2-18 + 实现）：生成器程序化构造恰好 1000 事件（seq 连续/ts 递增/step 配对完整），且**生成器自身有一条自证用例**（10000 临时流下该用例如期红，防「改了规模没改断言」型空转）；计时取 `performance.now`（126 `median()`）3 次中位数（防 GC 尖刺）+ `beforeAll` 50 事件预热（:135，防 JIT 冷启动）；断言 ≤250ms 且 `itemCount>500` 非空投影（实测 717）——预算与假绿双钉。实测登记：1000 事件中位 ~0.25ms；10000 数据点 ~2.33ms（线性，未改阈值）。

## 5. 测试执行证据（vitest 只读跑）

```
$ cd packages/ui-shared && ./node_modules/.bin/vitest run --maxWorkers=4
 Test Files  67 passed (67)
      Tests  723 passed (723)
```
（编排者 2026-10-15 07:4x 复跑；含 store-hung-turn 14、turn-work-duration 17、tool-card-shimmer 4、tool-running-shimmer-css 6、perf-replay-b1 2。）

## 结论与问题清单

**P0 = 0。P1 = 0。P2 = 2。**

- **P2-1（执行者审出 → 编排者复核改判：误报）**：执行者称 :701 noteActivity 在 :704 判重早退前、若触发同步收敛会漏 notify。**编排者独立核**：`noteActivity`（:283-285）先 `lastFrameAt = Date.now()` 再 arm → `armHungTurnWatch` 的 `idle = Date.now() − lastFrameAt ≈ 0`、`remain ≈ 30_000 > 0` → **该调用点永不可达 :298 同步收敛分支**（只能走 setTimeout 挂表，回调自带 notify）→ 所设场景不存在，判误报撤销。保留一条真纪律作 P2：`armHungTurnWatch` 的同步收敛分支「不 notify，由调用方负责」（:298-301 注释）依赖调用纪律，建议在该分支加断言式注释或改自带 notify（幂等无害）——纯防御，**不计入问题数**。
- **P2-2**：`WORK_TICK_MS=1_000` 与 ZCode `RUNNING_WORK_DURATION_TICK_MS=1000` 同值——口径登记即可，无需动作。

**总体判定**：Z-97 域（悬挂收敛/耗时行/扫光/微基准）实现与规格一致、竞态推演闭合、测试断言敏感（变异自证已由 T4a-d 各批留痕，本轮未重复执行变异以让位并行约束）。**P0=0 / P1=0 / P2=1（P2-2 登记项），无阻塞项。**
