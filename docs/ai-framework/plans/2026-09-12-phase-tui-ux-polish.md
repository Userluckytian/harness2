# 阶段 TUI-UX：终端 TUI 交互 5 项修复

> **状态：** 计划已就绪（2026-09-12） · **实施档位：** 全能（默认） · **子代理：** 启用（实现 + 独立只读审查）
> **来源：** `docs/issue-log/2026-09-12.md` §2（用户真机实测反馈，5 条） · **设计参考：** `D:\AI_Projects\refs\grok-build`（Grok CLI/TUI，TUI crate = `crates/codegen/xai-grok-pager/`）
> **元规范：** `docs/ai-framework/phased-plan-driven.md` · **交接提示词**见文末

**Goal:** 修复终端 TUI（`packages/cli` Ink TUI）的 5 项交互问题：①子代理执行内容不可见 ②输入框锚底 + 转录鼠标滚动 ③`/mode` 等弹层位置 ④回合结束声音提醒 ⑤斜杠候选与审批提示移到输入框上方。

**Architecture:** 全部改动收敛在 `packages/cli/src/tui/`（必要时少量 CLI 内文件）。数据来源：`subagent_start` 的 `tool/result.output` 已含 `childSessionId`（JSON），CLI 用 `SessionManager.locate()` 定位子会话目录后只读重投影——**不需要改 core**。鼠标滚轮/终端焦点用原生 ANSI 序列（SGR 1006 鼠标上报、DECSET 1004 焦点事件）自行解析 stdin，不新增依赖。

**Tech Stack:** TypeScript / Ink 7 / React 18（ink 渲染）/ vitest（`packages/cli/test/tui/` 有 21 个既有用例文件）

---

## Global Constraints（冲突时以本节为准）

1. **冻结区不可动**：`packages/core/**`、`packages/gateway/**` 处于 2026-09-11 契约冻结；本阶段任何需要改它们的想法一律不做、不绕写，记入「风险/待解冻」。
2. **只动 `packages/cli`**（`git diff --name-only` 出现其他包 = 违规）；桌面端不在范围。
3. **不新增运行时依赖**；不为了鼠标/声音引入第三方包。
4. **配置面向后兼容**：提醒开关用环境变量（`HARNESS2_NOTIFY=always|unfocused|never`，缺省 `unfocused`；`HARNESS2_NOTIFY_METHOD=bel|osc9`，缺省 `bel`）——不改 core 的 config schema。
5. **既有键位/行为不回归**：PageUp/PageDown/Ctrl+G/Ctrl+O/Ctrl+R、Esc/Ctrl+C、`/undo` `/redo` 等语义与文案不变；piped/非 TTY 路径（legacy）零改动。
6. **Git**：从 `main` 拉 `feat/tui-ux-polish`；每 Task 小步 commit（`<gitmoji><type>(cli): 中文`）；**不 push**。
7. **YAGNI**：不做鼠标点击/选区、不做子代理实时流式桥接（只读磁盘重投影即可）、不做通知历史。
8. **明确不做**：`/tasks` 面板数据注入、桌面端对应交互、审批通知（本次只做回合结束提醒）。

---

## 阶段开头：上阶段遗留

| 上阶段遗留项 | 来源 | 未通过原因 | 状态 |
| ------------ | ---- | ---------- | ---- |
| 无（2026-09-12 冒烟 A/B/C 组验证见当日日志；本阶段为新需求，不阻塞） | — | — | — |

## 跳过项（因档位未做，非缺陷）

| 跳过项 | 原因 | 待补做 |
| ------ | ---- | ------ |
| 无 | — | — |

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
| ---- | ---- | ---- |
| `packages/cli/src/tui/runInkChat.tsx` | 修改 | 布局（T2/T3/T5）、子会话浮层入口（T1）、提醒接线（T4） |
| `packages/cli/src/tui/Composer.tsx` | 修改 | 候选列表渲染到输入行上方（T5） |
| `packages/cli/src/tui/OverlayHost.tsx` / `Modal.tsx` | 修改 | 浮层位置规则（T3/T5） |
| `packages/cli/src/tui/transcript.ts` / `TranscriptView.tsx` | 修改 | 工具卡携带 `childSessionId` 与「子会话」入口（T1） |
| `packages/cli/src/tui/terminal-events.ts` | **新建** | SGR 鼠标 + DECSET 1004 焦点序列解析（T2/T4） |
| `packages/cli/src/tui/notify.ts` | **新建** | 提醒策略（always/unfocused/never + bel/osc9）（T4） |
| `packages/cli/test/tui/*.test.tsx` | 新增/修改 | 各 Task 行为用例 |

---

## Task 1：子代理执行内容可见（子会话入口）

**Files:** `transcript.ts`、`TranscriptView.tsx`、`runInkChat.tsx`、`test/tui/tui-transcript.test.tsx`、新用例文件

