# 阶段 14-激进-终端：交互复刻终端（T0–T5，ink TUI）

> **状态：** 计划已就绪（2026-09-08）；**修订 R3（2026-09-11）：并行双轨开工版 —— 本轨为「甲」，与桌面 D 轨同时进行**
> **来源：** `docs/research/notion-ai-20260908-0056/04-implementation-plan.md`（I1 R2）§7 的 T0–T5；本文档是其正式阶段化落地之一。方向未变（Grok 终端复刻保持），仅底座已扩为 S0–S7。
> **角色：** 激进版「终端 UI」owner。**依赖共享底座（现为 S0–S7；终端仅依赖 S0–S6，S7 为桌面功能契约）冻结后才能开工**；未冻结时可用协议 fixture 隔离开发 T3，但真实恢复/审批/任务必须联调，不能用 mock 冒充端到端。
> **开工闸门（R3 新增）：** 共享底座 S0–S7 已于 2026-09-08 完成；阶段 15 质量收口已于 2026-09-11 验收（CI 三平台 7/7 全绿）。本轨开工的硬前置是 **`docs/ai-framework/plans/2026-09-11-phase-foundation-patch.md`（地基补丁 P0–P4）合入 main 并宣布 core/gateway 冻结**。冻结后本轨对 `packages/core`、`packages/gateway`、`packages/desktop` 一律只读；边界与合入纪律以该文档「并行开工守则」小节为准。
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 终端打造成 Grok 式全屏应用：固定视口 + 完整多行编辑 + 粘贴 chip + 命令/参数候选 + 历史草稿 + 持久可展开的工具/推理/任务卡；长历史用虚拟化 viewport；忙时可草稿/排队、随时可停；退出干净无残留。**高保真，不是换皮。**
**Architecture：** 消费共享底座（S2/S3/S4/S5/S6）的契约帧；用 typed transcript（稳定 itemId，正文/工具/reasoning/attempt/child 分离）替换现在的 `string[]`+`Static`；输入用独立 reducer/normalize；保留 `legacy-chat.ts` 非交互路径逐字节不变。
**Tech Stack：** TS · ink · vitest · PTY/process fixture
**实施档位：** 全能（开发 + 测试 + 代码审查；Windows 真机/录屏属手工项）
**子代理：** 启用（代码审查 + 验收独立角色）

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | `docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`                                                                        |
| P0     | `docs/research/notion-ai-20260908-0056/04-implementation-plan.md`（I1 §7 T0–T5）                                                                |
| P0     | `docs/research/notion-ai-20260908-0056/01-grok-build-research.md`（终端复刻证据）                                                               |
| P1     | `docs/research/notion-ai-20260908-0056/03-harness2-core-audit.md`（H1/H2 缺口）                                                                 |
| P1     | `packages/cli/src/tui/runInkChat.tsx`、`Composer.tsx`、`Transcript.tsx`、`useTurnStream.ts`、`StatusBar.tsx`、`chat-setup.ts`；`legacy-chat.ts` |
| P1     | 共享底座契约（`packages/core/src/interaction/types.ts`、`runtime-journal.ts`、`task-coordinator.ts`，S 冻结后）                                 |

**仓库路径：** `D:/AI_Projects/harness2`
**基线分支 / worktree：** **从地基补丁阶段（P0–P4）的冻结 commit** 建 `feat/notion-i1-tui`。**别在主工作树切分支**；不删他人 worktree；git 不 reset/clean。**可 push 本分支**；合入 main 前该分支 CI 必须三平台全绿，并以 `--no-ff` 合入。

---

## Global Constraints（冲突时以本节为准）

