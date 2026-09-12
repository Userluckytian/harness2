# 开放事项索引(未关闭项) — harness2

> 规则：每天开工先读本文件掌握未完成事项；每天收工把当天仍未关闭的项同步进来，已关闭的移出。
> 状态：待处理 / 修复中 / 已修复待验证。已关闭项不在此文件，历史留在各日期日志。
> 元约定：`docs/issue-log/README.md`（AGENTS.md 强制遵循第 6 条）
> **已决策/已关闭事项：** 已关闭 / 已评估不修 / 已评估推迟 / 已知限制 / 口径登记 / 已被取代 等已决策事项，统一迁入 [`DECISIONS.md`](DECISIONS.md)（B1 只搬不删，保留原文与日期）。
> **本阶段（阶段 15 质量收口，2026-09-09）：** 总纲 [`2026-09-09-phase-quality-closeout.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout.md) · 验收表 [`…-acceptance.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md) · 审查任务书 [`…-review-brief.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md) · 执行者任务书 [`…-executor.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout-executor.md)
>
> **当前主方向（2026-09-08 用户确认）：采用 R2「Grok 终端复刻 + 功能优先桌面 harness」**，主流成为 `docs/ai-framework/plans/2026-09-08-phase-aggressive-{core-foundation,cli-interaction,desktop-interaction}.md`（共享底座 S0–S7 / 终端 T0–T5 / 桌面 D0–D6），依据 `docs/research/notion-ai-20260908-0056/`。原「09-07 终端 T0–T9 / 桌面 B0–B9 优化」与「阶段 13 交互复刻」方向已废止。
>
> **共享底座 S0–S7 ✅ 已完成（2026-09-08）**，验收不通过项已闭环（FixA–D）。
>
> **阶段 15 质量收口（2026-09-09）结论：⚠️ 有条件通过**（见验收表第 9 节）。本阶段范围内 A0/A1/A2自动化/A3/A4/B1/B2/B3/B4/B5-文档 已完成并独立验收；剩下**人类授权/真机项**如下表。

