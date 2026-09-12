# 终端（CLI TUI）grok 对标复刻方案

> **文档类型：** 程序级方案（**供实施同事执行**；编排者按 §8 独立检验）
> **状态：** 方案就绪（2026-09-12 · v1） · **实施者：** 其他同事（可分阶段多人） · **检验者：** 编排者（AI 主会话，独立复跑证据）
> **必读关联文档：**
> - **分阶段执行计划（施工单，实施人从这里开工）：** [`2026-09-12-terminal-grok-parity-execution.md`](./2026-09-12-terminal-grok-parity-execution.md)
> - 对齐研究（grok 原版机制逐项 + 源码索引）：[`docs/research/2026-09-12-grok-tui-alignment.md`](../../research/2026-09-12-grok-tui-alignment.md)
> - 进行中的 5 项修复阶段：`docs/ai-framework/plans/2026-09-12-phase-tui-ux-polish.md`
> - 工程规范：[`AGENTS.md`](../../../AGENTS.md)、[`coding-standards.md`](../../../coding-standards.md)、[`CODE_REVIEW.md`](../../../CODE_REVIEW.md)
> - 参考源码：`D:\AI_Projects\refs\grok-build`（TUI 在 `crates/codegen/xai-grok-pager/`，含 27 篇用户手册 `docs/user-guide/`）

---

## 0. 一页速览

| 问题 | 答案 |
| ---- | ---- |
| **做什么** | 把终端 TUI 的**交互语义与布局结构**对标 grok-build（grok CLI/TUI）：分层布局、贴底输入框、完整滚动/鼠标、内联下拉与审批卡片、模式循环、焦点门控通知、子代理块与视图、状态行/快捷键条 |
| **不做什么** | ①改 `packages/core` / `packages/gateway`（契约冻结）②桌面端（`packages/desktop`）③逐像素照搬颜色/主题 ④引入 GPL/传染性许可的代码或依赖 |
| **怎么做** | **P0 选型 spike**（渲染层四选一）→ **P1 输入与事件层** → **P2 渲染与布局层** → **P3 交互功能对齐** → **P4 打磨**。P0 与进行中阶段可并行（文件不冲突，见 §6） |
| **怎么算完成** | 每阶段：先红后绿的用例 + 可复跑证据命令 + 编排者复跑通过 + 真机清单（§8.4）。**禁止「应该能过」** |
| **从哪开始** | P0 spike（§4）：先出选型报告，同事与编排者共同评审后再开 P1 |

---

## 1. 背景与目标

### 1.1 背景

用户对当前终端 TUI 提出 5 项交互反馈（子代理不可见 / 输入框未贴底与无法滚动 / `/mode` 弹层位置 / 缺回合结束提醒 / 斜杠候选与审批位置），并明确：

- 终端版本**主要参考 `D:\AI_Projects\refs\grok-build`**；要求「根据问题去 grok-build 找答案，再复刻过来」；
- 目标档位为 **C 档（重度复刻）**：不只修 5 项，要对齐 grok 的交互与页面布局；
- 由**其他同事实施**，编排者负责**后续独立检验**。

### 1.2 目标

1. **交互语义对齐**：键位、焦点、滚动、弹层、审批、模式、通知等行为与 grok 一致（允许注明差异项）。
2. **布局结构对齐**：终端纵向分层、输入框贴底、滚动区在上、状态行/快捷键条在底；弹层锚定输入框。
3. **视觉可接受**：字符网格层面高度接近 grok（配色/间距可保留我方主题，但结构与层级一致）。

### 1.3 非目标

- 不做桌面端（用户明确后续再看）。
- 不追求逐像素/逐帧复制（grok 为 Rust + ratatui 自绘；见研究文档 §2）。
- 不改 core/gateway 契约；不为此开解冻窗口（若 P2 选型确需 core 新能力，**停下来报编排者**，不得静默扩权）。
- 不引入与现仓库冲突的许可证（grok-build 为 MIT，参考其思路/接口设计合法；直接拷贝大段代码需保留版权声明并在 PR 说明）。

---

## 2. 现状快照（基线事实，2026-09-12）