1. **非交互路径逐字节不变（最高红线）**：`piped`/CI/测试/`--no-tui`/`HARNESS2_NO_TUI=1` 走 `legacy-chat.ts`，现有 `packages/cli/test/` 一条不能挂。
2. **不新增事件类型 / 不改内核编排**：只消费共享底座契约；`turn-end` 语义不变；不破坏轨迹不变量。
3. **真实恢复/审批/任务必须联调**：不得拿 fixture 成功冒充端到端。
4. 密钥不进 git；只显式 add 本任务文件（**禁 `git add -A`**）；修改同一文件前检查并发变化。**可 push 自己的分支 `feat/notion-i1-tui`；合入 main 前该分支 CI 必须三平台全绿，并以 `--no-ff` 合入；禁 force push、禁在 main 上试错。**
5. **并行边界（R3 新增，红线）**：本轨独占 `packages/cli/`；`packages/core/`、`packages/gateway/`、`packages/desktop/` 一律**只读**。需要改动它们时**停手**，在 `docs/issue-log/<日期>-T.md` 登记并上报编排者裁决，不得自行修改，也不得把 core 逻辑复制进 cli 绕过。根级 `pnpm-lock.yaml`、`package.json`、`tsconfig.base.json`、`.github/workflows/`、eslint / prettier 配置禁止擅改（新增依赖须先报备）。共享文档（`OPEN.md` / `DECISIONS.md` / `HANDOFF.md` / `MASTER-PLAN.md` / `CHANGELOG.md` / `ROADMAP.md`）阶段内不改，各自记在本计划文档里、合入后由编排者统一回填；日志只写 `docs/issue-log/<日期>-T.md`。完整边界表见 `2026-09-11-phase-foundation-patch.md` 的「并行开工守则」小节。
6. **明确不做（本阶段）**
   - ❌ 不整体移植 Grok 云端/认证/遥测/更新/语音栈
   - ❌ 不新增完整 Git 工作台 / 集成 shell 终端 / codemap
   - ❌ 不把「取消当 undo」；不对 shell/MCP 承诺 exactly-once
   - ❌ 不启动第二套 Codex 后端、不迁移 Tauri
7. **YAGNI**：输入/转录/滚动用够用的实现，不做可配置帧率矩阵。

---

## 阶段开头：上阶段遗留（必填）

> 上阶段（阶段 12 终端 TUI）已并入 main。但审计确认的终端侧缺口必须在本阶段闭环。
>
> **R3 补充（2026-09-11）：** 直接上阶段为**阶段 15 质量收口**（验收结论「✅ 有条件通过」，CI 三平台 7/7 全绿）。其验收表 §6 要求下一阶段逐条抄入，见下表。

### 阶段 15 遗留（抄自 `2026-09-09-phase-quality-closeout-acceptance.md` §6）

| 遗留项                                             | 处理方                        | 本轨动作                                                               |
| -------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| A3 P1-1：serve token 三端贯通 + 默认严格模式       | 地基补丁 **P2**（开工前完成） | 开工后 CLI 已自带 token；本轨**不得再改鉴权逻辑**                      |
| A3 P1-2：`waitForHealth` 把 401 当健康             | 地基补丁 **P2**               | 桌面侧，与本轨无关                                                     |
| A3 P2-3 / P2-1 / P2-2：playwright 降级、锁文件权限 | 地基补丁 **P3**               | core 侧，与本轨无关                                                    |
| A5 P1-1 / P1-2 / P1-3：网关挂死、双会话、测试缺口  | 地基补丁 **P0–P1**            | gateway 侧，与本轨无关                                                 |
| 「按 key 解析或新建会话必须做 in-flight 去重」     | 地基补丁 **P0** 定口径        | 本轨若引入任何「按 key 取或建」的缓存/会话逻辑，**必须同样做在途去重** |
| network 错误收尾 `finalText` 为空的展示语义        | 地基补丁 **P3** 一次定死      | **T3/T4 必须消费 P3 的定义，不得自行发明**                             |
| assistant / attempt 半截文本展示语义               | 地基补丁 **P3** 一次定死      | 同上；两端渲染语义必须一致                                             |
| 无独立人工审查（R7）、A4/B3 拆分类审查未派         | 地基补丁阶段补派              | 本轨阶段末**仍需**派独立只读子代理审查                                 |
| CI 首跑 POSIX 两平台红（R10）                      | ✅ 已闭环（main 7/7 全绿）    | 纪律沿用：**本轨分支 CI 红即停线**，不得合入                           |

