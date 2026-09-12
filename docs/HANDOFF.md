# HANDOFF — 交接入口（新维护者/AI 从这里开始）

> 更新：2026-09-12（**阶段 I1 交互复刻双轨（甲 CLI/TUI · 乙桌面）已各自独立验收并按 D→T 顺序 `--no-ff` 合入 main**；解冻窗口 #1/#2 均已闭环；CI `test` job 改为分包独立步骤，单点红不再掩盖其余包；两条轨道分支已删，本地与远程仅剩 `main`） · 2026-09-11（地基补丁 P0–P4：网关双会话/挂死/测试缺口、serve token 三端贯通与默认严格、401 误判健康、playwright 降级、锁文件权限、turn 终态文本语义已全部闭环，`packages/core` 与 `packages/gateway` 契约冻结） · 2026-09-09（阶段 15 质量收口进行中：A0/A1/A2 自动化/A3/A4/A5 与 B1–B4 已落地——Windows P0 修复、本地网关真机验证、serve 安全加固、大文件拆分、lint/format 基建、规范文档；阶段 9 复审已补；B5 文档部分完成、README 三图与 B6 发布另待） · 本文件是唯一交接入口，保持与实际状态同步。

## 0. 🔒 冻结公告：core/gateway 契约冻结（2026-09-11）

- **冻结 commit：** `3c9b31f`（`✨feat(core): turn 终态文本语义 final/partial/empty 跨端定死（P3-a/P3-b）`）——地基补丁 P0–P4 中 `packages/core` / `packages/gateway` 的**最后变更点**；`fix/foundation-patch` 以 `--no-ff` 合入 main，合并提交为该冻结提交之后第一个提交。
- **冻结范围：** `packages/core/**`、`packages/gateway/**`（含 serve HTTP/WS 帧形状、默认严格鉴权 + 一次性 token、`turn-end` 的 `finalText`/`partialText`/`textOutcome` 展示语义、`api-surface-baseline.json` 导出面快照）。契约文本：`docs/API-STABILITY.md`「跨端展示语义」节。
- **生效时间：** 2026-09-11。**冻结仍然有效**：`packages/core` / `packages/gateway` 的公开契约不得在并行轨中改动。
- **并行两轨状态（2026-09-12 更新）：** 甲 `feat/notion-i1-tui`（只动 `packages/cli`）、乙 `feat/notion-i1-desktop`（只动 `packages/desktop`）均已独立验收，按 D→T 顺序 `--no-ff` 合入 main（`a0686fb` / `6330f76`），两条分支本地与 origin 均已删除。
- **已用解冻窗口：** #1 `fix/gateway-serve-client-orphan-socket`（gateway 竞态 B1：`1dd40d8` → `05c3cd7`，CI #63 绿） · #2 `fix/core-flake-and-steer-export`（core 并发上限用例屏障化 + `SessionSteerSink`/`SteerSinkObserver` **加性**导出：`a442f4b`+`d7834c8` → `5aa1ff2` / `34354d2`，CI #64/#66 绿；加性变更经批准，基线 493 → 495）。
- **解冻方式：** 只能由**编排者**在 main 上开独立小补丁窗口（`fix/*` 分支 → 三平台 CI 全绿 → `--no-ff` 合入 main → 通知两轨`git fetch && git merge origin/main`）。两轨不得自行改 core/gateway，也不得复制逻辑绕过。
- **越界信号：** `packages/core/test/fixtures/api-surface-baseline.json` 变化。

## 1. 项目一句话

**harness2**：自研跨端 AI agent harness（CLI / 桌面 / IM 网关多形态），TypeScript monorepo。对标 opencode / hermes / deepseek-harness / grok（调研见 `docs/research/`）。

## 2. 当前状态快照

