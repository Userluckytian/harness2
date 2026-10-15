# 阶段 U1：桌面端 ZCode 化修复与不卡顿收口（产品交付波）

> **状态：** 已完成（V1-V5、V7 ✅；**二轮全量复审完成：P0=0/P1=2 已修（`4de407c`/`aa6b8ba`）/P2=8 登记，交付物重建（08:11）端到端复验绿——见 `u1-rereview-summary.md`**；V6 真机项交人类；push/tag v1.0.2 待授权）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 修复用户实机五项桌面端报障（§81）并对齐 ZCode v3.15.1 规格，交付一个「空态可用、托盘齐备、侧栏闭环、反馈可见、长任务有终感、不卡顿」的可安装 Windows 产品（本地构建 + smoke 全绿为交付线；push/发布需人类另行授权）。
**Architecture:** 改动收敛在 `packages/desktop`（主进程 + renderer 装配）与 `packages/ui-shared`（共享渲染层）；`packages/core`/`packages/gateway` 为契约冻结区——本阶段只读不改，暴露出的 core 侧缺口按「登记不带病硬修」处理。
**Tech Stack:** Electron 44 / React 19 / vitest / electron-builder nsis。
**实施档位：** 全能（默认）。
**子代理：** 启用——**实施/测试/审查一律由 `cat-jam` 子代理执行**（2026-10-13 用户指令），编排者只做计划与验收。

---

## 前置阅读（必须）

| 优先级 | 文件 |
| ------ | ---- |
| P0 | `docs/ai-framework/plans/2026-10-14-phase-U1-desktop-parity-fixes.md`（本文件） |
| P0 | `docs/refs/refs-zcode-layout.md` §Z-04/Z-46/Z-47/Z-48/Z-49（v3.15.1 复核+新增） |
| P0 | `docs/refs/refs-zcode.md` §Z-96/Z-97 |
| P0 | `docs/issue-log/2026-10-11.md` §81（五痛点取证与行号） |
| P1 | `docs/design-inputs/denia-ui-analysis.md`、`docs/design-inputs/web-ui-research.md` |
| P1 | `AGENTS.md`、`CODE_REVIEW.md`、`coding-standards.md` |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支：** 从 `main`（≥ `fe50366`）拉 `feat/phase-u1-desktop-parity-fixes`

---

## Global Constraints（冲突时以本节为准）

1. **core/gateway 零改动**（2026-09-11 冻结公告；`api-surface-baseline.json` diff 必须为 0 行——越界信号）。
2. **视觉复刻口径**：一切窗控/托盘/侧栏/反馈形态以 Z-46~Z-49、Z-96/Z-97 规格为准（refs-zcode* 权威），**不得自创视觉**；确需超出规格的产品决策（如「删除会话」入口，ZCode 未上线）按「复刻+改进」口径：改进处不得改 ZCode 已有形态，只能新增（见 T3 决策）。
3. 每个 Task 必须附**可复跑证据**（命令 + 期望输出），禁止「应该能过」。
4. 密钥不进 git；默认不 push。
5. **不卡顿预算**（本阶段验收硬线，全部可自动化）：
   - B1 store 重放 1000 条事件 ≤ 200ms（jsdom 微基准 vitest 用例）
   - B2 `window:*` IPC（min/close）在 serve 未就绪时仍响应 ≤ 200ms（单测计时）
   - B3 `projects:pickFolder` handler 从调用到进入 `showOpenDialog` ≤ 50ms（mock dialog 计时，路径上零 await 的静态+动态双重证明）
   - B4 打包产物 `--smoke` 输出 `{"ok":true,…}` 且 exit 0（既有 gate）
6. **明确不做（本阶段）**：❌ 列表虚拟化（除非 B1 失败才触发 T7）❌ 附件图片字节通道（core 契约缺口，挂账）❌ serve 重启采纳竞态全量修（R0-3 只做「窗口命令与免 serve 命令连坐解除」最小面）❌ 托盘图标品牌设计（用现有应用图标资源）❌ push/发版。

