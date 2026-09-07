# 阶段（桌面轨道）：桌面端设置面板 + 视觉对齐 Codex 基础线

> **状态：** 计划已就绪
> **For agentic workers：** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范：** `docs/ai-framework/phased-plan-driven.md`
> **唯一实施来源：** `docs/research/2026-09-07-terminal-desktop-implementation-plan.md`（阶段二）。本文档是它的**正式阶段化落地**，二者冲突时**以本文档为准**，方向与做法不偏离。
> **视觉唯一基准：** `design/prototype-v5.html` 及 `design/v5-*.png`。有分歧以原型真实 DOM/CSS 为准（截图仅辅助），**不重新设计一套**。

**Goal：** 把 `packages/desktop` 从「Chat 皮肤的 React 壳」升级为「达到 Codex 基础水平」的桌面工作台：完整设置弹窗（14 类信息架构）、主题工程化（CSS 变量化 + 可切换）、精简 Electron 菜单、会话侧栏搜索/重命名/归档、对话头、真实 diff 卡片、命令面板、任务完成通知。
**Architecture：** 纯展现层 + 少量主进程能力（菜单、配置读写、`Notification`、`@file` 文件读取）。渲染进程零 Node，一切经既有 `harness2:invoke` IPC 桥；设置数据读写复用现有 `config.json`/`auth.json`（与 CLI 共用，**不建平行配置**），纯桌面偏好落新文件 `desktop-preferences.json`（复用 `desktop-layout.json` 的「校验 + 损坏回退」模式）。`write/edit` diff 卡片复用现有文件快照数据。
**Tech Stack：** React 19 + Electron 44 + Vite；新增 `diff`/`@types/diff` 依赖；CSS 变量化（V5 暖纸 token + 深色）。
**实施档位：** 全能（开发 + 测试 + 代码审查）。端到端/真机 GUI 属手工项，列「残留手工验收清单」。
**子代理：** 建议启用（代码审查 + 验收独立角色）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | `docs/ai-framework/phased-plan-driven.md` |
| P0 | `docs/research/2026-09-07-terminal-desktop-implementation-plan.md`（阶段二全文） |
| P0 | `design/README.md`、`design/prototype-v5.html` |
| P0 | `packages/desktop/src/renderer/App.tsx`、`styles.css`、`store.ts`、`chat-model.ts`、`app-controller.ts` |
| P0 | `packages/desktop/src/main/main.ts`、`bridge.ts`、`layout-file.ts`、`serve-manager.ts` |
| P0 | `AGENTS.md`、`CODE_REVIEW.md` |
| P1 | `packages/desktop/src/shared/layout.ts`、`protocol.ts`、`packages/desktop/package.json`、`vite.config.mts` |
| P1 | `packages/core/src/config/schema.ts`（配置字段）、`packages/core/src/config/load.ts`（读法） |

**仓库路径：** `D:\AI_Projects\harness2`（本文用 `<root>` 指代）
**基线分支：** 从 `main` 拉 `feat/desktop-settings`

---

## Global Constraints（冲突时以本节为准）

1. **渲染进程零 Node（红线）**：渲染层不直接碰文件系统、不读 `config.json`/`auth.json`、不跑 shell/`git`。一切经既有 `harness2:invoke` IPC 桥（`bridge.ts` 的 `handleInvoke` 加 `cmd` 分支），或新增同名风格的命令。**设置写入必须走主进程**，且 `auth.json` 涉及密钥——界面只显示掩码，回写只写 `auth.json`，**绝不把密钥写进 `config.json` 或日志**。
2. **配置单一来源（与 CLI 共用）**：桌面设置弹窗读写的是**同一份** `config.json`/`auth.json`（global/项目级解析规则复用 core 的 `load`/`parseConfig`），**不建立桌面专属平行配置**。纯桌面 UI 偏好（默认分栏数、是否显示欢迎页等不影响内核行为的项）才落到新 `desktop-preferences.json`。
3. **主题工程化是地基（B0）**：`styles.css` 目前的十六进制颜色必须先抽成 CSS 变量（默认 = V5 暖纸浅色），否则后续主题切换/强调色全返工。**颜色值只来自 `design/prototype-v5.html` 的 `:root`（原样搬，不改数值）** + 一套 `[data-theme="dark"]` 覆盖（直接照抄现暗色硬编码值，不重新设计）。
4. **`packages/core` 默认不动**：本轨道**不修改内核逻辑、也不新增内核导出**。B4 上下文水条需要用 `getContextUsage(sessionId)`——**该只读导出由终端轨道（T6）独家新增，桌面轨道只通过 IPC（`getContextUsage` cmd）调用 `@harness2/core` 的同一导出，禁止在 desktop 里另算一套**。并行合并建议：先合终端轨道的 `packages/core` 改动，再合本轨道。除此之外不碰 core。
5. **`write/edit` diff 数据源**：用文件快照（before/after）拿到的内容，**不是**重新读磁盘当前状态（磁盘可能已被后续覆盖）。B5 只做**展示** + 「撤销此次修改」按钮（调用现有 undo 能力），**不做「接受/拒绝」交互**（工具已执行完，接受/拒绝语义是 undo/redo）。
6. **`@file` 协议与终端轨道一致**：B8 复用终端轨道 T9 定的**同一套 `@路径` 协议**（正则/64KB 截断/未找到提示文案），区别只是从 CLI 环境换成经 IPC 主进程读文件。两端行为必须一致。
7. **密钥/凭证不进 git**；默认**不 push**，除非人类明确授权。
8. **明确不做（本阶段）**：
   - ❌ 不做文件树面板、集成终端、Codemap「上图下码」、子代理树可视化、会话全文搜索引擎、崩溃报告可视化细化（全部属阶段三）。
   - ❌ 不做审批 `plan` 第四态的**行为实现**（那是内核 T1 的事，B2 只把 `approval.mode` 做成 UI 单选）。
   - ❌ 不做「接受/拒绝 diff」的确认机制（语义重叠 undo/redo，见 §5）。
   - ❌ 不做自动更新（如实注明「目前无自动更新」）。