| 项                                          | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认分支                                    | `main`（**唯一分支**，2026-09-07 确立：从 master 平移建立后，应用户要求删除了 master 与全部 feat/phase-* 分支——内容零丢失，12 阶段全部包含于 main。历史文档提及 master/feat/phase-* 的均指已并入 main 的历史）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 开发分支                                    | `main` 已含阶段 15 与**地基补丁 P0–P4 冻结提交 `3c9b31f`**（阶段 I1 两轨已合入：D 轨 `a0686fb` → T 轨 `6330f76`，随后两条分支本地与 origin 均已删除；此前各阶段 feat/phase-* 分支同样并入 main 后删除。2026-09-12 起本地与远程**仅剩 `main`**，当前 HEAD `cfde184`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 阶段 1–12                                   | ✅ 全部完成（内核 → loop+工具 → Provider+配置 → CLI chat+undo/redo → 服务化+桌面 → 记忆+分叉 → 浏览器+压缩+cron[M2] → 插件+MCP+subagent → QQ/飞书网关 → 轨迹导出/回放+Skills[M3] → 稳定化+分发 → **v1.0.0 收口**：API 导出面快照 + API-STABILITY semver 政策 + MIGRATION + docsify 文档站 + RELEASE-CHECKLIST + 版本物料 1.0.0）；各阶段独立审查/验收记录见 plans 与 issue-log                                                                                                                                                                                                                                                                                                                                                                       |
| 阶段 13–14（R2）                            | R2 方向 2026-09-08 确立（Grok 终端复刻 T0–T5 + 功能优先桌面 D0–D6，原「交互复刻 CodexMonitor」方向废止并删除计划）；**共享底座 S0–S7 已实现、独立验收通过并合并 main**（验收时点 789 passed + 1 skipped，记录见 issue-log 2026-09-08；含 runtime.v1.jsonl 运行账本、submit/resumeSubscription/approval/cancel/task/steer 契约、protocolVersion=2、任务协调器）；激进-终端/激进-桌面计划已就绪（`plans/2026-09-08-phase-aggressive-{core-foundation,cli-interaction,desktop-interaction}.md`）→ **已于 2026-09-11/12 以并行双轨执行完毕**（见下「阶段 I1（交互复刻双轨）」行）                                                                                                                                                                        |
| 阶段 15（质量收口）                         | 🔶 **进行中**（2026-09-09）：A0 仓库卫生+基线 ✅ · B1 OPEN.md 拆分 ✅ · B2 lint/format 基建+CI+全量格式化 ✅ · A1 Windows 可用性 P0 ✅（自动化全绿；真机联网检索待 A2 环境）· A2 本地网关真机验证 🟡（八项中自动化批次全过；桌面端真机 🟡、云端厂商 A2-2 ➖ 待 key）· A3 serve 安全加固 ⚠️ 有条件通过（2 个 P1 发布前必闭环，见 acceptance 第 6 节）· A4 sessions.ts 拆分 ✅（71862B→2844B）· B3 cli/desktop 拆分 ✅ · B4 规范文档补齐 ✅ · A5 阶段 9 网关独立复审 ⚠️ 有条件通过（3 个 P1 下放）· B5 文档与验收欠账 🟡（文档部分完成：形式验收补记/复审归位/本文件/diary；README 三图另处理）· B6 发布准备 ⬜ 待人类授权。**唯一计划** `plans/2026-09-09-phase-quality-closeout.md`                                                                  |
| **地基补丁 P0–P4**                          | ✅ 已闭环（2026-09-11，`fix/foundation-patch` → `ad12a08`）：网关双会话/挂死/测试缺口、serve token 三端贯通与默认严格、401 误判健康、playwright 降级、锁文件 POSIX 0600、turn 终态文本语义；末点 `3c9b31f` 即契约冻结提交。计划 `plans/2026-09-11-phase-foundation-patch.md`（由独立第三人执行，两轨等待期间只读预研）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **阶段 I1（交互复刻双轨）**                 | ✅ 已验收并合入 main（2026-09-12）。**甲 = 终端 T0–T5**（只动 `packages/cli`：steer 边界收窄 113→45 行、`useTurnStream` timer 卸载清理、`SIGTERM`/`SIGHUP` 退出码 143/129、本地统一网关 E2E；链尾 `4defd0a`）；**乙 = 桌面 D0–D6**（只动 `packages/desktop`：修掉阻塞级 P1-1「`assignToPane` 不调 `store.select` → 分屏右侧六页签数据源永不写入」并做变异取证、草稿原子写、模式切换真落盘、resume 补真实入口；链尾 `eac21ee`）。两轨文件交集 0、越界文件各 0、基线 diff 各 0；合入前后 CI #67/#68/#70/#71 均绿。T 轨一条 `/help` 计时假红经授权由编排者屏障化加固（`4e2c7a6`）。**仍待人工签收**：甲的 IME/raw-mode/alt-screen 真机项与两行 `➖` 跳过项、乙的关窗口对话框真机项                                                                      |
| 阶段 9 特别说明                             | 独立审查曾判 **fail**（P0 网关聋哑 + 7 P1，审查引用 QQ 官方文档纠偏），修复落地（`fb837bb`）后全量绿；**复审已补：有条件通过**（阶段 15 A5，2026-09-09——startGateway 生命周期/断线重连重订阅/msg_seq 递增三关注点核心行为正确，`pnpm --filter @harness2/gateway test` 5 files / 14 passed 与基线一致；3 个 P1 已下放，见 acceptance 第 6 节；四段结论归位见 `plans/2026-09-06-phase-9-im-gateway.md` 顶部）                                                                                                                                                                                                                                                                                                                                          |
| **M1 v0.1 / M2 v0.3 / M3 v0.6 / M4 v1.0.0** | 🔶 代码/物料全部就绪（四包版本已升 **1.0.0**）；发布动作待人类操作：`Userluckytian/harness2` 已授权 push、npm 包名占用检查、`NPM_TOKEN` secret、推 tag `v1.0.0`（合并发布，跳过 0.1/0.3/0.6 独立 tag）——**Pages 已开启并随 main 自动部署**，清单见 `docs/RELEASE-CHECKLIST.md` ③ 与 OPEN.md                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 未关闭事项                                  | 读 `docs/issue-log/OPEN.md`（保持为零上下文第一读；含 v1.0.0 发布动作、真实 key/真机类手工清单）。当前剩余分三类：①**只有人能做**——README 三张真机截图（B-13）、桌面端真机一轮（A2-1 第 6 项）、云端厂商 key 一轮（A2-2）、甲的 IME/raw-mode/alt-screen 与乙的关窗口对话框真机项、§8 六项手工清单；②**发布动作**——B6（npm 包名占用检查、`NPM_TOKEN`、tag `v1.0.0`）；③**技术小尾巴（编排者可包掉）**——`packages/core/vitest.config.mts` 的 `include` 未含 `.tsx`（漏跑风险）、node20 actions 余项（`upload-artifact@v4`/`configure-pages@v5`/`deploy-pages@v4`/`download-artifact@v4`）、46 个 lint warning、redo 渲染层零入口、F7 故障注入、文件树 IPC、主进程关窗口对话框自动化测试、三处提交语义瑕疵（`5a5984d`、`ad12a08`、`f79bb23`，不改历史） |
| 测试                                        | `pnpm test`（= `pnpm -r build` + 四包 vitest，**2026-09-12 合入后 main 实跑**）—— **core 844 passed + 2 skipped（61 files）+ desktop 304 + 1 skipped（36）+ gateway 40（14）+ cli 281 + 2 skipped（41，包名 `harness2`）= 1469 passed + 5 skipped（152 files）**，exit 0；lint 0 error / 46 warnings；typecheck 0；cli spawn 型用例 testTimeout 30s（阶段 15 R8 落地）。根脚本 `test`/`typecheck` 自 2026-09-12 起带 `--no-bail`（首个失败包不再中断其余包）。历史：1116 + 2（地基补丁 P4）· 1032 + 1（阶段 15）                                                                                                                                                                                                                                     |
| API 稳定承诺                                | `docs/API-STABILITY.md`（1.0 起 semver：breaking 只进 major；导出面快照测试，基线 fixture 随导出变更同步更新——更新命令见该文件）。当前基线 fixture 为 **495 导出**（解冻窗口 #2 加性 +2：`SessionSteerSink`、`SteerSinkObserver`；此前地基补丁 P3 加性 +2 至 493：`TurnTextOutcome`、`enforceLockFileMode`；历史写 491 / 489 / 372 均为旧口径）                                                                                                                                                                                                                                                                                                                                                                                                      |
| 性能基线                                    | `pnpm bench`（10 万事件合成日志，可复跑）——全部操作 <1.5s，无 >3s 痛点；预算表见 architecture.md「性能预算」节                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 远程                                        | `origin → github.com/Userluckytian/harness2`（public）。**2026-09-11 起 push 已获用户授权**，`main` 与 `origin/main` 同步（当前 `cfde184`，337 次提交）；GitHub Actions 已真实运行且稳定全绿（最新 run #73 七 job），Pages 站点已开：https://userluckytian.github.io/harness2/ 。**仍待人类**：npm 包名占用检查、`NPM_TOKEN` secret、推 tag `v1.0.0`                                                                                                                                                                                                                                                                                                                                                                                                 |