---

## 设计规格摘要（实施者直接引用编号，勿再发明）

- **空态窗控**（Z-46）：桌面壳层 overlay 三键常驻（win/linux），覆盖空态/启动壳/ErrorBoundary 三处缺口；48px 标题高、28px 键、右安全区 136px、drag/no-drag 分区照 Z-46 附加规格。
- **托盘**（Z-47）：win32+linux；左键/双击=show 主窗；右键菜单=打开 harness2 ┃ 新建会话 / 添加项目 ┃ 关于/导出日志 ┃ **退出**；退出=markExplicitQuit+app.quit；关窗 hide 三重门（设置开∧托盘成功；win 默认开）；设置页「关闭窗口时隐藏到托盘」开关。
- **侧栏**（Z-48/Z-49 + Denia③）：项目组头 hover 出现「在此项目新建会话」（点击=以该项目 cwd 调 createSession(cwd)）与会话行 hover「删除」（软删通道已存在 `app-controller.ts:676-695`，**接 UI + ConfirmDialog**；`running` 时禁用——Denia 做法）；「移出项目」加确认（仅当组内有 running 会话，Z-49 语义）。
- **发送可见化**（Z-96）：composer 上方错误横幅（非 toast）+ 草稿保留 + 查看详情/复制报错/关闭 X；禁用态给 tooltip 解释原因（改进，ZCode 死灰不解释——我们至少补 tooltip，视觉不动）；**接 `onSubmitError`**（两壳现零接线）。
- **长任务/终态**（Z-97 + Denia⑤）：轮次级「工作中 {duration}/已工作 {duration}/已停止」；工具行不用旋转 spinner 改扫光文案（若 ui-shared 现实现是转圈则替换）；Stop 与发送互斥（已有 D-36 主按钮判定，核对 busy 态可达）；**悬挂回合兜底**：重放/reconnect 后，store 中无 turn-end 的 running 回合在 X=30s 内未被 WS 活帧确认 → 本地合成 `interrupted` 终态（Denia TurnChrome 兜底语义）。
- **cwd 默认**（§81 取证二）：`main.ts:31-33 resolveRepoRoot()` 语义修正——打包态新会话默认目录 = 用户「最近使用文件夹」或 `~`（绝不允许落在安装目录）；dev 态 = 仓库根。新建会话显式带项目 cwd 优先（T3 接线后自然满足）。
- **R0-3 最小面**（§81 取证三④）：`bridge.ts:422` 的 `const base = deps.serve.baseUrl` 移入需要它的 case 分支内部；`window:*`、`projects:*`、`notify`、`settings/metadata/drafts:*`、`loadLayout`、`gitBranch`、`listDir`、`getStatus` 等免 serve 命令在未就绪时不再连坐抛错（OPEN.md 2026-09-14 行已给三层修法，本阶段只做第①层）。

---

## 任务表（全部执行者 = cat-jam）