### 阶段 12 终端侧遗留（原表）

| 上阶段遗留项                                                                                                  | 来源                   | 未通过原因                        | 状态              |
| ------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------- | ----------------- |
| H1：忙时输入/取消未接线（`Composer` `if(busy)return`、`submit` 未调 `abortTurn`、空闲首次 Ctrl+C 污染 draft） | 03-harness2-core-audit | 内核有 `abortTurn`，缺 UI 接线    | ⬜ 本阶段 T0 闭环 |
| H2：历史是 `string[]`、`Static` 不可交互卡片                                                                  | 03-harness2-core-audit | 运行后无法继续展开 reasoning/diff | ⬜ 本阶段 T3 闭环 |

---

## 跳过项（因档位未做，**非缺陷**）

| 跳过项                                                                       | 原因              | 待补做                    |
| ---------------------------------------------------------------------------- | ----------------- | ------------------------- |
| Windows 四环境真机手感（raw mode 进出/中文宽度/Ctrl+C 恢复/IME/Shift+Enter） | 需用户真机 + 录屏 | ⬜ 留「残留手工验收清单」 |
| 阶段三工作台级（codemap/文件树/集成终端）                                    | I1 明确不在本版   | ⬜ 另行立项               |

---

## File Structure（预期变更）

| 文件                                                                                    | 动作      | 职责                                                               |
| --------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `packages/cli/src/tui/runInkChat.tsx`                                                   | 修改      | T0：全局 abortTurn、幂等 shutdown、`/exit` 退出码0/确认 SIGINT 130 |
| `packages/cli/src/tui/Composer.tsx`                                                     | 修改/替换 | T1：完整多行编辑（reducer/null fokus）                             |
| `packages/cli/src/tui/input.ts`                                                         | 新建      | T1：input reducer/normalize/layout/focus                           |
| `packages/cli/src/tui/paste.ts`                                                         | 新建      | T2：分片 paste 原子插入/CRLF/chip/1MB                              |
| `packages/cli/src/tui/terminal-capabilities.ts`                                         | 新建      | T2：raw/alt screen/resize/cleanup + Windows 四场景闸门             |
| `packages/cli/src/tui/Transcript.tsx`、`useTurnStream.ts`、`StatusBar.tsx`              | 修改      | T3：typed transcript/reducer/viewport                              |
| `packages/cli/src/tui/task-panel.tsx`/`approval-panel.tsx`/`retry-panel.tsx`            | 新建      | T4：task/approval/retry/queue panels                               |
| 测试新增：`tui-keyboard`、`tui-paste`、`tui-shutdown`、`tui-transcript`、`tui-viewport` | 新增      | 全覆盖                                                             |

---

## 任务

### T0 — 取消/退出接线（依赖 S0，审批接 S2）

- 全局 `abortTurn`（内置）；幂等 `shutdown`（只调一次 finish，清 timer）；`/exit` 进程退出、锁/MCP 释放；legacy/ink 核心命令一致；能力缺失明确 disabled。忙时不禁草稿，Esc 停当前 turn，Ctrl+C 按明示退出协议（不把提示写入 draft）。
- 测：`tui-shutdown`（PTY 级）。Commit：`🐛feat(cli): 忙碌时可靠取消 + 幂等退出（T0）`

### T1 — 完整多行输入（依赖 T0）

- grapheme/视觉 cursor/软折行/词移动/Home/End/历史往返恢复原 draft 与 selection；IME/候选/Enter 优先级；Shift+Enter 换行（终端无法区分时提供 footer 替代键）。
- 测：`tui-keyboard`。Commit：`✨feat(cli): 完整多行输入编辑（T1）`

### T2 — 粘贴 chip + 终端能力（依赖 T1）

