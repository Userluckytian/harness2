# 阶段（终端轨道）：CLI 全屏 TUI 改造（ink）+ 计划审批态

> **状态：** 计划已就绪
> **For agentic workers：** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`
> **唯一实施来源：** `docs/research/2026-09-07-terminal-desktop-implementation-plan.md`（阶段一）。本文档是它的**正式阶段化落地**，二者冲突时**以本文档为准**，但方向与做法不偏离来源文档。

**Goal：** 把 `harness2 chat` 从「逐行追加输出的 readline REPL」升级为「撑满终端的高度、常驻状态栏 + 可滚动历史 + 常驻输入框 + 真实弹窗」的全屏交互（对标 Grok Build 的 `xai-grok-pager` 体验层次），同时**保证一切非交互路径（管道/CI/测试/`--no-tui`/`HARNESS2_NO_TUI=1`）行为逐字节不变**。
**Architecture：** 引入 `ink`（React 化终端 UI 库，Node 生态最接近 ratatui 的方案）搭建全屏 App Shell；用 `legacy-chat.ts` 完整保留原 readline 路径（字符级不动），`chat.ts` 变成纯分流入口；两路径共享**同一套会话装配**（`chat-setup.ts`）与**同一份命令注册表/模式别名/`@file` 协议**，避免分叉；唯一的内核改动是新增 `plan` 第四审批态（T1）与一个只读 `getContextUsage` 导出。
**Tech Stack：** `ink` + `react` + `string-width`（东亚宽字符）+ `diff`（diff 高亮）；`packages/core` 的 `schema.ts`/`policy.ts` 各加一处。Node ≥22，ESM。
**实施档位：** 全能（开发 + 测试 + 代码审查）。**端到端/真机 Windows 终端验证属手工项，列「残留手工验收清单」，不由执行方自判通过。**
**子代理：** 建议启用（用于代码审查 + 验收的独立角色）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | `docs/ai-framework/phased-plan-driven.md` |
| P0 | `docs/research/2026-09-07-terminal-desktop-implementation-plan.md`（阶段一全文） |
| P0 | `packages/cli/src/chat.ts`、`render.ts`、`commands.ts`、`packages/cli/src/index.ts` |
| P0 | `AGENTS.md`、`CODE_REVIEW.md` |
| P1 | `packages/core/src/config/schema.ts`、`packages/core/src/approval/policy.ts` |
| P1 | `packages/cli/package.json`、`tsconfig.json`、`tsconfig.build.json`、`docs/ROADMAP.md` |
| P2 | `arch` 参照：`D:\AI_Projects\refs\grok-build`（`xai-grok-pager` 的 modal/picker/overlay）——只做交互形态参考，**不照抄代码** |

**仓库路径：** `D:\AI_Projects\harness2`（本文后续用 `<root>` 指代）
**基线分支：** 从 `main` 拉 `feat/terminal-tui`

---

## Global Constraints（冲突时以本节为准）

1. **非交互路径逐字节不变（最高红线）**：`piped` 输入 / CI / 测试 / `--no-tui` / `HARNESS2_NO_TUI=1` 五种情况，必须走**原样搬迁的 `legacy-chat.ts`**，输出与改动前 `chat.ts` 字符级一致。现有 `packages/cli/test/` 全部测试（尤其 `chat.test.ts`、`chat-cancel.test.ts`、`crash-drill.test.ts`）**一条不能挂**。改 T0/T1/T2 前先跑绿基线。
2. **`packages/core` 默认不动**，只允许两处、且都是窄口子：
   - **T1（唯一逻辑例外）**：`schema.ts` 的 `ApprovalMode` + `APPROVAL_MODES` 各加 `'plan'`；`policy.ts` 的 `decide()` 在 `bypass` 分支后加一个 `if (mode === 'plan')`。**不得**借机改动审批之外的任何内核子系统。
   - **T6（只读导出例外，源计划授权）**：新增只读 `getContextUsage(sessionId)` 导出（暴露已有压缩阈值的占用比例），**不改**压缩算法/事件溯源逻辑。
3. **新依赖（实现前需确认）**：`ink`、`react`、`@types/react`、`string-width`、`diff`、`@types/diff`。来源文档已论证引入 `ink` 的收益与风险（Windows 兼容必须在 T0 验证）。**不引** `react-dom`（ink 自带 reconciler）。
4. **配置落盘口径**：`/mode` 切换**只作用于当前进程/会话**，**不写回 `config.json`**；`plan` 态通过 T1 内核支持，但会话级默认仍读 `config.json` 的 `approval.mode`。
5. **两路径功能对等**：任何新增交互（`/mode`、`/context`、`/sessions`、`/help`、`/tasks`、`/reasoning`、`@file`）**必须同时**让 legacy 纯文本路径可用（呈现形式不同，能力等价）。
6. **密钥/凭证不进 git**；默认**不 push**，除非人类明确授权。
7. **明确不做（本阶段）**：
   - ❌ 不引 `react-dom`、不换 `/review` 之外的框架、不做 alt-screen 主题商店/Vim 模式/鼠标全屏（ratatui 级重型能力，来源文档 §2.3 已列为「不建议」）。
   - ❌ 不做 `/mode` 之外的其它运行时模型切换（G8 属阶段三）。
   - ❌ 不改事件溯源、压缩算法、Provider 协议。
8. **Git：** 每个 Task 小步 commit（见 AGENTS.md 规范）；**默认不 push**。

---

## 阶段开头：上阶段遗留（必填小节）

> 规则：把上一阶段验收表中 ⬜/❌ 项原文抄入。本轨道是新增量（独立于既有 1~12 生命周期阶段、后于 M4），**无生命周期意义上的上阶段**。但**有一项既有已知缺陷必须带入本阶段优先处理**（来源 `docs/issue-log/OPEN.md`）。

| 上阶段遗留项 | 来源（测试/验证/审查） | 未通过原因 | 状态 |
|-------------|----------------------|-----------|------|
| Windows 下 `bash` 工具 `spawn(command,{shell:true})` 走 cmd.exe，`ls/head/tail/pwd` 报「不是内部或外部命令」；输出 GBK 乱码；`browser_navigate` 未装 chromium。来源：2026-09-07 抓新闻 25 步 maxSteps 未回复 Bug | 验证（window terminal 实测） | Windows 适配缺陷 | ⬜ 带本阶段 T0/T2 一并评估（见 Task 2 风险，T0 决定是否连同修） |
| 无 | — | — | — |

> 说明：上表第 1 行与来源计划 **T0 的 Windows 兼容性验证强相关**。本阶段**不承诺修 bash/cmd 适配**（那是独立缺陷，见 OPEN.md「待后续分析解决」），但在 T0 的四环境验证中必须**记录**该缺陷是否影响 ink raw-mode/中文宽字符判断，作为 T2 是否全量启用的决策依据之一。

---

## 跳过项（因档位未做，非缺陷，待补做）

> 规则：只记「因档位/子代理选择而未做」的项，不自动下放。

| 跳过项 | 原因 | 待补做 |
|--------|------|--------|
| 端到端真机验证（Windows Terminal / VS Code 终端 / cmd.exe / PowerShell 5.1 四环境逐项） | 属「端到端验收」，需用户/真机，执行方不自判 | ⬜ 待用户/真机补做（见「残留手工验收清单」） |
| macOS / Linux 终端实测 | 跨平台真机，需部署机 | ⬜ 待部署机补做 |
| 代码审查 | 独立角色（子代理）执行，见「代码审查」节 | ⬜ 独立审查方执行 |

---

## 与前后阶段

| 阶段 | 状态 | 交付 |
|------|------|------|
| 既有生命周期 1~12（M4 v1.0.0） | ✅ | 会话内核、CLI/桌面/网关三形态、发布物料。功能已齐 |
| **本阶段（终端轨道）** | ⬜ | CLI 全屏 TUI（T0~T9）+ `plan` 审批态 |
| 阶段二（桌面轨道，另一文件） | 🔶 并行 | 桌面设置面板 + 视觉对齐 Codex（B0~B9，与本轨道互不依赖） |
| 阶段三（工作台级） | ⬜ 勿塞进 | 文件树/终端面板/Todo/子代理树/codemap 等（G1~G15），**交付本轨道并收到用户反馈后另行立项** |

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/cli/package.json` | 修改 | 加 `ink`/`react`/`@types/react`/`string-width`/`diff`/`@types/diff` 依赖 |
| `packages/cli/tsconfig.json` | 修改 | 加 `"jsx": "react-jsx"` 与 `@types/react` |
| `packages/cli/tsconfig.build.json` | 修改 | 同上 JSX 配置 |
| `packages/cli/src/legacy-chat.ts` | 新建 | 原 `chat.ts` 全文原样搬入 + `runLegacyReadlineChat` 重命名（行为零改） |
| `packages/cli/src/chat.ts` | 修改 | 精简为分流入口（调用 `runInkChat` / `runLegacyReadlineChat`） |
| `packages/cli/src/chat-setup.ts` | 新建 | `setupChatSession(options)` 共享装配（provider/审批/记忆/压缩/插件/MCP/subagent/会话解析） |
| `packages/cli/src/command-registry.ts` | 新建 | 斜杠命令元数据（名称+一句话），legacy 与 ink 共用 |
| `packages/cli/src/mode-alias.ts` | 新建 | `normal/allow-approve/auto/plan` ↔ 内核 mode 别名映射 |
| `packages/cli/src/context-ref.ts` | 新建 | `@file`/`@dir` 引用解析（发送前预处理，两路径共用） |
| `packages/cli/src/tui/App.tsx` | 新建 | ink 三段式 App Shell（StatusBar/Transcript/Composer） |
| `packages/cli/src/tui/runInkChat.ts` | 新建 | ink 路径入口 + 事件桥接到 React state |
| `packages/cli/src/tui/Composer.tsx` | 新建 | 常驻多行输入框 |
| `packages/cli/src/tui/Transcript.tsx` | 新建 | 历史/未完成分层渲染 + 工具卡片 |
| `packages/cli/src/tui/useTurnStream.ts` | 新建 | 桥接 `runTurn` 事件到 state（节流合并） |
| `packages/cli/src/tui/StatusBar.tsx` | 新建 | 状态栏（模式/模型/cwd/上下文占用） |
| `packages/cli/src/tui/Modal.tsx` 等 | 新建 | `SelectList.tsx`/`ConfirmDialog.tsx`/`ScrollableList.tsx`/`OverlayHost.tsx` |
| `packages/cli/src/tui/ReasoningBlock.tsx` | 新建 | reasoning 折叠块 |
| `packages/cli/src/tui/DiffCard.tsx` | 新建 | write/edit 结果红绿 diff |
| `packages/cli/src/tui/overlays/*.tsx` | 新建 | 具体弹窗（mode/sessions/help/tasks） |
| `packages/cli/test/` | 新增 | 覆盖 `plan` 态、`@file`、`/mode` 别名、legacy 兼容回归 |
| `packages/core/src/config/schema.ts` | 修改 | T1：`ApprovalMode` 加 `'plan'` |
| `packages/core/src/approval/policy.ts` | 修改 | T1：加 `if (mode === 'plan')` 分支 |
| `packages/core/src/`（导出） | 修改 | T6：新增只读 `getContextUsage` 导出 |
| `docs/issue-log/2026-09-07.md` | 修改 | 记录 T0 四环境验证结果与决策分支 |