| ID | 任务 | 文件边界 | 验收证据（编排者复跑） |
| -- | ---- | -------- | ---------------------- |
| T0 | 环境与基线：`pnpm -r build`；electron 二进制经 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重装使 `dev`/`smoke` 本地可用；记录基线测试数 | 只动 node_modules（重装），不碰源码 | ✅ 编排者实跑：smoke `{ok:true}` exit 0；build 六包 Done；基线 core 1623+2/gateway 40/cli 1575+2/desktop 1210/ui-shared 641（code-viewer 为并行 flaky，隔离 14/14 绿）/web 150 |
| T1 | **主进程批 A**：R0-3 第①层（base 移入分支）+ `window:*` 命令免就绪 + B2 单测；`resolveRepoRoot` cwd 修正 + 单测（打包/dev 两态）；隐藏控制台消黑框调研（Denia console.rs 类比，Electron 是否已 windowsHide 足够——结论进 issue-log） | `packages/desktop/src/main/**` + `packages/desktop/test/**` | ✅ 编排者实跑（`1450b53`+`b4532a9`）：desktop 121 files 全绿、typecheck 0、build 0、smoke 0、冻结区 0；diff 目视核过；含变异自证；黑框=windowsHide 已压住（serve-manager:284 / bridge:115） |
| T2 | **主进程批 B**：托盘全套（Z-47：win/linux 门、图标复用 build icon、左键 show、右键菜单、markExplicitQuit、关窗 hide 三重门、设置开关+偏好持久化）+ 单测（裁决函数纯函数化） | `packages/desktop/src/main/**`、`preload/**`（加通道）、`shared/protocol` 桌面段 | ✅ 编排者实跑（`d72f37a`）：`vitest --maxWorkers=4` → 124 files 全绿（1262 passed）；typecheck 0；smoke `{ok:true}` exit 0 无进程残留；冻结区 0；icon.ico 5 帧合法；裁决表 32 例；「导出日志」无通道如实置灰。遗留：linux DBus 探测折叠注记、渲染端接线归 T3、打包端到端归 T8 |
| T3 | **渲染端批**：空态 overlay 窗控（Z-46 三处缺口）+ 侧栏项目/会话操作面（Z-48/Z-49 语义：项目行新建(带 cwd)、行删除(running 禁用)、移出项目条件确认、ConfirmDialog）+ 发送可见化（Z-96 横幅+onSubmitError 接线+禁用 tooltip） | `packages/desktop/src/renderer/**`、`packages/ui-shared/src/renderer/**`（含 sidebar/composer/conversation）；**禁碰 core/gateway** | ✅ 编排者实跑（8 commits `90fdf5c..aa24a91`）：ui-shared **62 files/680 passed**、desktop **128 files/1282 passed+1 skip**（--maxWorkers=4）、typecheck 六包 0、build 0、smoke `{ok:true}` exit 0、冻结区 0；overlay 挂载与 onDeleteSession→deleteSession 接线 spot-check 吻合；变异自证 11 轮。3b 结论：选择器初值本无缺陷（roles.main 经 settings 通道），根因=core 启动期 loadConfig 定格（冻结区，挂账）；自主决策：web 边界回退 `b34f327`（onSubmitError 走共享 seat 零 web 改动）；遗留：`draftModelReadinessError` 无数据面未实现（如实登记） |
| T4 | **性能/终态批**：轮次耗时行（Z-97 文案+完成态锁事件时间戳）、工具行扫光替换（如现实现为 spinner）、悬挂回合 30s 合成 interrupted、`projects:pickFolder` handler 零 await 前置审计+B3 计时用例、B1 重放微基准用例、`prefers-reduced-motion` 降级核对 | `packages/ui-shared/src/renderer/**`、`packages/desktop/src/main/bridge.ts`（pickFolder 段） | B1/B3 微基准绿；重放 interrupted 单测：构造无 turn-end 事件流 → 时间推进后 store `turnEnds[turnId].stopReason==='interrupted'` |
| T5 | **测试批补全**：审 T1-T4 用例是否为「断言非空转」——每条新用例做变异验证（临时改坏实现必红，恢复后绿，方法同 §I1 P1-1 先例），报告落 `docs/ai-framework/plans/u1-mutation-notes.md` | 测试文件 + 该报告 | ✅ 并入 T6 执行（审查员抽查 6 用例全敏感 + 重跑 2 变异先红后绿；各实施者自带变异自证合计 20+ 轮，记录散见各 commit 信息与 §5 日志） |
| T6 | **审查批**：按 `CODE_REVIEW.md` 全 diff 只读审查 → P0/P1/P2 报告；P0/P1 由 cat-jam 修完，P2 登记 | — | ✅ 报告 `2026-10-14-u1-review.md`（`84f31f7`）：**P0=0 / P1=3 已修 / P2=5 登记**。P1-1 `d12bddc` resume-snapshot/removeApproval 漏挂看门狗（真缺陷，先红实证）；P1-2 `1492b99` removeSessionFromView 撤除 hungTimers；P1-3 `6925fcf` prettier 归位。修后 ui-shared 723/desktop 1283/web 150 全绿；P2 五条登记（含设置页窗控安全区让位、软删流缓存滞留等） |
| T7 | （条件任务）B1 微基准不过 → 列表窗口化（Denia⑤ 手法：IO rootMargin 800px 保留高度） | `ui-shared` | B1 达标 |
| T8 | 打包与交付线：`pnpm --filter @harness2/desktop dist:win`（镜像变量）+ 产物 `--smoke` + 编排者验收清单执行 | release/ | ✅ 变通完成（`ff8b2d5`+`d73bc7c`）：本机 `System32\cmd.exe` 丢失（复制替代也被拦截，疑安全软件隔离）→ electron-builder 依赖收集器必红。走「手工组 asar + `--prepackaged`」（脚本入库 `desktop/scripts/manual-pack.mjs`，robocopy 组 stage/文件级 unpack/resedit 元数据/elevate）。产物 `release/harness2-1.0.2-win-x64.exe` 124.8MB + `…-portable.exe` 124.6MB。**编排者独立端到端**：7za 全解最终 NSIS 内 77 文件 → `harness2.exe --smoke` `{"ok":true}` exit 0；asar 四项独立复验：root=1.0.2、zod=4.5.4 含 ./v3、shadcn=0、包内 store.js（cjs+esm）实含 `HUNG_TURN_TIMEOUT_MS`/`noteActivity`，tray_icon.ico/elevate/cli 在位。**注**：`win-unpacked` 半成品目录（builder 清后未重写）与两个 1.0.0 旧 exe 仍在 release/，以两个 1.0.2 exe 为准 |

