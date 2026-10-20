# refs-zcode —— ZCode GUI 视觉与组件规格（复刻权威）

> 本文档是 harness2 **GUI（桌面 / Web）视觉与组件**的复刻依据，与同目录 `refs-zcode-layout.md` 配对。
> 条目前缀 **`Z-*`**，本文件从 **`Z-60`** 起（`Z-01`～`Z-45` 在布局文档）；编号**永不复用、永不重排**。
> 布局与默认展开折叠见 `refs-zcode-layout.md`——**先读它，再读本文**。

---

## 分析基线

| 项          | 值                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游仓库    | `D:/AI_Projects/refs/ZCode`（`origin` = `https://github.com/zai-org/ZCode.git`；**Apache-2.0**）                                                                  |
| 快照 commit | `3c5b2276`（v3.16.2 / 2026-10-20；上一基线 `aac47556` v3.15.1）                                                                                                   |
| 上游拉取    | ✅ 2026-10-20 拉取成功（`aac47556..3c5b2276` 两个 squash 同步提交）                                                                                               |
| 分析日期    | 2026-10-20（本轮**未逐条复核**视觉/组件条目——本轮工作面在侧栏会话操作区，见 `refs-zcode-layout.md` 同日更新；v3.16 侧栏重构可能使部分行号漂移，涉及时按 §2 勘正） |
| 权威范围    | GUI 的 **设计原则 / token / 字体与尺寸规范 / 组件规格 / 图标 / 主题链路 / 设置页与对话页规格 / 对话框族**                                                         |
| 非权威范围  | 布局与折叠（见 `refs-zcode-layout.md`）；ZCode 业务页面（见 §12 不采纳清单）                                                                                      |

### 本轮更新记录

| 日期       | 执行者                                   | 上游 commit                   | 改了什么                                                                                                                                                                          |
| ---------- | ---------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | 编排者（主会话）                         | `29628c9`（未拉取）           | 首建：完成视觉/组件/主题/设置页/对话页规格调研，产出 Z-60～Z-95                                                                                                                   |
| 2026-10-14 | 编排者（主会话，Explore 子代理源码取证） | `aac47556`（v3.15.1，已拉取） | 桌面五场景补组件规格：Z-96 composer 错误反馈、Z-97 长任务运行态与终态保护（行号全部实核）                                                                                         |
| 2026-10-20 | 编排者（主会话）                         | `3c5b2276`（v3.16.2，已拉取） | 仅刷新基线与登记：本轮工作面在侧栏会话操作区（layout 文档同日勘正并新增 Z-50/Z-51），本文档条目未逐条复核；**登记许可证 = Apache-2.0**（「整体移植/组件级搬代码」路线的法律前提） |

---

## 1 设计原则

### Z-60 产品性格与禁止项

原文摘要（`DESIGN.md:22-40`）：界面要 **"calm, dense, and operational rather than decorative"**；服务目标是长会话、高信息密度、键盘驱动、桌面/Web 对齐、i18n 容忍变长文本、明暗双主题。

**明文禁止**：过大的营销式留白；默认使用花哨渐变；大面积品牌色填充；background / card / popover 层级含混。

### Z-61 字号强制规范（最高优先级约束）

所有 UI 字号**必须**用 `text-ui-*` 专用刻度；**禁止** Tailwind 内置 `text-base/sm/xs`，**禁止**任意 `text-[13px]` 或内联 `font-size`；代码 / Diff / 终端除外（`DESIGN.md:9-18`）。改变界面字号**只改 `--ui-font-size`**，不得改 `html` 字号（`DESIGN.md:211`）。

### Z-62 颜色使用规则

只用语义 token，禁止 `text-white/60`、`border-white/10` 这类一次性值；页面根用 `bg-background + text-foreground`，内容容器用 `bg-card`/`bg-surface`，浮层用 `bg-popover`/`bg-menu`；主按钮 `bg-primary text-primary-foreground`；**优先用文字层级而非加边框/颜色制造密度**（`DESIGN.md:165-176`）。

### Z-63 深度（阴影）策略

克制：优先靠背景对比、边框、圆角，再考虑阴影。Overlay 用 `shadow-md`，只有 Toast / 强调浮卡才用 `shadow-lg`（`DESIGN.md:461-476`）。

### Z-64 动效原则

快、低调：淡入 / 缩放 / 方向滑入，**避免长弹簧动画**（`DESIGN.md:478-483`）；全局 `prefers-reduced-motion` 一律归零。

---

## 2 主题与 Token

### Z-65 三层结构与挂载点

实现是 **`primitive(static) → semantic(alias) → component(specific)`** 三层，全部在 `packages/ui/src/styles.css`：

| 层           | 载体                                                                                                                          | 说明                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| L1 primitive | Tailwind v4 内置 `--color-neutral-*` 等 + `styles.css` 里 `@theme` 中的静态值                                                 | 语义层只做引用                                          |
| L2 semantic  | `:root` / `@theme`（亮，`:57-306`）、`.dark`（`:308-459`）、`.theme-zai-light`（`:461-604`）、`.theme-zai-dark`（`:606-710`） | **Zai 两套为正式主题，`light/dark` 只是 fallback 基础** |
| L3 component | 同文件内的 `--color-git-*` / `--color-terminal-*` / `--color-usage-*` / `--color-*-node` 等                                   | 组件级特化                                              |

**重要：Zai 两层全硬编码 hex，绕过了 primitive 层**——这是 ZCode 的实现隐患；我们复刻时应保持 primitive→semantic 的引用关系（见 §13 待确认）。

### Z-66 主题清单与默认值

| 项         | 值                                                              |
| ---------- | --------------------------------------------------------------- |
| 偏好三选一 | `system` / `zai-dark` / `zai-light`（`useTheme.ts:3,21-25,86`） |
| **默认**   | **`zai-dark`**                                                  |
| 旧值归一   | `light → zai-light`、`dark → zai-dark`                          |
| 持久化 key | `zcode-theme`                                                   |

### Z-67 完整语义 token 表（Zai Light / Zai Dark）

