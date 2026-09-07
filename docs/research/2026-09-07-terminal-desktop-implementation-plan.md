# harness2 终端与桌面端体验 · 唯一执行计划（2026-09-07 定稿）

> 本文档**取代并删除**了同日的 `2026-09-07-terminal-desktop-ux-optimization-plan.md`。旧文档以“调研对比 + P0/P1/P2 多选项”的形式呈现，导致方向一直定不下来。本文档不再做选项对比，**直接给出唯一确定的实施顺序与具体做法**，可直接交给任意 AI/工程师按顺序执行。
>
> 目标节奏：**先把阶段一+阶段二做完，做出一版看得见、用得上的效果给用户**；用户用后如果不满意，在这一版基础上继续改（提 bug / 提调整），而不是重新讨论“方向要不要变”。阶段三明确排在后面，等前两阶段交付、收到真实反馈后再决定顺序和细节，现在不要提前做。
>
> **2026-09-07 15:25 补充**：阶段一新增 **T7**（运行时切换审批模式 `/mode`，并新增第四态 `plan`）。原「阶段四：审批 plan 模式」的需求已并入 T7 一次做掉，不再单列阶段四；T7 是阶段一、二对 `packages/core` 内核的**唯一例外改动**，范围见 T7 正文与 §0 第 6 条。
>
> **2026-09-07 17:05 补充（方向变更）**：经核实 `D:\AI_Projects\refs\grok-build` 源码（`ratatui`/`crossterm` 全屏 TUI，`xai-grok-pager` crate 内有 `SettingsModalState`/`ExtensionsModalState`/`ModalConfirmation`/`overlay.rs`/`picker.rs` 等一整套真实弹窗组件），确认终端里做出真对话框是可行且有先例的，此前“不引入 TUI 框架”的结论被推翻。**阶段一改方向：引入 `ink`（React 化终端 UI 库，Node 生态里最接近 ratatui 的方案）实现真实弹窗**，具体做法见新增 **T0**，以及后续弹窗化任务（注：任务编号已在 17:35 补充中重新排列为 T0~T9，本段仅保留作为方向变更的历史记录）。
>
> **2026-09-07 17:35 补充（终端目标升级为完整 TUI）**：用户明确要求终端做成 Grok Build 那种真实的全屏交互体验，而不是只在个别命令上加个弹窗，并要求计划必须完整不能只写一半。阶段一范围据此整体重写为 T0~T9（原 T0~T7 拆解合并进新任务，`/mode` 的内核改动改叫 T1）：搭建 ink 全屏 App Shell（状态栏 + 可滚动历史 + 常驻输入框），配一套原生弹窗（模式切换/会话选择/帮助/审批确认），非 TTY/测试/CI 场景通过独立的 `legacy-chat.ts` 完整保留。桌面端阶段二不受影响。

---

## 0. 给实施者的强制约定

1. **不要重新评估“要不要做”**——本文档里的每一项都已经决定要做，只需要决定“怎么做得更好”，不需要再拿出别的方案讨论方向。
2. **桌面端视觉唯一基准**：`design/prototype-v5.html` 及其截图 `design/v5-*.png`（`v5-workbench.png`/`v5-settings.png`/`v5-plan-progress.png`/`v5-conversation-plan.png`/`v5-landing.png`/`v5-mode-dropdown.png`）。照着这个原型的布局、配色、交互做，不要重新设计一套。有分歧时以 `prototype-v5.html` 的真实 DOM/CSS 为准（截图仅辅助）。
3. **配置落盘口径**：
   - 所有“模型/审批/记忆/浏览器/子代理/网关/定时任务”类设置，桌面端设置弹窗最终都读写现有 `config.json` / `auth.json`（与 CLI 共用同一份配置，不建立平行配置体系，理由见 §3.2 Codex `config.toml` 多端共享的设计参照）。
   - 纯桌面 UI 偏好（默认分栏数、是否显示欢迎页等，不影响 CLI/内核行为的项）落到新文件 `desktop-preferences.json`，与现有 `desktop-layout.json` **同目录**、复用同一套「校验 + 损坏回退默认值」读写模式（抽公共函数，不要复制粘贴两套逻辑）。
   - 渲染进程不直接读写文件，一律走现有 `contextIsolation` 的 IPC 桥（在主进程 `bridge.ts` 一类文件新增通道，通道命名见各任务）。
4. **执行顺序**：终端轨道（T0→T9）与桌面轨道（B0→B9）可以两个人/两个 AI 并行开工，互不依赖。**两条轨道内部都必须严格按顺序执行**：终端轨道里 T0（兼容性验证）必须先做、T2（App Shell 骨架）是 T3~T8 所有交互任务的地基；桌面轨道里 B0（CSS 变量化）是后面所有视觉任务的地基。跳过顺序会导致后面任务返工。
5. **每完成一个任务立刻验证一次**（跑得起来、肉眼看得到效果），不要攒到最后统一验收。全部任务完成后再跑一次整体验收：`pnpm -r typecheck && pnpm -r test` 全绿 + 按每个任务的“验收标准”手工过一遍。
6. **改动范围红线**：阶段一、二的任务默认**不改动 `packages/core` 的内核逻辑**（事件溯源、压缩算法等），只在展现层（`packages/cli`、`packages/desktop`）调用已有内核能力。**唯一例外是阶段一 T1**（运行时切换审批模式 + 新增 `plan` 第四态）：只允许改动 `packages/core/src/config/schema.ts`（加一个 mode 字面量）与 `packages/core/src/approval/policy.ts`（加一个 if 分支），不得借这个口子顺便改动审批之外的其他内核子系统。运行时切换模式（`/mode`）本身是纯展现层逻辑，见 T6。
7. 完成阶段一、二后，请更新 `docs/issue-log/` 当天日志（四要素：需求描述/处理过程/修改结果/遗留风险）并同步 `docs/issue-log/OPEN.md`，这是项目强制的日志规范（`docs/issue-log/README.md`），不要跳过。