9. **Git：** 小步 commit；**默认不 push**。

---

## 阶段开头：上阶段遗留（必填小节）

> 本轨道是新增量（独立于既有 1~12 生命周期阶段、后于 M4），**无生命周期意义上的上阶段**。但桌面端有一项既有已知项必须带入（来源 `docs/issue-log/` 与 `design/README.md`）。

| 上阶段遗留项 | 来源（测试/验证/审查） | 未通过原因 | 状态 |
|-------------|----------------------|-----------|------|
| 桌面端「太简陋」：无设置面板、主题色写死、Electron 默认菜单栏 | 用户反馈 + `design/README.md` | 能力齐但体验/视觉落后 | ⬜ 本阶段修复（B0/B1/B2 直接对应） |
| 桌面端 GUI 真机验收清单（分屏拖拽手感、断线重启、审批弹条、背景会话徽标等） | `docs/issue-log/OPEN.md` | 需 Windows 实机 | ⬜ 本阶段「残留手工验收清单」承接，部分沿用 |
| 无 | — | — | — |

---

## 跳过项（因档位未做，非缺陷，待补做）

| 跳过项 | 原因 | 待补做 |
|--------|------|--------|
| 端到端 GUI 真机（分屏拖拽/断线重启/系统通知/多屏） | 属端到端验收，需用户/真机 | ⬜ 待用户/真机补做 |
| macOS / Linux 桌面实机 | 跨平台真机，需部署机 | ⬜ 待部署机补做 |
| 代码审查 | 独立角色（子代理）执行 | ⬜ 独立审查方执行 |

---

## 与前后阶段