### 2.1 包与分层

```
packages/core     会话内核（事件溯源 JSONL）+ agent loop + 工具 + Provider + 记忆/压缩/子代理/cron/浏览器/插件/MCP + serve(HTTP+WS)
packages/cli      终端端（Ink TUI + 14 个子命令；npm 名 harness2）
packages/desktop  Electron 桌面端（不在本方案范围）
packages/gateway  IM 网关（不在本方案范围）
```

### 2.2 现有 TUI 资产（`packages/cli/src/tui/`）

`runInkChat.tsx`（装配/布局/键位）、`Composer.tsx`（输入框+候选）、`TranscriptView.tsx` + `transcript.ts`（typed 转录 + 虚拟化 viewport）、`OverlayHost.tsx`/`Modal.tsx`/`SelectList.tsx`/`ConfirmDialog.tsx`（浮层）、`StatusBar.tsx`、`DiffCard.tsx`、`ReasoningBlock.tsx`、`panels/`（queue/retry/task）、`terminal-capabilities.ts`、`terminal-events.ts`（新增：SGR 鼠标 + 焦点解析）、`ink-commands.ts`、`input.ts`、`paste.ts`、`scheduler.ts`、`shutdown.ts`、`useTurnStream.ts`。

测试：`packages/cli/test/tui/`（26 个文件 / 255 用例，随 TUI-UX 阶段增长中）。

### 2.3 已具备 / 缺口

| 能力 | 现状 | 对标 grok |
| ---- | ---- | --------- |
| 转录虚拟化 + 跟随/锚定滚动 | ✅ 键盘（PageUp/PageDown/Ctrl+G） | 需补：Ctrl+U/D 半页、Tab 焦点、滚轮跨区域 |
| 鼠标 | 🟡 SGR 滚轮 + 焦点（TUI-UX T2 落地） | 需补：点击聚焦、命中测试、滚动条拖动、悬停下拉改选 |
| 布局 | 🟡 输入框锚底（T2 落地），状态栏在**顶部** | grok：状态行/快捷键条在**底部**，输入框贴底，scrollback 在上 |
| 斜杠下拉 | 🟡 候选已移到输入框上方（T2/T5） | grok：prompt 锚定内联下拉 + 模糊匹配 + 最多 6 行 + 滚动 |
| 审批 | 🟡 居中浮层（T3/T5 改为贴输入框上方） | grok：blocking card + Tab 走行 + 数字直选 + Esc 寄放焦点 |
| 模式 | 🟡 `/mode` 选择器 + 文本提示 | grok：Shift+Tab 循环 + 输入框底边指示器 |
| 通知 | ⬜ 无（TUI-UX T4 加 bel/osc9 + 失焦门控） | grok：5 种协议 + hooks + 标题栏 + `/doctor` 诊断 |
| 子代理 | 🟡 工具卡 + 只读浮层（TUI-UX T1 落地） | grok：生命周期块（动画/着色/耗时）+ Enter 全屏实时视图 + 动词组折叠 |
| 文本选择/复制/超链接/图片 | ⬜ 无 | grok 全有（自绘实现） |
| 主题 | 🟡 Ink 有限样式 | grok：完整主题 + `/theme` |

### 2.4 进行中的工作（不要重做）

`feat/tui-ux-polish` 分支（AI 子代理实施中）：T1（子代理只读入口）✅、T2（布局锚底 + 鼠标/焦点）✅、T3~T5 进行中。**该分支将合并 main，是本方案 P1 的起点**；同事不要在同一批文件上并行开工（见 §6）。

---

## 3. 对标规格（grok 行为 → 我们的目标）

> 详细机制与源码引用见研究文档；下表是**验收时可观察的行为规格**。