| 变量                                                                                                              | Zai Light                                                                                    | Zai Dark                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--color-background`                                                                                              | `#f8f8f8`                                                                                    | `#161616`                                                                                    |
| `--color-background-win-alt`                                                                                      | `#ececee`                                                                                    | `#2b2b2b`                                                                                    |
| `--color-background-alt`                                                                                          | `color-mix(background 70%, transparent)`                                                     | `color-mix(background-win-alt 60%, transparent)`                                             |
| `--color-brand`                                                                                                   | `#000000`                                                                                    | `#ffffff`                                                                                    |
| `--color-accent`                                                                                                  | `#ebf4ff`                                                                                    | `#001d3d`                                                                                    |
| `--color-primary`                                                                                                 | `#000000`                                                                                    | `#ffffff`                                                                                    |
| `--color-primary-foreground`                                                                                      | `#ffffff`                                                                                    | `#000000`                                                                                    |
| `--color-secondary`                                                                                               | `#e6e6e6`                                                                                    | `#363636`                                                                                    |
| `--color-header` / `--color-panel`                                                                                | `#ffffff` / `#ffffff`                                                                        | `#202020` / `#202020`                                                                        |
| `--color-sidebar`                                                                                                 | `#f0f0f0`                                                                                    | `#161616`                                                                                    |
| `--color-surface`                                                                                                 | `rgba(13,13,13,0.03)`                                                                        | `rgba(255,255,255,0.05)`                                                                     |
| `--color-surface-hover`                                                                                           | `rgba(13,13,13,0.05)`                                                                        | `rgba(255,255,255,0.1)`                                                                      |
| `--color-card`                                                                                                    | `#ffffff`                                                                                    | `#2b2b2b`                                                                                    |
| `--color-popover`                                                                                                 | `#ffffff`                                                                                    | `#2b2b2b`                                                                                    |
| `--color-popover-header`                                                                                          | `#f8f8f8`                                                                                    | `#202020`                                                                                    |
| `--color-input`                                                                                                   | `#ffffff`                                                                                    | `#2b2b2b`                                                                                    |
| `--color-menu`                                                                                                    | `#ffffff`                                                                                    | `#2b2b2b`                                                                                    |
| `--color-menu-hover`                                                                                              | `#f0f0f0`                                                                                    | `#363636`                                                                                    |
| `--color-tab` / `--color-tab-active`                                                                              | `#f0f0f0` / `#ffffff`                                                                        | `#202020` / `#161616`                                                                        |
| `--color-hover`                                                                                                   | `rgba(13,13,13,0.05)`                                                                        | `rgba(255,255,255,0.05)`                                                                     |
| `--color-selected`                                                                                                | `rgba(13,13,13,0.05)`                                                                        | `rgba(255,255,255,0.1)`                                                                      |
| `--color-border`                                                                                                  | `rgba(13,13,13,0.1)`                                                                         | `rgba(255,255,255,0.1)`                                                                      |
| `--color-border-hover`                                                                                            | `rgba(13,13,13,0.15)`                                                                        | `rgba(255,255,255,0.15)`                                                                     |
| `--color-foreground`                                                                                              | `var(--color-neutral-800)`                                                                   | `var(--color-neutral-300)`                                                                   |
| `--color-foreground-subtle`                                                                                       | `color-mix(neutral-800 60%, transparent)`                                                    | `color-mix(neutral-300 60%, transparent)`                                                    |
| `--color-foreground-subtlest`                                                                                     | `color-mix(neutral-800 40%, transparent)`                                                    | `color-mix(neutral-300 30%, transparent)`                                                    |
| `--color-foreground-inverse`                                                                                      | `#ffffff`                                                                                    | `#000000`                                                                                    |
| `--color-success` / `-foreground`                                                                                 | `#1e8a3e` / `#ffffff`                                                                        | `#46bf72` / `#000000`                                                                        |
| `--color-warning` / `-foreground`                                                                                 | `#e07b00` / `#ffffff`                                                                        | `#ff8a30` / `#000000`                                                                        |
| `--color-destructive` / `-foreground`                                                                             | `#e03131` / `#ffffff`                                                                        | `#ff5c5c` / `#ffffff`                                                                        |
| `--color-diff-added` / `-foreground`                                                                              | `#1e8a3e` / `#ffffff`                                                                        | `#46bf72` / `#000000`                                                                        |
| `--color-diff-removed` / `-foreground`                                                                            | `#e03131` / `#ffffff`                                                                        | `#ff5c5c` / `#000000`                                                                        |
| `--color-idle-task` / `-surface`                                                                                  | `#9e77ed` / `#f5f3ff`                                                                        | `#7b5ce5` / `#160d38`                                                                        |
| `--color-interaction-ask-surface` / `-foreground` / `-fill`                                                       | `#ebf4ff` / `#0066dd` / `rgba(70,191,114,0.2)`                                               | `#001d3d` / `#80beff` / `rgba(70,191,114,0.24)`                                              |
| `--color-interaction-confirmation-surface` / `-foreground`                                                        | `#eaf7ee` / `#166b32`                                                                        | `rgba(70,191,114,0.16)` / `#87d9a4`                                                          |
| `--color-toast` / `--color-tooltip` / `-foreground`                                                               | `#ffffff` / `#f0f0f0` / `#0d0d0d`                                                            | `#2b2b2b` / `#2b2b2b` / `#f8f8f8`                                                            |
| `--color-tooltip-tag` / `-foreground`                                                                             | `#e6e6e6` / `#5c5c5c`                                                                        | `#363636` / `#adadad`                                                                        |
| `--color-tag`                                                                                                     | `#e6e6e6`                                                                                    | `#363636`                                                                                    |
| `--color-find-highlight` / `-active`                                                                              | `#fff4eb` / `#ffb26b`                                                                        | `#542500` / `#ff8a30`                                                                        |
| `--color-workflow-rule`                                                                                           | `rgba(13,13,13,0.055)`                                                                       | `rgba(255,255,255,0.065)`                                                                    |
| `--color-workflow-trace` / `-strong`                                                                              | `rgba(13,13,13,0.3)` / `0.55`                                                                | `rgba(255,255,255,0.35)` / `0.6`                                                             |
| `--color-trajectory-user` / `-assistant` / `-reasoning` / `-tool-call` / `-tool-result`                           | `#2563eb` / `#0f766e` / `#7c3aed` / `#d97706` / `#0284c7`                                    | `#60a5fa` / `#2dd4bf` / `#a78bfa` / `#f59e0b` / `#38bdf8`                                    |
| `--color-git-none` / `-modified` / `-added` / `-deleted` / `-renamed` / `-untracked` / `-ignored` / `-descendant` | `fg` / `#e07b00` / `#1e8a3e` / `#e03131` / `#0b7fff` / `#1e8a3e` / `fg-subtlest` / `#e07b00` | `fg` / `#ff8a30` / `#46bf72` / `#ff5c5c` / `#4099ff` / `#46bf72` / `fg-subtlest` / `#ff8a30` |
| `--color-file-node` / `-hover` / `-fg`                                                                            | `rgba(26,112,184,0.1)` / `0.16` / `#1a70b8`                                                  | `rgba(112,174,224,0.16)` / `0.22` / `#8fc5ef`                                                |
| `--color-skill-node` / `-hover` / `-fg`                                                                           | `rgba(116,83,176,0.1)` / `0.16` / `#7453b0`                                                  | `rgba(166,137,218,0.16)` / `0.22` / `#bda5e6`                                                |
| `--color-command-node` / `-hover` / `-fg`                                                                         | `rgba(86,98,112,0.1)` / `0.16` / `#566270`                                                   | `rgba(154,166,180,0.14)` / `0.2` / `#b5c0cc`                                                 |
| `--color-subagent-node` / `-hover` / `-fg`                                                                        | `rgba(111,122,47,0.1)` / `0.16` / `#6f7a2f`                                                  | `rgba(183,189,117,0.16)` / `0.22` / `#c8cd90`                                                |
| `--color-session-node` / `-hover` / `-fg`                                                                         | `rgba(20,128,122,0.1)` / `0.16` / `#14807a`                                                  | `rgba(104,196,188,0.16)` / `0.22` / `#93d8d2`                                                |
| `--color-plugin-node` / `-hover` / `-fg`                                                                          | `rgba(184,122,26,0.1)` / `0.16` / `#b87a1a`                                                  | `rgba(224,174,112,0.16)` / `0.22` / `#efc58f`                                                |
| `--color-usage-chart-1..6`                                                                                        | `#0b7fff` `#1e8a3e` `#9e77ed` `#e03131` `#e07b00` `#0aa7a7`                                  | `#4099ff` `#46bf72` `#7b5ce5` `#ff5c5c` `#ff8a30` `#42c8c8`                                  |
| `--color-context-breakdown-1..7`                                                                                  | 由 `#0b7fff` 递淡至 `#e0ecff`                                                                | 由 `#4099ff` 递淡至 `#e4f1ff`                                                                |
| `--color-usage-heatmap-0..4`                                                                                      | `color-mix(#0b7fff 0/18/36/58%, surface)`、`#0066dd 82%`                                     | `color-mix(#4099ff 0/24/42/62%, surface)`、`#80beff 78%`                                     |
| `--animated-gradient-text-strong` / `-soft`                                                                       | `rgba(13,13,13,1)` / `rgba(13,13,13,0.22)`                                                   | `rgba(255,255,255,1)` / `rgba(255,255,255,0.22)`                                             |