| 阶段 | 状态 | 交付 |
|------|------|------|
| 既有生命周期 1~12（M4 v1.0.0） | ✅ | 桌面壳（serve + preload 桥 + 多会话分屏）已交付 |
| **本阶段（桌面轨道）** | ⬜ | 设置面板 + 主题工程化 + 菜单精简 + 侧栏增强 + 对话头 + diff + 命令面板 + 通知 |
| 阶段一（终端轨道，另一文件） | 🔶 并行 | CLI 全屏 TUI（T0~T9），与本轨道互不依赖（仅 `getContextUsage` 协同） |
| 阶段三（工作台级） | ⬜ 勿塞进 | 文件树/终端/Todo/子代理树/codemap 等（G1~G15），交付本轨道并收到反馈后另行立项 |

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/desktop/package.json` | 修改 | 加 `diff`/`@types/diff` 依赖 |
| `packages/desktop/src/renderer/styles.css` | 修改 | B0 全量抽成 CSS 变量（V5 暖纸 token + `[data-theme=dark]`） |
| `packages/desktop/src/renderer/App.tsx` | 修改 | 主题切换入口、侧栏增强、对话头、diff 渲染、`@file` 输入 |
| `packages/desktop/src/renderer/components/SettingsDialog.tsx` | 新建 | 14 类设置弹窗（左侧分类 + 右侧内容） |
| `packages/desktop/src/renderer/components/CommandPalette.tsx` | 新建 | `Ctrl+K` 命令面板 |
| `packages/desktop/src/renderer/components/ConversationHeader.tsx` | 新建 | 对话头（cwd/分支/模型/上下文水条） |
| `packages/desktop/src/renderer/components/DiffCard.tsx` | 新建 | write/edit 红绿 diff 卡片 |
| `packages/desktop/src/renderer/theme.ts` | 新建 | `data-theme` 切换 / 偏好读取（可选） |
| `packages/desktop/src/main/main.ts` | 修改 | B1 菜单精简；B7 通知；B4 分支 IPC |
| `packages/desktop/src/main/bridge.ts` | 修改 | `handleInvoke` 加 `settings:*`、`getContextUsage`、`gitBranch`、`readFileForRef`、`notify` 等 cmd 分支 |
| `packages/desktop/src/main/preferences-file.ts` | 新建 | 仿 `layout-file.ts`：`desktop-preferences.json`「校验 + 损坏回退」读写 |
| `packages/desktop/src/shared/preferences.ts` | 新建 | 偏好 schema + 校验函数（main/renderer 共享） |
| `packages/desktop/src/shared/protocol.ts` | 修改 | `InvokeCommand` 类型加新 cmd（类型钉死） |
| `packages/desktop/src/renderer/store.ts` | 修改（可能） | 会话元数据（archived/renamed 覆盖层）态 |
| `packages/desktop/test/` | 新增 | 覆盖 preferences 校验、diff 计算、设置读写、命令面板过滤 |
| `packages/core/src/`（导出，仅 B4 需且终端未交付时） | 修改 | 只读 `getContextUsage`（若复用终端已交付则不重复加） |
| `docs/issue-log/2026-09-07.md` | 修改 | 记录 B0 变量化、B2 设置耦合点、`getContextUsage` 协同 |

---

## 配置或 API 契约（如有）

**`desktop-preferences.json`（新建，`~/.harness2/desktop-preferences.json`，与 `desktop-layout.json` 同目录）：**

```jsonc
{
  "theme": "warmPaper | dark | system",   // 默认 warmPaper
  "defaultPaneCount": 1,                    // 1..3
  "showWelcome": true,
  "notifyDetails": "minimal | full"         // 通知详情级别，默认 minimal
}
```
> 校验规则：未知字段忽略；`theme` 不在枚举内 → 回落 `warmPaper`；`defaultPaneCount` 越界 → 回落 1；非对象 → 全默认。**复用 `layout-file.ts`/`layout.ts` 的「normalize + 损坏回退」模式（抽公共函数 `readJsonWithDefault`，不要复制两套逻辑）。** 读写都走 IPC（`settings:getPreferences`/`settings:setPreferences`），渲染进程不直接碰文件。

**新增 IPC `cmd`（`handleInvoke` switch 中追加，类型加进 `protocol.ts` 的 `InvokeCommand`）：**

| `cmd` | 作用 | 读/写 |
|-------|------|-------|
| `settings:getConfig` | 读 `config.json`（已脱敏的常用字段） | 读 |
| `settings:updateConfig` | 改 `config.json`（白名单字段，禁止 key 类字段） | 写 |
| `settings:getAuthMasked` | 读 `auth.json` 掩码（gateways 等，回显 `****`） | 读 |
| `settings:updateAuth` | 写 `auth.json` gateway 凭据（仅 `auth.json`） | 写 |
| `settings:getPreferences` / `settings:setPreferences` | 桌面偏好 | 读/写 |
| `settings:getDoctorReport` | `doctor` 六项结果 | 读 |
| `settings:getCrashReports` | 崩溃报告列表 | 读 |
| `getContextUsage` | 读上下文占用（协同 `getContextUsage` 内核导出） | 读 |
| `gitBranch` | 读当前分支（主进程执行 `git rev-parse --abbrev-ref HEAD`，渲染端不跑 shell） | 读 |
| `readFileForRef` | 读 `@file` 引用内容（主进程 fs，64KB 截断） | 读 |
| `notify` | 系统通知（渲染端请求 notify 时走这里，或 main 直接触发） | 触发 |

> **注：** 配置读写优先复用 `packages/core` 的 config 模块（`load`/`parseConfig`），**避免在 desktop 重建一套 config schema**；只通过 IPC 暴露最小改动面。

---

## Task 0（B0）：前置工程——`styles.css` 颜色变量化（一切后续视觉任务的地基）

**Files：** `packages/desktop/src/renderer/styles.css`。

**行为：** 把硬编码颜色值全部替换成 CSS 变量，直接采用 `design/prototype-v5.html` `:root` 的 V5 暖纸 token（**原样搬数值，别改**）：

```css
:root{
  --bg:#F6EFE3; --surface:#FFFCF6; --surface2:#FBF4E9; --muted:#F0E7D8;
  --border:#E6D9C3; --border2:#D7C7AC;
  --fg:#3B2E21; --fg-muted:#8A7A66; --fg-dim:#B5A58C;
  --accent:#C7743B; --accent-2:#A85D28; --accent-soft:#F6E4D3;
  --ink:#4A3826;
  --ok:#6B8F4E; --ok-soft:#E9F0E0; --warn:#C98A2E; --warn-soft:#F9EAD3; --danger:#B5482E; --danger-soft:#F6E2DC;
  --code-bg:#33271A; --code-fg:#F2E8D6;
  --shadow:0 1px 2px rgba(70,50,30,.06),0 12px 32px rgba(70,50,30,.10);
  --radius:14px;
}
```
另加一套 `[data-theme="dark"]` 覆盖（**直接照抄现有暗色硬编码值**作为深色主题值，不重新设计）。**默认主题 = 暖纸浅色**（`:root` 生效，不加 `data-theme` 时）。

**Steps：**

1. 把 `styles.css` 里所有 `#xxxxxx` 替换成对应 `var(--xxx)`（**已统计约 70 处十六进制色值**）。替换时按语义归类（bg/表面/边框/前景/强调/状态/代码），不要只替换不归类。
2. 加 `:root`（V5 暖纸）与 `[data-theme="dark"]` 覆盖。
3. 验证：设置 `<html data-theme="dark">` 整个界面变深色，**不需要改任何组件代码**。跑 `pnpm --filter @harness2/desktop build` 确认无编译错；跑既有桌面测试 `pnpm --filter @harness2/desktop test` 全绿。
4. Commit：`🎨style(desktop): styles.css 颜色变量化（V5 暖纸 token + 深色主题）`