| 领域 | grok 行为 | 我们的目标（可验收） |
| ---- | --------- | -------------------- |
| 纵向布局 | 快捷键条（最底）→ 可选状态行 → 输入框（贴底，底边带模式/模型指示）→ scrollback（剩余空间） | 相同分层；输入框恒定贴底；弹层出现不顶起输入框；resize 不溢出 |
| 滚动 | PageUp/PageDown、Ctrl+U/D 半页、Ctrl+K/J 单行；**prompt 聚焦时 PageUp/PageDown 仍滚动会话**；跟随/锚定/粘性 | 全部键位生效；鼠标滚轮在任意区域滚动转录（悬停下拉时移动下拉选择）；跟随状态下向上滚动自动脱开跟随 |
| 鼠标 | 点击聚焦、pane 命中、滚动条拖动、双击选择、下拉开合 | 至少：滚轮 + 点击聚焦 + 下拉交互；选择/复制为 P4 可选 |
| 斜杠菜单 | prompt 上方的内联下拉；模糊匹配；Tab/Enter 接受；最多 6 行 + 滚动条；悬停高亮 | 位置/交互一致；`/`后逐字过滤；←/→ 或 Tab 补全 |
| 审批卡片 | blocking card：Tab/Shift+Tab 走行、数字直选、Ctrl+F 展开参数、Esc 寄放焦点到 scrollback（不回答）、Ctrl+C 取消、`Ctrl+O` 开 always-approve | 位置（输入框上方）与键位一致；Esc 行为一致 |
| 模式 | Shift+Tab 循环 Normal→Plan→Auto→Always-approve；输入框底边指示；`/plan` `/auto` `/always-approve` 开关 | 循环键 + 指示器 + 三个开关命令；指示器内容含上下文占用（我方 StatusBar 迁移底部后合并） |
| 通知 | `[ui.notifications]`：默认 `turn_complete`+`approval_required`、`condition=unfocused`、`idle_threshold_secs=3`、`method=auto|osc9|osc99|osc777|bel|none`；hooks 可挂系统通知；标题栏/进度 | 默认失焦才响；方法可选（至少 bel/osc9）；环境变量或设置面（core 冻结期间用 CLI 侧配置）；回合完成/需审批触发 |
| 子代理 | 生命周期块（运行动画/完成着色/耗时）+ Enter 全屏子视图（实时路由）+ 动词组折叠 + dashboard 行 | 块（状态/耗时/成功失败）+ Enter/Ctrl+J 打开视图（P3 起支持实时增量；P1 仅只读磁盘） |
| 状态行 | 可配置状态行（默认 `cwd/model/context`）+ 快捷键条（随状态变化） | 状态行合入底部；快捷键条按上下文显示，含当前可用键 |
| 键位 | 见研究文档 §1-T2/附录；Tab 焦点切换、Esc 多级语义、Ctrl+C 先清草稿再取消、`Ctrl+P`/`?` 命令面板 | P1 产出《键位对照表》：逐条标明 grok 键位、我方现状、目标、差异理由 |
| 块交互 | 折叠/展开（h/l、e/E、Ctrl+E）、复制（y/⇧Y）、全屏查看（Enter）、折叠组（group_tool_verbs） | P3/P4 按优先级逐步补齐；折叠组与复制优先 |

---

## 4. P0：渲染层选型 Spike（先决，先做这个）

**为什么先做**：C 档的核心是「渲染与事件控制力」。现有 Ink 在鼠标命中、文本选择、平滑滚动、图片上有硬天花板；继续堆会越走越窄。先花小成本（2~4 人日）用数据决定路线，再开 P1/P2。

### 4.1 候选方案

| 代号 | 方案 | 说明 | 优点 | 风险/代价 |
| ---- | ---- | ---- | ---- | --------- |
| **A** | Ink 渐进增强 | 保留 Ink，只做能做的 | 零新依赖、测试资产全保留 | 达不到 C 档（选择/图片/平滑/性能）；鼠标只能 hack |
| **B** | Node 自绘最小渲染层 | 自研 cell buffer + 差量刷新 + 轻布局（或保留 React 做布局、换渲染后端） | 全可控、无原生依赖、npm/desktop bundle 友好 | 工程量大：宽字符、IME、选择、性能都要自研 |
| **C** | OpenTUI（推荐候选） | `@opentui/core` + `@opentui/react`：Zig 核 + TS 绑定；flexbox；内建 mouse/scrollbox/input/select；图片/音效；OpenCode 生产验证 | 能力最接近 grok、React 心智可复用、社区活跃（MIT） | 原生依赖：需验证 Node ≥22 运行、Windows 预编译、npm 安装、与 desktop 内嵌 esbuild 单文件 bundle 的兼容；构建工具链（Bun/Zig）较重 |
| **D** | Rust TUI（ratatui/crossterm） | 与 grok 同栈，经 core 的 serve（HTTP/WS）通信 | 保真/性能上限最高；可直接参考 grok 结构 | 引入第二种语言 + 打包链路 + IPC 协议面；双端维护成本高；组织成本先问编排者/用户 |