## 全闸门（每批合入前必跑，编排者验收时亲自复跑）

`pnpm -r build` → 六包 `test` → `typecheck` 6/6 → eslint 0 error → prettier --check。

## 验收表（阶段级，编排者独立执行）

| # | 项 | 判据（命令 + 期望） | 状态 |
| - | -- | ------------------- | ---- |
| V1 | 五痛点逐条有代码级证据 | T1-T4 对应单测全绿（§81 编号引用） | ✅ ①空态窗控 overlay `90fdf5c`（6 用例钉 DOM 与单实例）②托盘 `d72f37a`（裁决表 32 例+T3 渲染接线 7 例）③侧栏项目新建带 cwd/软删/移除守卫 `0df51e4`（sidebar-z48-z49 11 例+cwd 链 3 例）④发送可见化 `d34ae7a`（横幅+错误模型 18 例）⑤耗时行/扫光/悬挂收敛 `fe4cc94`/`ce37e2d`/`94072c8`（17+10+11 例，含 T6 补 g/h/i 3 例）|
| V2 | 不卡顿预算 | B1-B4 实跑输出贴入验收记录 | ✅ B1=包内实测中位 ~0.25ms ≤250（10000 事件外推点 ~2.3ms 线性，`232d7a6`，无需虚拟化 T7）；B2=window:*/getStatus 未就绪 <200ms + pickFolder <50ms（`1450b53` C1/C2）；B3=收集链零 await（T4 审计 bridge:805）；B4=最终 NSIS 解包直跑 `{ok:true}` exit 0（§T8 行）|
| V3 | 契约冻结未越界 | `git diff main -- packages/core packages/gateway` 为空；`api-surface-baseline.json` diff 0 行 | ✅ **契约面零改动**：`api-surface-baseline.json` diff **0 行**、core/gateway **功能代码 diff 0 行**（穷举 `git diff main...HEAD -- 'packages/core/src' 'packages/gateway/src' ':(exclude)*version.ts'` = 0）。⚠️ 自纠：本行终态记「0 文件」不准确——T8 版本 bump（`ff8b2d5`，发版必需）触及 `core/gateway/cli` 的 `package.json` + `core/src/version.ts` 共 **3 文件 3 行**（纯 `1.0.1→1.0.2` 字符串），非契约/逻辑变更。除版本字段外 core/gateway 全域零 diff，冻结公告「越界信号=api-surface 变化」未触发 |
| V4 | 全量闸门 | 六包测试/typecheck/lint/prettier 全绿且不低于基线数 | ✅ 六包 typecheck 0；ui-shared **723** / desktop **1282+1skip** / web **150** / gateway **40** 全绿（均 ≥ 基线）；**core 1617 passed+5 环境红、cli 1569+2skip+6 环境红**——失败面全为真子进程用例（node -e/cmd 回退/状态行 runner），隔离复跑同红，归因=本机 `System32\cmd.exe` 缺失（§T8 行），U1 对 core/cli **功能源码与测试**零 diff（仅 T8 版本字段变更，见 V3 行）、T0 基线同环境绿 → 非回归、不阻塞；修复=系统层面恢复 cmd.exe 后复跑（OPEN.md 挂账）；**V4 终口（编排者 23:3x 全量亲跑）**：68 个 U1 diff 文件 eslint **0 error**（1 warning=App.tsx:173 既有）——此前 T3 自报「0 error」实漏 1（gen-icon `oy`，`dee288b` 修+图标再生+交付物 22:11 重打包）；prettier --check 68 文件全绿（`manual-pack.mjs` 一处格式 `a96b100` 归位，`node --check` 语法复验） |
| V5 | 可安装产物 | dist:win 出 exe + win-unpacked smoke `{ok:true}` exit 0 | ✅ `harness2-1.0.2-win-x64.exe` 124.8MB + portable 124.6MB（手工 prepackaged 路线，见 T8 行）；NSIS 内解出全壳直跑 smoke 绿；asar 四项复验绿 |
| V6 | 真机项（人类） | 装新 exe 点一遍：选路径/空态窗控/托盘右键退出/发送失败横幅/长任务耗时与停止 | ☐ **交人类**（M1-M12 清单已备：`docs/ai-framework/plans/2026-10-14-u1-real-machine-checklist.md`）；不阻塞 V1-V5 |
| V7 | 日志闭环 | issue-log 当日条目 + OPEN.md 行状态更新（含 core 侧新挂账：工具超时无限、serve 竞态第②③层） | ✅ 当日日志 §1-§6（本目录按约定不入库）；OPEN.md U1 行关闭 + 新挂账行登记（下提交）|