**验收标准：** 全局搜 `styles.css` 无裸十六进制颜色（除了这份 `:root`/`[data-theme=dark]` 定义本身）；`<html data-theme="dark">` 切换整个界面为深色；桌面既有测试不回归。

---

## Task 1（B1）：Electron 菜单栏精简

**Files：** `packages/desktop/src/main/main.ts`。

**行为：** `app.whenReady()` 之后调用 `Menu.setApplicationMenu(null)`。macOS 下如需保留系统级「关于/退出」可建极简 `Menu.buildFromTemplate` 只含 App 菜单项 + 「关于/退出/开发者工具」三条，**不要保留 File/Edit/View/Window/Help 默认整套**。

**Steps：**

1. 在 `main.ts` whenReady 里加 `Menu.setApplicationMenu(null)`（macOS 用极简模板）。
2. 验证：启动后窗口顶部无 File/Edit/View；`Ctrl+Shift+I` 仍能打开 DevTools（保留调试能力，别连这个也删）。
3. Commit：`♻️refactor(desktop): 精简 Electron 默认菜单栏`

**验收标准：** 启动后无默认菜单；DevTools 仍可开（`Ctrl+Shift+I`）。

---

## Task 2（B2）：设置弹窗组件 + 桌面偏好存储（最大 UI 任务）

**Files：** 新建 `components/SettingsDialog.tsx`、`main/preferences-file.ts`、`shared/preferences.ts`；改 `main/bridge.ts`（IPC）、`renderer/App.tsx`（挂载）、`shared/protocol.ts`（InvokeCommand）。

**行为：**

1. 弹窗结构：居中 dialog + 左侧分类导航 + 右侧内容区，遮罩点击/`Esc` 关闭；`Ctrl+,`（macOS `Cmd+,`）全局打开。
2. **左侧分类固定 14 类**（最终 IA，不要增删或讨论合并）：通用 General / 外观 Appearance / 模型与角色 Providers&Models / 审批与安全 Approval&Security / 记忆 Memory / 浏览器工具 Browser / 定时任务 Cron / 插件与集成 Plugins&MCP / 子代理 Subagent / IM 网关 Gateway / 会话与数据 Sessions&Data / 诊断 Diagnostics / 快捷键 Keyboard Shortcuts / 关于 About。每类内容与数据来源见来源文档 §3.4 表格（照抄）。
3. 第 3~10、12 类数据经 IPC 读写（`settings:*`）；渲染进程只调 `ipcRenderer.invoke('harness2:invoke', {cmd})`，不碰文件。
4. 第 1、2、13、14 类纯本地/静态，经 `settings:getPreferences`/`setPreferences`。
5. 第 8、11、12 类若数据结构复杂来不及做交互，**允许先只读展示**（导航条与框架必须搭出，标注「完整管理功能见后续版本」），但整个类目不能缺失。
6. 外观分类（第 2 类）：主题单选（暖纸浅色/深色/跟随系统），切换 `<html data-theme>`，写回 `desktop-preferences.json`。