### Z-68 终端 / Ansi16 系列

| 变量                                                           | Light                                                      | Dark                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `--color-terminal-black`                                       | `#5c5c5c`                                                  | `#363636`                                                     |
| `--color-terminal-red` / `-green` / `-yellow` / `-blue`        | `#e03131` / `#1e8a3e` / `#e07b00` / `#0b7fff`              | `#ff5c5c` / `#46bf72` / `#ff8a30` / `#4099ff`                 |
| `--color-terminal-magenta` / `-cyan` / `-white`                | `#9e77ed` / `#0aa7a7` / `#adadad`                          | `#7b5ce5` / `#42c8c8` / `#adadad`                             |
| `--color-terminal-bright-black`                                | `#888888`                                                  | `#747474`                                                     |
| `--color-terminal-bright-red` / `-green` / `-yellow` / `-blue` | `#e03131` / `#1e8a3e` / `#e07b00` / `#0066dd`              | `#ff9999` / `#87d9a4` / `#ffb26b` / `#80beff`                 |
| `--color-terminal-bright-magenta` / `-cyan` / `-white`         | `#9e77ed` / `#0aa7a7` / `#0d0d0d`                          | `#a888f2` / `#8ee5e5` / `#f8f8f8`                             |
| 光标 / 选中 / 非活动选中                                       | `#0d0d0d` / `rgba(11,127,255,0.22)` / `rgba(13,13,13,0.1)` | `#f8f8f8` / `rgba(64,153,255,0.28)` / `rgba(255,255,255,0.1)` |

### Z-69 滚动条

全局：`scrollbar-width:auto`、`scrollbar-color: var(--color-border) transparent`；`::-webkit-scrollbar` 宽/高 **14px**；track 透明；thumb `min-height/min-width 32px`、`border: 3px solid transparent`、`border-radius: 9999px`、`background: var(--color-border)`、`background-clip: padding-box`。终端与 pptx 渲染面单独隐藏原生滚动条。

---

## 3 字体 / 字号 / 间距 / 圆角 / 尺寸 / 阴影

### Z-70 字体族

- UI Sans：App 默认 `font-sans` 栈（ZCode 仓库**未定义** `--font-sans`，依赖 Tailwind 默认）。
- UI Mono：`--font-mono`（`styles.css:140-142`），用于**路径 / 命令 / 代码 / ID / 快捷键 / hash / 模型 ID / 终端**。

### Z-71 字号刻度

基准 `--ui-font-size` 默认 **14px**（`--ui-font-size` 可调范围 **12–20**，`lib/uiFontSize.ts:3-5`）：

| class                    | 计算 | 值                          |
| ------------------------ | ---- | --------------------------- |
| `text-ui-xl`             | +4   | 18px                        |
| `text-ui-lg`             | +2   | 16px                        |
| `text-ui-base`           | =    | 14px                        |
| `text-ui-caption`        | −1   | 13px                        |
| `text-ui-sm`             | −2   | 12px                        |
| `text-ui-xs`             | −4   | 10px                        |
| `text-ui-2xs`            | −5   | 9px（**仅限工作流图轴面**） |
| `text-mobile-input-safe` | 固定 | 16px（防 iOS 聚焦缩放）     |

角色映射（`DESIGN.md:218-234`）：h1→xl；h2→lg；h3–h6/正文/按钮/标题→base（h3–h4 `font-semibold`、h5 `font-medium`、h6 `font-normal`）；caption→紧凑支撑文案；sm→次要/帮助/Tooltip/行内代码；xs→快捷键标签/徽标/计数/极弱元数据。

### Z-72 间距

基准 **4px**。推荐档：4（tight）/ 8（紧凑控件）/ 12（密集列表与菜单行）/ 16（标准卡片与面板）/ 20–24（大区块或弹窗内部）。

### Z-73 圆角（按可见容器嵌套降级，非按重要度）

| 场景                                                 | 圆角                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| 第一层圆角容器                                       | `rounded-xl`（12px）                                     |
| 嵌套依次降级                                         | `lg(8) → md(6) → sm(4)`                                  |
| 基础控件（按钮/菜单触发/Input/Textarea/Select 触发） | 默认 `rounded-lg`，按最近圆角父容器降级                  |
| 对话框外壳                                           | `rounded-2xl`（16px）（3 个预览弹窗例外为 xl）           |
| 菜单/下拉/上下文菜单/Select 面板外壳                 | `rounded-lg`；菜单项 `rounded-md`；项内嵌套 `rounded-sm` |
| 独立 popover                                         | 从 `rounded-xl` 起                                       |
| `rounded-full`                                       | 仅限刻意的胶囊/圆形                                      |
| `rounded-2xl` 的 4 个例外                            | 主聊天输入壳、会话状态浮层、Toast、品牌图标底板          |

### Z-74 尺寸与阴影

- 图标：`size-3 / 3.5 / 4 / 5 / 6`，**默认 `size-4`**。
- 控件高：`h-6 / 7 / 8 / 9`；方形图标按钮 `size-6 / 7 / 8 / 9`。
- 阴影四层：Base 无阴影 → Surface 用边框分隔 → Overlay `shadow-md` → Attention（Toast/强调浮卡）`shadow-lg`。
- 菜单：`bg-menu` + `border border-popover-border` + 常 `p-1` + `rounded-lg` + `shadow-md`；**相邻选项固定 2px 垂直间距（gap-0.5）**。

---

## 4 组件规格

### Z-75 Button

基础：`rounded-md border border-transparent text-ui-base/relaxed transition-colors`。
变体：`default / outline / secondary / ghost / destructive / warning / link`。
尺寸：`default h-7 px-2`、`xs h-5 rounded-sm px-2`、`sm h-6 px-2`、`lg h-8 rounded-lg px-2.5`、`icon size-7`、`icon-xs size-5`、`icon-sm size-6`、`icon-md size-7`、`icon-lg size-8`。默认图标 `size-4`。

### Z-76 Input / Textarea / Select

