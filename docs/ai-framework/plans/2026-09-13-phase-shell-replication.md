# 阶段计划：内核下沉与三壳重建（core / cli / desktop / web）

- 计划日期：2026-09-13
- 起点 commit：`7e0fcc4`（main）
- 上层文档：`docs/MASTER-PLAN.md`、`docs/ROADMAP.md`、`docs/ai-framework/plan-layering.md`
- 元规范：`docs/ai-framework/phased-plan-driven.md`、`docs/ai-framework/workflow-delegation.md`
- **强制前置**：`docs/refs/README.md` 六步开工流程 + `docs/refs/refs-grok-build.md`、`refs-deepseek-harness.md`、`refs-hermes-agent.md`

## 0. 目标（一句话）

把 harness 必备能力（agent loop、会话、记忆、工具、审批、压缩、命令分发）**全部下沉到 `core`**，然后把三个壳重建成：

| 壳        | 交互基准                          | 功能基准                          |
| --------- | --------------------------------- | --------------------------------- |
| `cli`     | **完全复刻 grok-build**（G-\*）   | hermes-agent（H-\*）补齐          |
| `desktop` | **参考 deepseek-harness**（D-\*） | hermes-agent（H-\*）补齐          |
| `web`     | 与 desktop 共用壳层组件           | 最小可用（只要求对话 + 会话列表） |

目标目录结构（终态）：

```text
harness2/
  packages/
    core/       # agent loop、记忆、会话、工具、命令注册表、审批、压缩、调度
    cli/        # 只有终端渲染与按键
    desktop/    # 只有 Electron 壳 + React 视图
    web/        # 只有浏览器壳 + React 视图（与 desktop 共用组件包）
    gateway/    # 外部平台接入（现状保留）
```

## 1. 反“半成品”硬规则（违反任何一条，阶段不得退出）

1. **不准摆可点击的假入口**（Global Constraints #7）。没实现就不要画按钮/菜单项；宁可少一个入口，不可一个入口点了没反应。
2. **每一条 G-/D-/H- 项目必须有归存**：要么完成（✅ + 测试用例号），要么显式下放下一阶段（🟡 + 阶段号），要么正式不采纳（➖ + 理由）。**绝不允许静默丢弃。**
3. **交互类改动必须有自动化测试**。终端侧用 `ink-testing-library` 断言帧输出；桌面侧用渲染层单测 + Electron smoke。“我手动试了”不算验收。
4. **禁止为了绿而改测试**：不得注释/删除/skip 已有用例，不得 `--passWithNoTests`，不得把断言改成总为真。
5. **每阶段结束必须能跑**：阶段产物要么可从命令行/桌面真实跑起来，要么在本文件内写清“本阶段不可运行的原因 + 哪一阶段接上”。
6. **文档与代码同批提交**：改了交互就要同步改 `docs/refs/refs-*.md` 的状态列与 `docs/HANDOFF.md`。

## 2. 全局闸门（每阶段退出前必须全部绿）

| 闸门   | 命令                           | 基线（`7e0fcc4`）                                                          |
| ------ | ------------------------------ | -------------------------------------------------------------------------- |
| 构建   | `pnpm -r build`                | 0 错误                                                                     |
| 类型   | `pnpm typecheck`               | 0 错误                                                                     |
| ESLint | `pnpm exec eslint .`           | 0 error（warning 不得增长，当前 46）                                       |
| 格式   | `pnpm exec prettier --check .` | 全绿（**含 `.md`，文档提交也会红**）                                       |
| 测试   | `pnpm -r --no-bail run test`   | 不低于 **1469 passed + 5 skipped**（152 files）                            |
| 导出面 | `test/api-surface.test.ts`     | 基线 495；变更必须 `H2_UPDATE_API_SNAPSHOT=1` 显式更新并在提交说明里写理由 |
| CI     | GitHub Actions                 | 七个 job 全绿（3 平台 test + 3 平台 build-desktop + pages）                |

> 推送纪律：**一次推送**（`concurrency` + `cancel-in-progress` 会取消连续推送的前一个 run）；推完必须回查 run 的 `conclusion`，不能停在 `in_progress`。

## 3. 执行模式（用户硬约束，不得改）

接下本计划的模型是**编排者**，不是码工：