**Steps：**

1. 先抽 `shared/preferences.ts`（schema + `normalizePreferences`，仿 `layout.ts`）+ `main/preferences-file.ts`（仿 `layout-file.ts`）+ `preferences.ts` 单测。
2. `bridge.ts` 加 `settings:*` IPC（`getConfig`/`updateConfig`/`getAuthMasked`/`updateAuth`/`getPreferences`/`setPreferences`/`getDoctorReport`/`getCrashReports`）+ `protocol.ts` 类型。
3. 实现 `SettingsDialog.tsx`（14 类导航 + 内容区），挂到 `App.tsx`，绑定 `Ctrl+,`。
4. 验证：`Ctrl+,` 弹出；14 类导航可切换；第 3、4、6、9、10 类（数据简单的）**必须能真实读写 `config.json`/`auth.json` 并重启后保留**；其余允许只读但不能不存在。
5. 跑：`pnpm -r typecheck && pnpm -r test`；桌面既有 41 测试不回归。
6. Commit（可拆多笔）：`✨feat(desktop): 设置弹窗（14 类 IA）+ settings:* IPC + desktop-preferences.json`

**验收标准：** `Ctrl+,` 打开；14 类齐全可切；数据简单类能真实读写并重启保留；配置与 CLI 共用同一份（不建平行配置）；`auth.json` 只显示掩码；既有测试不回归。

---

## Task 3（B3）：会话侧栏搜索 / 重命名 / 归档

**Files：** `packages/desktop/src/renderer/App.tsx`（侧栏部分），可能 `store.ts`。

**行为：**
- 侧栏顶部加搜索输入框，按标题/首条消息关键字过滤会话（**前端过滤**，全文索引属阶段三）。
- 每个会话项加更多按钮 `⋯` → 菜单：重命名（内联编辑标题）、归档（软删除，移出主列表但保留数据，在「已归档」折叠区可见/恢复）、删除（物理删除，复用现有逻辑 + 二次确认）。
- 归档状态：会话元数据里可扩展则加 `archived: boolean`；否则加一层轻量展示态覆盖层（**不碰事件溯源日志文件本身**）。重命名同理（只改展示元数据）。

**Steps：**

1. 若无会话元数据扩展位，设计一个轻量覆盖层（如 `desktop-metadata.json` 或会话目录 `metadata.json`），加 `archived`/`title` 字段。
2. App 侧栏加搜索框 + 更多菜单 + 归档折叠区 + 恢复。
3. 验证：搜索实时过滤；重命名持久化（重启仍在）；归档后移出主列表、在已归档可见可恢复；删除仍有二次确认且与改前一致。
4. Commit：`✨feat(desktop): 会话侧栏搜索/重命名/归档`

**验收标准：** 搜索实时过滤；重命名重启持久化；归档/恢复正常；删除二次确认不回归；**事件日志文件未被改动**。

---

## Task 4（B4）：对话头组件（cwd / 分支 / 模型 / 上下文水条）

**Files：** 新建 `components/ConversationHeader.tsx`，改 `renderer/App.tsx`、`main/bridge.ts`（`gitBranch`/`getContextUsage` IPC）。

**行为：** 每个对话面板顶部一条头（全局 topbar 之外）：当前会话 cwd、当前分支（`.git` 存在时 `git rev-parse --abbrev-ref HEAD`，`gitBranch` IPC 主进程执行）、当前模型（`roles.main` 展示名）、上下文占用水条。水条数据源 = core 只读 `getContextUsage(sessionId)`（经 IPC）。

**Steps：**

1. `bridge.ts` 加 `gitBranch`/`getContextUsage` IPC；`protocol.ts` 类型。
2. 实现 `ConversationHeader.tsx`，挂到对话区顶部。
3. 依赖终端轨道 T6 的 `getContextUsage` 核心导出（**本轨道不修改 core、不新增导出**）：B4 的 `getContextUsage` IPC cmd 直接 import `@harness2/core` 的 `getContextUsage` 调用。若并行验证时该导出尚未落地（终端轨道 T6 未提交），**IPC 通路与 UI 先行验证，导出落地后即生效**；若实在需要在本地临时跑通，可用现有压缩阈值做一次**仅限本地的只读换算兜底**，但最终必须切回 core 导出，禁止两套算法并存（合并时以终端轨道的 core 导出为准）。
4. 验证：切会话头部信息跟着更新；水条数值与终端 `/context` 命令读数一致（**同一会话**）。
5. Commit：`✨feat(desktop): 对话头（cwd/分支/模型/上下文水条）`

**验收标准：** 切会话头部更新；水条与终端 `/context` 读数一致；`getContextUsage` 单一实现（与终端轨道协调）。