## 3. 文档地图（按阅读顺序）

1. `AGENTS.md` —— 协作规范入口：工作模式（编排者/子代理分工）、强制遵循、提交规范
2. `docs/ai-framework/workflow-delegation.md` —— 角色/流程细则（每阶段标准流程、验收规则、交接要求）
3. `docs/MASTER-PLAN.md` —— **总控计划**（里程碑 M1–M4、阶段 Ph2–Ph12、横切线）——批准后为全局实施依据
4. `docs/ROADMAP.md` —— 26 项功能清单 + 架构决策 D1–D6 + 明确不做
5. `architecture.md` —— 技术栈与核心不变量（阶段 3 起：含 Provider 缝 / Agent loop / 工具系统 / 配置体系小节）
6. `docs/API-STABILITY.md` —— API 稳定承诺（semver 政策 + 导出面快照更新流程）
7. `docs/MIGRATION.md` —— 迁移指南（0.6→1.0 零迁移 + 演进索引）· `docs/RELEASE-CHECKLIST.md` —— 发布回归汇总（发布动作清单在 ③）· `docs/SMOKE-TEST.md` —— **冒烟测试手册**（三种启动入口 + 36 条手工用例 + 期望结果；命令面取自 `--help` 实测与源码）
8. `docs/ai-framework/plans/` —— 阶段计划（每份含零上下文交接提示词）。**当前阶段 15 四件套**：`2026-09-09-phase-quality-closeout.md`（唯一计划：背景/执行顺序/12 任务/全局约束）、`…-closeout-acceptance.md`（验收与证据登记表，进度以它为准）、`…-closeout-review-brief.md`（专职审查者任务书）、`…-closeout-executor.md`（执行者提示词）。**阶段 I1（已完成）的双轨计划**：`2026-09-08-phase-aggressive-cli-interaction.md`（甲/终端轨）、`2026-09-08-phase-aggressive-desktop-interaction.md`（乙/桌面轨）、`2026-09-11-phase-foundation-patch.md`（地基补丁 P，独立第三人执行）——三份均含并行边界表与零上下文交接提示词
9. `docs/diary/YYYY-MM-DD.md` —— 每日日志（发版 release note 素材）
10. `docs/issue-log/` —— 问题日志（README 约定 + OPEN.md 未关闭索引）
11. `docs/research/2026-09-06-reference-analysis.md` —— 四参考项目实证调研