### 4.2 Spike 验证清单与通过门槛（缺一不可）

1. **平台**：Node ≥22（本项目 engines）下可运行；Windows Terminal **真机**：鼠标滚轮/点击/拖动选择、Ctrl+C 复制、中文 IME 输入正常。
2. **性能**：合成 1 万行转录下，滚动/输入延迟 < 30ms；帧率 ≥ 30fps（或帧耗 < 33ms）；CPU 无持续满载。
3. **打包**：`npm i` 可安装（预编译二进制可用）；与 `packages/desktop` 的 CLI bundle（esbuild 单文件 + extraResources）兼容，或给出明确替代打包方案。
4. **体验底线**：宽字符（CJK/emoji）对齐正确；resize 正常；alternate screen 进出恢复原始终端状态；异常退出不残留鼠标上报。
5. **许可**：MIT/BSD/Apache 等宽松许可；无传染性条款。

### 4.3 产出物

- 报告：`docs/research/<日期>-tui-renderer-spike.md` —— 结论 + **原始数据**（命令、版本、截图/录屏路径、性能数字）+ 未通过项 + 建议。
- 可复跑 demo：独立目录/分支（如 `packages/tui-spike/` 或 `spike/`），**不得并入主线**；报告须给出复跑命令。
- 结论形式：在 A/B/C/D 中给出**推荐 + 决策矩阵打分**，并列出各自对 P1~P4 的影响。

---

## 5. 路线图（P1~P4）

> 各阶段的**完整施工单**（任务清单/测试/审查/验收/出口条件）见配套执行计划 [`2026-09-12-terminal-grok-parity-execution.md`](./2026-09-12-terminal-grok-parity-execution.md)；本节只保留地图级摘要。
> 每阶段独立分支、独立验收；**同一时间只有一个阶段改 `packages/cli/src/tui/**`**（见 §6）。
> 人日为粗估（±50%），P0 结论后才可细化。

### P1 输入与事件层（约 3~5 人日）

**目标：** 渲染引擎无关的统一输入模型 + 键位对照表。

**交付物：**
- `packages/cli/src/input/`：键/鼠标/焦点/粘贴事件的**统一解析与分发**（原始字节 → 语义事件；含 kitty/CSI-u、SS3、SGR 鼠标、bracketed paste、焦点 1004）。
- `docs/` 内《终端键位对照表》（grok 键位 vs 现状 vs 目标 vs 差异理由）。
- `HARNESS2_MOUSE` / `HARNESS2_NOTIFY` 等逃生开关的**统一开关约定**。

**验收条件（命令 + 期望）：**
1. `pnpm --filter harness2 exec vitest run test/input`（新目录）exit 0；解析用例必须喂**原始字节序列**（不得 mock 解析器内部）。
2. 既有键盘回归：`pnpm --filter harness2 exec vitest run test/tui/keyboard.test.tsx` 全绿。
3. 真机：IME 中文输入、粘贴、Ctrl+C/Esc 语义在 Windows Terminal 正常。

**依赖：** 无（可与 P0 并行）。**风险：** 与 Ink 键位通道的共存（已有 T2 的 unshift 回注方案可参考）。

### P2 渲染与布局层（约 10~20 人日，取决于 P0 选型）

**目标：** 新的渲染层 + 布局对齐 grok。

**交付物：**
- 渲染核心（自绘或 OpenTUI）：布局引擎（分层/弹性）、差量刷新、宽字符测量、resize、alternate screen 生命周期。
- 迁移：`TranscriptView`（scrollback pane：跟随/锚定/粘性 + 滚动条）、`Composer`（贴底 + 底边指示）、`StatusBar` 迁底、`OverlayHost`/`Modal`（锚定输入框上方）、`panels`。
- 视觉快照测试（字符网格断言）+ 性能基线脚本（10k 行合成转录）。