---

## Task 5（B5）：`write`/`edit` 工具调用结果的 diff 卡片

**Files：** 新建 `components/DiffCard.tsx`，改 `renderer/App.tsx`（工具渲染）；加 `diff`/`@types/diff` 依赖。

**行为：** `write`/`edit` 结果用**文件快照**的 before/after 内容（非重读磁盘）经 `diff` 算行级差异，渲染红绿 unified diff 卡片（删除行 `var(--danger-soft)`、新增行 `var(--ok-soft)`），默认前 20 行，超出可展开。**只做展示 + 一个「撤销此次修改」按钮**（调用现有 undo 能力），不做「接受/拒绝」。

**Steps：**

1. 加 `diff`/`@types/diff`。
2. 实现 `DiffCard.tsx`（用 `diffLines`/`createTwoFilesPatch`；数据来自快照 before/after）。
3. 接到工具调用结果渲染处。
4. 验证：模型执行 `edit` 后对话流见红绿 diff（不再是参数 JSON）；点「撤销此次修改」正确触发 undo 并让文件回到之前状态。
5. Commit：`✨feat(desktop): write/edit 结果真实 diff 卡片 + 撤销按钮`

**验收标准：** `edit` 后见红绿 diff；撤销按钮正确 undo（文件复原）；本任务不改 core（纯展示 + 复用 undo）。

---

## Task 6（B6）：命令面板 `Ctrl+K`

**Files：** 新建 `components/CommandPalette.tsx`，改 `renderer/App.tsx`。

**行为：** 全局监听 `Ctrl+K`（macOS `Cmd+K`），弹出居中输入框 + 过滤列表；第一版固定 4 条：新建会话 / 切换分栏数（1/2/3）/ 打开设置 / 跳转到会话…（列会话标题选中即切）。上下键选中、Enter 执行、`Esc` 关闭。命令用数组注册（方便阶段三加条目），不做一次性写死分支。

**Steps：**

1. 实现 `CommandPalette.tsx`（注册一个命令数组 + 过滤 + 执行）。
2. 挂到 App，绑定 `Ctrl+K`，与 `Ctrl+,`/`Ctrl+N`/`Ctrl+F` 共存。
3. 验证：`Ctrl+K` 唤出；4 条命令执行；输入文字按标题模糊过滤。
4. Commit：`✨feat(desktop): Ctrl+K 命令面板（4 条基础命令）`

**验收标准：** `Ctrl+K` 唤出；4 条命令正确；标题模糊过滤正确。

---

## Task 7（B7）：任务完成通知

**Files：** `packages/desktop/src/main/main.ts` 或桥接层，使用 Electron `Notification` API。

**行为：** 一个 turn 结束（assistant 完成响应）且**窗口非当前聚焦**时弹系统通知（标题=会话标题或「harness2」，内容=assistant 回复前 80 字摘要），点击通知聚焦对应窗口并跳转会话。窗口聚焦时不弹（避免打扰），只体现在现有未读徽标。

**Steps：**

1. main 进程监听 turn 完成事件（经 WS 帧或桥接回调），配合 `BrowserWindow.isFocused()` 判断。
2. 用 Electron `Notification` 弹通知；点击 `focus()` + 跳转会话。
3. 验证：切到其它应用后让长任务会话完成 → 收到系统通知；点击聚焦并跳转；窗口前台不弹。
4. Commit：`✨feat(desktop): 任务完成系统通知（非前台时）`

**验收标准：** 非前台完成收到通知；点击聚焦跳转；前台不弹；不破坏现有未读徽标。

---

## Task 8（B8）：`@file` 引用在桌面端打通

**Files：** `packages/desktop/src/renderer/App.tsx`（输入框逻辑）、`main/bridge.ts`（`readFileForRef` IPC）、`protocol.ts`。

**行为：** 桌面输入框复用**终端轨道 T9 定的同一套 `@路径` 协议**（正则、64KB 截断、未找到提示文案一致），区别：文件读取经 IPC 主进程（`readFileForRef`）。可加下拉建议（输入 `@` 弹当前 cwd 下文件列表供点选）——**加分项，非阻塞**；时间不够先只做纯文本解析，**但两端行为必须一致**。

**Steps：**

1. `bridge.ts` 加 `readFileForRef`（主进程 fs + 64KB 截断）；`protocol.ts` 类型。
2. App 输入框发送前复用 T9 的 `@file` 解析（抽纯函数共享；本阶段可先 CL 内部实现，后续抽公共协议），把解析结果经 `readFileForRef` 读回、拼进消息。
3. 验证：桌面输入 `@README.md 总结一下` 效果与终端一致。
4. Commit：`✨feat(desktop): 输入框 @file 引用（与终端轨道协议一致）`