## 4. 如何继续开发（标准循环）

```
读 AGENTS.md + workflow-delegation.md
→ 读 OPEN.md 掌握未关闭项
→ 读下一阶段计划（docs/ai-framework/plans/）
→ 编排者派实现代理（用计划文末的交接提示词）
→ 编排者派只读审查代理 → P0/P1 修复 → 编排者验收（重跑证据）
→ 更新：计划状态 / ROADMAP / diary / issue-log / 本文件快照
```

## 5. 关键决策（详见 ROADMAP D1–D6）

- TS/Node ≥22 + pnpm monorepo；Electron+React 桌面（P1）
- 会话 = append-only JSONL 事件日志（唯一事实源，Model-visible ⟺ logged）；SQLite 只做索引（后期）
- 撤回/分叉 = 同一日志上的投影操作（undo 为主、fork 为辅、grok 三模式为增强）
- 自研轻量插件总线，不引 Cordis；文件快照不依赖 git
- QQ 机器人走官方 Bot API v2（用户已注册）；不做个人号逆向

## 6. 环境与命令

- Node ≥22（实测 v22.23.1）、pnpm 11（实测 11.13.0）、Windows + Git Bash
- `pnpm install` → `pnpm test`（= build + test）→ `pnpm -r typecheck`
- 试轨迹：`node packages/cli/dist/index.js traj packages/core/fixtures/demo-session`（阶段 1 手写样例）；`node packages/cli/dist/index.js traj packages/core/fixtures/loop-demo`（阶段 2 agent loop 实跑生成的会话）
- 查配置：`node packages/cli/dist/index.js config check`（`--root`/`--home` 可重定向路径；key 来源只显示 auth.json / env:XXX / **missing**，不显示明文）
- **服务冒烟（阶段 5）**：`node packages/cli/dist/index.js serve --port 0 --provider mock`——stdout 一行 JSON 端口 → `curl http://127.0.0.1:<port>/api/sessions` / WS `ws://127.0.0.1:<port>/ws`
- **桌面冒烟（阶段 5）**：`pnpm --filter @harness2/desktop smoke`——无头冒烟输出 `{ok,port,rendererLoaded,bridgeReady}`；打包后 `packages/desktop/release/win-unpacked/harness2.exe --smoke` 同样可验；GUI 交互（拖拽手感/多会话实机体验）待真机
- **chat 冒烟（阶段 4）**：`node packages/cli/dist/index.js chat --provider mock --root <临时目录>`——演示 write+read 两轮工具 → `/undo --dry-run` → `/undo`（创建的文件被删）→ `/redo`（内容回放）→ `/sessions` → `/exit`
- **记忆冒烟（阶段 6）**：config 写 `"memory": {"mode":"auto"}` 后 `harness2 chat` 让模型记一条偏好 → `harness2 memory show` 查看；改 `"mode":"ask"` → 让模型记忆 → `harness2 memory pending` → `approve <id>` 落盘；`off`（缺省）时模型看不到 memory 工具
- **插件/MCP/subagent 冒烟（阶段 8）**：①插件：把样例插件放 `~/.harness2/plugins/<name>/`（manifest + ESM index.js）→ `harness2 plugin list` 看权限清单 → `plugin enable <name>` 确认 → config `plugins.allow` 出现该名 → chat/serve 重启后工具可调；②MCP：config 写 `"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}}` → `harness2 mcp list` 探测连接与工具数 → chat/serve 里出现 `mcp__filesystem__*` 工具；③subagent：mock REPL `harness2 chat --provider mock` 让模型派子任务（或真实模型说"派子代理去做 X"）→ 工具行 `subagent_start` → 子会话独立 traj（桌面端工具行「子会话 ↗」跳转）
- **分叉冒烟（阶段 6）**：`harness2 chat --fork <id>`（或 REPL `/fork [seq]`）→ banner 标血缘与复制事件数 → 原会话零改动（traj 对比）；serve 模式 `POST /api/sessions/:id/fork` / WS op `fork`
- **导出/回放/Skills 冒烟（阶段 10）**：①`harness2 export <会话目录>` → 当前目录得 `<sessionId>.zip`（再跑一次字节数一致=幂等）；②`harness2 replay <zip>` → 主会话/子会话投影摘要（events/messages/lastSeq/badLines）；③把带 frontmatter 的 .md 放进 `.harness2/skills/` → `harness2 skill list` 出现（[project] 标注）→ chat 里 system 注入「[Skills 可用]」列表、模型可 `skill` 工具取全文
- **性能基线（阶段 11）**：`pnpm build && pnpm bench`——10 万事件合成日志六项操作耗时表（`H2_BENCH_EVENTS`/`H2_BENCH_SEED` 可调）；对照 architecture.md「性能预算」节
- **doctor（阶段 11）**：`node packages/cli/dist/index.js doctor [--probe]`——node/config+auth（脱敏）/目录可写/MCP/会话库完整性/skills 分节报告，exit 0/1；崩溃报告 `~/.harness2/crash/`（无遥测，手动反馈）
- **桌面包构建（阶段 11）**：`pnpm --filter @harness2/desktop dist:win|dist:mac|dist:linux`（三平台 unsigned；本地已验 win nsis，mac/linux 待远程 CI）
- 注意：cli 包名已改为 `harness2`（npm 发布名），根工作区更名为 `harness2-monorepo`（避免重名）；`pnpm --filter harness2` 指向 packages/cli
- 注意：`pnpm --filter harness2 test` 在干净检出需先 build（根脚本已串 build）
- 跑一次 loop 演示：任意 node 脚本 `runTurn(dir, { provider, tools, cwd, userText })`；provider 可用 `createProvider(config, role)`（真实协议，需 stub/真实端点）或 `new MockProvider(script)`（见 `packages/core/test/loop.test.ts`、`packages/core/test/providers.test.ts` 的 E2E 用例）