- Input：`w-full border border-input-border bg-input text-foreground`；hover `border-input-border-hover`；focus `border-input-border-focused bg-input-focused ring-0`；placeholder `text-foreground-subtlest`。尺寸 `xs h-5 rounded-sm px-2`、`sm h-6 rounded-md`、`default h-7 rounded-md px-2`、`lg h-8 rounded-lg px-3`。
- Textarea：`min-h-16 rounded-md border-input bg-input/20 px-2 py-2` + `field-sizing-content`。
- Select 触发：同 Input 语义，高度与圆角同档。

### Z-77 Card / Badge / Kbd / Separator / Avatar / Progress

| 组件      | 规格                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card      | `rounded-xl border border-card-border bg-card py-4 gap-4 text-ui-base/relaxed`；sm 档 `gap-3 py-3`；Header/Content/Footer `px-4`（sm `px-3`）；Title `text-ui-base font-medium`；Description `text-foreground-subtle` |
| Badge     | `h-5 rounded-full px-2 py-0.5 text-ui-xs font-medium`；内 svg `size-2.5`；变体 default/secondary/destructive/outline/ghost                                                                                            |
| Kbd       | `h-5 min-w-5 rounded-sm bg-muted px-1 font-sans text-ui-xs font-medium`；`KbdGroup` gap-1                                                                                                                             |
| Separator | 横 `h-px w-full`；竖 `w-px self-stretch`；`bg-border`                                                                                                                                                                 |
| Avatar    | 默认 `size-8`、sm `size-6`、lg `size-10`、`rounded-full`；有 Group / GroupCount                                                                                                                                       |
| Progress  | 轨道 `h-1 rounded-md bg-muted`；指示条 `rounded-full bg-primary`；支持多分段                                                                                                                                          |

### Z-78 Dialog / Popover / Tooltip / DropdownMenu / ContextMenu / HoverCard / Toast

| 组件         | 规格                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog       | 遮罩 `bg-black/60 backdrop-blur-xs`；面板 `rounded-2xl border border-popover-border bg-popover p-4 gap-4 shadow-md`，居中，`max-w-[calc(100%-2rem)]`；开合 fade+zoom-95 **100ms**                                                                   |
| Popover      | `z-[60] w-72 rounded-xl bg-popover p-2.5 border shadow-md`（含 Header/Title/Description）                                                                                                                                                           |
| Tooltip      | `max-w-xs rounded-lg border border-border bg-tooltip px-3 py-1.5 text-ui-sm text-tooltip-foreground`；方向滑入 2                                                                                                                                    |
| DropdownMenu | 面板 `rounded-lg border border-popover-border bg-menu p-1 gap-0.5 shadow-md`、`max-h/min-w-32`；item `min-h-7 rounded-md px-2 py-1 gap-2 text-ui-base/relaxed`，高亮 `bg-menu-hover`，disabled `text-foreground-subtlest`；`z-[60]`                 |
| ContextMenu  | 同上（shell `rounded-lg … bg-menu p-1 shadow-md`），`z-[60]`                                                                                                                                                                                        |
| HoverCard    | `z-50 w-72 rounded-lg bg-popover p-2.5 shadow-md ring-1 ring-foreground/10 duration-100`                                                                                                                                                            |
| Toast        | 定位 `fixed top-16`/`bottom-*`、`z-[9999]`；卡片 `rounded-2xl border bg-toast/60 shadow-lg backdrop-blur-xl text-ui-base`；两套宽度（300px 胶囊 / 自适应）；内网格 `[auto_minmax(0,1fr)_auto] px-2.5 py-2`；入场 200ms `cubic-bezier(.77,0,.175,1)` |

### Z-79 Tabs / Accordion / Collapsible / Switch / Checkbox / Alert / Command / Spinner / Resizable

| 组件             | 规格                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs             | list `rounded-lg p-[3px] text-muted-foreground h-8`（line 变体 `rounded-none`）；trigger `h-[calc(100%-1px)] rounded-md px-1.5 text-ui-base font-medium text-foreground/60`，active `bg-background text-foreground` |
| Accordion        | `rounded-md border`，item `not-last:border-b`，trigger `p-2`，内容 `animate-accordion-down/up`                                                                                                                      |
| Collapsible      | `animate-collapsible-down/up` + fade，**300ms**，内容延迟卸载                                                                                                                                                       |
| Switch           | `rounded-full`；default `h-[18px] w-[32px]`、sm `h-4 w-7`；thumb `size-4`/`size-3.5`；选中 `bg-primary`、未选 `bg-primary/30`                                                                                       |
| Checkbox         | `size-4 rounded-sm border-input-border bg-input`；选中/半选 `border-primary bg-primary`；半选用 `Minus`                                                                                                             |
| Alert            | `rounded-lg border px-2 py-1.5`；变体 default/warning/destructive                                                                                                                                                   |
| Command（cmdk）  | 容器 `rounded-xl bg-popover p-1`；输入 wrapper `p-1 border-b`、InputGroup `h-8`；list `max-h-72`；item `min-h-7 rounded-lg px-2.5 gap-2`，hover 与 `data-selected` 共用 `bg-menu-hover`；`CommandDialog` `top-1/3`  |
| Spinner          | `LoaderIcon size-4 animate-spin`，`role=status`                                                                                                                                                                     |
| Resizable handle | 透明 1px；focus 显 `bg-border-hover/60`；工作台手柄为 **4px 命中区** + hover/focus/drag 显 2px 圆头线                                                                                                               |

> **不存在 `radio-group` 组件**（`components/ui/radio-group.tsx` 无此文件）；单选经 dropdown-menu 或分段 tab 表达。

### Z-80 CodeViewer / DiffViewer

- CodeViewer 外层 `h-full w-full overflow-auto`；行内评论草稿卡 `rounded-lg border bg-background p-3 font-sans shadow-sm`；自定义 tooltip `border-radius: 8px`、`box-shadow: 0 4px 12px`。
- DiffViewer 基于 `@pierre/diffs`，渲染在 **Shadow DOM** 内，需显式设 `--diffs-font-family: var(--font-mono)`。

### Z-81 图标

`lucide-react`；基线 `size-4`，常用 `size-3 / 3.5 / 4 / 5 / 6`。品牌图标在 `packages/ui/src/assets/provider-icons/`（zai、openai、anthropic、opencode…），另有 `assets/{channel,cli,payment,plugin,document-skill}-icons` 与 `components/icons/windowIcons.ts`。

### Z-82 空态 / 错误态 / 加载

**没有全局标准 `EmptyState` / `ErrorState` / `Loader` 组件**——各 surface 局部实现。已知实现：`ChatEmptyState.tsx`、`ConversationDraftEmptyState.tsx`、`settings/PluginInstallEmptyState.tsx`、`TreemappingPane.tsx:506`、`feedback/TicketsView.tsx:233`。加载用 `Spinner`、`ChatLoading`、`RootStartupLoading`、`GlobalDatabaseStartupLoading`。

> 复刻决策：我们**可以**做一个统一的空态/错误态组件（属改进，非复刻），但视觉语言必须与本节规范一致。

---

## 5 主题链路

### Z-83 切换入口