- 分片 paste 一次原子插入、CRLF/chip/1MB 限额、提交用完整原文（含 `/exit` 的 paste 不自动触发命令）；raw/alt screen/resize/cleanup；Windows 四场景能力闸门通过才默认开启，否则优雅降级 legacy。
- 测：`tui-paste`。Commit：`✨feat(cli): 大粘贴 chip + 终端能力闸门（T2）`

### T3 — typed transcript / viewport（依赖 T1/S3；可用协议 fixture 隔离开发）

- 结构事件身份 + 真实 tool output/diff；历史卡片可展开；session 切换重投影；follow/anchor/高度缓存；context 按 revision 刷新；reasoning 只展示 provider 明确暴露内容。
- 测：`tui-transcript`、`tui-viewport`。Commit：`✨feat(cli): typed transcript 分层渲染与虚拟化 viewport（T3）`

### T4 — task/approval/retry/queue panels + scheduler（依赖 T2/T3 + S4/S5）

- 有界 UI 批处理、输入优先、final flush；两审批/多任务；重试倒计时可停；step 解释→工具→解释顺序保真。
- 测：`tui-viewport` 扩充 + 审批/重试 panel 单测。Commit：`✨feat(cli): 任务/审批/重试/队列面板与有界调度（T4）`

### T5 — 兼容 steer 与 legacy + 压力，真机签收（依赖 T4/S6）

- 已实现 commands 可用；无 timer/子进程/锁遗留；参考 12 场景终端部分录屏签收。
- 测：PTY/进程/压力 fixture。Commit：`✅test(cli): 兼容 steer/legacy + 压力与退出无残留（T5）`

---

## 代码审查（阶段级，验收前）

**审查方：** 独立子代理（非实现者）；面：风格/测试完整性/依赖/架构红线（非交互路径不变、不新增事件类型）/API 契约一致性/安全。
**结论：** ✅ 通过 / ⚠️ 有条件通过 / ❌ 不通过

---

## 验收标准总表

| #   | 标准               | 通过条件                                                                                         | 验证责任人      |
| --- | ------------------ | ------------------------------------------------------------------------------------------------ | --------------- |
| 1   | 忙时可草稿/排队    | `tui-shutdown`+keyboard                                                                          | 自动化          |
| 2   | 随时可停/退出干净  | `/exit` 0、确认 SIGINT 130、无 timer/子进程/锁遗留                                               | 自动化（PTY）   |
| 3   | 完整输入           | grapheme/软折行/历史往返/paste 原子单测                                                          | 自动化          |
| 4   | typed transcript   | 结构分型/可展开/重投影/follow/锚点                                                               | 自动化          |
| 5   | 任务/审批/重试面板 | panel 单测 + 有界批处理                                                                          | 自动化          |
| 6   | 非交互路径不变     | `packages/cli/test/` 全绿                                                                        | 自动化          |
| 7   | 全量回归           | `pnpm -r test` 全绿（真实命中）                                                                  | 自动化          |
| 2b  | 代码审查           | ✅ / ⚠️；❌ 下放                                                                                 | 独立角色        |
| 8   | 红线/密钥          | 无禁止项、`git ls-files` 无敏感文件                                                              | 自动化          |
| 9   | 并行边界           | 未改 core/gateway/desktop 与根级配置；`api-surface-baseline.json` 无变化；日志只写 `<日期>-T.md` | 自动化 + 编排者 |
| 10  | 真实模型联调       | T5 用本地 `http://127.0.0.1:40080/v1`（`big-pickle`）跑通真实往返，非 fixture                    | 自动化 + 人工   |

---

## 风险与降级

| 风险                                | 缓解                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| ink 无法满足视口/Unicode/输入公平性 | T2 首做四环境能力闸门；硬伤停线并提供最小复现，不默认开启              |
| 依赖共享底座                        | 未冻结先用 fixture 隔离开发 T3；真实恢复/审批/任务必须联调             |
| 长历史性能                          | 虚拟化 viewport + 高度缓存；1000 条消息/万级事件/100k 连续流压力 trace |

---

## 给接手 AI 的完整提示词

> 复制以下整段给实施/审查子代理：