---

## 给接手 AI 的完整提示词（零上下文，按波次粘贴）

> 你是 harness2 仓库（`D:/AI_Projects/harness2`，分支 `feat/phase-u1-desktop-parity-fixes`）的实施子代理。先读：`docs/ai-framework/plans/2026-10-14-phase-U1-desktop-parity-fixes.md` 全文、`AGENTS.md`、`coding-standards.md`，再读本任务书指向的 refs 条目（Z-46~Z-49/Z-96/Z-97）与 `docs/issue-log/2026-10-11.md` §81。执行任务表 <T-ID>：文件边界=「文件边界」列，禁止越界（core/gateway 与 `api-surface-baseline.json` 绝对禁触）。完成后：跑「全闸门」全套命令并贴真实输出；按 `<type>(<scope>): 中文描述` gitmoji 规范**本地 commit**（不 push）；返回改动清单+证据。任何步骤失败如实报告，禁止编造输出。

---

## 风险与挂账预告（实施中如实登记，不静默）

- cat-jam 模型（`new-provider/cat-jam`）昨夜起持续 `Provider returned a server error`——派发前探测 pong，恢复前不动代码。
- core 侧「工具执行无硬超时」（84s bash 事件）与「serve 竞态第②③层」→ 完成后向 OPEN.md 加行，归后续解冻窗口。
