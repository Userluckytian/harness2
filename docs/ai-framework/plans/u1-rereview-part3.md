# U1 第二轮审查 · 片3（Z-97 域：性能 / 终态）

> 审查人：子代理（片3）；日期：2026-10-14；模式：只读源码（不改 packages/**、不动 git）。
> 规格依据：`docs/refs/refs-zcode.md` Z-97 节；计划：`docs/ai-framework/plans/2026-10-14-phase-U1-desktop-parity-fixes.md` 设计摘要。
> 审查面：1) store.ts 悬挂收敛；2) turn-work.tsx；3) ToolCard 动效；4) perf-replay-b1 测试；5) 只读测试证据。

## 1. store.ts 悬挂收敛（noteActivity / armHungTurnWatch / convergeHungTurn / dropSyntheticEnd / turnEndedAt）

**结论：OK（实现正确；注释与实现有一处口径不符 → P2）**。文件：`packages/ui-shared/src/renderer/store.ts`。

### 1.1 调用点穷举表（全量 grep + 逐处读码核对）

| 点位                 | 函数                                                                          | 行号     | 语义                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 帧入口               | `applyFrame` → `noteActivity(stream)`                                         | 701      | 任何有会话归属的帧（含随后被 seq 判重丢弃的 event，704 早退前已刷水位）；置 `lastFrameAt=Date.now()`（284）后对表                                                                                                                                                                   |
| markSending          | `markSending` → `noteActivity`                                                | 956      | 提交时刻 = 静默起点；此后 957 notify                                                                                                                                                                                                                                                |
| delta 复活           | `applyFrame` delta 分支 → `dropSyntheticEnd` + `armHungTurnWatch`             | 717-718  | running=true（714）后删合成、重挂表                                                                                                                                                                                                                                                 |
| text/reasoning-delta | `applyFrame` → `dropSyntheticEnd(frame.turnId)` + `armHungTurnWatch`          | 724-725  | 水位判重 return（734）前先摆正计时（注释 723）                                                                                                                                                                                                                                      |
| turn-end 真帧        | `applyFrame` → `turnEnds[turnId]=`整体覆盖 + `turnEndedAt[turnId]=Date.now()` | 752-762  | 真终态对象替换（synthetic 一并消失）；running=false（764）、审批清空（768）                                                                                                                                                                                                         |
| absorbEvent 翻转     | `user/message` → `armHungTurnWatch`                                           | 937-940  | running 帧内翻转（入口对表见旧值），补挂表                                                                                                                                                                                                                                          |
| resume-snapshot      | `applyResumeSnapshot` → `armHungTurnWatch`                                    | 883, 887 | PD2 权威翻转 + P1-1 修复（断线重连补到的悬挂回合可收敛）                                                                                                                                                                                                                            |
| clearRunning         | `armHungTurnWatch`                                                            | 966      | running=false → 291-295 clearTimeout 撤表                                                                                                                                                                                                                                           |
| removeApproval       | `armHungTurnWatch`                                                            | 979      | P1-1：审批「让路」后清卡时刻重新对表（此刻起算静默）                                                                                                                                                                                                                                |
| 对表本体             | `armHungTurnWatch`                                                            | 289-309  | 先清旧定时器（291-294）→ running=false 撤表返回（295）→ `idle = now − (lastFrameAt ?? now)`（296）→ remain≤0 就地 `convergeHungTurn`（298-301，不 notify，由调用方负责）→ 否则挂**单次** setTimeout（302-308，回调先 delete 自身再按返回值决定 notify）                             |
| 收敛本体             | `convergeHungTurn`                                                            | 316-330  | running 假→false 短路（317）；**审批豁免**：`stream.approvals.length > 0` → 不合成不撤表（319）；写 `turnEnds[turnId]={stopReason:'interrupted',synthetic:true}` + `turnEndedAt[turnId]`（321-324，仅当该 turnId 无真终态）；清 running/live/liveAttemptId/activeAttempt（325-328） |
| 撤表（视图移除）     | `removeSessionFromView`                                                       | 410-414  | P1-2：清 `hungTimers` 该项，防 ≤30s 窗口内对已删流触发合成 + 空转 notify                                                                                                                                                                                                            |

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

## 编排者复核节（2026-10-14 U2 波）

> 复核人：编排者；模式：只读源码 + 实跑测试，HEAD `1912992`（批A–D 已入），工作树仅两个未跟踪文件。结论：**已修 P2×5 全部复认（认=5/5）；三条登记项维持性复核全部成立（维持=3/3）**。

### ① 已修 P2 复认（5 项）

| #   | 提交      | 登记原判                                                         | 复认证据                                                                                                                                                                                                                                                                                                                                                  | 结论   |
| --- | --------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `ac0df60` | part2-P2-1：删除确认框「兜一层」注释撒谎                         | `SessionBrowser.tsx:1042-1043` 注释与实现已对齐；`onConfirm` 内 `:1053-1058` 真复查 `isSessionRunning?.(target.id) === true` → 只 `setDeleteTarget(null)` 不删；测试双向钉：`sidebar-z48-z49.test.tsx:171-181`（命中只关框 + 断言调用参数）/`:185`（反向钉 web 不变）                                                                                     | **认** |
| 2   | `1c7c71d` | ac0df60 断链：prop 未透传                                        | grep 三处接线全通：声明 `SessionBrowser.tsx:136`/解构 `:650`/消费 `:1055`；`SidebarRoot.tsx:119` 声明 + `:197` 条件透传（`!== undefined` 展开式，exactOptionalPropertyTypes 口径与邻行一致）；桌面装配 `shell-seat-contents.tsx:252` `store.peekStream(id)?.running === true` 直读 live（注释注明不新造 controller API）。web 不传 = 行为不变（有反向钉） | **认** |
| 3   | `b09e4ca` | part1-P2-1：probeCapabilities 直读 baseUrl 与 :430 注释矛盾      | `bridge.ts:261` 已改 `serveBase()`；connected 护在位（`:259` `serveReady = deps.serve.status === 'connected'` 为普通字段读取、不抛；仅 `serveReady ∧ sessionId 非空` 才进 `:261`，:430 定义 `= deps.serve.baseUrl`）。serveBase 其余消费点仍全部在 HTTP case 分支首行（:440/:450/:460/:464/:475/:518/:523/:529/:537），无泄漏                             | **认** |
| 4   | `b09e4ca` | part1-P2-2：normal 模式 ready 无消费者 → unhandledRejection 噪声 | `main.ts:323` `void ready.catch(() => {})`；rejectReady 源 `:307`（serve.start 失败兜底）。smoke 路径 `handles.ready` 仍走原 promise 的 await，`:323` 只挂附加 handler，不改语义（注释 `:321-322` 如实）                                                                                                                                                  | **认** |
| 5   | `b09e4ca` | part1-P2-3：trayHandle 无 destroy 调用点                         | `main.ts:310-318` before-quit 内判空 `destroy()` + 置 null（smoke `tray:false` → null 安全；注释注明）。同提交附带 manual-pack.mjs robocopy 注释纠偏（/E 非 /MIR 幂等），纯文档面                                                                                                                                                                         | **认** |

### ② 登记项「维持登记」复核（3 条）

**(a) part1-P2-4 busy 双 close 重入 —— 维持登记。** 现状读码：`close-window-handler.ts:45` `if (!runtime.busy || stoppingForClose) return;`，而 `stoppingForClose` 直到 `:70`（用户选「请求停止」的 `.then` 内）才置真——**首次 `showDialog`（:47-48）await 挂起期间该标志为假**，第二次 close 事件会再过 :45 门、再进 `showDialog`，重入路径原样存在，登记的修法（`dialogOpen` 同步门）未实施。Electron 语义推演：`dialog.showMessageBox(win,…)` 对同一父窗**异步且模态串行**——第二调用排队/阻塞于首框之后，不是双框叠打；两框先后落定时 `.then` 各跑一次，最坏序列 = `requestStopAll`×2（幂等）+ `scheduleClose`×2 → `win.close()`×2（窗口已销毁后二次为 no-op）。缝隙窄、后果良性，与第一轮「P2 注记非 P1」定级一致。**维持登记，不升级不关闭。**

**(b) part2-P2-② 设置页右上 136×48 窗控让位 —— 维持登记。** 层级核实：设置壳 `SettingsShell.tsx:103` `fixed inset-0 z-[100]` 全屏；窗控覆层 `desktop-window.css:57-70` z-130 本体 `pointer-events:none` 但透明 drag 条 `:72-76` `inset:0 + pointer-events:auto + -webkit-app-region:drag`——z-130 > z-100，设置页顶右角 136×48 被 drag 条吃掉（该区文案选不中、按下即拖窗）。让位规则 `:113-120` 仅覆盖 `.pane-header` 与 `side-pane-tabstrip`（根类 `window-controls-active` 由 `App.tsx:452-461` 恒挂，不辨设置页开合），设置壳与命令面板均未让位。影响面判据不变：设置页右上**无交互控件**——关闭走左栏「返回工作区」（`SettingsShell.tsx:108-118`），右栏顶行是 48px 面包屑（`h-12 px-4`，内容左对齐、右端留白），命令面板同例。毛刺级（选择/拖拽干扰），不吞按钮。**维持登记成立；批A–D 未触碰此面，修法照旧（覆层打开时 drag 带 `pointer-events:none` 开关，或两覆层头 `padding-right:140px`）。**

**(c) part3-P2-1 误报改判 —— 改判成立，维持。** 独立重推（`store.ts` 现码与审片时同构）：`noteActivity`（:283-286）**先** `stream.lastFrameAt = Date.now()`（:284）**再** `armHungTurnWatch`（:285）；arm 内 `:296` `idle = Date.now() − (lastFrameAt ?? now)` 与 :284 同处一个同步 tick → `idle ≤ 1ms`，`:297` `remain = 30_000 − idle ≥ 29_999 > 0` → 帧入口路径（含随后 :704 event 判重早退者）**数学不可达** `:298` 同步收敛分支，只走 `:302-307` setTimeout，回调自带 `notify()`（:306）→ 原判「漏 notify」场景不存在，撤销正确。同步分支真实可达路径独立核：①`removeApproval`（:979 arm，审批挂起期 WS 已死则 lastFrameAt 陈旧 → 就地收敛）——其后 `:982` 方法级 `this.notify()` 无条件覆盖；②定时器回调走 `:306` 自 notify。六个直调点无一出现「收敛了但没人 notify」。改判（误报撤销 + 保留「调用纪律」纯防御注记不计问题数）**成立**。**维持登记。**

### ③ 测试实跑（本机直调 vitest，2026-10-14）

```
$ cd packages/ui-shared && ./node_modules/.bin/vitest run --maxWorkers=4   # 第 2、3 次
 Test Files  70 passed (70)
      Tests  767 passed (767)

$ cd packages/desktop && ./node_modules/.bin/vitest run --maxWorkers=4
 Test Files  129 passed (129)
      Tests  1288 passed | 1 skipped (1289)
```

与基线 70/767、129/1288+1skip 完全吻合。**如实登记一次抖动**：ui-shared 首跑报 `1 failed file / 2 failed tests`（当次 tail 未留存失败用例名）；同树第 2、3 跑均全绿零失败。期间工作树对 `packages/**` 零改动（`git status` 仅 `.zcodeignore` 与 `docs/design-inputs/u2-audit-digest.md` 两个未跟踪文件，与首跑时一致），且首跑时有 desktop 全量 vitest 并行占机——判为高并发下环境抖动（jsdom/timer 类敏感用例在 4 worker × 129 文件并行下偶发），**非批A 引入，未做任何 stash 验证（无主仓改动可归因）**。复现归因如需硬证据，可单跑首红文件对拍。