**行为:**
- 工具卡渲染时，若工具名 ∈ {`subagent_start`,`subagent_continue`} 且 `tool/result.output` 可解析出 `childSessionId`，卡片显示「子会话 <id>」入口提示（不伪造：解析不到就不显示）。
- 键盘：`Ctrl+J` 打开当前选中工具卡（缺省 = 最近一张工具卡）的子会话只读浮层，内容 = 用既有 `projectSession()` 读子会话目录重投影的转录；`Esc` 关闭返回。子会话目录不存在/读取失败时显示如实错误文案。
- 浮层内不提供任何输入/undo/审批操作（纯只读）。

**Steps:** 1) 解析并挂载 childSessionId 到工具卡数据；2) 打开/关闭逻辑 + 浮层渲染（复用 Transcript/Modal）；3) 用例：构造含子会话目录的 fixture → 断言入口出现、打开显示子会话文本、坏目录显示错误、无 childSessionId 不显示入口；4) `pnpm --filter harness2 exec vitest run test/tui/tui-transcript.test.tsx` 期望 exit 0；5) commit `✨feat(cli): TUI 工具卡增加子会话只读入口（T1）`

**验收:** 上述用例 + 真机人工（真实模型派子代理后 Ctrl+J 查看）。

---

## Task 2：输入框锚底 + 鼠标滚轮滚动

**Files:** 新建 `terminal-events.ts`、`runInkChat.tsx`、`test/tui/terminal-events.test.ts`、`test/tui/viewport.test.ts`（扩展）

**行为:**
- 布局：`StatusBar` 顶 / 转录区吃剩余高度 / 面板区 / `Composer` 恒定屏幕最低行；浮层与面板出现时**不顶起**输入框；`stdout.rows` 变化（resize）不溢出（现有 `rows-8` 魔数改为结构化约束）。
- 鼠标：进入 alt-screen 时开启 SGR 鼠标上报（`\x1b[?1000h\x1b[?1006h`），退出时还原（`\x1b[?1006l\x1b[?1000l`）。滚轮上/下（`\x1b[<64;…M` / `\x1b[<65;…M`）映射既有 `scrollUp()/scrollDown()`（含锚定/恢复跟随语义）。
- 焦点：同时开启 DECSET 1004（`\x1b[?1004h`），解析 `\x1b[I`（focus in）/`\x1b[O`（focus out）供 T4 使用；退出还原。
- **降级条款**：若实测鼠标上报与 Ink 输入通道冲突（键盘/粘贴/IME 回归），允许仅保留 `terminal-events.ts` 的解析能力与布局修复，鼠标开关默认关闭并在报告与 OPEN.md 如实登记——不得为了滚轮破坏键盘。

**Steps:** 1) 布局重构；2) 序列解析模块 + 挂载/卸载；3) 单测（喂 SGR 序列断言滚动调用、喂焦点序列断言状态）；4) `pnpm --filter harness2 exec vitest run test/tui/terminal-events.test.ts test/tui/viewport.test.ts test/tui/keyboard.test.tsx` exit 0；5) commit `✨feat(cli): TUI 输入框锚底并支持鼠标滚轮/焦点事件（T2）`

---

## Task 3：`/mode` 等弹层位置

**Files:** `runInkChat.tsx`、`OverlayHost.tsx`、`Modal.tsx`、`test/tui/tui-transcript.test.tsx` 或新用例

**行为:** `/mode`、`/sessions`、`/help` 与确认框统一渲染在输入框上方区域（贴近底部、不顶到状态栏）；转录区被遮挡的行数有界（不超过弹层高度）；`Esc` 关闭后焦点回 Composer（既有互斥逻辑不变）。

**Steps:** 1) 调整渲染树/OverlayHost 定位规则；2) 用例断言浮层节点位于 Composer 之前且不与状态栏相邻（或按实现断言渲染顺序 + 高度约束）；3) 跑 `test/tui` 全目录 exit 0；4) commit `🎨style(cli): TUI 弹层统一渲染在输入框上方（T3）`

---

## Task 4：回合结束声音提醒

**Files:** 新建 `notify.ts`、`runInkChat.tsx`、`test/tui/notify.test.ts`

**行为:**
- `runTurnText` 收尾（含 `final`/`partial`/`empty` 终态）后按策略发提醒；`HARNESS2_NOTIFY`：`never`=不发、`unfocused`（缺省）=仅终端失焦时发、`always`=总是发；`HARNESS2_NOTIFY_METHOD`：`bel`（`\x07`，缺省）/`osc9`（`\x1b]9;…\x07`）。
- 非 TTY / legacy 路径不发（避免管道污染输出）；Ctrl+C 取消回合**不**发提醒（或按实现如发则报告说明）。
- 不得影响既有退出还原（BEL/OSC 写 stderr，不破坏帧）。

**Steps:** 1) 策略模块（纯函数可测）；2) 接线 + 焦点状态来自 T2；3) 单测：三种策略 × 焦点两态 × 方法两种；4) `pnpm --filter harness2 exec vitest run test/tui/notify.test.ts` exit 0；5) commit `✨feat(cli): TUI 回合结束提醒（默认失焦时响铃，可用环境变量关闭）（T4）`

**验收:** 单测 + 真机人工（失焦时回合结束应响，聚焦时不响）。

---

## Task 5：斜杠候选与审批提示移到输入框上方