> ## 🔒 冻结公告：`packages/core` 与 `packages/gateway` 契约冻结（2026-09-11）
>
> - **冻结 commit：** `3c9b31f`（`✨feat(core): turn 终态文本语义 final/partial/empty 跨端定死（P3-a/P3-b）`）——地基补丁 P0–P4 中 `packages/core` / `packages/gateway` 的**最后变更点**；P4 只追加本公告文档，并以 `--no-ff` 将分支 `fix/foundation-patch` 合入 main（合并提交为该冻结提交之后第一个提交）。
> - **冻结范围：** `packages/core/**`、`packages/gateway/**`，含其对外契约：serve HTTP/WS 帧形状（`turn-end` 的 `finalText`/`partialText`/`textOutcome`）、serve 默认严格鉴权与一次性 token、`api-surface-baseline.json` 导出面快照。契约文本见 `docs/API-STABILITY.md`「跨端展示语义」节。
> - **生效时间：** 2026-09-11（合入 main 并推送后）。并行两轨分支已从冻结提交建立：甲 `feat/notion-i1-tui`（只动 `packages/cli`）、乙 `feat/notion-i1-desktop`（只动 `packages/desktop`）。
> - **解冻方式：** 只能由**编排者**在 main 上开独立小补丁窗口——新建 `fix/*` 分支 → 三平台 CI 全绿 → `--no-ff` 合入 main → 通知两轨各自 `git fetch && git merge origin/main`。两轨**不得**自行修改 core/gateway，也不得复制其逻辑绕过。
> - **越界信号：** `packages/core/test/fixtures/api-surface-baseline.json` 变化（冻结后不应变化）。
>
> **阶段级代码审查遗留（2026-09-11，非阻塞 P2）：** 独立只读子代理审 `47d5d30..ef4c315` → ⚠️ 有条件通过（无 P0/P1）。① 镜像类型 `textOutcome` 可选 vs core 必填 → 已在 `API-STABILITY.md` 明示（关闭）；② 桌面 WS `?token=` 边界 → 已在 `API-STABILITY.md` 如实声明（关闭）；③ 飞书 listen 失败未 close → 复核为非缺陷（二次 start 成功、无句柄泄漏）；④ `ad12a08` 单父却用 `🔀`、⑤ 合入文案与计划原文略有出入 → 历史不可改，登记。
> **A4/B3 拆分类审查（补阶段 15 欠账）：** ✅ 通过（无 P0/P1）；4 条设计建议（基类构造期虚拟派发、`export *` 通配、组件公共入口注释、命令级类型作用域）→ 登记为后续可选优化。
>
> **🔓 解冻窗口 #1（2026-09-11，已闭环）：B1 — gateway `ServeClient` 孤儿 WS 竞态。** 根因：`this.ws` 只在 `'open'` 回调里赋值、且该回调不检查 `this.closed`；`close()` 早于 `'open'` 派发时什么都关不掉，随后 `'open'` 又把这条 WS 记为活跃连接 → 服务端永远收不到 close（CI run #59 ubuntu `gateway-lifecycle` 3s 超时；生产含义＝`stop()` 之后仍有 WS 在回调 `onFrame`）。修法：`'open'` 首部加 `closed` 守卫并 `terminate()`；就绪 promise 挂 `void catch` 防 unhandled rejection；同步构造失败不再把 `readyPromise` 留成已拒绝值而永久阻塞重连。实测留痕：CONNECTING 期的 `terminate()` 只中止客户端请求、不释放底层 TCP（Node 22.23.1 / ws 8.21.3），故不能靠 `close()` 中止在途握手——已写入代码注释。窗口流水：`fix/gateway-serve-client-orphan-socket` → `1dd40d8`（+23/−2，新增回归 `test/serve-client-close-race.test.ts` 4 例，已验证修复前 3 例必红）→ CI run #61 三平台 test + 三平台 desktop build 全绿 → `--no-ff` 合入 main（`05c3cd7`）。`api-surface-baseline.json` 零改动（未越界）；gateway 用例 36 → 40，全量 1120 passed + 2 skipped。**两轨待办：各自 `git fetch && git merge origin/main` 后重跑 CI。**
>
> **🔓 解冻窗口 #2（2026-09-11，已闭环）：core 测试抖动屏障化 + steer 加性导出。** ① `packages/core/test/browser.test.ts` 并发上限用例原靠三个任务各 `sleep(120)` 互相重叠取峰值，CI windows 高负载时第二个任务在第一个 sleep 结束后才进入 → `expected 1 to be 2`（run #61 attempt1 唯一红）。改为本地 `deferred()` 屏障：前两个进入后卡在 gate 上，主体先确认「第三个进不来」（`entered` 仍为 2、`inFlight` 为 2）再放行，最后校验排队者确实被执行且全程峰值未破上限；变异验证：临时把 `maxConcurrent` 改为 3 → 用例立即红（`expected 3 to be 2`），证明断言非空转，随后已回退无残留。② `packages/core/src/index.ts` 加性导出 `./interaction/steer-sink.js`（steer 三步收敛第 1 步），并按 `docs/API-STABILITY.md` 流程（`H2_UPDATE_API_SNAPSHOT=1`）更新导出面基线，净增 `SessionSteerSink`(class) / `SteerSinkObserver`(interface) 两条，无删除/改名/种类变更。**此次 `api-surface-baseline.json` 变化由编排者在解冻窗口内按流程产生，属已批准变更，不是越界信号**；两轨 merge 后直接采用新基线，不得自行重生。窗口流水：`fix/core-flake-and-steer-export` → `a442f4b`（test 屏障化）+ `d7834c8`（加性导出）→ CI run #64 三平台 test + 三平台 desktop build 全绿（windows 亦绿）→ `--no-ff` 合入 main（`5aa1ff2`）。生产代码仅 1 行加性导出，全量 1120 passed + 2 skipped 不变，lint 0 error / typecheck 0。**steer 收敛第 2 步归甲 T 轨**：`packages/cli/src/steer.ts` 删 `CliSteerSink` 改从 `@harness2/core` 引入，仅留 `makeSteerId`/`buildSteerRequest`/`describeSteerResult`——该文件只存在于 `feat/notion-i1-tui`，main 上无此文件，故窗口内不跨轨改动。
>
> **两轨阶段级独立审查（2026-09-11）：** 甲 T 轨 ⚠️ 有条件通过（无 P0/P1，P2×3）；乙 D 轨 ❌ 不通过（P1-1 阻塞合入 + P2×4）。两份报告按 `.gitignore:13` 口径**不入仓、只留本机**（`b96fb71` 误提交的 `2026-09-11-review-T.md` 已由 `6fad1e0` 停跟踪，磁盘文件保留），结论摘要以下表为准。合入顺序：B1 入 main（已完成）→ 两轨 merge origin/main → CI 绿 → 先合 D（P1-1 修完）再合 T，每次合完 main 再跑一次 CI。
>
> **✅ 阶段 I1 两轨合入闭环（2026-09-12）：** 两轨修完后各自 `merge origin/main`，分支 CI 全绿（甲 #67 `4defd0a`、乙 #68 `eac21ee`）。编排者独立验收留痕：越界文件各 0、`api-surface-baseline.json` diff 各 0 行（冻结区未动）；乙本机六闸门全绿（core 844+2、gateway 40、desktop 304+1、cli 72，lint 0 error），**D 轨 P1-1 已做变异取证**——删掉 `assignToPane` 里新增的三行接线后用例必红（`expected 'A' to be 'B'`），恢复后复绿且工作树无残留，证明断言非空转。甲本机唯一红点为 `packages/cli/test/tui/undo-redo-shell.test.tsx` 的「共享 /help 文本同源」用例：满载 `pnpm -r test` 偶发失败，隔离复跑 3/3 绿、同 sha 的 CI 亦绿 → 定性为**测试侧计时假设、非生产缺陷**，经用户授权由编排者在 T 分支直接屏障化加固（`4e2c7a6`：回车后改 `waitFor` 等 `/undo`·`/redo` 真正落帧，断言内容不放宽，cli 全包 281 passed + 2 skipped）。合入：先 D（`a0686fb`）后 T（`6330f76`），两轨文件交集 0、`merge-tree` 预判无冲突。**仍待人工签收：** 甲的 IME/raw-mode/alt-screen 真机项与两行 `➖` 跳过项、乙的关窗口对话框真机项。