- 编排者**不亲自写功能代码**。只做：拆任务、写子代理简报、守闸门、重跑验证、回填文档、向人类汇报。
- 每个阶段**固定四段**，四段都要派子代理，编排者只在第四段亲自动手：

| 段     | 负责人                           | 产出                                                                                                |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| ① 开发 | 开发子代理（可并行多个）         | 代码 + 自测；严格按“目录独占表”分工，不得跨界                                                       |
| ② 测试 | 测试子代理（可并行）             | 新增/加固用例，每条 G-/D-/H- 项至少一个用例号                                                       |
| ③ 审查 | **只读**审查子代理（不得改代码） | 审查报告，按 P0/P1/P2 分级；P0 必修才能进④                                                          |
| ④ 验证 | **编排者亲自**                   | 重跑全局闸门 + 真实启动一次（CLI 跑 `harness2 chat`，桌面跑 `pnpm --filter @harness2/desktop dev`） |

- **并行规则**：只有当两个任务的“目录独占表”无交集时才允许并行。有交集就串行。
- **失败处理**：验证不通过的项**不得原地反复磨**，按元规范 §4.1 显式下放下一阶段，并在本文件写清“下放原因 + 接收阶段”。
- **汇报**：每阶段结束编排者给人类一份简报：完成项 / 下放项 / 闸门数字 / 下一阶段开工条件。

### 子代理简报模板（编排者每次派工照拄）

```text
【任务】<阶段号>-<序号> <一句话目标>
【必读】docs/refs/README.md、docs/refs/refs-<相关项目>.md 的 <ID 区间>、本计划 <阶段小节>
【目录独占】只允许改：<路径列表>；禁止改：其余任何文件（包括配置与 workflow）
【完成定义】每条 ID 有对应测试；本包 test 全绿；typecheck 0；eslint 0 error；prettier --check 全绿
【禁止】不改已有用例的断言；不动 api-surface 基线（需动先回报）；不做假入口；不 force push
【产出】改动文件清单 + 测试命令与真实输出 + 未完成项及原因
```

## 4. 阶段总览

| 阶段   | 主题                                 | 依赖    | 可并行子代理      | 预估   |
| ------ | ------------------------------------ | ------- | ----------------- | ------ |
| **P0** | 参考基线刷新 + 目标分层确认          | —       | 3（三仓各一）     | 0.5 天 |
| **P1** | 内核下沉：core 吸走命令/会话/模式    | P0      | 2                 | 2–3 天 |
| **P2** | CLI 骨架：双渲染模式 + 焦点/Esc      | P1      | 2                 | 3 天   |
| **P3** | CLI 命令面 + 阻塞卡片 + 状态行       | P2      | 3                 | 3–4 天 |
| **P4** | 桌面骨架：slot + 三栅 + 侧栏         | P1      | 2（可与 P2 并行） | 3 天   |
| **P5** | 桌面对话页：视图环 + 乐观提交 + 队列 | P4      | 2                 | 3–4 天 |
| **P6** | 桌面轨迹 + 模型配置 + 设置           | P5      | 3（三页各一）     | 4 天   |
| **P7** | 功能补齐（hermes 对标）              | P3 + P6 | 3–4               | 5 天   |
| **P8** | web 壳最小可用                       | P5      | 1                 | 2 天   |
| **P9** | 收口：全面验收 + 文档 + 发布准备     | 全部    | 2                 | 2 天   |

**并行窗口**：P2+P4 可同时开（一个只碰 `packages/cli`，一个只碰 `packages/desktop`）；P3+P5 同理。**P1 必须单独串行完成**，因为它改 `packages/core` 导出面。

## P0 参考基线刷新与目标分层确认（0.5 天）

**目的**：动手前确保三份 `docs/refs/refs-*.md` 与上游最新代码一致。

- ① 开发（三个子代理并行，每仓一个）：按 `docs/refs/README.md` §2 六步流程跑完；若 HEAD 与文档基线不一致，重新分析并补条目（新增编号往后接，**永不重排**）。
  - 目录独占：子代理 A 只改 `docs/refs/refs-grok-build.md`；B 只改 `refs-deepseek-harness.md`；C 只改 `refs-hermes-agent.md`。