**验收标准：** 桌面 `@README.md 总结一下` 效果与终端一致；不存在的路径不报错不阻塞；实现与终端轨道 T9 同源（不允许各写一套）。

---

## Task 9（B9）：阶段二整体收尾自检

**Files：** 无新代码；对照清单打勾。

**行为：** 对照来源文档 §3.5 的 P0 必做 8 项逐条打勾，**全部打勾才算「达到 Codex 基础水平」**：

1. `Ctrl/Cmd+,` 打开设置弹窗，14 个分类导航齐全。
2. 主题可在暖纸浅色/深色间切换，切换后不需要重启应用。
3. 顶部不再是 Electron 默认菜单栏。
4. 会话侧栏能搜索、能重命名、能归档（不只是删除）。
5. 每个对话面板顶部有独立对话头（cwd/模型/上下文水条）。
6. `write`/`edit` 工具结果展示真实红绿 diff，而不是参数 JSON。
7. `Ctrl/Cmd+K` 唤出命令面板并至少执行 4 条命令。
8. 窗口非前台时，任务完成收到系统通知。

**Steps：**

1. 逐条核对并在 `docs/issue-log/2026-09-07.md` 记录。
2. 跑：`pnpm -r typecheck && pnpm -r test` 全绿 + 桌面既有测试不回归。
3. Commit：`✅test(desktop): 阶段二 8 项 P0 自检`（若仅记录则并入最后一条提交）。

**验收标准：** 8 条全达；typecheck + 测试绿；记录留痕。

---

## 代码审查（阶段级环节，验收前，按档位执行）

**审查方：** 独立角色（子代理，非本阶段实现者；只读）

**审查面：** 代码风格 / 测试完整性 / 依赖合理性（`diff` 必要；确认未引入平行配置）/ 架构红线（渲染进程零 Node 是否被破坏、`config.json`/`auth.json` 是否被渲染层或错误处直接触碰、密钥是否仅存 `auth.json`）/ 安全（掩码、secret 不入 config/日志）/ API 契约一致性（`InvokeCommand` 类型、`getContextUsage` 签名、`desktop-preferences.json` schema）。

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
| 1 | 主题工程化 | `styles.css` 无裸色值；`data-theme=dark` 切换无需改组件 | 自动化（执行方） |
| 2 | 设置弹窗 | `Ctrl+,` 打开；14 类齐全；简单类能真实读写 `config.json`/`auth.json` 并重启保留 | 自动化（执行方）+ 真机 |
| 3 | 侧栏增强 | 搜索/重命名/归档/恢复；事件日志文件未改 | 自动化（执行方） |
| 4 | 对话头 | cwd/分支/模型/水条；水条与终端 `/context` 读数一致 | 自动化（执行方）+ 真机 |
| 5 | diff 卡片 | `edit` 见红绿 diff；撤销按钮正确 undo | 自动化（执行方）+ 真机 |
| 6 | 命令面板 | `Ctrl+K` 唤出；4 条命令 + 模糊过滤 | 自动化（执行方） |
| 7 | 通知 | 非前台完成收到通知；点击聚焦；前台不弹 | 真机（不设执行方自证） |
| 8 | `@file` | 桌面与终端行为一致 | 自动化（执行方） |
| 9 | 构建/typecheck | `pnpm -r typecheck && pnpm -r test` exit 0；桌面 41 测试不回归 | 自动化（执行方） |
| 10 | 代码审查 | 结论 ✅ 或 ⚠️（问题已登记）；❌ 下放 | 独立角色（子代理） |
| 11 | 红线 | 渲染进程零 Node 未破坏；密钥仅 `auth.json` 且掩码；无平行配置 | 自动化（执行方）+ 审查 |
| 12 | 密钥 | `git ls-files` 无敏感文件 | 自动化（执行方） |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 渲染进程零 Node 被破坏（renderer 直读 config/跑 git） | 红线钉死：一切走 `harness2:invoke` IPC；审查重点核对 renderer 无 `fs`/`child_process`/`electron` 主进程 API |
| `auth.json` 密钥泄露到 config/日志 | 仅写 `auth.json`；`settings:getAuthMasked` 只回掩码；出口脱敏（复用 core redactSecrets） |
| 配置读写逻辑与 CLI 分叉 | 复用 core `load`/`parseConfig`；不重建 schema；只在 bridge 暴露最小 IPC |
| `getContextUsage` 与终端轨道三套算法 | 单一 core 只读导出；B4 与 T6 协同（见 Global Constraint §4） |
| 主题切换后视觉回归 | B0 先落地（地基）；验收标准 1 用 `data-theme=dark` 直接验证，不需改组件 |
| `desktop-preferences.json` 损坏 | 复刻 `layout-file.ts`「normalize + 回退」；读容错、写前 normalize |
| 设置弹窗 14 类体积过大来不及做全交互 | 分类导航与框架必须先齐；复杂类先只读展示（标注「见后续版本」）；不允许整个类目缺失（B9 验收 #1 硬指标） |