---

## 配置或 API 契约（如有）

**`packages/core` 审批态从 3 变 4（向后兼容：旧的 3 态值仍合法，新增 `'plan'` 仅作加法）：**

```
ApprovalMode = 'default' | 'acceptEdits' | 'bypass' | 'plan'   // schema.ts
APPROVAL_MODES = ['default', 'acceptEdits', 'bypass', 'plan']  // schema.ts
```

**`createApprovalPolicy({ mode: 'plan' })` 决策语义（T1）：**

| 工具 | per-tool 规则（最高优先） | mode=plan 推导 |
|------|--------------------------|----------------|
| `read`/`glob`/`grep` | allow/ask/deny 覆盖 | `allow` |
| `write`/`edit`/`bash` | allow/ask/deny 覆盖 | `deny` |
| 其它 | allow/ask/deny 覆盖 | `deny`（非安全集） |

> per-tool 显式 `allow` 在 `plan` 模式下仍放行——这是**有意保留的口子**（用户显式手势优先）。

**新增只读导出（T6，core）：`getContextUsage(sessionId: string): number`** —— 返回上下文占用百分比（0~1），复用现有压缩阈值计算，**不改算法**。若不使用 `sessionId` 的调用面（如注入 renderer），可接受一个宽松签名并在代码注释说明。终端 StatusBar、`/context` 命令、桌面端 B4 水条**三处共用同一数据源**（禁止三套算法）。