| 日期 | 事项 | 状态 | 详情 |
|------|------|------|------|
| 2026-09-11 | **D 轨 P1-1（阻塞合入）**：`SidePanel.tsx:26` 读 `state.selectedId`，而主路径 `controller.assignToPane` 不调 `store.select` → 六页签（对话/工具/审批/事件/文件/设置）数据源永不写入，分屏右侧恒为空。修法：`assignToPane` 内同步 `select` + `refreshAllViews` + `refreshAuthoritativeState`，并补一条接线用例锁住 | ✅ 已修复（乙 `cccfe38`；变异取证通过：删接线三行 → 用例必红 `expected 'A' to be 'B'`，恢复复绿无残留；已随 `a0686fb` 合入 main） | 本地 `2026-09-11-review-D.md` §7 |
| 2026-09-11 | **两轨 P2 下放清单（非阻塞）**：D=①cron 帧造 `undefined` 幽灵流 ②force 无去重且 `resumeSession` 渲染层零调用 ③草稿写盘非原子 ④模式切换按钮不落地（逼近「不摆可点击假入口」红线）；T=①`useTurnStream` 50ms timer 无 unmount 清理 ②E2E 兜底 key 字面量 ③无 `SIGTERM`/`SIGHUP` 恢复。另：redo 渲染层零入口、F7 故障注入、文件树 IPC、主进程关窗口对话框自动化测试 | ✅ P2 主体已结案（2026-09-12）：D=①`b6dd93f` ②`5220a33`（并补 `SidePanel` 「重新同步」真实入口，resume 不再是零调用死代码）③`3ea0b1b`（临时文件+rename 原子写）④`48fce5d`（真写全局配置并如实标注「当前会话不变、新会话生效」）；T=①`ae87f63` ②`c0162b0` ③`4defd0a`。**剩余未清**：redo 渲染层零入口、F7 故障注入、文件树 IPC、主进程关窗口对话框自动化测试 | 本地 `…-review-T.md` / `…-review-D.md` |
| 2026-09-11 | **CI windows 抖动（已闭环）**：`packages/core/test/browser.test.ts` 并发上限用例 `expect(peak).toBe(2)` 在 CI windows 高负载下取到 1（run #61 attempt 1 `AssertionError: expected 1 to be 2`）。已在**解冻窗口 #2** 改为 `deferred()` 屏障钉死峰值与排队（`a442f4b`；变异验证 `maxConcurrent=3` → 立即红），CI run #64 三平台全绿后 `--no-ff` 合入 main（`5aa1ff2`） | 已修复 | run #61 / #64 |
| 2026-09-11 | **CI 单点红掩盖其余包（由上行派生，新登记）**：`pnpm -r test` 在 core 失败即中断——run #61 attempt1 的 windows 作业里 gateway/cli/desktop 当次根本没跑到，单个抖动用例会掩盖其余三个包的真实状况。待定：是否改成分包 job（四个包并行，互不遮蔽）或加不早退开关；涉 `.github/workflows/ci.yml`，属编排者独占文件，不交两轨 | 待处理 | run #61 |
| 2026-09-09 | **B6 — v1.0.0 发布准备（逐项等人类授权，不得自行执行）**：①`npm view harness2` / `npm view @harness2/core` 包名占用检查（**只读，可先做**，结果告知人类）；②配置 `NPM_TOKEN` secret（人类操作，列出字段/步骤）；③推 tag `v1.0.0`（合并发布，跳过 0.1/0.3/0.6 独立 tag）；④push 远端（阶段 15 口径：只提交本地，push 待人类授权）。清单 = `docs/RELEASE-CHECKLIST.md`。**此项永不交子代理，等人类授权** | 待处理（需人类操作） | [2026-09-09.md](2026-09-09.md) |
| 2026-09-09 | **README 三张截图（真机项，图槽已就位）**：`docs/screenshots/{cli-chat,desktop-multi,traj-timeline}.png`（终端 chat 流式+工具行 / 桌面多会话分屏 / traj 时间线）。README 图槽结构与命名约定已就位（B5-13，`docs/screenshots/README.md`）。**图必须真实反映当前 UI，由人类真机运行后截取，不得用 AI 生成或占位图冒充**；补图后删除 README 顶部「截图区（待真机截图补入）」说明 | 待处理（需真机环境） | [2026-09-09.md](2026-09-09.md) |
| 2026-09-09 | **A2 桌面端真机一轮（验收表第 8 节·人类）**：桌面端接本地网关（`local-oai`/`local-ant`）走对话/流式/审批/undo 一轮真机体验 | 待处理（需真机） | 验收表第 8 节 |
| 2026-09-09 | **A2-2 云端厂商真机差异（➖，待 key）**：拿到 DeepSeek / 智谱 GLM / Anthropic 官方 key 后按 A2-1 同一份八项清单逐家跑，覆盖 reasoning 字段/限流/错误码/超长上下文/tool_calls 差异；**不得用本地网关或 stub 冒充** | 待处理（需 key） | 验收表第 7 节 / A-7b |
| 2026-09-09 | **cli 全量 spawn 型用例超时 flaky（环境）**：`crash-drill`/`export`/`memory` 在默认 5s 超时下因机器高负载（vmware-vmx 占 CPU）超时失败；`--testTimeout=20000~30000` 复跑全绿（17/71）。机器负载降后可回归默认超时观察 | 已知限制（非缺陷，记 B-6/B-9） | 验收表 B-6/B-9 |
| 2026-09-07 | **v1.0.0 发布动作待授权**（同上 B6，本行为历史登记，以 B6 为准）：①npm 包名占用检查；②配 `NPM_TOKEN`；③推 tag `v1.0.0`；④GitHub Pages 开启（**2026-09-07 已由 API 完成**）。**push 备份已授权** | 待处理（需人类操作） | [2026-09-07.md](2026-09-07.md) |
| 2026-09-06 | **阶段 9 真机联调清单**（待 QQ/飞书凭据）：auth.json.gateways 配 appId/appSecret → `harness2 gateway` → QQ 群 @bot/私聊 → 审批「1/2」→ 频率限制与 msg_seq 递增真机观察 → 飞书 webhook + verificationToken。**msg_seq 与 QQ token/心跳契约真机行为无法离线证明（A5 已如实声明）** | 待处理（需凭据 + 真机） | [2026-09-06.md](2026-09-06.md) §17 |
| 2026-09-06 | **阶段 5/6/8 真机/外部依赖**（其余真机与手工验收，合并见验收表第 8 节）：阶段 5 桌面 GUI 真机；阶段 6 真实模型记忆三态（A2-1 第 2 批已补本地网关口径，云端待 key）；阶段 8 真实 MCP/第三方插件（A2-1 第 3 批已补做）；阶段 10 段真实大会话导出/回放；阶段 11 bench 复核/doctor 实机/崩溃演练；阶段 3 真实端点验证；Windows Terminal 实机 REPL；nsis 安装包流程；桌面系统通知真机；阶段 9 真机联调 | 待处理（需用户环境/key/真机） | [2026-09-06.md](2026-09-06.md) 等 |
| 2026-09-06 | **CI 与 release 待远程验证**：`.github/workflows/ci.yml` 三平台 test matrix + build-desktop + `release.yml` 三平台产物（本地 YAML 已过校验），Actions 真实运行需远程仓库 + push 授权 | 待处理（需人类操作） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 审查 P2-3（剩余）：多进程并发追加、陈旧锁 TOCTOU、父目录刷新未实现 | 部分关闭（带入后续阶段） | [2026-09-06.md](2026-09-06.md) |