1. 侧栏 Footer 账号菜单 →「界面主题」子菜单（radio 组）：系统默认 / 深色主题 / 浅色主题（`WorkspaceSidebarFooter.tsx:264-288`）。
2. 设置页 → 外观 →「界面主题」**下拉（Select，不是三宫格）**，带图标 Monitor / Moon / Sun（`settingsCodePreview.tsx:114-138`）。
3. 快捷键 `switchTheme` = `CmdOrCtrl+Shift+L`，行为是在浅/深之间切换（`shortcutCommands.ts:71`；`App.tsx:686-689`）。
4. quickpick 命令「切换主题到深色/浅色」。

### Z-84 data-* 与 class 全清单

| 载体            | 值                                                                                                                                                                                                       | 谁设置                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 根 class        | `dark`、`theme-zai-light`、`theme-zai-dark`                                                                                                                                                              | `useTheme.ts:66-68`                     |
| 根属性          | `data-zcode-browser-theme-surface = light\|dark`（仅当根已有该属性时）                                                                                                                                   | `useTheme.ts:37-56`                     |
| 根 style / meta | `root.style.colorScheme`、`meta[name=color-scheme]`、`meta[name=theme-color]`                                                                                                                            | 同上                                    |
| 设置页          | `data-active-section`、`data-settings-content-frame`、`data-settings-top-inset`、`data-settings-panel-frame`                                                                                             | `SettingsPage.tsx`                      |
| 桌面壳          | `data-desktop-window-frame="true"`                                                                                                                                                                       | `DesktopWindowFrame.tsx:45`             |
| 状态面板        | `data-state` / `data-display-mode` / `data-goal-status` / `data-goal-objective` / `data-running-background-count` / `-terminal-count` / `-agent-count` / `-workflow-count` / `data-ended-workflow-count` | `ConversationStatusPanel.tsx:1881-1893` |
| Composer        | `data-input-routing`                                                                                                                                                                                     | `ConversationComposer.tsx:2200`         |

> ⚠️ **不存在 `data-theme`，也不存在 `data-platform-*`**（全仓 grep 无命中）。平台差异靠 **JS 布尔 prop**（`isWindowsDesktop` 等），不是 data 属性。
> 我们的实现若要引入 `data-theme`，属于**改进**，需在实现计划里显式登记（避免与 ZCode 复刻混淆）。

### Z-85 跟随系统与持久化

- `matchMedia("(prefers-color-scheme: dark)")` 监听：`useTheme.ts:100-105` 与 `store/index.ts:400-433`。
- 持久化 key：`zcode-theme` / `zcode-interface-mode` / `zcode-ui-font-size-px` / `zcode-locale`。
- 多窗口同步字段：theme / locale / uiFontSizePx / interfaceMode（`store/index.ts:214-216,438-489`）。

### Z-86 桌面 nativeTheme

`useDesktopNativeThemeSync` → `platform.setTitleBarTheme(theme === "system" ? "system" : resolveTheme(theme))`（`root/useDesktopNativeThemeSync.ts:23-32`）→ preload → IPC `PlatformChannels.SetTitleBarTheme` → `nativeTheme.themeSource = theme` + `applyWindowsTitleBarTheme`。

### Z-87 界面模式（InterfaceMode）

`"office" | "coding"`，key `zcode-interface-mode`。切换入口：设置常规页 / 侧栏账号菜单 / 快捷键 `CmdOrCtrl+Shift+U`。**影响面**：侧栏与侧面板隐藏终端与 review；状态面板隐藏 Git；工具卡渲染；终端外壳；编辑器按钮组；插件预览排序；草稿问候语。

> 复刻等级：**参考**（本期不做，记条目备查）。

---

## 6 设置页规格

### Z-88 外壳

- 结构：`grid-cols-[68px_minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]`，行 `grid-rows-[minmax(0,1fr)]`。
- 左栏：48px 拖拽条 → 返回按钮（ghost / lg，`ArrowLeft` +「返回工作区」）→ 分组导航 → 底部 `WorkspaceSidebarFooter`（`max-lg:hidden`）。
- 导航项：`h-8 w-full rounded-xl px-2.5`；窄屏 `max-lg:mx-auto max-lg:size-10` 收成图标；激活 `bg-surface-hover text-foreground`。分组标题 `text-ui-sm text-foreground-subtlest`，窄屏 `sr-only`，组间窄屏加 `border-t`；最末是虚线框「引导」按钮。
- 右栏：容器 `border bg-background`（Windows `rounded-[5px]`，其余 `rounded-xl`）；顶部 48px 面包屑行；主区 `overflow-y-auto [scrollbar-gutter:stable]`。
- 内容列：`mx-auto w-full max-w-4xl px-4 pb-8 pt-0 lg:px-8 lg:pb-10`；区块标题 `h2 text-2xl lg:text-3xl`；面包屑 `items.length < 2` 返回 null。
- **没有全局搜索框，也没有外壳级分段 tab**；搜索是**分区级**的 `SettingsSearchInput`（`h-9 rounded-xl pl-9` + 左 `Search` 图标 + 可清除）。

### Z-89 分区清单与可见性

`settingsPageConfig.ts:45-159` 定义 **16 个分区**，分三组：`basics`=基础设置、`agentCapabilities`=Agent 能力、`dataAndStats`=数据与统计。

| 顺序 | id                  | 图标         | 中文标题            | 分组              |
| ---- | ------------------- | ------------ | ------------------- | ----------------- |
| 1    | general             | Settings2    | 常规                | basics            |
| 2    | appearance          | Palette      | 外观                | basics            |
| 3    | modelProvider       | Package      | 模型设置            | basics            |
| 4    | memory              | Brain        | 记忆                | agentCapabilities |
| 5    | subagents           | Bot          | 子智能体            | agentCapabilities |
| 6    | plugin              | Blocks       | 插件                | agentCapabilities |
| 7    | mcp                 | Cable        | MCP 服务器          | agentCapabilities |
| 8    | skill               | WandSparkles | 技能                | agentCapabilities |
| 9    | commands            | Terminal     | 命令                | agentCapabilities |
| 10   | automations         | AlarmClock   | 自动化（Beta 徽标） | agentCapabilities |
| 11   | hooks               | Anchor       | 钩子                | agentCapabilities |
| 12   | browser             | Globe2       | 浏览器控制          | basics            |
| 13   | computerUse         | Monitor      | 电脑控制            | basics            |
| 14   | shortcuts           | Keyboard     | 键盘快捷键          | basics            |
| 15   | workspaceFileSearch | FileSearch   | 工作区搜索范围      | basics            |
| 16   | usage               | BarChart3    | 使用统计            | dataAndStats      |

**实际可见只有 13 个**：`HIDDEN_SETTINGS_SECTIONS` 隐藏了 `automations`、`plugins`、`workspaceFileSearch`、`computerUse`（`lib/settingsNavigation.ts:27-35`）。`plugins` 会被重定向到 `plugin`。`migration` 是孤儿 id（无导航项）。

> **复刻要点**：可见性是**数据驱动**的；照抄 BASE 列表会多出 4 个不可见分区。

### Z-90 外观分区细节