**`HARNESS2_NO_TUI=1` / `--no-tui`：** 强制走 `legacy-chat.ts`（逃生舱，T0 提供）。

**`HARNESS2_TUI`（可选，T0 决定）：** 用于显式开启 ink（调试用）；默认行为由 T0 的「现代终端检测」决定。

---

## Task 0（T0）：技术选型验证——ink 全屏模式在真实 Windows 终端下能否用

**Files：** 临时验证脚本 `packages/cli/scripts/tui-spike.tsx`（验证后可删或留作手工回归脚本）；`docs/issue-log/2026-09-07.md`（记录结果）。

**行为：** 一个最小 ink 全屏 demo：`<Static>` 渲染 30 行模拟历史 + 底部方向键可选列表 + 受控输入框。**不进入正式代码库结构。**

**Steps：**

1. 确认基线干净：`pnpm -r typecheck && pnpm -r test` 全绿（改什么之前先跑一次，避免把既有红混进本阶段）。
2. 给 `packages/cli` 临时加 `ink`/`react`/`@types/react`/`string-width` 依赖并配 `tsconfig` JSX（此为后续 Task 的正式前置，T0 一并落地；若用户拒绝引入 `ink`，此处即触发降级——见「风险与降级」）。
3. 写 `tui-spike.tsx`，在**四个环境**各跑一遍：Windows Terminal、VS Code 集成终端、`cmd.exe`、Windows PowerShell 5.1（非 pwsh 7）。逐项记录：
   - raw mode 进入/退出是否干净（退出后 `cmd.exe` 提示符有无残留控制字符 / 方向键失灵）。
   - 中英文混排时行宽是否对齐（ink 默认按字符数不按东亚宽度，验证是否需 `string-width`）。
   - `Ctrl+C` 能否终止进程并恢复终端。
4. 加逃生舱：`HARNESS2_NO_TUI=1` 与 `--no-tui` 强制回退 legacy（T0 先做钩子，T2 接线）。
5. **决策分支（必须落进 `docs/issue-log/2026-09-07.md`，供 T2 直接执行，不再二判断）**：
   - 四环境全过 → T2 默认所有 TTY 启用 ink。
   - `cmd.exe`/PowerShell 5.1 有硬伤 → T2 加「现代终端检测」：`process.env.WT_SESSION`（=Windows Terminal）、`process.env.TERM_PROGRAM==='vscode'`（=VS Code 终端）；两者都无 → 走 legacy（安静降级，不报错不提示）。
   - 中文宽度错位 → 用 `string-width` 做所有对齐行宽计算，不自写宽度表。
6. Commit（如保留 spike 脚本）：`✨feat(cli): T0 ink 兼容性 spike 与决策记录`（或暂时不 commit，先记录日志）。

**验收标准：**
- `docs/issue-log/2026-09-07.md` 有完整的四环境验证记录 + 明确的决策分支结论（「默认全量」还是「仅现代终端」）。
- `HARNESS2_NO_TUI=1`/`--no-tui` 能强制回退（钩子可用）。
- `pnpm -r typecheck && pnpm -r test` 全绿（基线未红）。

---

## Task 1（T1）：内核侧新增 `plan` 第四审批态（core 唯一逻辑例外）