---

## 阶段一：终端 CLI 深度改造（目标：视觉与交互对齐 Grok Build 的全屏 TUI）

> 范围：`packages/cli/src/`下新增 `tui/` 目录（ink 组件与应用壳）、`legacy-chat.ts`（原 readline 路径原样搬迁）、`chat-setup.ts`（两路径共享的会话装配逻辑）、`context-ref.ts`、`command-registry.ts`、`mode-alias.ts`；`chat.ts`/`render.ts`/`commands.ts` 保留作为 legacy 路径的载体。
>
> **目标形态**（对标 `D:\AI_Projects\refs\grok-build` 的 `xai-grok-pager` 体验层次）：终端启动后是一个撑满终端高度的应用，而不是传统的行式 readline 对话：顶部常驻状态栏（模式/模型/cwd/上下文占用），中间可滚动历史区，底部常驻多行输入框，所有需要交互的场景（模式切换/会话选择/审批确认/帮助）都用真实弹窗而不是文字命令。
>
> **两条不可动摇的边界**（全部任务都必须遵守，不接受实施时自行放宽）：
> 1. **非交互路径完全不变**：管道输入/CI/测试/`--no-tui`/`HARNESS2_NO_TUI=1` 四种情况下，跑的必须是原样搬迁的 `legacy-chat.ts`，输出字符级不变（见 T2），现有依赖输出格式的测试断言一条不能挂。
> 2. **`packages/core` 默认不动**，唯一例外是 T1（新增 `plan` 第四审批态，只动 `schema.ts` 一行字面量与 `policy.ts` 一个 if 分支）。

### T0 — 技术选型验证：ink 全屏模式在真实 Windows 终端下能不能用
- **改动文件**：临时验证脚本（不进最终代码库，或放 `packages/cli/scripts/tui-spike.tsx`，验证完删除/保留作为手工回归脚本）。
- **做法**：
  1. 写一个最小 ink 全屏 demo：`<Static>` 渲染 30 行模拟历史 + 底部一个 `useInput` 驱动的方向键可选列表 + 一个模拟“输入框”（受控 state 拼字符）。
  2. 在四个环境各跑一遍：Windows Terminal、VS Code 集成终端、`cmd.exe`、Windows PowerShell 5.1（非 pwsh 7）。记录：raw mode 进入/退出是否干净（退出后 `cmd.exe` 提示符有没有残留控制字符或方向键失灵）、中文字符宽度计算是否对齐（ink 默认按字符数不按东亚宽度算，历史区如果混排中英文可能错位，需要验证）、Ctrl+C 能否正常终止进程并恢复终端。
  3. **决策分支**（把结果记录进 `docs/issue-log/` 当天日志，供 T2 实施者参考，不要跳过这步就直接开始写 App Shell）：
     - 四个环境都跑通 → T2 直接做“默认在所有 TTY 场景启用 ink 全屏模式”。
     - `cmd.exe`/PowerShell 5.1 有硬伤（卡死、退出不了 raw mode）→ T2 加一层“现代终端检测”（`process.env.WT_SESSION` 存在 = Windows Terminal；`process.env.TERM_PROGRAM === 'vscode'` = VS Code 终端；两者都没有则视为老旧终端），只在检测通过时启用 ink，否则自动走 T2 的 legacy 路径（不报错、不提示“不支持”，直接安静降级，用户不会感知到有什么“缺失”，只是没有花哨界面）。
     - 中文宽度错位 → 引入 `string-width` 包（社区成熟库，专门处理东亚宽字符）做所有需要对齐的行的宽度计算，不要自己写宽度表。
  4. 额外提供一个用户可控的逃生舱：环境变量 `HARNESS2_NO_TUI=1` 或命令行参数 `--no-tui`，无论环境检测结果如何，强制走 legacy 路径（给不想要花哨界面、或者遇到显示问题的用户一个可靠退路）。
- **验收标准**：四环境验证记录写入日志；`--no-tui`/`HARNESS2_NO_TUI=1` 能强制回退；决策分支的选择结果明确记录（“是否默认全量启用”或“仅现代终端启用”），供 T2 直接执行，不需要 T2 实施者自己再判断一次。

### T1 — 内核侧新增 `plan` 第四审批态（阶段一对 `packages/core` 的唯一例外改动）
- **现状**（先确认，别重新猜）：`packages/core/src/config/schema.ts` 定义 `ApprovalMode = 'default' | 'acceptEdits' | 'bypass'`（三态），`packages/core/src/approval/policy.ts` 的 `createApprovalPolicy` 按 mode 推导 `allow/ask/deny`，per-tool 规则最高优先级。`plan` 模式目前完全不存在。
- **做法**：
  1. `packages/core/src/config/schema.ts`：`ApprovalMode` 加字面量 `'plan'`（变成四态），`APPROVAL_MODES` 常量数组同步加 `'plan'`。
  2. `packages/core/src/approval/policy.ts`：`decide()` 加一个分支——`if (mode === 'plan') return safeTools.has(input.tool) ? 'allow' : 'deny';`（放在 `bypass` 分支之后）。per-tool 规则判断保持在最前面不变——`config.json` 里显式 `allow` 的工具即使在 `plan` 模式下仍放行，这是有意保留的口子。