**验收条件：**
1. `pnpm --filter harness2 exec vitest run test/tui` exit 0（含新快照用例）。
2. 性能：`node scripts/bench-tui.mjs`（新）在 10k 行下 ≥ 30fps / 输入延迟 < 30ms，输出原始数字。
3. 真机：布局截图对比（对照 grok 截图）、resize、alt-screen 进出恢复。

**依赖：** P0 结论 + P1 事件层。**风险：** 选型落地风险（原生依赖/打包），需在 P0 已排除。

### P3 交互功能对齐（约 15~25 人日）

**目标：** 功能面对齐 grok（§3 表逐项）。

**交付物：**
- 斜杠/文件内联下拉（模糊匹配、Tab/Enter、滚动、悬停）。
- 审批 blocking card（Tab 走行、数字直选、Ctrl+F 展开、Esc 寄放）。
- 模式循环 + 指示器 + `/plan` `/auto` `/always-approve` 开关。
- 通知（焦点门控、多方法、标题栏可选、hooks 可选）。
- 子代理块（动画/着色/耗时）+ Enter 全屏**实时**子视图（core 已导出 `SubagentHooks`，装配层接线，勿改 core）。
- 状态行 + 快捷键条（随焦点/状态变化）；块折叠/展开；队列面板对齐。

**验收条件：**
1. 逐项行为对照表（本文件 §3 表 + grok 手册引用）勾选，每项附「命令 + 原始输出/截图路径」。
2. `pnpm --filter harness2 exec vitest run test/tui` exit 0。
3. 真机逐项操作录屏/截图。

**依赖：** P2。**风险：** 功能面广，必须按对照表收口，避免范围蔓延。

### P4 打磨与可选能力（约 10~20 人日）

**候选（按优先级）：** 文本选择与复制 → 超链接 → 主题/`/theme` → 搜索/时间线 → 图片（可选）→ Vim 模式（可选）→ 动画细节。

**验收条件：** 真机清单逐项；性能不退步；每项独立开关可回退。

---

## 6. 并行与文件冲突面（派工表）

> 规则：触碰同一文件集合的两个工作流**不可并行**（见 `docs/ai-framework/plan-layering.md` §4）。

| 工作流 | 触碰文件 | 可与谁并行 | 冲突（等谁） |
| ------ | -------- | ---------- | ------------ |
| **进行中** `feat/tui-ux-polish`（AI 子代理） | `packages/cli/src/tui/**`、`packages/cli/test/tui/**` | P0 spike（只写 docs + 独立目录） | — |
| **P0 Spike（同事）** | `docs/research/**`、独立 demo 目录（`packages/tui-spike/` 或 `spike/`，**不并入主线**） | 进行中阶段 | 不碰 `packages/cli` |
| **P1 输入层（同事）** | `packages/cli/src/input/**`（新）、`packages/cli/test/input/**`（新）、少量迁移点 | 无（等 TUI-UX 合并） | 等 `feat/tui-ux-polish` 合并 main |
| **P2 渲染层** | `packages/cli/src/tui/**`、依赖/打包脚本 | 无 | 等 P1 |
| **P3 功能对齐** | `packages/cli/src/tui/**` | 无 | 等 P2 |
| **P4 打磨** | `packages/cli/src/tui/**` | 无 | 等 P3 |

**合并由编排者仲裁**，不现场解决冲突。

---

## 7. 工程规约