**Files:** `Composer.tsx`、`runInkChat.tsx`、`ConfirmDialog.tsx`、`test/tui/composer.test.tsx`、`test/tui/approvals.test.tsx`

**行为:** 输入 `/` 时候选列表渲染在输入行**上方**（当前在下方，`Composer.tsx` L349-375）；审批 `ConfirmDialog` 同样贴输入框上方（复用 T3 的浮层位置规则）；总高度受 `rows` 约束，不把输入框挤出屏幕。

**Steps:** 1) 候选列表顺序调整；2) 审批位置接线；3) 用例断言渲染顺序（候选位于输入行之前）；4) `pnpm --filter harness2 exec vitest run test/tui/composer.test.tsx test/tui/approvals.test.tsx` exit 0；5) commit `🎨style(cli): 斜杠候选与审批提示移到输入框上方（T5）`

---

## 代码审查（阶段级环节，验收前）

**审查方：** 独立只读子代理（非实现者），按 `CODE_REVIEW.md` 出 P0/P1/P2 报告。

| 审查项 | 结论 | 问题清单 |
| ------ | ---- | -------- |
| 风格 | ⬜ | |
| 测试完整性 | ⬜ | |
| 依赖与架构红线（冻结区/新依赖） | ⬜ | |
| 安全（转义序列注入、子会话路径读取） | ⬜ | |
| 交互回归（键盘/粘贴/IME/legacy 路径） | ⬜ | |

---

## 验收标准总表

| # | 标准 | 通过条件 | 验证责任人 |
|---|------|----------|------------|
| 1 | T1~T5 行为用例 | `pnpm --filter harness2 exec vitest run test/tui` exit 0，新增用例先红后绿 | 实现方 + 编排者复跑 |
| 2 | cli 全量 | `pnpm --filter harness2 test` exit 0（基线 281 passed + 2 skipped，只增不减） | 编排者 |
| 3 | 全量闸门 | `pnpm test` / `pnpm -r typecheck` / `pnpm lint` exit 0 | 编排者 |
| 4 | 边界 | `git diff --name-only main..HEAD` 仅 `packages/cli/**` + docs；`api-surface-baseline.json` 零变化 | 编排者 |
| 5 | 代码审查 | 结论 ✅ 或 ⚠️（问题已登记）；❌ 阻塞 | 独立子代理 |
| 6 | 真机 | T1~T5 在 Windows Terminal 人工确认（滚动/响铃/浮层位置/候选位置/子会话入口） | 用户 |
| 7 | 密钥 | 无新增凭据入 git | 编排者 |

---

## 风险与降级

| 风险 | 缓解 |
| ---- | ---- |
| 鼠标上报与 Ink/IME 冲突 | T2 降级条款：保留布局修复，鼠标默认关闭，如实登记 |
| 子会话大转录导致浮层卡顿 | 浮层复用 Transcript 虚拟化；只读、不订阅 |
| 焦点事件在不支持终端缺失 | 缺省按「未失焦」保守处理（unfocused 策略下不响），提供 always |
| 转义序列注入风险 | 提醒/鼠标序列只写固定 ANSI；子会话文本只经 Ink Text 渲染，不拼注释 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行**本阶段计划，不要只写方案；不要改冻结区（`packages/core`、`packages/gateway`）。

### 基线
- 目录：`D:\AI_Projects\harness2`（bash: `/d/AI_Projects/harness2`）
- 从 `main` 创建并切换：`git switch -c feat/tui-ux-polish`
- 唯一实施计划：`docs/ai-framework/plans/2026-09-12-phase-tui-ux-polish.md`（先完整读）
- 参考实现（只读）：`D:\AI_Projects\refs\grok-build\crates\codegen\xai-grok-pager\src\`（`slash/`、`notifications/`、`scrollback/`、`app/mouse.rs`）
- 问题原文：`docs/issue-log/2026-09-12.md` §2

### 做
按 Task 1→5 顺序执行；每 Task 先写/改用例（先红后绿），跑计划里的验证命令，然后 commit。

### 不做
- 改 `packages/core` / `packages/gateway` / `packages/desktop`
- 引入新运行时依赖；改 legacy（非 TTY）路径行为
- `git push`；提交任何密钥
- 鼠标滚轮若被证实与键盘/IME 冲突：按 T2 降级条款处理并如实登记，不许硬塞

### 工作方式
1. 开工先 `git status`（工作树应干净）+ `pnpm --filter harness2 exec vitest run test/tui` 确认基线绿。
2. 严格按 Task 顺序；证据优先，完成前重跑验证命令。
3. 全部完成后自评验收表（第 1 项）并给出：分支名、提交列表、测试输出摘要、未决风险。

现在开始：读完计划，从 Task 1 执行到 Task 5。

---

## 残留手工验收清单

1. Windows Terminal：滚轮滚动、输入框贴底、`/mode` 位置、`/` 候选位置、审批位置、回合结束响铃（失焦时）。
2. 真实模型派子代理后：工具卡「子会话」入口 + `Ctrl+J` 只读查看。
3. IME / 粘贴 / Ctrl+C / `/exit` 回归（T2 改动后重点）。