- ② 测试：无代码，改为自检清单（每份文档是否含全部 10 小节、基线表是否更新、是否有本轮更新记录行）。
- ③ 审查：检查是否有“凭记忆写的条目”（抽查 5 条，回源到上游文件路径）。
- ④ 验证（编排者）：`pnpm exec prettier --check .` 全绿；在本文件补上“本轮采用的基线 commit”三行。

**退出闸门**：三份文档基线表的 commit 与 `git -C <仓> rev-parse --short HEAD` 逐字相等。

**执行记录（2026-09-13，编排者四段跑毕）——本轮采用的基线 commit**：

- grok-build `37949780`（2026-09-09T19:03:16Z，main）——已过期并重新分析：新增 G-91～G-95，修正 G-09/G-14/G-15/G-19/G-34/G-38/G-79/G-84/G-89，➖ G-16；**关键行为变化：回合中 Esc 永不取消（改弹 Ctrl+C 提示）、会话选择器 F3→Ctrl+R**（P2/P3 实施必须按新条目）。
- deepseek-harness `c291e7961a`（2026-09-10T22:17:09+08:00，master）——已过期并重新分析：新增 D-73～D-86（右栏停靠引擎等），修正 D-03/D-10/D-11/D-12/D-13/D-36（**details 席位废除，改每会话右栏停靠面；让步链改序；Send 标签跟随 Enter 投递模式**）。
- hermes-agent `79445a4`（2026-09-04T20:24:51-04:00，main）——**本轮未拉取**：fetch 三次网络中断（完整/shallow-since/HTTP1.1 均 early EOF），`ls-remote` 证实远端 main 已前移（≥ `b6b53c69`）；沿用 `79445a4`，条目未按新上游更新，补拉已登记 `docs/issue-log/OPEN.md`，下轮涉及 H-\* 的阶段开工前优先补拉。

四段留痕：①三个开发子代理（目录独占）+ 三个修复子代理（模板锚点、H-20 修正、H-70 状态符号、更新记录措辞）②测试自检（基线表逐字相等 ✅、更新记录口径 ✅、编号连续性 G ✅ / D·H 缺号为首版分段预留非本次引入、prettier ✅）③只读审查（抽查 15 条回源全部属实；发现 H-20 与源码冲突已修）④编排者重跑 `pnpm exec prettier --check .` 全绿并核实本节基线三行。

**CI 加固窗口（2026-09-13，并入 P0）**：推送后发现 main 遗留红——上一会话 P3/P4 新增 TUI 测试首次上 CI（run #94/#95），四个用例在 2 核 runner 抖动失败（性能报警阈值按开发机标定 ×2、Windows EBUSY 清理竞争、waitFor 饿死）；同代码 run #93 全绿 + 本机 windows 两轮全绿证明无产品回归。按四段子流程修复（测试子代理加固 + 只读审查「可提交，无 P0/P1」+ 编排者重跑）：chat-controller 单键阈值 1→4ms、scrollback-render 10k wrap 200→700ms（均带本机/CI 实测数据注释，报警语义=抓数量级退化，符合阶段 11 墙钟约定）；`test/tui/shell-runtime.ts` rmSync 加 EBUSY/EPERM/ENOTEMPTY 退避重试、waitFor 默认超时 8s→20s 加退避让出；overlay-position 补发 Esc 自愈（**单次 Esc 语义覆盖见 `test/tui/approvals.test.tsx:111`，未削弱**；chat-controller 另加 `timeout: 20000` 使断言先于 vitest 超时报出实测值）。生产代码（`packages/cli/src/**`）零改动。本机全量 1107 passed + 2 skipped 复绿。

## P1 内核下沉（core 吸走命令、会话、模式）—— **串行，2–3 天**

**目的**：壳不得再拥有业务语义。依据 H-70（斜杠命令两层分层）与 D-01～D-04（壳只组装）。

① 开发（两个子代理，串行或分文件并行）：

1. **命令注册表下沉**：把 `packages/cli/src/command-registry.ts` 的 13 条命令搜到 `packages/core/src/commands/`，拆为：
   - `CoreCommand`：`{ id, aliases, group, summary, argsSpec, run(ctx) }`，**与渲染无关**。
   - `ShellCommand`：只留必须由壳处理的（清屏、密度、主题、重绘、模式切换）。
   - 壳侧提供 `dispatch(input)`：本地能处理就处理，否则下沉 core（镜像 H-70）。