1. **分支**：每阶段 `feat/tui-p0|p1|p2|p3|p4-<slug>`，从最新 `main` 拉；完成后走编排者验收再合并。
2. **提交**：`<gitmoji><type>(cli): 中文`（见 AGENTS.md）；小步提交，一 Task 一提交；**push 需编排者/用户授权**。
3. **边界**：`packages/core`、`packages/gateway`、`packages/desktop` **零改动**；`packages/core/test/fixtures/api-surface-baseline.json` 零变化。任何例外**先停下报编排者**。
4. **依赖**：新增依赖需在 PR/交接说明中列出：包名、版本、许可证、体积、为何自研不可行；原生依赖必须给出多平台验证结果。
5. **测试要求**：
   - 先红后绿：新用例必须先在旧代码上失败（留红截图/日志），再实现转绿；
   - 关键断言要能通过**变异验证**（临时破坏实现 → 用例必红 → 还原）；
   - 终端交互测试用**原始字节序列**驱动，不 mock 解析层；
   - 回归基线：`packages/cli` 全量用例数只增不减（TUI-UX 完成后基线以当日实测为准）。
6. **性能预算**：输入响应 < 30ms；10k 行转录 ≥ 30fps 或帧耗 < 33ms；无按键全屏重绘（差量刷新）；内存无持续增长（滚动 5 分钟不涨 > 20%）。
7. **可回退**：鼠标/通知/新渲染层等有风险项必须带开关（环境变量），异常时一键回退到可用状态；开关与行为写入文档。
8. **文档义务**：每阶段完成后更新本文件 §5 的验收勾选与 `docs/issue-log/YYYY-MM-DD.md`；有用户可见行为变化同步 README/HANDOFF（由编排者定稿）。

---

## 8. 检验协议（编排者独立验收）

> 以下步骤由编排者在**每阶段交付后**执行；实施同事需保证全部命令可复跑。

### 8.1 复跑清单（每阶段）

1. **边界检查**：`git diff --name-only <base>..HEAD` 全部落在允许路径内（见 §7.3）。
2. **冻结区检查**：`git diff <base>..HEAD -- packages/core packages/gateway` 为空；`api-surface-baseline.json` 无 diff。
3. **闸门**：`pnpm test`（含 build）、`pnpm -r typecheck`、`pnpm lint` 全 exit 0。
4. **逐条复跑**：按 §5 该阶段验收条件重跑命令，核对原始输出（不接受转述）。
5. **红绿核验**：检查用例先红后绿与变异验证的留存证据；抽取 1~2 条关键断言现场做变异复现。
6. **独立审查**：派只读审查子代理按 `CODE_REVIEW.md` 出 P0/P1/P2 报告（阶段级审查，与复跑互为补充）。
7. **真机项**：§8.4 清单由用户/同事在真实终端完成，截图/录屏留档。

### 8.2 结论模板（四段）

```
结论：✅ 通过 / ⚠️ 有条件通过 / ❌ 不通过
证据：命令 + 原始输出摘要（含 exit code、用例数）
问题：P0/P1/P2 列表（含复现步骤与影响）
下放：未关闭项 → 进 OPEN.md / 下阶段，缺陷显式带入
```

### 8.3 变异与抽查原则

- 「用例绿」不等于「断言有效」：关键行为（滚动、鼠标拦截、通知触发、子代理视图）必须做**删实现 → 必红**的抽查。
- 抽查不预先告知实施者；抽查命令与结果记入验收记录。

### 8.4 真机清单（用户确认，编排者整理）

1. Windows Terminal：布局（输入框贴底/状态行在底）、滚轮滚动、鼠标点击、中文 IME、粘贴、resize。
2. 斜杠下拉位置与键盘操作；审批卡片位置/键位；Esc 多级语义。
3. 回合结束响铃（失焦时响、聚焦时静默）；开关关闭后不响。
4. 子代理：块状态（运行/完成/失败 + 耗时）、Enter 打开视图、实时增量。
5. 性能：大会话滚动流畅度、无闪烁/撕裂；alt-screen 进出终端恢复原状。

---

## 9. 风险与回退

| 风险 | 影响 | 缓解 |
| ---- | ---- | ---- |
| P0 选型错误（如 OpenTUI 在 Node/Windows 不达标） | P2 返工 | 通过门槛缺一不可；spike 未过不得开 P2 |
| 原生依赖破坏 desktop 单文件 bundle | 发布链路断 | P0 必检项；必要时为 desktop 保留旧链路并双轨 |
| 范围蔓延（功能面大） | 交付延期 | §3 对照表收口；P3 逐项勾选验收 |
| 交互回归（键位/IME/粘贴） | 用户不可用 | P1 先做事件层；每阶段真机回归清单 |
| 性能退化 | 体验差 | 性能预算 + 基线脚本纳入验收 |
| 同事上下文成本 | 返工 | 本文件 + 研究文档 + grok 手册路径；每阶段交接说明 |