- **主题**：`Select`（下拉），选项 system(Moon/Sun/Monitor 图标)、文案「系统 / 深色 / 浅色」；行标签「界面主题」，描述「选择浅色、深色或跟随系统主题。」
- **界面字号** `FontSizeInput`：`w-28` 数字输入、右对齐 `tabular-nums`、右侧固定 `px` 后缀；**12–20**，默认 14；失焦提交 / Enter 提交 / Esc 还原；隐藏原生步进器。
- **代码设置卡**：浅色代码主题 Select、深色代码主题 Select、显示行号开关、长行自动换行开关、代码字号 FontSizeInput（12–20）。主题选项 10 个：GitHub Light/Dark、Vitesse、Vitesse Dark、Minimal、Minimal Dark、GitHub HC、Catppuccin Latte/Mocha 等。
- **代码预览卡** `ThemePreviewCard`：头部 title（浅色预览 / 深色预览）+ themeName + 徽标（当前生效 / 浅色 / 深色）；主体渲染一段固定 TS 预览代码；浅色预览固定背景 `#f8f8f8`、深色 `#161616`；两卡 `grid gap-4 sm:grid-cols-2`。

### Z-91 其余分区内容要点

- **general**：语言 Select（system/zh-CN/en-US）；界面模式 Select（coding/office）+ 主动建议开关；终端卡（继承系统 Profile、终端字体、集成终端 Shell（仅 win32）、增强 find/grep）；网络卡（HTTP 代理 / No Proxy / 自定义 CA）；桌面与通知卡（硬件加速、接收预览版、自动更新、通知开关、通知声音、Windows 关闭到托盘、keep-awake）；交互卡（交互行为 queue/guide、AskUserQuestion 自动结束、模型 IO 全量保留、显示思考过程、显示 Todo、三组工具聚合）；任务自动归档 + 天数；数据目录；引导按钮。
- **memory**：工作区记忆开关 + 记忆查看器（**仅本地桌面**）。
- **subagents**：含跳转「管理模型」。
- **plugin / mcp / skill / commands**：复用同一个 `PluginsSection`（按 `mode` 区分）；含分区级搜索；MCP 有分段 tab；删除走确认框。
- **hooks**：含分区级搜索 + 「高级」分组。
- **browser**：非桌面提示「浏览器数据只能在 ZCode 桌面端管理」；不安全证书开关；清缓存 / 清全部（二次确认）。
- **shortcuts**：列头「命令 / 按键绑定 / 操作 / 作用域」；带按键录制搜索；「全部恢复默认」二次确认。
- **usage**：顶部来源分段 pill（App Usage + 各 Coding Plan）+ 用量图表。

---

## 7 对话页规格

### Z-92 Timeline 行类型（9 种）

协议判别联合 `conversationRowSchema`（`packages/shared/src/zcode-protocol-v4/rows.ts:420-432`）：

| kind             | 结构要点                                                                                                                                                                                         | 渲染 / 默认态                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turnHeader`     | origin / state / startedAt / endedAt / activeMs / workSegments / fileChanges                                                                                                                     | 调试串；真实分组由 `ConversationTurnGroup` 负责                                                                                                                 |
| `userInput`      | text / epilogueStart / origin / guided / attachments                                                                                                                                             | `epilogueStart` 之后**默认收起**                                                                                                                                |
| `assistantText`  | text / state(streaming·complete·interrupted·failed) / model / feedback                                                                                                                           | 可复制 / 赞踩 / 分叉 / 重试                                                                                                                                     |
| `reasoning`      | text / state / durationMs                                                                                                                                                                        | **默认收起**；流式时渐变扫光「正在思考」，完成显示「思考 · 持续了 N 秒」；内容 `max-h-60`、纯文本**不解析 Markdown**（防长思考卡顿）；收起后 **300ms 延迟卸载** |
| `toolCall`       | toolCallId / toolName / status(inputStreaming·pendingApproval·running·success·error·cancelled) / inputText / input / output / display / error / progress / outputPreview / backgrounded / workId | `ToolCallBlocks`；默认折叠；展开态持久化 `toolLayoutOpenState`；Todo 类在设置关闭时整行 null                                                                    |
| `artifact`       | artifactVersionId / type(pdf·pptx·docx·xlsx·image·html·md·text) / ref / sha256                                                                                                                   | `ArtifactRowView`                                                                                                                                               |
| `subagent`       | parentToolCallId / subagentType / status / summaryText / childSessionId                                                                                                                          | 不内嵌子行，走侧栏下钻                                                                                                                                          |
| `hookInvocation` | hookEventName / lane / executions                                                                                                                                                                | 行分发 default 返回 null，由工具/hook 卡承载                                                                                                                    |
| `timelineMarker` | payload：compact / forkNotice / forkCreated / modelChange / goalSet / goalVerify / retryNotice / checkpointRestored                                                                              | `TimelineMarkerRowView`；compact = 压缩边界                                                                                                                     |

可见性规则：关闭「显示思考过程」只隐藏每轮**后续** reasoning，第一条仍显示。

### Z-93 工具卡

- 头部 `ToolSummaryRow`：图标（可隐藏）+ `kindLabel` + `kindDetail` + source 小徽标（`rounded border bg-background-alt px-1.5 py-0.5`）+ 主/次文案 + diffCount + 状态节点 + **悬停才显现的 `ChevronRight`**（展开时 `rotate-90`）。整行 `role=button`，键盘 Enter/Space 展开。
- 失败态文字带**虚线下划线 + tooltip**，内含复制按钮（复制后变对勾）；文案「复制错误 / 已复制」。
- 结果区：`CollapsibleContent` + **300ms** 动画；`aria` 文案「展开详情 / 收起详情」。
- **没有统一的"在侧栏打开"按钮**——侧栏入口按行类型由宿主注入。

### Z-94 Composer

- 外壳 `z-20 w-full @container/composer`；草稿态居中 `max-w-2xl`。
- 输入体是 **Lexical 编辑器**（`ChatPromptEditor`），开启 `/` 按钮、`@` 提及按钮、附件动作、leadingActions、submitControl。
- **左簇**：模式切换（`V4ComposerModeSwitch`）+ 电脑控制入口 + 后台任务触发器。
- **右簇**：模型选择 `ModelConfigSelect`（trigger = provider 前缀 + 模型名，可退化为纯图标；菜单含「管理模型」与搜索）+ 上下文用量 `ChatContextUsage` + 思考深度循环 `ThoughtLevelCycleControl`（`Ctrl+T`）+ 停止（`Square`，Esc）或发送（`ArrowUpIcon`，`size=icon-md rounded-lg bg-brand`；pending 时 Spinner）。
- **模式切换**：DropdownMenu，首项是 Plan 复选框（选中后 trigger 旁出现灯泡标记），下方权限单选组，宽 `w-64`，每项图标+标题+描述。
- **`@` / `/` / `#` / `$`**：`@` 文件与画板、`/` 命令、`#` 会话、`$` 技能。
- **四类上下文 chip**：代码评论、网页元素、PPTX 元素、对话选区。
- 快捷键：**Enter 发送、Shift+Enter 换行**；停止按钮 tooltip 标 Esc。

### Z-95 状态面板的 mini 胶囊兜底链

`variant="auto"` 时按容器查询 `@min-[1280px]` 切换：<1280px 显示 mini 胶囊（`max-h-8.5`，宽 = 测量值 ≤320），≥1280px 显示面板（`rounded-2xl border bg-popover shadow-md`，展开 `max-h-[min(64dvh,32rem)] w-80`）。