**Files：** `packages/core/src/config/schema.ts`、`packages/core/src/approval/policy.ts`、`packages/core/test/`（新增单测，命名如 `approval-policy-plan.test.ts`）。

**行为：** 已核对现状：`ApprovalMode = 'default' | 'acceptEdits' | 'bypass'`、`APPROVAL_MODES = [default, acceptEdits, bypass]`、`createApprovalPolicy` 的 `decide()` 按 per-tool 优先、`bypass`/`acceptEdits` 分支、尾部 `safeTools` 兜底。`plan` 模式目前不存在。

**Steps：**

1. `schema.ts`：`ApprovalMode` 加字面量 `'plan'`；`APPROVAL_MODES` 数组加 `'plan'`（置于末尾，`default/acceptEdits/bypass` 顺序不变）。
2. `policy.ts`：`decide()` 中，在 `if (mode === 'bypass') return 'allow';` 之后加：
   ```ts
   if (mode === 'plan') return safeTools.has(input.tool) ? 'allow' : 'deny';
   ```
   `per-tool` 规则判断保持在最前不变。
3. 新增单元测试（`createApprovalPolicy({ mode: 'plan' }, safeTools)`）：
   - `read/glob/grep` → `allow`；
   - `write/edit/bash` → `deny`；
   - per-tool 显式 `allow`（如 `{ tools: { bash: 'allow' } }`）时即使 mode=plan 也返回 `allow`。
   - 同时补一条回归断言：`plan` 态不影响 existing 模式（`default/acceptEdits/bypass` 期望值不变）。
4. 跑：`pnpm --filter @harness2/core test`。期望：新增用例绿 + 既有用例期望值零改动仍绿。
5. 跑全量：`pnpm -r typecheck && pnpm -r test`。期望：全绿。
6. Commit：`✨feat(core): 新增 plan 第四审批态（只读工具 allow，其余 deny，per-tool 覆盖优先）`

**验收标准：** 上述 3 条决策 + 回归；`pnpm -r typecheck && pnpm -r test` 全绿；**不改任何既有测试的期望值**。

---

## Task 2（T2）：拆分 legacy 路径 + 搭建 ink App Shell 骨架（本轨道地基）

**Files：** `packages/cli/src/legacy-chat.ts`、`package.json`（依赖已由 T0 加）、`tsconfig*.json`（JSX 已由 T0 加）、`packages/cli/src/chat.ts`、`packages/cli/src/chat-setup.ts`、`packages/cli/src/tui/App.tsx`、`packages/cli/src/tui/runInkChat.ts`。

**行为：**

1. `runChat(options)` 改成**薄分流**：
   ```
   runChat(options):
     若 isTTY && !(HARNESS2_NO_TUI || --no-tui) && (T0 决策==全量启用 || T0 现代终端检测通过)
       → runInkChat(options)
     否则 → runLegacyReadlineChat(options)
   ```
   `runLegacyReadlineChat` = 原 `chat.ts` 的 `runChat` 全文原样搬迁（改函数名与文件位，行为零改），继续导出 `MOCK_DEMO_SCRIPT`/`MOCK_CHILD_DEMO_SCRIPT`/`ChatOptions`（`index.ts` 等处引用不破坏）。
2. 把 `legacy-chat.ts` 里「provider/审批/记忆/压缩/插件/MCP/subagent/会话解析」这段装配抽成 `chat-setup.ts` 的 `setupChatSession(options)`，返回 `{ provider, approval, tools, sessionManager, current, ... }`；`legacy-chat.ts` 与 `runInkChat.ts` 都调用**同一个**函数（禁止两套装配）。
3. `App.tsx` 三段式布局（ink `<Box flexDirection="column">` 撑满终端高度 + `useStdout` 响应尺寸）：
   - 顶部 `<StatusBar />`（1 行，T6 填真）
   - 中间 `<Transcript />`（`flexGrow:1`，可滚动，T4 填真）
   - 底部 `<Composer />`（2~3 行，T3 填真）
4. App 顶层维护核心 state：`messages`、`mode`、`activeOverlay`、`contextUsage`。数据流：`runTurn` 事件经回调桥接进这些 setter（不再像 legacy 那样 `renderer.textDelta` 直写 stdout）。
5. **T2 只要求骨架 + 分流 + 装配共享跑通**，`Composer`/`StatusBar`/`Transcript` 可以先用占位（一个输入框能输入回车发消息 + 历史区能追加文本即可），后续 Task 填细节。

**Steps：**

1. **先搬迁**：把 `chat.ts` 全文复制为 `legacy-chat.ts`，改导出名为 `runLegacyReadlineChat`，原 `chat.ts` 引 `import { runLegacyReadlineChat } from './legacy-chat.js'`。**此时先跑绿**：`pnpm --filter harness2 test`。期望：`chat.test.ts`/`chat-cancel.test.ts` 等全绿（证明行为零改）。
2. 抽 `chat-setup.ts`（只搬不移：从源码原样抽段，行为不变）。
3. 加 `tui/App.tsx` + `runInkChat.ts`（占位实现）。
4. `chat.ts` 改分流入口。
5. 跑：`pnpm -r typecheck && pnpm -r test`。期望：全绿。
6. 冒烟：`node packages/cli/dist/index.js chat --provider mock`（TTY）应看到三段式布局；`HARNESS2_NO_TUI=1 node ... chat --provider mock` 应与改动前一致。
7. Commit（分步）：先 `♻️refactor(cli): 拆分 legacy 路径为 legacy-chat.ts + 分流入口`，再 `✨feat(cli): ink App Shell 三段式骨架 + 共享会话装配`。