- **验收标准**：`packages/core` 新增单元测试覆盖 `createApprovalPolicy({ mode: 'plan' }, ...)`：`read/glob/grep` → `allow`；`write/edit/bash` → `deny`；per-tool 显式 `allow` 时即使 mode 是 plan 也返回 `allow`。`pnpm -r typecheck && pnpm -r test` 全绿，不改动任何既有测试的期望值。

### T2 — 拆分 legacy 路径 + 搭建 ink App Shell 骨架（本阶段的地基，T3~T8 都建在它上面）
- **改动文件**：新增 `packages/cli/src/legacy-chat.ts`（原 `chat.ts` 的全部内容原样搬进来，导出 `runLegacyReadlineChat`，不改一行行为逻辑，只改函数名和文件位置）；`chat.ts` 精简为分流入口；新增 `packages/cli/src/tui/App.tsx`、`packages/cli/src/tui/runInkChat.ts`。
- **做法**：
  1. `chat.ts` 的 `runChat(options)` 改成薄分流：按 `isTTY`（输入流是否为 TTY）、`HARNESS2_NO_TUI`/`--no-tui`、T0 的现代终端检测结果三个条件综合判断：全部满足时调用新的 `runInkChat(options)`，否则调用 `runLegacyReadlineChat(options)`。
  2. `runInkChat` 内部先完成 `legacy-chat.ts` 里“provider/审批/记忆/压缩/插件/MCP/subagent/会话解析”这一整段装配逻辑（**原样复用，不重写**——把这段装配抽成 `packages/cli/src/chat-setup.ts` 的一个共享函数 `setupChatSession(options)`，返回 `{ provider, approval, tools, sessionManager, current, ... }`，`legacy-chat.ts` 和 `runInkChat.ts` 都调用这同一个函数，避免两套装配逻辑分叉维护）。
  3. `App.tsx` 三段式布局（用 ink 的 `<Box flexDirection="column">` 撑满终端高度，`useStdout` 拿终端尺寸变化事件做响应式）：顶部 `<StatusBar />`（固定 1 行，见 T6）、中间 `<Transcript />`（`flexGrow: 1`，占满中间剩余空间，可滚动；见 T4）、底部 `<Composer />`（固定 2-3 行，见 T3）。
  4. App 顶层维护核心状态：`messages`（当前会话已渲染的消息/工具调用列表）、`mode`（当前 `ApprovalMode` 别名）、`activeOverlay`（`null` 或某个弹窗描述，见 T5）、`contextUsage`（见 T6）。数据流：`runTurn`（核心 API）产生的事件通过回调桥接进这些 state 的 setter，不再像 legacy 那样直接 `renderer.textDelta(...)` 直写 stdout。
- **验收标准**：TTY 且现代终端下运行 `harness2 chat` 能看到三段式布局撑满终端；`--no-tui`/非 TTY 下行为与改动前的 `chat.ts` 完全一致（因为跑的是原样搬移的 `legacy-chat.ts`，字符级不变）；`pnpm -r typecheck && pnpm -r test` 全绿。