```
你是 harness2 激进版「终端（T0-T5）」的实现者。先完整读：
- docs/ai-framework/phased-plan-driven.md（元规范）
- docs/ai-framework/plans/2026-09-08-phase-aggressive-cli-interaction.md（本计划）
- docs/ai-framework/plans/2026-09-11-phase-foundation-patch.md（开工闸门 + 【并行开工守则】，边界以它为准）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md 的 §6（上阶段遗留）
- docs/research/notion-ai-20260908-0056/04-implementation-plan.md（I1 R2 §7）
- docs/research/notion-ai-20260908-0056/01-grok-build-research.md（终端复刻证据）

前提：共享底座 S0-S7 已完成（2026-09-08），阶段 15 质量收口已验收（2026-09-11，CI 三平台 7/7 全绿）。
开工闸门＝地基补丁阶段 P0-P4 已合入 main 并宣布 core/gateway 冻结；本计划从该冻结 commit 建分支
`feat/notion-i1-tui`。桌面 D 轨由另一人同期并行，两轨只经 main 交汇。
真实恢复/审批/子任务必须真联调，不能拿 mock 冒充端到端。

Global Constraints 优先级最高：
- 非交互路径逐字节不变：piped/CI/测试/--no-tui/HARNESS2_NO_TUI=1 走 legacy-chat.ts，
  现有 packages/cli/test/ 一条不能挂。
- 不新增事件类型、不改内核编排：只消费共享底座契约；turn-end 语义不变；不破坏轨迹不变量。
- 不做：Grok 云端/认证/遥测；Git 工作台/集成 shell/codemap；把取消当 undo；第二套 Codex 后端；Tauri。
- 命令 PowerShell 5.1 分行，每条查 $LASTEXITCODE；测试名真实命中 >0，禁止 --passWithNoTests 假绿。
- Git：只显式 add 本任务文件（禁 git add -A），小步 commit，提交格式 <gitmoji><type>(<scope>): <中文描述>；
  可 push 自己的分支 feat/notion-i1-tui；合入 main 前该分支 CI 必须三平台全绿并 --no-ff 合入；
  禁 force push、禁在 main 上试错、禁 --passWithNoTests、禁注释或删除失败用例。
- 并行边界（红线）：本轨独占 packages/cli。packages/core、packages/gateway、packages/desktop 只读；
  根级 pnpm-lock.yaml、package.json、tsconfig.base.json、.github/workflows、eslint/prettier 配置禁止擅改。
  需要改这些时停手，在 docs/issue-log/<日期>-T.md 登记并上报编排者，不得自行修改，
  也不得把 core 逻辑复制进 cli 绕过。新增依赖须先报备。
- 日志分文件：本轨只写 docs/issue-log/<日期>-T.md（四要素：需求描述/处理过程/修改结果/遗留风险）；
  不改 OPEN.md、DECISIONS.md、HANDOFF.md、MASTER-PLAN.md、CHANGELOG.md、ROADMAP.md（阶段末由编排者统一回填）。
- 本地真实模型（T5 联调用）：base URL http://127.0.0.1:40080/v1、key sk-unified-local、模型 big-pickle
  （200K 上下文、纯文本）；用隔离 --home，key 只写该目录下的 auth.json，不进 git。

每 Task：先写失败用例 → 最小实现 → 跑对应包测试 → 贴「实际命令+输出」。
最后跑 `pnpm -r test` 全量回归。完成后给出：worktree 名、commit 清单、逐 Task/验收结果、
真实测试输出、12 场景终端部分录屏/截图证据（无则标「仅源码规格，视觉待真机签收」）、已知风险。
```

---

## 残留手工验收清单

1. Windows Terminal / VS Code 集成终端 / cmd.exe / PowerShell 5.1：raw mode 进出、中文宽度、Ctrl+C 恢复、IME、Shift+Enter。
2. 真实模型端到端：完整多行/粘贴/历史草稿、忙时排队、随时停、退出干净，12 场景录屏对照。