**验收标准：**
- TTY/现代终端下冒烟能看到三段式布局撑满终端。
- `--no-tui`/非 TTY 下输出与改前 `chat.ts` 逐字符一致（跑 `chat.test.ts` 等证明）。
- `pnpm -r typecheck && pnpm -r test` 全绿。

---

## Task 3（T3）：Composer——常驻多行输入框

**Files：** `packages/cli/src/tui/Composer.tsx`。

**行为：** 自实现一个最小多行输入（不追求 Grok `xai-ratatui-textarea` 全部功能）：
- 受控 `value` + `cursor`。
- `useInput`：可打印字符插入光标位；`Backspace`/`Delete` 删除；左右键移光标；`Enter` 发送（清空，触发发送回调）；`Shift+Enter` 或行尾 `\` 续行不发送；上下键在本会话已发送历史回溯/前进（仅本会话，不跨会话持久化）；`Ctrl+C` 两次退出；空 buffer 时 `Ctrl+D` 退出。
- 复用现有退出逻辑。

**Steps：**

1. 实现 `Composer.tsx`（受控输入态 + 按键处理）。
2. 在 `App.tsx` 中挂到底部，与发送回调接通（发送 → 走 `setCurrent`/`runTurn` 语义）。
3. 中英文混排输入、光标移动、删除、换行、历史回溯人工冒烟。
4. Commit：`✨feat(cli): Composer 常驻多行输入框`

> 若个别方向键/组合键在特定终端识别不出，记录进 `docs/issue-log/2026-09-07.md` 的「已知问题清单」，不强求第一版覆盖所有边缘按键。

**验收标准：** 中英文混排连续输入、光标移动/删除/换行/历史回溯正常；Enter 发送后清空并聚焦。

---

## Task 4（T4）：Streaming 状态管理 + Transcript 渐进渲染（工具调用卡片化）

**Files：** `packages/cli/src/tui/Transcript.tsx`、`packages/cli/src/tui/useTurnStream.ts`。

**行为：**
- **历史/未完成分层**：完结消息用 `<Static items={completedMessages}>`（只渲一次，避免长会话/滚动区闪烁）；当前流式中的最后一条用普通 `<Box>` 渲染（只有这一小块随 state 重绘）。
- **节流合并**：`textDelta` 增量先入 ref 缓冲，约 50ms 或攒够一定字符数才 flush 一次到 state（一次真正重绘）。
- **工具卡片**：legacy 的 `> tool (args)` 单行文本 → `<ToolCallCard tool status="pending|ok|failed">`，pending 显示 spinner，完成显示状态图标 + 参数摘要（**复用 legacy `render.ts` 的 `summarizeArgs`，别重写截断**）。
- `render.ts`/`StreamRenderer` **保持不动**，供 legacy；ink 路径**不 import 它**，独立一套（两套并存，不互相替代）。

**Steps：**

1. 实现 `useTurnStream`（桥接 `runTurn` 事件 → React state，含节流）。
2. 实现 `Transcript.tsx`（`<Static>` + 流式区 + `ToolCallCard`）。
3. 长会话（50+ 条）冒烟：Windows Terminal 下看是否明显闪烁/卡顿。
4. Commit：`✨feat(cli): Transcript 分层渲染 + 工具调用卡片 + 流式节流`

**验收标准：** 流式输出不明显闪烁（Windows Terminal 实测）；50+ 条滚动区不卡顿；工具调用可见 pending→ok/failed 状态变化。

---

## Task 5（T5）：弹窗/浮层组件库

**Files：** `packages/cli/src/tui/Modal.tsx`、`SelectList.tsx`、`ConfirmDialog.tsx`、`ScrollableList.tsx`、`OverlayHost.tsx`。

**行为：**
- `Modal.tsx`：居中边框容器（`<Box borderStyle="round">`）+ 标题 + 内容 + 底部操作提示，`Esc` 关闭（关闭回调由调用方传入）。
- `SelectList.tsx`：上下键高亮、Enter 确认、Esc 取消，选项 `{label,value,description?}`。
- `ConfirmDialog.tsx`：审批场景，语义化选项（`[y] 本次 / [a] 本会话总是 / [n] 拒绝`），方向键选或按首字母，**取代 legacy 纯文本审批问答**。
- `ScrollableList.tsx`：超屏可滚动列表（会话选择/任务列表），支持关键字实时过滤（前端过滤）。
- `OverlayHost.tsx` + App 的 `activeOverlay` 态：**任意时刻只开一个浮层**；浮层开时用 `useInput(handler,{isActive})` 把 Composer `isActive` 置 false、浮层 `isActive` 置 true（严格互斥，避免多组件同时监听）。

**Steps：**

1. 实现上述 5 个组件。
2. 在 App 里挂 OverlayHost 与 activeOverlay 状态（先接 T3 Composer 与 T5 互斥）。
3. Commit：`✨feat(cli): 弹窗组件库（Modal/SelectList/ConfirmDialog/ScrollableList/OverlayHost）`

**验收标准：** 任意时刻开一个浮层，键盘只被该浮层消费，Composer 不响应；Esc 关闭并把焦点还给 Composer。

---

## Task 6（T6）：具体功能接入（状态栏 + 各弹窗真实业务逻辑）

**Files：** `packages/cli/src/tui/StatusBar.tsx`、`packages/cli/src/mode-alias.ts`、`packages/cli/src/tui/overlays/*.tsx`、`packages/core` 导出 `getContextUsage`。

**行为（每项都要保证 legacy 对应纯文本命令继续可用）：**

1. **StatusBar**：常驻显示模式别名（`normal/allow-approve/auto/plan`）、`roles.main` 展示名、cwd（`.git` 存在时附加分支名，异步子进程取值避免阻塞）、上下文占用百分比。上下文数据源 = T6 新增的 core 只读 `getContextUsage(sessionId)`（与 legacy `/context`、桌面 B4 **三处共用同一数据源**）。
2. **`/mode` → SelectList 弹窗**：选项 `normal→default`、`allow-approve→acceptEdits`、`auto→bypass`、`plan→plan`（别名映射抽 `mode-alias.ts` 两路径共用）；选中后调同一 `setMode`：切到 `plan` 时清空会话级 `alwaysAllowed` 缓存；`plan` 模式下每条 user message 前追加固定系统前缀（`[系统：当前处于 plan 模式。只读工具可用，write/edit/bash 等有副作用的工具调用会被拒绝执行。请先给出你的计划，不要反复重试被拒绝的工具调用；等用户手动切换到其他模式后再执行。]`，**两路径共用同一份文案常量**，别各写一遍）；StatusBar 随之更新；**只在当前进程/会话生效，不写回 `config.json`**。legacy 路径：`/mode` 无参走纯文本列四选项+说明；带参 `/mode <别名>` 两路径都走文本分支不弹窗。
3. **审批确认 → ConfirmDialog 弹窗**：`onAsk` 拦截下一行输入的逻辑，ink 路径换成打开 ConfirmDialog；turn 取消时弹窗自动关闭并按拒绝处理。
4. **`/sessions` → ScrollableList**：数据源 `manager.list`/`manager.search`（legacy 已有内核调用，不重实现），关键字过滤，Enter 选中即 `switchSession`。
5. **`/help` → Modal**：复用 legacy `HELP_TEXT` 的每行文案。
6. **`/tasks` → ScrollableList**：只读展示 cron 任务，复用 `harness2 cron list` 数据；**不支持在 REPL/弹窗内增删改**（管理留给桌面端 + 独立 `harness2 cron` 命令）。
7. **`/context`、`/compact`**：`/context` 信息常驻 StatusBar，不单独弹窗；`/compact [说明文字]` 作为直接执行、无需确认的命令（触发内核已有压缩），执行后 Transcript 插入一条系统提示「已手动压缩」。

**Steps：**

1. 先加 core 只读 `getContextUsage` 导出 + 单测（`packages/core/test/`），跑 core test。
2. 实现 `mode-alias.ts` + StatusBar。
3. 逐个实现 overlays（mode/sessions/help/tasks）。
4. 接线：Composer 发送前对 plan 模式加系统前缀；审批 onAsk 接 ConfirmDialog。
5. 跑：`pnpm -r typecheck && pnpm -r test`。
6. Commit（可拆多笔）：`✨feat(cli): StatusBar + /mode 弹窗 + /sessions /help /tasks 弹窗 + plan 模式前缀`

**验收标准：**
- ink 路径 `/mode`、审批确认、`/sessions`、`/help`、`/tasks` 全以弹窗呈现且功能与 legacy 等价。
- StatusBar 上下文百分比与 `/compact` 前后变化、与桌面 B4 水条读数一致（同一会话）。
- `packages/core` 新增的 `getContextUsage` 与 `plan` 策略单测绿。
- legacy 路径对应纯文本命令仍可用。

---

## Task 7（T7）：斜杠命令输入实时提示（替代 legacy Tab 补全）

**Files：** `packages/cli/src/tui/Composer.tsx`（增强）、`packages/cli/src/command-registry.ts`。

**行为：**
- `Composer` 检测 `value` 以 `/` 开头且不含空格（命令名阶段），在输入框下方实时渲染**非模态候选下拉**（复用 T5 SelectList 视觉但不接管键盘焦点）：`↑↓` 切候选，`Tab` 用高亮候选补全命令名（补全后停在输入框继续编辑参数，不直接发送），`Enter` 直接发送当前 buffer（不强制先补全）。
- 命令元数据（名称+一句话）从**两路径共用的** `command-registry.ts` 读（legacy `commands.ts` 迁移到该注册表；legacy 侧继续用 `readline` `completer` 消费同一份数据做 Tab 补全）。**不要各维护一份。**

**Steps：**

1. 建 `command-registry.ts`（现有 8 命令 + 新增 `/mode`/`/context`/`/compact`/`/reasoning`/`/tasks`）。
2. `Composer.tsx` 加候选下拉 + 按键处理。
3. legacy `commands.ts` 改为从注册表读（保持行为）。
4. 冒烟：输入 `/mo` 见 `/mode`；`Tab` 补全后能继续打字；非 `/` 开头不下拉；legacy `/re` 按 Tab 仍补全 `/reasoning /resume`。
5. Commit：`✨feat(cli): 斜杠命令实时提示（共享命令注册表）+ legacy Tab 补全共用`

**验收标准：** 上述 4 条冒烟全过；两路径读同一份注册表。

---

## Task 8（T8）：reasoning 折叠块 + write/edit 结果 diff 高亮卡片

**Files：** `packages/cli/src/tui/ReasoningBlock.tsx`、`packages/cli/src/tui/DiffCard.tsx`；依赖 `diff` + `@types/diff`。

**行为：**
- `/reasoning` 命令（无参=看状态；`on`/`off` 切换会话级默认，**默认 off**，两路径共用同一状态变量）。ink 路径 reasoning 默认折叠为一行 `[reasoning · 按 r 展开]`，当前 turn 内按 `r` 展开/收起；legacy 保持原灰色斜体折叠为一段（`reasoning_content`/`thinking` 字段取值逻辑**直接抄桌面端已有渲染代码**，别重新猜字段名）。
- `write`/`edit` 结果用 `diff` 计算行级差异，在 `ToolCallCard`（T4）展开态渲染红绿高亮（`<Text backgroundColor="red">`/`green` 或前景色降级，取决于终端色彩支持检测），默认前 20 行，超出可展开。

**Steps：**

1. 加 `diff`/`@types/diff` 依赖。
2. 实现 `ReasoningBlock.tsx` + `/reasoning` 命令（两路径）。
3. 实现 `DiffCard.tsx`（用 `diff`，字段取值抄桌面端）。
4. 测：默认关 reasoning 两路径行为与改前一致；开启后 ink 按 `r` 展开、legacy 见灰色斜体；`edit` 结果 ink 见红绿 diff；`/help` 有此命令说明。
5. Commit：`✨feat(cli): reasoning 折叠块（/reasoning 开关）+ write/edit 结果 diff 高亮卡片`

**验收标准：** 默认关 reasoning 两路径零回归（`pnpm -r test` 绿）；开启后上述 4 条手动验证过。

---

## Task 9（T9）：`@file`/`@dir` 引用语法（两路径通用）

**Files：** 新增 `packages/cli/src/context-ref.ts`（发送前预处理，`legacy-chat.ts` 与 ink 发送逻辑都调用它，**不分叉实现**）。

**行为：**
1. 发送前用 `/@([^\s"']+)/g` 找出所有 `@路径` token。
2. 路径优先「相对当前 cwd」解析，找不到再试「相对项目 root」；文件 `fs.readFile`（UTF-8，失败/不存在跳过并在本轮末尾追加 `[@x 未找到，已忽略]`）；目录列出直接子项（不递归）。
3. 单文件 64KB 截断保护，超出取前 64KB 并追加截断提示。
4. 解析结果拼成代码块插到发给模型的 user message 最前；终端回显给用户的仍是原始输入文本。

**Steps：**

1. 实现 `context-ref.ts`（纯函数，便于单测）。
2. 在 legacy 与 ink 的发送逻辑都调用（同一函数）。
3. 单测：`@README.md 这是什么项目？` 模型能答真实内容；不存在路径不报错不阻塞；两路径行为一致。
4. 跑：`pnpm -r typecheck && pnpm -r test`。
5. Commit：`✨feat(cli): @file/@dir 引用语法（两路径共用 context-ref）`

    > 注：阶段二 B8 会在桌面端打通同一协议；两端必须共享正则/截断/提示文案（可后续抽公共协议，本阶段先 CLI 落地，接口尽量纯函数化以便复用）。

**验收标准：** 上述 3 条单测/冒烟过；两路径一致。

---

## 代码审查（阶段级环节，验收前，按档位执行）

**审查方：** 独立角色（子代理，非本阶段实现者；只读）

**审查面：** 代码风格 / 测试完整性（关键路径有无断言）/ 依赖合理性（`ink`/`react`/`diff` 是否必要、是否误引 `react-dom`）/ 架构红线（`packages/core` 是否被越界改动、legacy 路径是否被破坏）/ 安全（密钥、注入）/ API 契约一致性（`ApprovalMode` 4 态、`getContextUsage` 签名）。

| 审查项 | 结论（✅/⚠️/❌） | 问题清单 |
|--------|------------------|----------|
| 风格 | | |
| 测试完整性 | | |
| 依赖与架构红线 | | |
| 安全 | | |
| API 契约 | | |

**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表，❌ 下放下阶段）/ ❌ 不通过（阻塞）

---

## 验收标准总表

> 按档位取舍；未做的项在「跳过项」登记，不作为缺陷。低调档位 ≠ 全绿。

| # | 标准 | 通过条件 | 验证责任人 |
|---|------|----------|-----------|
| 1 | legacy 输出逐字节不变 | `packages/cli/test` 全绿（chat/chat-cancel/crash-drill 等）且 `--no-tui`/非 TTY 冒烟与改前一致 | 自动化（执行方） |
| 2 | `plan` 审批态单测 | `approval-policy-plan.test.ts` 绿；既有期望值零改动 | 自动化（执行方） |
| 3 | `getContextUsage` 导出 | core 单测绿；三处读数一致 | 自动化（执行方） |
| 4 | 构建/typecheck | `pnpm -r typecheck && pnpm -r test` exit 0 | 自动化（执行方） |
| 5 | 代码审查 | 结论 ✅ 或 ⚠️（问题已登记）；❌ 不通过则下放下阶段 | 独立角色（子代理） |
| 6 | 红线 | 无禁止项；`packages/core` 仅 T1+T6 窄改动；无 `react-dom`；密钥未入库 | 自动化（执行方）+ 审查 |
| 7 | 密钥 | `git ls-files` 无敏感文件 | 自动化（执行方） |
| 8 | 端到端真机 | T0 四环境 + T3/T4/T8 手工——见「残留手工验收清单」 | 用户/真机（不设为执行方自证项） |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| `ink` 在 Windows 老终端（cmd/PowerShell 5.1）raw-mode / 中文宽字符有硬伤 | T0 先验证并记录决策；T2 按「仅现代终端」检测降级；`--no-tui`/`HARNESS2_NO_TUI` 逃生舱必带 |
| legacy 路径被改动破坏现有测试 | 强制先跑绿基线 + legacy 原样搬迁零改 + 每 Task 后跑 `chat.test.ts` |
| `packages/core` 被越界改动 | Global Constraints 钉死 T1+T6 两处窄口子；审查重点核对 diff 是否越界 |
| 装配分叉（legacy/ink 两套 setup） | `chat-setup.ts` 共享；审查确认 ink 不复制装配 |
| `getContextUsage` 三处算法不一致 | 唯一数据源 = core 只读导出；StatusBar/`/context`/B4 共用 |
| 新依赖引入（`ink` 较重） | 来源文档已论证；T0 先用 spike 验证；引前向用户确认 |

**降级路径（若 T0 判 ink 不可用）：** 本轨道整体降级为「legacy 路径渐进增强」（ANSI 颜色 + `@file` + `/context` + reasoning 开关 + Tab 补全），并行更新本文档与 `docs/research/...implementation-plan.md`，并把 T1（plan 态，与 UI 无关）**独立交付**（T1 本就是 core 改动，不受 ink 影响）。

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_Projects\harness2`
- 从 `main` 创建并切换：`feat/terminal-tui`
- 已完成：项目已到 M4（v1.0.0，生命周期 1~12 全部完成），本阶段是 M4 之后的**终端 UX 增量轨道**，不与生命周期阶段号冲突。
- 唯一实施来源：`docs/ai-framework/plans/2026-09-07-phase-terminal-tui.md`（本文）与 `docs/research/2026-09-07-terminal-desktop-implementation-plan.md`。
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`、`packages/cli/src/chat.ts`、`render.ts`、`commands.ts`。

### 做
1. 先跑基线确认干净：`pnpm -r typecheck && pnpm -r test`。
2. 严格按本文 Task 顺序执行：**T0（含 Windows 四环境验证与决策记录）→ T1（plan 态）→ T2（legacy 拆分 + ink 骨架）→ T3 → T4 → T5 → T6 → T7 → T8 → T9**。**不得跳过顺序**；T0 的验证记录与决策讨论必须写进 `docs/issue-log/2026-07-…` 当天日志（实际按当天日期）。
3. 每 Task 测完（跑对应测试/冒烟）后 commit，小步可审查。
4. 每个 Task 的验收标准都要实际跑证据，禁止「应该能过」。

### 不做
- 不改 `packages/core` 的**事件溯源/压缩算法/Provider 协议**；只允许 Task 1 的 `plan` 态与 Task 6 的只读 `getContextUsage`（见 Global Constraints）。
- 引入 `ink` 前必须向用户确认；**禁止引 `react-dom`**。
- 不 push；不提交密钥。
- 不做阶段三（文件树/工作台等）与桌面轨道（另一文件）。
- 不在 legacy 与 ink 各写一套装配/命令表/`@file`/`/mode` 别名——必须共享。

### 工作方式
1. 先测基线再动代码；每 Task 完成后跑 `pnpm -r typecheck && pnpm -r test`。
2. 用简体中文回复进度；代码标识符保持原样。
3. `--no-tui`/`HARNESS2_NO_TUI=1`/非 TTY 三种场景必须确认走 legacy 且输出逐字节不变（对 CI 稳定性最关键）。
4. T0 的 Windows 四环境验证属真机手工项——若你无法真机操作，**如实记录为「手工待补」并给出你在能跑的环境（如 Git Bash/单元测试）中的证据**，交由用户补做，不得虚构通过。

### 交卷
全部完成后给出：分支名、提交列表、验收表自评（✅/⚠️/❌ 每项 + 命令与输出）、测试/构建结果、T0 决策记录位置、残留风险、需用户真机补做的清单。

现在开始：读完本阶段计划，从 Task 0（T0）执行到最后。

---

## 残留手工验收清单

（自动化之外的 GUI / 真机项）

1. **T0 四环境真机验证**：Windows Terminal / VS Code 终端 / `cmd.exe` / Windows PowerShell 5.1 各跑 ink spike，记录 raw-mode、中文宽字符、Ctrl+C。执行方若不能真机，登记「手工待补」。
2. **T3**：中英文混排输入 / 光标 / 删除 / 换行 / 历史回溯的实机手感（Windows Terminal）。
3. **T4**：长会话（50+）流式不闪烁 / 滚动不卡顿实测（Windows Terminal）。
4. **T8**：`/reasoning on` 后按 `r` 展开、`edit` 结果红绿 diff 的实机显示（含 256/真彩色终端下的颜色降级判断）。
5. **macOS / Linux 终端**：交叉平台手动冒烟（含 `--no-tui` 回退）。
6. **Windows bash 工具适配缺陷**（OPEN.md 遗留）：记录在 T0 中是否影响 ink 判断，但**本阶段不承诺修复**，另立事项。