2. **能力描述面**：core 导出 `describeCapabilities()`，返回命令表/模式表/工具表/审批策略，**三个壳均由此渲染菜单**（此后永远不会三份命令表分叉）。

目录独占：`packages/core/src/commands/**`、`packages/core/src/index.ts`、`packages/cli/src/command-registry.ts`、`packages/cli/src/tui/ink-commands.ts`。

② 测试：`packages/core/test/commands/*.test.ts` 盖 13 条命令的解析/别名/参数校验/错误文案；`packages/cli` 侧只测“下沉路由”。**旧的 CLI 命令测试全部保留并必须继续绿**（这是回归安全网）。

③ 审查重点：是否有任何渲染类型（Ink / React / ANSI）泄漏进 `packages/core`；导出面新增是否已显式更新 api-surface 基线。

④ 验证（编排者）：全局闸门 + `harness2 chat` 实跑 `/help` `/context` `/mode` 三条，确认文案与改造前一致。

**退出闸门**：`packages/cli` 不再包含命令业务实现（`grep -r "case '/" packages/cli/src` 无命中）；1469 基线不降。

**执行记录（2026-09-13，编排者四段跑毕）**：

- ① 开发（两棒串行）：Dev-1 core 侧——新建 `packages/core/src/commands/`（CoreCommand/CoreCommandContext/parseCoreCommand/runCoreCommand/describeCapabilities），13 条命令注册，**11 条业务进 core**（help/exit/new/resume/sessions/fork/undo/redo/context/compact/tasks），mode/reasoning 为 `shellOnly` 元数据（壳实现，不画饼）；导出面快照加性 23 条（实测 499→522，审查修正口径）。Dev-2 cli 侧——`command-registry.ts` 改 core 派生聚合、`commands.ts` 改薄 facade、`shell-commands.ts` 新建壳分发表（mode/reasoning，表驱动）、三处内联实现（legacy-chat if 链 / runInkChat switch / next-shell switch）全部收敛；`case '/` 在 `packages/cli/src` **0 命中**。
- ② 测试：core `test/commands/` 10 文件 75 用例（含真实分叉字节级零改动、undo 三层、大写归一、HELP 全枚举）；cli `command-routing.test.ts` 20 用例（shellOnly 拦截/未知命令/三入口一致性）。既有 cli 测试零断言改动全绿。
- ③ 审查（只读）：**可合入，0 P0 / 0 P1 / 3 P2**——P2-1 ink/next 文案统一到 legacy 基准属第三类用户可见变化（已登记：`/reasoning on` 文案与 `/mode` 带参文案/解析面统一）；P2-2 两处 `void` Promise 防御（当前不可达，留待三壳接 compact 缝时补 `.catch`）；P2-3 基线计数口径修正为 499→522。next-shell `/mode` UI 四态保留为注册型呈现差异（不触审批状态，红线 6 不弱化）。
- ④ 验证（编排者亲跑）：`pnpm -r build` 0 错 · typecheck 0 · eslint **0 error / 46 warning**（49→46：3 条为上批 P3/P4 遗留，本批 lint 窗口行为保持消除；legacy-chat `no-unsafe-finally` 留 P9）· prettier 全绿 · 全量 **2397 passed + 5 skipped（196 files）**（core 926+2 · gateway 40 · desktop 344+1 · cli 1127+2，1469 基线不降反升）；真机 `harness2 chat --provider mock` 实跑 `/help` `/context` `/mode` 文案与改造前逐字一致，exit 0。
- H-70 状态 ⬜→🟡（refs-hermes-agent.md 同批回填：core 半边已落，桌面/web 接线待 P5/P6/P8）。

> **授权重写**：若现有 `packages/cli/src/tui` 结构承载不了 G-01～G-49 的交互模型（双渲染模式、焦点环、阻塞卡片层），**授权整体重写 `packages/cli/src/tui`**，不必向下兼容旧渲染层；但命令语义测试与会话文件格式（`session.v1.jsonl`）**不得破坏**。

## P2 CLI 骨架：双渲染模式 + 输入/焦点/Esc 语义（3 天）

**依据**：`refs-grok-build.md` 的 G-01～G-20。

① 开发（两子代理并行）：