---

## 10. 附录

### A. grok 参考索引（速查）

| 主题 | 路径（`D:\AI_Projects\refs\grok-build`） |
| ---- | ---------------------------------------- |
| 键盘/焦点/卡片契约 | `crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md` |
| 斜杠命令 | `…/docs/user-guide/04-slash-commands.md`、`…/src/views/slash_dropdown.rs`、`completion_dropdown.rs` |
| 通知 | `…/docs/user-guide/05-configuration.md` §Notifications、`…/src/notifications/` |
| 子代理 | `…/docs/user-guide/16-subagents.md`、`…/src/scrollback/blocks/subagent.rs`、`…/src/app/agent_view/render.rs`（`open_subagent_fullscreen`） |
| 计划模式 | `…/docs/user-guide/19-plan-mode.md` |
| 状态行 | `…/docs/user-guide/25-status-line.md` |
| 鼠标 | `…/src/app/mouse.rs`、`…/src/scrollback/scrollback_pane.rs` |
| 提示符组件（模式指示） | `…/src/views/prompt_widget/mod.rs` |
| 下拉锚点 | `…/src/app/agent_view/render.rs`（`render_dropdown_chrome` 调用点） |

### B. 目标键位对照（节选，P1 需出完整表）

| 键 | grok 行为 | 我方现状 | 目标 |
| -- | --------- | -------- | ---- |
| `Tab` / `Shift+Tab` | 焦点在 prompt/scrollback 间切换；卡片内走行 | ⬜ | P1 定义并实现 |
| `PageUp` / `PageDown` | 滚动会话（prompt 聚焦也生效） | ✅ | 保持 |
| `Ctrl+U` / `Ctrl+D` | 半页滚动 | ⬜ | P1 |
| `Shift+Tab` | 模式循环（Normal→Plan→Auto→Always-approve） | ⬜ | P3 |
| `Esc` | 多级：取消 turn / 清草稿（双按）/ rewind / 关浮层 | 🟡 部分（取消/关浮层） | P1 拉齐语义表 |
| `Ctrl+C` | 有草稿先清、空则取消；再按升级退出 | 🟡 | P1 |
| `Ctrl+O` | always-approve 开关（grok）/ 我方=展开工具卡 | ⚠️ 冲突 | P1 出映射与差异理由 |
| `Ctrl+G` | grok=任务面板；我方=恢复跟随 | ⚠️ 冲突 | P1 出映射与差异理由 |
| `Ctrl+J/K` | grok=单行滚动；我方=子会话视图（T1 定） | ⚠️ 冲突 | P1 出映射与差异理由 |

### C. 现有 TUI 文件清单（P0 后可能整体迁移）

见 §2.2；迁移原则：**业务逻辑（`chat-setup.ts`、`commands.ts`、`transcript.ts` 的 reducer/投影）不动，视图层可替换**。

---

## 给实施同事的开工提示词（可直接粘贴）

> 你是 harness2 终端 TUI 的实施工程师。先完整阅读：
> ① `docs/ai-framework/plans/2026-09-12-terminal-grok-parity-program.md`（本文件）
> ② `docs/research/2026-09-12-grok-tui-alignment.md`
> ③ `AGENTS.md`、`coding-standards.md`
> ④ 参考源码 `D:\AI_Projects\refs\grok-build\crates\codegen\xai-grok-pager`（先看 `docs/user-guide/`）
>
> 从 **P0 spike** 开始：按 §4 验证清单做选型实验，产出报告与可复跑 demo；**不要动 `packages/cli`**（有进行中的阶段分支），不要改 core/gateway。P0 报告交给编排者评审后再开 P1。
> 每阶段遵守 §7 工程规约（先红后绿、变异验证、性能预算、可回退开关）；完成后按 §8 准备复跑证据。