胶囊内容**优先级链**：当前 Todo 项 → 活跃 Goal → Git 更改(+/−) → 已完成 Goal → 已完成 Todo 项 → Todo 计数 → 最近 SessionPlan → 运行计数 → 已结束工作流。图标按「恰好一类」取 Workflow/SquareTerminal/Bot，混合取 Activity。点击胶囊切回展开态。

### Z-96 composer 错误反馈形态（@aac47556 新增）

**主形态 = 输入框上方常驻错误横幅，不用 toast**：

- 渲染点 `packages/ui/src/v4/ConversationComposer.tsx:2354-2366`（`visibleError` → `ChatErrorBanner`，`mb-6 w-full shrink-0`，独立于输入 surface、先于 contextHeader）。
- 错误来源优先级链（`v4/SessionPane.tsx:4758-4761`）：`draftModelReadinessError ?? sendSubmissionError ?? (quotaBanner.takesOverError ? null : projectedComposerError)`。
- **发送失败**：造 `SEND_FAILED`（或 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`）错误对象，文案「发送失败，请稍后重试。」（`SessionPane.tsx:3716-3730`；`zh-CN.ts:5968`），**草稿保留不清空**；关横幅按错误指纹去重（关掉不立刻顶回，`SessionPane.tsx:4771-4782`）。
- 横幅内容：`Info/Anchor` 图标 + 单行截断消息 +（模型缺失时）升级/设置模型入口 +（有 detail 时）「查看详情」Dialog(`<pre>`) +「复制完整报错」+「反馈」+ 右上 X（label「关闭错误提示」`zh-CN.ts:5952`）：`ChatErrorBanner.tsx:280-363`（详情 `:307-325`、复制 `:180-221`、X `:352-363`）。横幅按钮刻意不用 Radix Tooltip 包裹（防 update-depth 循环，`:331-333`）。历史残留的模型不可用错误被抑制（`:132-141 shouldSuppressChatErrorBanner`）。
- **无一键重试**：banner 有 `onRetry/retryLabel/retryDisabled` props（`ChatErrorBanner.tsx:145-155,346-350`，label「重试」`zh-CN.ts:5953`）但 v4 调用点未传（`ConversationComposer.tsx:2359-2364`）；轮次级 retry 有链路但**产品 UI 刻意不渲染普通重试入口**（`ConversationRowView.tsx:263` 注释「协议兼容：上层仍可提供 retryTurn capability，但产品 UI 不渲染」；动作链本身在 `SessionPane.tsx:3858-3873`）。
- **服务离线 = pane 级错误面板**（非横幅）：错误码 mono 红字 + 「反馈」+ 主按钮「重新连接」（`v4/SessionSubscriptionErrorPanel.tsx:49-61`，调用 `SessionPane.tsx:5584-5590`；兜底文案「与代理的连接已断开」`zh-CN.ts:5950`）。
- provider 自动重试防打扰：**前 2 次不显示**，第 3 次起行内「重新连接中... n/max」扫光文本（`chat-input-toolbar/display.tsx:133-181`；阈值 `ConversationTurnGroup.tsx:150 MIN_VISIBLE_API_RETRY_ATTEMPT=3`、`:226-236`）。
- 队列错误暂停横幅 +「继续」：「由于当前响应出错，队列已暂停（内容未丢失）」（`v4/ConversationQueuePanel.tsx:366-397`；`zh-CN.ts:4729`）；CLI 重启丢输入的恢复条「重新发送/稍后」、不自动重放（`v4/PendingCommandRecoveryBanner.tsx:21-46`；`zh-CN.ts:2032-2034`）。
- **禁用发送键**：`opacity-50 + pointer-events-none`（`components/ui/button.tsx:10` 基类），**不解释禁用原因**——tooltip 在 `canSend=false` 时强制关闭（`ConversationComposer.tsx:1224-1226`），且 pointer-events-none 使 hover 也拿不到。canSend 判据：`!disabled && !pending && hasDraftToSubmit && routingAllowsSend && attachmentsReady && submissionReady`（`:1214-1222`）；整块禁用原因：connecting / draftRuntimeRebuilding / queueEditActive / quota blocksSubmit（`SessionPane.tsx:5200-5205`）。Enter 路径同门禁（`ConversationComposer.tsx:2404-2408`）。
- **toast 只用于次要提示**（入队/冲突/复制结果），**不用于发送失败**（`SessionPane.tsx:3053-3059,3923-3974`）。

### Z-97 长任务运行态与终态保护（@aac47556 新增）

- **Stop 键与发送键互斥**（同一位置）：`showStopControl = canStop && !hasDraftToSubmit`（`ConversationComposer.tsx:1215-1222`）——有草稿时 Stop 变回发送（=入队）。Stop = `variant="secondary" size="icon-md"` + `SquareIcon fill-current`、tooltip「停止生成」+快捷键 Esc（`:2195-2208`；`zh-CN.ts:4706`）；归属守卫 `dispatchCommand("stop", {expectedForegroundExecutionId})`（`SessionPane.tsx:4345-4371`）；Esc 仅 focused pane ∧ canStop（`:4394-4410`）。
- **轮次级耗时**：running「工作中 {duration}」/ 完成「已工作 {duration}」/ 中断「已停止 / 已被新消息中断」（`v4/ConversationTurnGroup.tsx:661-683`；文案 `zh-CN.ts:4693-4694,4700-4701`；格式化天/时/分/秒最多 2 单位 `v4/conversationWorkDuration.ts:16-39`）。**时钟只在运行中 1s tick**（`v4/ConversationTimeline.tsx:112 RUNNING_WORK_DURATION_TICK_MS=1000`、`:619-632` hasRunningUnit 才起表），**完成态耗时取协议事实防漂移**（`v4/conversationTurnWorkSegments.ts:52-61,113-115`）。窗口唤醒后补时追平（`ConversationTimeline.tsx:638-640`、`SessionPane.tsx:1695-1726`，Chromium 冻结后台定时器的对策）。
- **工具行刻意不用旋转 spinner**（流式期数量多、动画长期占渲染资源）：运行态= kindLabel 文案扫光（`animated-gradient-text`）+ 状态文字，图标保持静态——`ToolCallBlocks/ToolLayout.tsx:138-147`（注释即规格原文）；`running→completed` 边沿自动收起展开（`:169-180`）。有 fraction 才画进度条，否则 indeterminate 扫光（`ToolCallBlocks/ToolCallProgressIndicator.tsx:16-44`，`role="progressbar"`）。**单个工具行不显示耗时秒数**（全仓 `elapsed/durationMs/useNowTicker` 检索，唯一例外 eval-workflow-snippet `:31-42`）。
- 后台任务/子代理行才有耗时+取消：「已运行 n 秒」（baseline 单调时钟 `BackgroundTaskElapsedLabel.tsx:9-28,39-48`；`zh-CN.ts:4938-4939`）+ `cancellable!==false` 才渲染「停止」钮（`v4/ConversationStatusPanel.tsx:1008-1019`，钮实现 `:920-954`，SquareIcon + `chat.statusPanel.runningStop` `zh-CN.ts:4877`；子代理版 `:1544-1558`；1s tick `:1046-1060`）。
- **终态保护四机制**（「转圈不停」的根治组合）：① ACK 后投影静默 watchdog：2s 内权威投影无该 row → `requestRecovery()` same-sub 重拉、不伪造消息（`v4/conversationProjectionStore.ts:47 ACCEPTED_INPUT_PROJECTION_GRACE_MS=2_000`、`:1309-1336`）；② 逻辑帧装配超时 30s / 查询超时 10s（`packages/shared/src/zcode-protocol-v4/core.ts:70,83`；装配器 `wire-assembler.ts:178-183`）；③ 终态枚举收口 `terminalStates = {completedSuccess, completedInterrupted, failed}`（`SessionPane.tsx:1359`；渲染单元判定 `v4/conversationTurnRenderUnits.ts:171,187-189,241-243`；compact 取消标 interrupted `ConversationRowView.tsx:1955-1958`）；④ 订阅 ACK 陈旧保护（`v4/agentConversationTransport.ts:217-220`）。

---

## 8 对话框族规格

| 对话框                                                      | 形态 / 层级                                                                                                                                                                       | 交互                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionDialog`                                          | **底部 dock 卡片**（`relative z-1 w-full rounded-2xl border bg-popover shadow-xs`），**无遮罩、非模态**                                                                           | 无独立允许/拒绝按钮；选项来自协议 `orderedOptions` 的 **numbered listbox**，语义 `allowOnce / allowAlways / deny / denyAlways`，文案「允许 / 始终允许 / 拒绝 / 始终拒绝 / 允许本会话 / 始终允许此命令 / 始终允许本项目」；底部右侧「确认」`bg-brand`；键盘 ↑↓←→/Tab + Enter；底部有「使用 Tab / 上下键选择，回车确认」提示；选项行含内联**规则作用域 chip**（命令前缀 / 仅此命令）；拒绝可填反馈（`Textarea rows=1`、`max-h-[5lh]` 内滚）。**没有"记住本会话"独立复选框**——会话级授权以「允许本会话」选项形式出现 |
| `ElicitationDialog`（覆盖 AskUserQuestion 与 ExitPlanMode） | **底部 dock 卡片**（`relative z-1`、`max-h-[min(72dvh,42rem)] rounded-2xl border bg-popover shadow-xs`），无遮罩                                                                  | 单选 `role=listbox` / 多选 `role=group` + checkbox；自定义回答行；分题翻页 x/y 与上/下一题；footer「忽略」+ 主按钮（提交 / 继续 / 检查）；提示「使用 Tab / 上下键选择，回车或空格选中」                                                                                                                                                                                                                                                                                                                           |
| `V4UserInputDialog`（兜底）                                 | **居中模态**：`fixed inset-0 z-[100] bg-black/40`，卡片 `max-w-lg rounded-xl bg-surface shadow-lg`                                                                                | 选项为 outline 按钮；自由文本 Input（`sensitive` 时为 password）+「提交」                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ConfirmDialog`（Host）                                     | **居中模态 Radix Dialog**：`rounded-2xl bg-popover/98 p-5 ring-border shadow-2xl`、`sm:max-w-md`；`compact` 时 `top-[44%] max-w-[400px]` + 遮罩 `bg-black/20 backdrop-blur-[2px]` | 左「取消」(secondary/outline, `esc`)，右「确认」(default/destructive, `⏎`)；打开时**全局 Enter 直接确认**（有 checkbox 时让位）；可选 checkbox 行 + 可选右上关闭                                                                                                                                                                                                                                                                                                                                                  |

> **没有名为 `ConfirmDeleteDialog` 的文件**。删除类确认走 `ConfirmDialogHost` + `useConfirmDialog`。

---

## 9 复刻等级矩阵（本文件范围）

| 条目                                | 等级                        | 说明                                                                                 |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Z-60～Z-64 设计原则                 | **必刻**                    | 当纪律执行（尤其"禁止一次性色值""字号只用 text-ui-*"）                               |
| Z-65～Z-69 主题与 token             | **必刻**                    | token 值逐条对齐；**但 Zai 硬编码 hex 的做法改为 primitive→semantic 引用**（见 §10） |
| Z-70～Z-74 字体/尺寸/圆角/间距/阴影 | **必刻**                    | 数值逐条对齐                                                                         |
| Z-75～Z-81 组件规格                 | **必刻**                    | 直接引入 shadcn 原语 + 覆盖 token                                                    |
| Z-82 空态/错误态                    | **参考**                    | ZCode 无统一组件；我们可自建，但视觉需一致                                           |
| Z-83～Z-86 主题链路                 | **必刻**                    | 含跟随系统与 nativeTheme 镜像                                                        |
| Z-87 界面模式 office/coding         | **参考**                    | 本期不做，留条目                                                                     |
| Z-88～Z-91 设置页                   | **必刻**（骨架 + 规范分区） | 分区内容按我们的能力对齐，未实现项如实标注                                           |
| Z-92～Z-95 对话页                   | **必刻**                    | 9 种行类型、工具卡、composer、思考块、状态面板                                       |

## 10 与 ZCode 的刻意差异（我们做得更好）

| #   | ZCode 做法                                    | 我们的做法                                              | 理由                                                       |
| --- | --------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Zai 主题绕过 primitive 层直写 hex             | 坚持 primitive→semantic 两层引用                        | ZCode 自己留下的重构隐患；语义层被当色值层用，改色要改多处 |
| 2   | 主题靠根 class 切换（`dark` / `theme-zai-*`） | 同上，但**额外**引入 `data-theme` 便于 CSS 选择器与调试 | 与既有 harness2 习惯一致；需在实现计划登记为"改进"         |
| 3   | 无统一空态/错误态组件                         | 自建统一组件（视觉遵循 §4）                             | 我们有 CLI 与多壳的一致性需求                              |
| 4   | 右栏 tab 顺序只存内存，重启丢                 | 持久化到磁盘                                            | 体验改进                                                   |

> 这些差异**必须写进实现计划**，避免被误判为"复刻不到位"。

## 11 不采纳清单

| 条目                                                                                | 理由                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| office 模式（InterfaceMode）的完整实现                                              | 属 ZCode 的办公场景业务；本期不做，仅留条目      |
| 插件商店商业形态、Bots 面板、SSH/远程向导、whiteboard、treemapping、developer-tools | ZCode 业务专属或已停用                           |
| Zai 的 30KB `DESIGN.md` 原文                                                        | 只搬运与我们相关的规范（已落进 Z-60～Z-74）      |
| `@pierre/diffs` Shadow DOM 补丁                                                     | 依赖其私有交互；我们自研只读渲染需自己实现行选区 |

## 12 待确认项

1. `--color-ring` 的实际值（来自 `shadcn/tailwind.css`，本地无 node_modules）。
2. `--font-sans` 具体字体栈（仓库未定义）。
3. Tailwind primitive 各色阶的确切数值（由 Tailwind v4 内置提供）。
4. 逐字淡入与"已用时长/token"浮动提示：**无明确实现证据**。
5. ZCode 上游未拉取成功——实施前必须重试并复核本文档。