- A：渲染模式层——fullscreen / minimal 双模式（G-01～G-03）、八个布局区域（G-04）、折叠与块操作（G-05、G-06）。目录：`packages/cli/src/tui/render/**`。
- B：输入与焦点——simple/vim 两套键位（G-07）、**焦点环（G-08，注意“Esc 不是焦点键”）**、导航与滚动粒度（G-09、G-10）、`!` shell 直达（G-11）、**Esc 语义状态表 G-14～G-20**。目录：`packages/cli/src/tui/input/**`。

② 测试：用 `ink-testing-library` 断言帧输出；**Esc 表每一行一个用例**（运行中取消保留草稿、取消中再按重发、800ms 双击清空并 stash、空草稿双击开 rewind、取消后 1s 抑制、steal-Esc 清单）。

③ 审查重点：模式切换是否真的**进程内**（不重启，会话不丢）；键位是否与 G-\* 逐条对得上。

④ 验证（编排者）：全局闸门 + 手工跑一次 `harness2 chat`，实测 `/minimal` `/fullscreen` 往返与 Esc 四种语义。

**退出闸门**：G-01～G-20 全部 ✅ 或有归存；`refs-grok-build.md` 状态列已回填。

**执行记录（2026-09-13，编排者四段跑毕）**：

- ① 开发：两棒并行（`tui/render/` 渲染模式层 96 例、`tui/input/` 输入焦点层 150 例，目录独占零交集）+ 一棒串行接线（Esc 全语义切 37949780 新规格、fullscreen 八区域接 RegionLayoutManager、/minimal /fullscreen 注册、core 配置加性 `ui`/`scrollback` 段、快照 522→524、catalog 13→15 条）。修复棒闭环审查 P1-1（Ctrl+S stash 语义对齐上游 StashPrompt，数据不丢）与 P2-2（寄放审批卡裸 Esc 整体吞掉）。
- ② 测试：覆盖矩阵 20/20（G-16 负向锁死）；11 例补口（G-02 会话/草稿不丢、G-03 门控、G-12 Alt+V、G-19 穿越等）；9 条旧断言按新规格迁移（②逐条裁决检验力不弱 + G 依据，③抽查复核；唯一附带缺口「候选钳位分支」已用新用例闭环）。
- ③ 审查：规格回源抽查 7 条全部与上游 37949780 一致（含 G-17 800ms 边界、G-19 宽限常量、G-03 清单）；假入口扫描通过（三数据面板真隐藏、/minimal 降级指引诚实、rewind picker 走 /undo 真管线）；判定「需修后合入」→ 修复棒闭环后可合入。
- ④ 验证（编排者亲跑）：`pnpm -r build` 0 错 · typecheck 0 · eslint **0 error / 46 warning** · prettier 全绿 · 全量 **2653 passed + 5 skipped**（core 928+2 · gateway 40 · desktop 344+1 · cli 1341+2）；真机 smoke：legacy 默认路径实跑正常（help 15 条、模式命令诚实拒绝「仅 next 渲染层提供」）；**piped stdin 非 TTY，next 渲染层按设计不启用 → /fullscreen /minimal 往返与 Esc 真机语义归档真机清单（OPEN.md）**；next 路径行为由 p2c-wiring 15 例 + 接线测试覆盖。
- 状态归存：G-04/G-08/G-10/G-13 ✅、G-14/G-15/G-17/G-18/G-19/G-20 ✅、G-16 ➖（维持）、**G-01/G-02/G-03/G-05/G-06/G-07/G-09/G-11/G-12 🟡 下放 P3/P7**（minimal 基座、folds/block-ops/shell-mode 接线、turn 导航、vim prompt 侧、图片真机透传——明细见 refs 状态列与下一条目）。

## P3 CLI 命令面 + 阻塞卡片 + 队列/转向 + 状态行（3–4 天）

**依据**：G-21～G-49、G-50～G-90。

① 开发（三子代理并行，目录无交集）：