**降级路径（若工期紧）：** 优先保住 B9 的 8 项 P0 硬指标；B2 中复杂类目（MCP/插件/记忆/诊断/数据导出）先只读展示，交互交互后置；`@file` 下拉建议（B8 加分项）可先不做（只做纯文本解析，仍满足两端一致）。

---

## 给接手 AI 的完整提示词

将下面整段粘贴给执行 AI 即可开工：

---

你是负责 **harness2** 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_Projects\harness2`
- 从 `main` 创建并切换：`feat/desktop-settings`
- 已完成：项目已到 M4（v1.0.0，生命周期 1~12 全部完成），本阶段是 M4 之后的**桌面 UX 增量轨道**。
- 唯一实施来源：`docs/ai-framework/plans/2026-09-07-phase-desktop-settings.md`（本文）与 `docs/research/2026-09-07-terminal-desktop-implementation-plan.md`。
- **视觉唯一基准：** `design/prototype-v5.html` 及 `design/v5-*.png`——照着做，别重新设计；有分歧以原型真实 DOM/CSS 为准。
- 必读：`docs/ai-framework/phased-plan-driven.md`、`AGENTS.md`、`CODE_REVIEW.md`、`packages/desktop/src/renderer/App.tsx`、`styles.css`、`main/bridge.ts`、`main/layout-file.ts`。

### 做
1. 先跑基线确认干净：`pnpm -r typecheck && pnpm -r test`。
2. 严格按本文 Task 顺序执行：**B0（CSS 变量化，地基）→ B1（菜单）→ B2（设置弹窗）→ B3（侧栏）→ B4（对话头）→ B5（diff）→ B6（命令面板）→ B7（通知）→ B8（@file）→ B9（8 项自检）**。**不得跳步**。
3. 每 Task 测完（对应冒烟/测试）后 commit，小步可审查。
4. 每个 Task 的验收标准都实际跑证据，禁止「应该能过」。真机 GUI 项（通知/分屏/主题切换手感）你在能跑的环境做，跑不了的**如实登记「手工待补」**，不得虚构通过。

### 不做
- 不破坏「渲染进程零 Node」：渲染层不碰 `fs`/`child_process`/主进程 API/`config.json`/`auth.json`，一切走 `harness2:invoke` IPC。
- 不改 `packages/core` 内核逻辑；唯一触点 = `getContextUsage`（若终端轨道已交付则复用，否则与终端一致地新增只读导出，禁第三套算法）。
- 不做文件树/集成终端/codemap/子代理树/全文搜索引擎/崩溃报告可视化细化（阶段三）。
- 不做自动更新（如实注明「目前无自动更新」）。
- 不把密钥写进 `config.json`/日志；`auth.json` 只显示掩码。
- 不 push；不提交密钥。

### 工作方式
1. 先测基线再动代码；每 Task 完成跑 `pnpm -r typecheck && pnpm -r test`。
2. 使用 `design/prototype-v5.html` 作为视觉与配色准绳；颜色值只来自 V5 暖纸 token 与深色覆盖，不要自行发明。
3. 用简体中文回复进度；代码标识符保持原样。

### 交卷
全部完成后给出：分支名、提交列表、验收表自评（✅/⚠️/❌ + 命令与输出）、测试/构建结果、B9 8 项逐条结果、残留风险、需用户真机补做清单。

现在开始：读完本阶段计划，从 Task 0（B0）执行到最后。

---

## 残留手工验收清单

（自动化之外的 GUI / 真机项）

1. **B2**：设置弹窗 `Ctrl+,` 打开、14 类切换、主题切换（暖纸/深色/跟随系统）实机；配置保存后重启保留。
2. **B3**：侧栏搜索/重命名/归档/恢复的实机拖拽与手感想。
3. **B7**：系统通知在真实桌面（非前台完成收到、点击聚焦）——必须真机，执行方不能自证。
4. **B8**：桌面 `@file` 下拉建议（如需）与命令行一致性实机。
5. **分屏/断线重启/后台会话徽标**（OpenCode 既有真机清单）：沿用/复核，本阶段不重做但不回退。
6. **macOS / Linux 桌面**：跨平台实机冒烟（含主题切换、菜单精简）。