### T3 — Composer：常驻多行输入框
- **改动文件**：`packages/cli/src/tui/Composer.tsx`。
- **做法**：ink 没有现成的多行文本框，自己实现一个最小可用版本（不追求 Grok `xai-ratatui-textarea` 的全部功能，只做够用的）：
  1. 受控状态：`value: string`（当前输入内容）+ `cursor: number`（光标字符位置）。
  2. `useInput` 监听：可打印字符插入光标位置；`Backspace`/`Delete` 删除；左右方向键移动光标；`Enter` 发送当前内容（清空 value，触发发送回调）；`Shift+Enter` 或行尾 `\` 续行插入换行不发送（与桌面端 v5 的约定对齐）；上下方向键在“本会话已发送消息历史”里回溯/前进（类似 shell 历史，仅本会话内，不做跨会话持久化）；`Ctrl+C` 两次退出（复用现有退出逻辑）、空 buffer 时 `Ctrl+D` 退出。
  3. T0 决定的“现代终端检测”边界情况：如果某些方向键/组合键在个别终端下识别不出来，在 `docs/issue-log/` 记录已知问题清单，不强求第一版覆盖所有边缘按键。
- **验收标准**：能连续输入中英文混排文本，光标移动、删除、换行、历史回溯均正常；Enter 发送后输入框清空并聚焦等待下一条。

### T4 — Streaming 状态管理 + Transcript 渐进渲染（工具调用/结果卡片化）
- **改动文件**：`packages/cli/src/tui/Transcript.tsx`、`packages/cli/src/tui/useTurnStream.ts`（桥接 `runTurn` 事件到 React state 的 hook）。
- **做法**：
  1. **历史/未完成分层渲染**：已经完结的消息用 ink 的 `<Static items={completedMessages}>` 渲染（`<Static>` 只渲染一次、不会被后续 re-render 重复刷，是 ink 处理“追加型日志”的标准做法，滚动区不这样做会在长会话/Windows 终端下明显闪烁卡顿）；当前正在流式输出的最后一条消息用普通 `<Box>` 渲染（会随每次 state 更新重绘，但只有这一小块，不是整页）。
  2. **节流合并**：`textDelta` 事件不要每次都触发一次 `setState`。用一个简单的攒批策略：增量先塞进一个 ref 缓冲区，每约 50ms 或每攒够一定字符数才 flush 一次到 state，触发一次真正的重绘。
  3. **工具调用/结果卡片**：不再是 legacy 版的“> tool (args)”单行文本，改成一个小组件 `<ToolCallCard tool={...} status="pending|ok|failed" />`，pending 时显示 spinner，完成后显示状态图标 + 参数摘要（复用 legacy `render.ts` 里现成的摘要函数，不要重新写截断逻辑）。
  4. legacy 路径的 `render.ts`/`StreamRenderer` **保持不动**，供 `legacy-chat.ts` 继续使用；ink 路径不导入它，是完全独立的另一套渲染实现（两套并存，不是谁替代谁）。
- **验收标准**：流式输出时终端不明显闪烁（肉眼判断，Windows Terminal 下尤其要过一遍）；长会话（50+ 条消息）滚动区不卡顿；工具调用能看到 pending→ok/failed 的状态变化。

### T5 — 弹窗/浮层组件库（对标 Grok `modal.rs`/`picker.rs`，JS/ink 版）
- **改动文件**：`packages/cli/src/tui/Modal.tsx`、`SelectList.tsx`、`ConfirmDialog.tsx`、`ScrollableList.tsx`、`OverlayHost.tsx`。
- **做法**：
  1. `Modal.tsx`：居中边框容器（`<Box borderStyle="round">`），标题 + 内容区 + 底部一行操作提示，`Esc` 关闭（关闭逻辑由调用方传入回调，组件自己不管“关闭后做什么”）。
  2. `SelectList.tsx`：上下键移动高亮项、Enter 确认、Esc 取消的单选列表，传入 `options: { label, value, description? }[]`。
  3. `ConfirmDialog.tsx`：审批场景专用，选项固定语义化（如 `[y] 本次 / [a] 本会话总是 / [n] 拒绝`），支持方向键选或直接按首字母选，取代 legacy 的纯文本审批问答。
  4. `ScrollableList.tsx`：条目数可能超过一屏时的可滚动列表（会话选择器、任务列表用），支持输入关键字实时过滤（前端过滤，不需要新的索引）。
  5. `OverlayHost.tsx` + App 顶层的 `activeOverlay` 状态：任意时刻只允许一个浮层打开，浮层打开时用 ink 的 `useInput(handler, { isActive })` 把 `Composer` 的 `isActive` 置 false、浮层组件的 `isActive` 置 true，实现“谁在监听键盘”的严格互斥（不要多个组件同时监听输入，否则按键会被重复处理或行为不确定）。
- **验收标准**：任意时刻打开一个浮层，键盘输入只被该浮层消费，Composer 不会同时响应；Esc 能关闭当前浮层并把输入焦点还给 Composer。

### T6 — 具体功能接入（状态栏 + 各弹窗的真实业务逻辑）
- **改动文件**：`packages/cli/src/tui/StatusBar.tsx`、`packages/cli/src/mode-alias.ts`（新增，别名映射，同 legacy 逻辑）、`packages/cli/src/tui/overlays/*.tsx`。
- **做法**（逐项列出，每一项都要同时保证 legacy 路径里对应的纯文本命令继续可用——两条路径都要能达到同等效果，只是呈现形式不同）：
  1. **StatusBar**：常驻显示当前模式别名（`normal/allow-approve/auto/plan`）、`roles.main` 的展示名、cwd（若 `.git` 存在附加分支名，通过异步子进程调用取值，避免阻塞）、上下文占用百分比（复用/新增内核只读函数 `getContextUsage(sessionId)`，与 legacy 的 `/context` 命令、桌面端 B4 的水条三处共用同一个数据源，不允许出现三套不同算出来的百分比）。
  2. **`/mode` → SelectList 弹窗**：四个选项 `normal → default`、`allow-approve → acceptEdits`、`auto → bypass`、`plan → plan`（别名映射逻辑抽到共享的 `mode-alias.ts` 给两条路径一起用）；选中后调用同一个 `setMode` 逻辑：切到 `plan` 时清空会话级 `alwaysAllowed` 缓存；`plan` 模式下每条发给模型的 user message 前追加固定系统前缀（`[系统：当前处于 plan 模式。只读工具可用，write/edit/bash 等有副作用的工具调用会被拒绝执行。请先给出你的计划，不要反复重试被拒绝的工具调用；等用户手动切换到其他模式后再执行。]`，两条路径共用同一份文案常量，不要各写一遍）；StatusBar 的模式文字随之更新；本命令的切换只在当前进程/会话内生效，不写回 `config.json`。legacy 路径下 `/mode` 无参数仍走纯文本列出四个选项+说明，带参数 `/mode <别名>` 两条路径都走文本分支不弹窗（用户已打出目标模式，没必要再选一次）。
  3. **审批确认 → ConfirmDialog 弹窗**：原来 `onAsk` 拦截下一行输入的逻辑，在 ink 路径换成打开 `ConfirmDialog`，turn 取消时弹窗自动关闭并按拒绝处理。
  4. **`/sessions` → ScrollableList 会话选择器**：数据源直接复用 `manager.list`/`manager.search`（legacy 命令已有的内核调用，不重新实现），支持输入关键字过滤，Enter 选中即 `switchSession`。
  5. **`/help` → Modal**：展示命令列表和快捷键说明，文案可以直接复用 legacy `HELP_TEXT` 里已有的每一行描述，不用重新写。
  6. **`/tasks` → ScrollableList**：只读展示 cron 任务，数据源复用 `harness2 cron list` 内核数据获取逻辑；**本命令不支持在 REPL/弹窗内新增/编辑/删除任务**（管理功能留给桌面端设置弹窗做，CLI 侧已有独立的 `harness2 cron add/remove` 命令，不重复建设）。
  7. **`/context`、`/compact`**：`/context` 的信息常驻在 StatusBar，不需要单独弹窗（如果内核目前没有把这个数字暴露成可调用的函数，先加一个只读的导出函数，命名如 `getContextUsage(sessionId)`）；`/compact [说明文字]` 保留为一条直接执行、不需要确认的命令（触发内核已有压缩流程，效果与自动触发一致），执行后在 Transcript 里插入一条系统提示消息说明“已手动压缩”。
- **验收标准**：TTY/ink 路径下 `/mode`、审批确认、`/sessions`、`/help`、`/tasks` 全部以弹窗形式呈现且功能与 legacy 路径等价；StatusBar 的上下文百分比与 `/compact` 前后的变化、与桌面端 B4 水条三处读数一致；`packages/core` 新增单元测试覆盖 `createApprovalPolicy({ mode: 'plan' }, ...)`（同 T1 验收标准）。

### T7 — 斜杠命令输入实时提示（替代 legacy 的 Tab 补全）
- **改动文件**：`packages/cli/src/tui/Composer.tsx`（在 T3 基础上增强）；新增 `packages/cli/src/command-registry.ts`。
- **做法**：`Composer` 检测当前 `value` 是否以 `/` 开头且不含空格（尚在输入命令名阶段），实时在输入框下方渲染一个非模态的候选下拉（复用 T5 的 `SelectList` 视觉但不接管键盘焦点）：`↑↓` 切换候选高亮，`Tab` 用高亮候选补全命令名（补全后继续停留在输入框里编辑参数，不直接发送），`Enter` 直接发送当前 buffer（不强制先补全）。命令元数据（名称+一句话说明）从两条路径共用的同一个命令注册表读取（legacy 的 `commands.ts` 和 ink 路径都从 `command-registry.ts` 读取列表，不要各维护一份，legacy 侧继续用 `readline` 的 `completer` 消费同一份数据做 Tab 补全）。
- **验收标准**：输入 `/mo` 能看到候选下拉里出现 `/mode`；`Tab` 补全后光标停在命令名后可继续打字；非 `/` 开头输入不出现下拉；legacy 路径下 `/re` 按 Tab 仍能补全出 `/reasoning /resume` 等前缀匹配候选。

### T8 — reasoning 折叠块 + write/edit 结果的 diff 高亮卡片
- **改动文件**：`packages/cli/src/tui/ReasoningBlock.tsx`、`packages/cli/src/tui/DiffCard.tsx`；依赖 `diff`（npm 包，与桌面端 B5 共用同一个依赖，行为对齐——CLI 和桌面端看到的 diff 应该是同一种呈现逻辑，只是一个是终端字符画一个是 HTML）。
- **做法**：
  1. 新增命令 `/reasoning`（无参数=查看当前状态；`/reasoning on` / `/reasoning off` 切换会话级默认值，**默认 off**，两条路径共用同一个状态变量）。ink 路径下 reasoning 内容默认折叠成一行摘要（`[reasoning · 按 r 展开]`），当前 turn 内按 `r` 键展开/收起；legacy 路径保持原有的灰色斜体折叠成一段的文本呈现方式（`reasoning_content`/`thinking` 字段的取值逻辑直接抄桌面端已有的渲染代码，不要重新猜字段名）。
  2. `write`/`edit` 工具结果用 `diff` 包算出行级差异，在 `ToolCallCard`（T4）展开态下渲染红绿高亮（`<Text backgroundColor="red">`/`<Text backgroundColor="green">` 或前景色降级，取决于终端色彩支持检测），默认只显示前 20 行，超出可展开。
- **验收标准**：默认不开启 reasoning 显示时两条路径行为都与改动前一致；开启后 ink 路径按 `r` 能展开当前 turn 内容，legacy 路径能看到灰色斜体推理内容；`edit` 工具结果在 ink 路径下能看到红绿高亮的 diff；`/help` 里有这条命令的说明。

### T9 — `@file` / `@dir` 引用语法（与 UI 改造正交，两条路径通用，随时可做）
- **改动文件**：新增 `packages/cli/src/context-ref.ts`（消息发送前的预处理，`legacy-chat.ts` 和 ink 路径的发送逻辑都调用它，不分叉实现）。
- **做法**：
  1. 发送前用正则 `/@([^\s"']+)/g` 找出所有 `@路径` token（`@` 紧跟非空白字符才触发）。
  2. 路径优先“相对当前 cwd”解析，找不到再试“相对项目 root”；文件用 `fs.readFile`（UTF-8，失败/不存在跳过并在本轮末尾追加提示 `[@x 未找到，已忽略]`）；目录列出直接子项（不递归）。
  3. 单文件 64KB 截断保护，超出取前 64KB 并追加截断提示。
  4. 解析结果拼成代码块插到发给模型的 user message 最前面；终端里回显给用户的仍是原始输入文本。
- **验收标准**：`@README.md 这是干什么的项目？` 模型能答出真实内容；不存在的路径不报错、不阻塞；两条路径（legacy 与 ink）行为一致。

**阶段一整体验收**：`pnpm -r typecheck && pnpm -r test` 全绿；Windows Terminal 下手工过一遍 T0~T9 全部验收标准；额外在 `cmd.exe`/PowerShell 5.1 下验证 T0 的检测/回退分支确实生效（老终端下安静降级到 legacy 路径，不报错不卡死）；确认 `--no-tui`/`HARNESS2_NO_TUI=1`/非 TTY 三种场景下运行的都是 `legacy-chat.ts`，输出格式与改动前逐字节一致（这条对 CI 稳定性最关键，务必单独确认）。

---

## 阶段二：桌面端设置面板 + 视觉对齐 Codex 基础线

> 范围：`packages/desktop/src/renderer/*`、`packages/desktop/src/main/*`。**严格按 B0→B9 顺序**，不要跳步。视觉细节以 `design/prototype-v5.html` 为准。

### B0 — 前置工程：`styles.css` 颜色变量化（一切后续视觉任务的地基）
- **改动文件**：`packages/desktop/src/renderer/styles.css`。
- **做法**：把当前硬编码的颜色值全部替换为 CSS 变量，直接采用 `design/prototype-v5.html` 里已经定稿的 V5 暖纸配色 token（`:root` 里已有，原样搬过来，不要改数值）：
  ```css
  --bg:#F6EFE3; --surface:#FFFCF6; --surface2:#FBF4E9; --muted:#F0E7D8;
  --border:#E6D9C3; --border2:#D7C7AC;
  --fg:#3B2E21; --fg-muted:#8A7A66; --fg-dim:#B5A58C;
  --accent:#C7743B; --accent-2:#A85D28; --accent-soft:#F6E4D3;
  --ink:#4A3826;
  --ok:#6B8F4E; --ok-soft:#E9F0E0; --warn:#C98A2E; --warn-soft:#F9EAD3; --danger:#B5482E; --danger-soft:#F6E2DC;
  --code-bg:#33271A; --code-fg:#F2E8D6;
  --shadow:0 1px 2px rgba(70,50,30,.06),0 12px 32px rgba(70,50,30,.10);
  --radius:14px;
  ```
  再额外定义一套 `[data-theme="dark"]` 覆盖（深色，直接照抄旧的暗色配色作为深色主题的值，不用重新设计——旧的暗色硬编码值就是现成的深色主题素材，别浪费）。所有 `styles.css` 里原来写死的十六进制颜色，逐个替换成对应的 `var(--xxx)`。
  **默认主题 = 暖纸浅色**（`:root` 不加 `data-theme` 属性时生效），深色为可选切换（见 B2 外观设置）。
- **验收标准**：全局搜索 `styles.css`，不应再有裸的十六进制颜色值（除了这份 `:root`/`[data-theme=dark]` 定义本身）；切换 `<html data-theme="dark">` 属性能让整个界面变成深色，不需要改任何组件代码。

### B1 — Electron 菜单栏精简
- **改动文件**：`packages/desktop/src/main/main.ts`。
- **做法**：`app.whenReady()` 之后调用 `Menu.setApplicationMenu(null)`（macOS 下如果需要保留系统级“关于/退出”可以单独建一个极简 `Menu.buildFromTemplate` 只含 App 名称菜单一项 + 里面“关于/退出/开发者工具”三条，不要保留 File/Edit/View/Window/Help 默认那一整套）。
- **验收标准**：启动后窗口顶部不再有 File/Edit/View 等默认菜单；`Ctrl+Shift+I`（或菜单里的开发者工具项）仍能打开 DevTools（保留调试能力，不要连这个也删掉）。

### B2 — 设置弹窗组件 + 桌面偏好存储
- **改动文件**：新增 `packages/desktop/src/renderer/components/SettingsDialog.tsx`（或项目现有的组件命名风格）、`packages/desktop/src/main/bridge.ts`（新增 IPC 通道）、新增 `desktop-preferences.json` 的读写模块（仿照 `desktop-layout.json` 现有实现）。
- **做法**：
  1. 弹窗结构：居中 dialog，左侧一列分类导航 + 右侧内容区，遮罩点击/`Esc` 关闭。快捷键 `Ctrl+,`（macOS 同时支持 `Cmd+,`）全局打开设置。
  2. 左侧分类导航固定为以下 **14 类**（这是最终确定的信息架构，不要再增删或讨论要不要合并——这些类目综合了 V5 原型已有的 6 节 + 本次调研补齐的 8 个缺口，直接照此实现）：

     | # | 分类 | 内容 | 数据来源 |
     |---|---|---|---|
     | 1 | 通用 General | 启动默认分栏数、发送快捷键说明（只读展示 Enter 发送/Shift+Enter 换行）、防止运行时休眠开关、通知详情级别 | `desktop-preferences.json` |
     | 2 | 外观 Appearance | 主题单选（暖纸浅色/深色/跟随系统）——直接切换 `<html data-theme>` | `desktop-preferences.json` |
     | 3 | 模型与角色 Providers & Models | channel 列表增删（baseUrl/协议/环境变量名）、`roles.main/small/subagent` 映射、reasoning effort | `config.json`（IPC 读写） |
     | 4 | 审批与安全 Approval & Security | `approval.mode` **四态**单选（default/acceptEdits/bypass/plan；plan 态的内核支持已在阶段一 T7 完成，这里只是把 `config.json` 里的同一个字段做成 UI 单选，不需要再实现判断逻辑）、按工具粒度 allow/ask/deny 列表 | `config.json` |
     | 5 | 记忆 Memory | 模式三态（off/ask/auto）+ nudge 间隔；`ask` 模式下的待审批记忆列表（approve/reject 按钮，复用 `harness2 memory pending/approve/reject` 已有内核命令的等价调用） | `config.json` + `~/.harness2/memories` |
     | 6 | 浏览器工具 Browser | 启用开关、最大并发数、空闲销毁时长 | `config.json` |
     | 7 | 定时任务 Cron | 任务列表、启停开关、新增/编辑/删除、上次执行时间与历史（复用已有 cron 内核数据） | `config.json` |
     | 8 | 插件与集成 Plugins & MCP | 已装插件列表（启停开关）、MCP 服务器列表（增删、连接状态点、断线重启提示）、Skills 列表（项目级+全局级，标注来源，**只读展示**，不支持在弹窗内编辑 Skill 内容） | `config.json` + 插件/MCP 内核状态查询 |
     | 9 | 子代理 Subagent | `maxDepth`/`maxTurns` 数值展示与调整、子代理专用 provider 选择 | `config.json` |
     | 10 | IM 网关 Gateway | QQ / 飞书凭据输入（写回 `auth.json`，界面只显示掩码，不回显明文）、私聊/群策略三态、连接状态点 | `config.json` + `auth.json` |
     | 11 | 会话与数据 Sessions & Data | 会话存储路径展示（只读文本+“在文件管理器中显示”按钮）、`export`/`replay` 入口按钮（调用已有 CLI 能力）、“仅本地存储无遥测”声明文字 | 会话存储目录 + 包一层桌面 IPC 调用 CLI 逻辑 |
     | 12 | 诊断 Diagnostics | `doctor` 六项检查结果可视化（OK/WARN/FAIL 图标 + 说明）、崩溃报告列表（时间/会话 id/摘要，点击展开详情） | 调用 `harness2 doctor` 逻辑 + crash 报告文件 |
     | 13 | 快捷键 Keyboard Shortcuts | 只读列表：Enter 发送、Shift+Enter 换行、`Ctrl+,` 设置、`Ctrl+K` 命令面板（见 B8）、`Ctrl+N` 新建会话、`Ctrl+F` 会话搜索（见 B5） | 静态文本 |
     | 14 | 关于 About | 版本号（读 `package.json`）、内核一句话说明（事件溯源、单写者）、“仅本地无遥测”声明、更新方式说明（如实写：目前无自动更新，需手动下载新安装包或 `npm update`） | 静态 + `package.json` |

  3. 第 3~10、12 类涉及的数据通过新增 IPC 通道读写，命名统一前缀 `settings:`，例如 `settings:getConfig` / `settings:updateConfig` / `settings:getAuthMasked` / `settings:updateAuth` / `settings:getDoctorReport` / `settings:getCrashReports`；渲染进程只调用这些通道，不直接碰文件系统。
  4. 第 1、2、13、14 类是纯本地/静态数据，直接在渲染进程读 `desktop-preferences.json`（经一个简单的 `settings:getPreferences` / `settings:setPreferences` 通道，同样不绕过 IPC）。
  5. 第 8、11、12 类如果短期内数据结构复杂、来不及做交互（增删改），**允许先做成只读展示**，但导航条目和框架必须先搭出来，标注“完整管理功能见后续版本”，不能整个类目缺失。
- **验收标准**：`Ctrl+,` 能打开设置弹窗；14 个分类导航全部存在且可点击切换；第 3、4、6、9、10 类（数据结构相对简单）必须做到能真实读写 `config.json`/`auth.json` 并在重启应用后保留；其余允许只读但不能不存在。

### B3 — 会话侧栏搜索 / 重命名 / 归档
- **改动文件**：`packages/desktop/src/renderer/App.tsx`（或已拆分出的会话列表组件）。
- **做法**：
  1. 侧栏顶部加一个搜索输入框，输入时按标题/内容关键字过滤当前会话列表（前端过滤即可，不需要新的全文索引——全文搜索是阶段三 G14 的范畴，这里只做“已加载列表里按标题/首条消息过滤”）。
  2. 每个会话项加一个更多按钮（`⋯`），点击弹出菜单：重命名（内联编辑标题，写回会话元数据）、归档（软删除，移出主列表但保留数据，可在“已归档”折叠区看到并恢复）、删除（物理删除，复用现有删除逻辑，加一次二次确认）。
  3. 归档状态存哪：如果会话元数据文件里已有可扩展字段就加一个 `archived: boolean`；如果没有，新增一个轻量的会话元数据覆盖层（不动会话事件日志本身，只加一层展示态标记），具体看现有会话存储结构，改动原则是“不碰事件溯源日志文件本身”。
- **验收标准**：搜索关键字能实时过滤列表；重命名后标题持久化（重启应用还在）；归档后会话从主列表消失、在“已归档”里能看到并可恢复；删除仍有二次确认且效果与改动前一致。

### B4 — 对话头组件（cwd / 模型 / 上下文水条）
- **改动文件**：`packages/desktop/src/renderer/App.tsx` 新增一个 `ConversationHeader` 组件，挂在对话区顶部（原来只有全局 topbar，现在每个对话面板自己顶部也要有一条头）。
- **做法**：展示当前会话的工作目录（cwd）、当前分支（如果 `.git` 存在则 `git rev-parse --abbrev-ref HEAD` 取值，通过主进程 IPC 执行，不在渲染进程跑 shell）、当前模型（`roles.main` 的展示名）、上下文占用水条（复用阶段一 T4 打通的同一个 `getContextUsage` 内核函数，通过 IPC 暴露给桌面端，**terminal 和 desktop 用同一个数据源，不要各写一套算法**）。
- **验收标准**：切换会话时头部信息跟着更新；上下文水条数值与终端 `/context` 命令展示的数值一致（同一份会话）。

### B5 — `write`/`edit` 工具调用结果的 diff 卡片
- **改动文件**：`packages/desktop/src/renderer/App.tsx`（工具调用渲染部分），新增依赖 `diff`（npm 包，`diffLines`/`createTwoFilesPatch`，成熟稳定、体积小，直接用，不要自己写 diff 算法）。
- **做法**：`write`/`edit` 工具调用结果里已经有 before/after 内容（复用现有文件快照机制拿到的数据，不是重新读取磁盘当前状态，因为磁盘可能已经被后续操作覆盖）；用 `diff` 包算出行级差异，渲染成红绿高亮的 unified diff 卡片（删除行浅红背景 `var(--danger-soft)`，新增行浅绿背景 `var(--ok-soft)`），卡片默认展示前 20 行，超出可展开。**本任务只做展示，不做“接受/拒绝”交互**（因为工具已经执行完毕，接受/拒绝的语义是 undo/redo，直接在卡片下放一个「撤销此次修改」按钮调用现有 `/undo` 等价的内核能力即可，不要重新发明一套确认机制）。
- **验收标准**：模型执行一次 `edit` 后，对话流里能看到红绿高亮的 diff（不再是参数 JSON 摘要）；点击「撤销此次修改」能正确触发现有 undo 逻辑并让文件回到之前状态。

### B6 — 命令面板 `Ctrl+K`
- **改动文件**：新增 `packages/desktop/src/renderer/components/CommandPalette.tsx`。
- **做法**：全局监听 `Ctrl+K`（macOS 同时 `Cmd+K`），弹出居中输入框 + 过滤列表，第一版固定收录 4 条命令：「新建会话」「切换分栏数（1/2/3）」「打开设置」「跳转到会话…（列出会话标题，选中即切换）」。按上下键选中、Enter 执行、`Esc` 关闭。命令列表用一个简单数组注册，方便阶段三继续往里加条目，不要设计成一次性写死的分支判断。
- **验收标准**：`Ctrl+K` 能唤出面板；四条命令都能正确执行；输入文字能按标题模糊过滤。

### B7 — 任务完成通知
- **改动文件**：`packages/desktop/src/main/main.ts` 或桥接层，使用 Electron 内置 `Notification` API。
- **做法**：当一个 turn 结束（assistant 完成响应）且**应用窗口不是当前聚焦窗口**时，弹一条系统通知（标题=会话标题或“harness2”，内容=assistant 回复的前 80 字摘要），点击通知聚焦对应窗口并跳转到该会话。窗口聚焦时不弹通知（避免打扰），只在应用内小红点/未读数上体现（现有未读徽标逻辑已经有,复用即可）。
- **验收标准**：切到其它应用窗口后让一个长任务的会话完成，能收到系统通知；点击通知能正确聚焦并跳转会话；窗口在前台时不弹通知。

### B8 — `@file` 引用在桌面端打通
- **改动文件**：`packages/desktop/src/renderer/App.tsx`（输入框逻辑）。
- **做法**：桌面端输入框复用阶段一 T1 定的**同一套 `@路径` 解析协议**（正则、64KB 截断、未找到提示文案都保持一致，不要各写一套），区别只是运行环境从 Node CLI 换成通过 IPC 调主进程的文件读取；可以额外加一个简单的下拉建议（输入 `@` 后弹出当前 cwd 下的文件列表供点选，属于体验加分项，非阻塞项，时间不够可以先不做下拉、只做纯文本解析，两端行为必须先保持一致）。
- **验收标准**：桌面端输入 `@README.md 总结一下` 效果与终端一致。

### B9 — 阶段二整体收尾自检
- 对照下面的清单逐条打勾，**全部打勾才算“达到 Codex 基础水平”**：
  1. `Ctrl/Cmd+,` 打开设置弹窗，14 个分类导航齐全。
  2. 主题可在暖纸浅色/深色间切换，且切换后不需要重启应用。
  3. 顶部不再是 Electron 默认菜单栏。
  4. 会话侧栏能搜索、能重命名、能归档（不只是删除）。
  5. 每个对话面板顶部有独立对话头，显示 cwd/模型/上下文水条。
  6. `write`/`edit` 工具结果展示真实红绿 diff，而不是参数 JSON。
  7. `Ctrl/Cmd+K` 能唤出命令面板并至少执行 4 条命令。
  8. 窗口非前台时，任务完成会收到系统通知。
- **阶段二整体验收**：`pnpm -r typecheck && pnpm -r test` 全绿 + 桌面端 41 个既有测试不回归 + 手工过一遍上面 8 条。

---

## 阶段三：工作台级能力（排在阶段一二交付、拿到用户反馈之后再做，不要提前开工）

对应 `design/README.md` 的 G1/G3/G6/G7/G8/G14/G15 缺口，参考落地顺序（`design/README.md` §7 已给出，此处直接采用，不重新排序）：
1. C1 文件树面板（复用阶段二 B8 的 `@file` 协议做双向打通：点文件树 = 插入引用）。
2. C2 集成终端面板（复用 `bash` 工具执行通道，展示实时输出流，不是重新起一个终端进程）。
3. C3 Todo/Plan 卡片（纯 UI 展示 agent 输出的结构化计划，打勾/划线；**不绑定审批门禁**，门禁是阶段四的内核工作）。
4. C4 子代理树可视化（拓展现有“子会话 ↗”深链为拓扑图）。
5. C5 工具调用时间线（复用 `traj` 数据）。
6. C6 会话全文搜索（区别于阶段二 B3 的“当前列表按标题过滤”，这里要建索引做全文检索）。
7. C7 崩溃报告可视化细化、codemap「上图下码」（`design/README.md` 核心亮点功能，工作量最大，放最后）。

> 阶段三具体任务在阶段一二交付并收到用户反馈后，参照本文档的写法（改动文件 + 做法 + 验收标准）单独补一份细化文档，不要现在就展开。

> 原「阶段四：审批 `plan` 模式」已并入阶段一 **T7**（见上），不再单列阶段四——`plan` 模式已经在本次范围内实现，不用等用户反馈后再单独立项。

---

## 附：文档血缘

- 本文档整合并取代 `2026-09-07-terminal-desktop-ux-optimization-plan.md`（已删除）。该文档中的调研素材（Grok Build TUI 完整命令图鉴对比表、Codex app 官方 Settings 结构调研、市场对比）已经消化并转成上面各任务里的具体决定，不再单独保留副本；如需追溯原始调研过程，可查 `docs/issue-log/2026-09-07.md` 当天日志。
- 桌面端视觉与信息架构的原始探索过程（V1~V5 迭代、G1~G15 缺口清单全文、权限模式对比全文、dsh 插件市场调研全文）保留在 `design/README.md`，本文档不重复摘录，只引用结论。