- A：命令面板——`Ctrl+P` / `?` palette、`/` 菜单模糊匹配、来源 badge、命令分组（G-31、G-50～G-53）；按 G-54～G-90 把命令补齐（**已存在内核能力的先接，尚无内核能力的不准建空菜单项**，改为归存到 P7）。目录：`packages/cli/src/tui/commands/**`。
- B：阻塞卡片层——四件套 + 优先级 permission > cancel-turn > question > elicitation（G-21～G-25）。目录：`packages/cli/src/tui/cards/**`。
- C：队列/转向 + 状态行——G-26～G-30（含 `follow_up_behavior = queue / steer`、send-now 和弦）、G-42～G-49。目录：`packages/cli/src/tui/queue/**`、`packages/cli/src/tui/status-line/**`。

② 测试：卡片优先级用例（同时到达时展示顺序）；状态行 stdin JSON 契约快照测试；超时/连续三次失败降级用例；队列保序与 send-now 取消语义。

③ 审查重点：**是否出现假入口**（菜单里有但点了没用）——发现即定 P0，必须删掉或实现。

④ 验证（编排者）：全局闸门 + 逐条点开 palette 里每一个命令，确认无“点了没反应”。

**退出闸门**：palette 内每一项都有真实行为或已从菜单移除；G-21～G-49 全部有归存。

## P4 桌面骨架：slot 组装 + 三栅布局 + 侧栏（3 天，可与 P2 并行）

**依据**：`refs-deepseek-harness.md` 的 D-01～D-25。

① 开发（两子代理并行）：

- A：slot 与布局——建 `packages/desktop/src/renderer/slots/`（single / keyed / list 三种席位，D-01～D-03）+ `AppFrame` 四席位（D-10）+ 拖拽缩放（D-11）+ **让步链**（D-12）+ 56px 轨道（D-13）+ 几何瞬时（D-14）+ 主题呈现器（D-15、D-16）。
- B：侧栏——品牌席位（D-20）、新会话作用域优先级（D-21）、收起动画（D-22）、会话列表席位（D-23）、滚动条可供性（D-24）、版本徐标（D-25）。

目录独占：A 只改 `packages/desktop/src/renderer/{slots,layout}/**`；B 只改 `packages/desktop/src/renderer/sidebar/**`（新建，取代 `SidePanel.tsx` / `SessionList.tsx`）。

② 测试：让步链用例（缩窗 → details 先缩后关、偏好宽度不被改写）、侧栏收起后 56px 轨道存在、`prefers-reduced-motion` 禁动画、新会话作用域四级降级。

③ 审查重点：面板几何是否真的**未持久化**（搜 `localStorage` 无命中）；旧的六页签 `PaneArea.tsx` 是否已拆掉而不是两套并存。

④ 验证（编排者）：全局闸门 + `pnpm --filter @harness2/desktop dev` 真实启动，手拖三栅、收起侧栏、缩窗到 900px 以下看让步。

**退出闸门**：D-01～D-25 全部有归存；`pnpm --filter @harness2/desktop smoke` 通过。

## P5 桌面对话页：视图环 + 乐观提交 + 队列/转向（3–4 天）

**依据**：D-30～D-39；队列/转向语义与 CLI 共用 core（不得再实现一遍）。

① 开发（两子代理）：

- A：视图注册表 + 视图环（D-30、D-32）、**视图选择规则 D-31（持久 > `chat` > 不渲染，绝不取首个）**、图片 URL 缓存（D-39）。
- B：composer——常驻挂载与引用 chip（D-33）、**乐观提交同事务**（D-34）、繁忙态 Queue/Steer 二选（D-35）、主按钮 Stop↔Queue Send（D-36）、上传队列（D-37，并发 2）、composer 链与 `ChainSelect`（D-38）。

② 测试：乐观提交同事务用例（Enter 后草稿立即空、撤销一步恢复）、`pendingSubmissions` 保序、失败重提不丢附件、视图选择规则三分支。

③ 审查重点：Queue/Steer 是否调的 core 同一套 API（与 CLI 一致）；是否出现桌面独有的业务分支。

④ 验证（编排者）：全局闸门 + 本地网关真实对话一轮（`http://127.0.0.1:40080/v1`、key `sk-unified-local`、模型 `big-pickle`），并在繁忙中按一次 Enter 验证队列/转向。

**退出闸门**：D-30～D-39 全部有归存；对话页能完成“新会话 → 发送 → 流式回复 → 队列追问 → 停止”完整回路。

## P6 桌面轨迹页 + 模型配置页 + 设置（4 天）

**依据**：D-40～D-47、D-50～D-59。