## 7. 已知坑

- Windows 下 tsc/commit 有 CRLF warning，无害
- 会话日志写入依赖「换行即提交」语义（未以 \n 结尾的尾行视为未提交丢弃），改 writer 前先读其测试
- **redo 的投影复活依赖 reason 前缀 `redo` 的标记链语义**（按 `rewindToSeq+1` 精确中立化被重做的 undo 标记）：手工构造 rewind 标记时不要用 `redo` 前缀，除非明确想触发复活（见 reader.ts computeProjection 注释与测试）
- **bash 副作用不进文件快照**（write/edit 才有 before/after）：对外已如实声明（README、chat /help），改快照范围时同步这两处
- **真实模型验证（阶段 15 A2-1，2026-09-09 已补）**：本地统一网关 openai/anthropic 双协议真机验证八项中自动化批次全过（config check/chat+工具调用/undo-redo-审批-会话/记忆三态/MCP-插件/上下文压缩/失败与降级，均无 key 明文）；**云端厂商（DeepSeek/智谱/Anthropic 官方）差异仍待真实 key**（A2-2 ➖，不得用本地网关或 stub 顶替）；桌面端真机一轮亦待补。早期阶段（3 起）的 stub 口径已由本地网关真机验证部分覆盖，未覆盖部分见 OPEN.md
- 密钥只在 `~/.harness2/auth.json`（不入 git，.gitignore 已含 `auth.json`）与环境变量；config/日志/错误消息里出现疑似密钥一律经 `redactSecrets` 脱敏——新增错误路径时记得过这个闸门
- 外部脚手架（.opencode/、ai-framework 文档）由项目负责人维护，更新时注意与 `workflow-delegation.md` 的角色约定保持一致
- CI（ci.yml）**已在远程真实运行并稳定全绿**（最新 run #73：三平台 test + 三平台 desktop build + pages 共 7 job）。`test` job 自 2026-09-12 起为**分包独立步骤**（Typecheck / Lint (ESLint) / Lint (Prettier check) / Test core|gateway|cli|desktop），步骤条件只看 `steps.build.outcome`：build 红则整段跳过，其余互不遮蔽且任一步红则 job 红——起因是 run #61 里 core 一个抖动用例让其余三包当次根本没跑到（本机已做探针变异取证）。`.github/workflows/**`、根 `package.json`、`tsconfig.base.json`、eslint/prettier 配置属**编排者独占**，并行轨不得改。release.yml 仍只做过 YAML 语法校验（tag 未推）。release.yml 的 publish 步骤为**条件跳过**语义：无 `NPM_TOKEN` → 明确 notice 跳过；有 token 但发布失败 → workflow 红（2026-09-06 审查修复 P1-1，勿再加 continue-on-error）
- chat 审批内联提示：ask 等待期间下一行输入即答案（含以 / 开头的行）；取消等待用 Ctrl+C / Ctrl+D（ask 与 turn 取消信号竞速，abort 后按拒绝处理且不再吞行）——改 chat.ts 的 askUser/answerResolver 前先读 chat-cancel.test.ts
- grep 工具优先 spawn ripgrep，CI 镜像若未装 rg 会自动回退纯 JS 扫描（行为一致但大目录更慢）
- **记忆文件（~/.harness2/memories/）属用户私有数据**：绝不入 git（测试全临时目录）、不出现在错误消息出口；写入按 `§` 条目结构 + 字符硬预算（memory 2200 / user 1375）校验，改 store.ts 前先读 memory.test.ts（round-trip/漂移/原子批量语义都在那）
- **memory/snapshot 事件 = ChatRequest.system 的唯一来源**（Model-visible ⟺ logged 扩展到 system）：loop 会话内冻结（活动投影已有快照就复用不重读文件）——改注入逻辑前先读 loop.test.ts 的「记忆开关与冻结注入」组
- **nudge 复盘不落主会话日志**（一次性临时会话预置系统提示、跑完即删）；计数在 SessionHub（turn 内调过 memory 工具即归零）；改 hub 的 buildTurnTools/bumpNudge 前先读 nudge.test.ts
- **分叉不复制 rewind/marker 与影子事件、不迁移文件快照**（新会话 undo 从零开始，README 已注明）；改 fork.ts 前先读 fork.test.ts（字节级零变化/投影一致断言在那）
- **sandbox preload 不能 require 相对模块**：IPC 通道名在 preload.ts 内联，与 shared/protocol.ts 的同名常量有静态一致性测试（test/protocol.test.ts）——改通道名先看这个测试
- **pnpm 11 的构建脚本白名单/overrides 在 pnpm-workspace.yaml**（allowBuilds / overrides），package.json 的 pnpm 字段已被忽略；electron 二进制下载失败可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重跑 install
- **electron-builder 26 需要 @electron/get ≥4**（ElectronDownloadCacheMode）：已用 workspace overrides `@electron/get: ^5.1.0` 钉住，动依赖版本时注意
- **打包后 serve 子进程 = esbuild 单文件 bundle**（packages/cli/dist-bundle/harness2-cli.cjs，经 extraResources）：jsonc-parser 必须走 ESM 入口（bundle 脚本带 `--alias:jsonc-parser=jsonc-parser/lib/esm/main.js`，UMD 运行时动态 require 打不进单文件）；改 cli 依赖后先 `pnpm --filter harness2 bundle` 并本地跑一次 bundle serve 验证
- **插件 v1 进程内非隔离（阶段 8）**：manifest 权限是 API 层约束不是强制隔离，恶意代码可绕过——改插件层时不得弱化 allow 审批与权限清单展示；worker/isolate 隔离留档评估（见 architecture.md 插件小节）
- **MCP 工具名 sanitize 后撞名 = 后者跳过**（`mcp__<server>__<tool>` 必须满足工具名约束 ^[a-z0-9_]+$，config 层拦 server 名，tool 名非法字符折叠 `_`）；MCP server 名在 config 校验里必须匹配 ^[a-z0-9_]+$
- **subagent 深度红线的实现点**：`buildSubagentChildTools` 重挂时血缘重绑（parentSessionId=子会话 id、depth+1）——改 subagent.ts 前先读 subagent.test.ts（孙会话血缘/深度断言在那）；hub 侧每次 turn 按会话 id 重绑（buildTurnTools），改 SessionHub 装配前先读 assembly.test.ts
- **导出幂等依赖固定 mtime**（2000-01-01；zip DOS 时间仅支持 1980-2099，用 `new Date(0)` 会抛 date not in range）：改 export.ts 前先读 export.test.ts（只读红线/幂等/黄金断言/坏行容错都在那）；子会话扫描只认「直接子会话」（parentSession === 本会话 id），孙会话不在冻结结构内
- **skills 列表不落事件**（唯一事实源 = 磁盘目录，与 memory/snapshot 冻结语义不同）：system 组装顺序 = memory 快照在前 + 空行 + `[Skills 可用]` 列表；每 turn 重扫、同一 turn 内冻结——改注入逻辑前先读 skills.test.ts（两级/覆盖/上限/零注入/每 turn 重扫描断言都在那）；**子会话 turn 同样注入宿主同款 skills 列表**（阶段 11 口径统一，SubagentOptions.skills；子会话工具集同时剔除 per-session 绑定类 memory/browser_*——改装配前先读 subagent.test.ts 口径统一组）
- **阶段 10 新增运行时依赖 `fflate`（^0.8.3，纯 JS zip）**：core 运行时唯一新增第三方依赖（cli 侧仅测试 devDep）——zip 结构已冻结（计划），改打包路径/条目命名先对照 architecture.md「轨迹导出与回放」小节
- **阶段 8 新增依赖 `@modelcontextprotocol/sdk`（锁 ^1.30.0）**：客户端只依赖 listTools/callTool 两面（适配层薄封装，SDK 升级先跑 mcp.test.ts）；stateless Streamable HTTP server 夹具每请求新建 transport（web-standard 传输禁止跨请求复用）
- **bundle 必须 `--external:playwright`**（阶段 11 修复：browser 工具进 core 导出图后，playwright-core 的 chromium-bidi require 打不进 cjs 单文件）——打包产物内 browser_* 走「未安装指引」降级是设计口径；改 bundle 脚本后先 `pnpm --filter harness2 bundle` 再跑一次桌面 dist
- **importReplay 有 256 MiB 解压上限**（前置中央目录声明体积 + 后置实际体积双闸门，`maxDecompressedBytes` 可覆盖）：改 export.ts 回放路径前先读 bench.test.ts 上限两例
- **时序敏感测试的写法约定**（阶段 11 抖动根治）：并行性/取消类断言优先用事件相对时序（tool/result 同批落盘间隔）而非绝对墙钟上限；必须用墙钟时给出充足余量并注释依据——新增测试前读 loop.test.ts 并行波次与 tools.test.ts P1-3 的注释
- **公开导出面变更必须同步快照基线**（阶段 12）：改 `packages/core/src/index.ts` 导出后跑 `pnpm build && H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts` 并在同一提交更新 fixture——删除/改名/声明种类变更是 breaking（走 major），流程见 `docs/API-STABILITY.md`
- **1.0 发布动作清单在 `docs/RELEASE-CHECKLIST.md` ③**（push/NPM_TOKEN/包名占用/tag/Pages）——全部待人类授权，勿自行执行