① 开发（三子代理并行，三页各一）：

- A 轨迹页：记录表（D-41）+ **时间概览（D-42，助手条区分 TTFT 与解码）** + 概览交互（D-43，悬停 500ms/拖选/缩放/平移）+ 检查器（D-44）+ 虚拟化（D-45，尾部 50）+ 浮层 composer（D-46）+ 诚实性（D-47）。
- B 模型配置页：提供方行 + 单卡编辑（D-50）、**单一密钥只写 + 派生 `<ROUTE>_API_KEY`（D-51）**、状态点保守规则（D-52）、自定义折叠区（D-53）、不放推理等级（D-54）、发现模型可搜索选择器（D-55、D-56）、校验（D-57）、revision 冲突（D-58）、删除与首运行（D-59）。
- C 设置壳 + 审批/工具卡：参照 D-6x 模块边界拆包（`ui-approval` / `ui-tool` / `ui-settings-general` 对应物）。

目录独占：A `renderer/trajectory/**`；B `renderer/settings/models/**` + 主进程凭据通道；C `renderer/settings/general/**` + `renderer/approval/**`。

② 测试：轨迹虚拟化（尾部 50 + 向前补页、行键稳定）、进行中不虚构耗时、密钥校验四类拒绝用例（非 ASCII / `NAME=value` / 引号包裹 / 空或重复 id）、`settings/conflict` 并发写用例。

③ 审查重点：**密钥是否真的从不回显、从不进 `config.json`**（搜渲染层是否持有明文）；轨迹页是否在无数据时也不崩。

④ 验证（编排者）：全局闸门 + 真机跑一轮：从模型配置页新增本地提供方 → 发一轮对话 → 轨迹页看到 TTFT 与解码段。

**退出闸门**：模型配置可以**完全不手改文件**完成（这是本阶段唯一硬指标）；D-40～D-59 有归存。

## P7 功能补齐（hermes 对标）（5 天）

**依据**：`refs-hermes-agent.md` 的 H-\*。本阶段专治“壳很好看但功能不够”。

**开头必须做的事**：编排者向人类确认决策点 **H-47（多平台网关是否纳入）**。未拍板之前不得扩大 `packages/gateway` 范围。

① 开发（三至四子代理并行，均在 `packages/core` 不同子目录）：

- A 记忆与自进化：H-20～H-22（经验造技能、主动持久化）。目录 `packages/core/src/memory/**`、`skills/**`。
- B 会话能力：H-11（全文搜索）、H-12（压缩分层）、H-13（可移植）、H-14（自动标题）。目录 `packages/core/src/session*/**`。
- C 工具与子代理：H-30、H-31（工具集成套分发）、H-41～H-43（**零开销轮次与并行扇出，优先级最高**）。目录 `packages/core/src/tools/**`、`src/subagent/**`。
- D 调度与审批：H-46（cron 自然语言）、H-44、H-66～H-68（审批/澄清/特权 flow，三壳共用）。

② 测试：每个 H-\* 一个用例；零开销轮次需断言**工具结果未进模型上下文**（统计 prompt token）；并行扇出需断言子代理隔离（主会话无子代理中间消息）。

③ 审查重点：新能力是否**三壳均可用**（而不是只接了 CLI）；是否遵循 H-70 两层分层。

④ 验证（编排者）：全局闸门 + 从 CLI 和桌面**各跑一遗编号**验证同一能力。

**退出闸门**：P3 归存到本阶段的命令菜单项全部已有真实实现或已移除；H-\* 必选项无未归存。

## P8 web 壳最小可用（2 天）

- 仅要求：会话列表 + 对话页 + 流式回复 + 停止；**组件从 desktop 抽共享包，禁止复制粘贴**。
- 接入方式：走现有 `serve` HTTP/WS（`/api/sessions`、`/ws`、`protocolVersion=2`、`x-harness2-token`）。
- 子代理 1 个即可；目录独占 `packages/web/**` + 新建共享包。
- **退出闸门**：浏览器能完成一轮真实对话；共享包重复代码率约为零（审查者目测即可）。

## P9 收口：全面验收、文档、发布准备（2 天）

- ① 按 `docs/SMOKE-TEST.md` 重跑全部用例，并**新增本次交付的用例**（CLI 双模式、palette、卡片、状态行、桌面三栅、轨迹、模型配置）。
- ② 回填三份 `docs/refs/refs-*.md` 状态列与本轮更新记录；更新 `docs/HANDOFF.md`、`docs/ROADMAP.md`、`docs/MASTER-PLAN.md`。
- ③ 审查：按硬规则六条逐条自检，输出一份“未完成事项清单”。
- ④ 验证：七个 CI job 全绿；`docs/RELEASE-CHECKLIST.md` 过一遗（发布本身仍需人类授权）。

## 5. 分支与提交纪律

- 每阶段一个分支：`feat/phase-<阶段号>-<slug>`（例 `feat/phase-p2-cli-skeleton`），从最新 main 开。
- 子代理**不单独开分支**，在阶段分支上按目录独占并行提交（这样不会出现历史上反复出现的两轨交叉问题）。
- 提交信息：`<gitmoji><type>(<scope>): <中文描述>`，首行 ≤ 50 字符；只显式 `git add`，禁 `-A`，禁 force push，禁在 main 上试错。
- 合入：阶段分支 CI 七 job 全绿 → `--no-ff` 合入 main → 一次推送 → 回查 run conclusion → 删除本地与远程分支。

## 6. 已知技术尾巴（任一阶段遇到就顺手收）

| 项                                                            | 建议阶段     |
| ------------------------------------------------------------- | ------------ |
| `packages/core/vitest.config.mts` 的 `include` 缺 `.tsx`      | P1           |
| node20 actions 残余（`upload-artifact@v4` 等）                | P9           |
| 46 个 eslint warning                                          | P9           |
| redo 渲染层零入口、文件树 IPC、主进程关窗口对话框自动化测试   | P5 / P6      |
| B6 发布授权（`npm view harness2`、`NPM_TOKEN`、tag `v1.0.0`） | P9（需人类） |

## 7. 给接手模型的零上下文开工提示

```text
你是本轮的编排者（不亲自写功能代码）。仓库：D:/AI_Projects/harness2（main）。
步骤：
1. 读 docs/refs/README.md，按 §2 六步流程刷新三份 docs/refs/refs-*.md（先 git fetch + pull --ff-only 三个参考仓）。
2. 读 docs/ai-framework/plans/2026-09-13-phase-shell-replication.md，从 P0 开始。
3. 每阶段固定四段：开发子代理（可并行，严格按目录独占表）→ 测试子代理 → 只读审查子代理 → 你亲自重跑全局闸门并真实启动一次。
4. 验证不通过的项不要原地死磕，按元规范 §4.1 显式下放到下一阶段，并在计划文件里写清原因。
5. 每阶段结束给我一份简报：完成项 / 下放项 / 闸门数字 / 下一阶段开工条件。
硬规则：不准假入口；每条 G-/D-/H- 编号必须有归存；交互改动必有自动化测试；不准为了绿而改测试；文档与代码同批提交；prettier --check . 含 .md 必须全绿。
```

## 8. 本计划的修订记录

| 日期       | 修订人                | 内容                                                                                                                                                                                          |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-13 | 编排会话（Notion AI） | 创建：P0～P9 十阶段，含并行窗口、目录独占表、四段子代理模式、反半成品硬规则、全局闸门、决策点 H-47                                                                                            |
| 2026-09-13 | 编排会话（本轮）      | P0 完成：三仓基线刷新（grok `37949780` / deepseek `c291e7961a` / hermes `79445a4` 未拉取待补）；refs 重分析 G-91～G-95、D-73～D-86、H-20 修正、三份文档补模板锚点；hermes 补拉登记 OPEN.md    |
| 2026-09-13 | 编排会话（本轮）      | P1 完成：命令注册表下沉 core（11 条业务 + describeCapabilities，导出面加性 499→522）、cli 三入口统一分发（`case '/` 清零）、20+75 条新测试、全量 2397+5；CI 加固与 lint 两条并入窗口；H-70 🟡 |
| 2026-09-13 | 编排会话（本轮）      | P2 完成：渲染模式层+输入焦点层（G-01~~G-20，246 例）+接线（Esc 新规格/fullscreen 八区域/15 命令）；审查回源 7 条一致；G-04/08/10/13、G-14~~20 ✅，9 条 🟡 下放 P3/P7；全量 2653+5             |
