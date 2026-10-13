# Z10 阶段计划：P1/P2 能力补齐（用户 2026-10-13 拍板「p 系列的也都做下」）

> 上游依据：`docs/ai-framework/plans/2026-10-12-zcode-gap-register.md`（P1/P2 分级）+ **ZCode 源码快照**（`D:/AI_Projects/refs/ZCode`，commit 29628c9）+ 编排者内置浏览器实测。
> 纪律：无通道一律 disabled+title+data-placeholder（红线⑩）；不照抄他方商标/私有文案；每批验收由编排者亲跑。

## 0 权威规格（本轮新取，替换总账中的旧记）

### 0.1 ZCode 快捷键表（源码 `packages/ui/src/.../@zcode/shared/src/shortcutCommands.ts`，**权威**）

| 命令                                    | 默认键                              | 我们能否兑现                                                               |
| --------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| openCommandCenter                       | `CmdOrCtrl+K` / `CmdOrCtrl+Shift+P` | ✅ 已有 K；**补 Shift+P 别名**                                             |
| openSettings                            | `CmdOrCtrl+,`                       | ✅ 补                                                                      |
| findInTask                              | `CmdOrCtrl+F`                       | ⚠️ 会话内查找 UI 未做 → 先不绑（如实登记）                                 |
| toggleSidebar                           | `CmdOrCtrl+B`                       | ✅ 已有                                                                    |
| switchTheme                             | `CmdOrCtrl+Shift+L`                 | ✅ 补（主题切换通道现成）                                                  |
| toggleTerminal                          | `CmdOrCtrl+J`                       | ✅ 已有                                                                    |
| toggleSidePane                          | `CmdOrCtrl+Alt+B`                   | ✅ 补（`rightbar/toggle` 现成）                                            |
| previousConversation / nextConversation | `CmdOrCtrl+Shift+[` / `]`           | ✅ 补（±1 会话现成）                                                       |
| navigateBack / navigateForward          | `CmdOrCtrl+[` / `]`                 | ✅ 补（见 Z10-3 历史导航）                                                 |
| openModelMenu                           | `Ctrl+M`                            | ⚠️ 模型菜单 UI 未做 → 先不绑                                               |
| cycleSessionMode                        | `Ctrl+Shift+M`                      | ✅ 模式切换现成                                                            |
| cycleThoughtLevel                       | `Ctrl+T`                            | ✅ 思考档位现成                                                            |
| newTask / openWorkspace                 | `CmdOrCtrl+N` / `CmdOrCtrl+O`       | N 已有；**补 O**（工作区打开已真）                                         |
| closeActiveContext                      | `CmdOrCtrl+W`                       | ✅ 补（关当前会话上下文；语义需对齐"关闭当前会话/上下文"）                 |
| zoomIn/Out/Reset                        | `CmdOrCtrl+=` / `-` / `0`           | ⚠️ Electron 缩放（桌面可做；web 走浏览器缩放浏览器自管）→ 桌面真、web 不绑 |
| toggleInterfaceMode                     | `CmdOrCtrl+Shift+U`                 | ❌ 我们无 office/coding 双模式概念 → 如实不绑                              |
| openOnboarding                          | `CmdOrCtrl+Shift+O`                 | ⚠️ 引导向导（P2）未做 → 先不绑                                             |

> **注**：总账原写「Ctrl+Shift+E/F/P」与源码不符，以源码为准。

### 0.2 空态（内置浏览器实测 1440×900，主区 x=269 起）

| 元素               | 实测                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Logo/水印          | `svg 400×320`，顶部居中（x≈646，y=80）                                                        |
| 问候语             | 「上午好呀，有什么想让我帮忙的吗」36px，`[510,262 672×36]` 居中                               |
| 项目 chip          | `[516,348 96×28]` 显示项目名（实测 "server"）                                                 |
| 分支 chip          | `[613,348 90×28]` 显示 git 分支（实测 "main"）                                                |
| 输入区 placeholder | 「向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力」（我们已是「向 harness2 提问…」）  |
| composer 行        | `添加上下文 28×28` → `变更前确认 125×28` → `模型 292×28` → `档位 79×28` → `发送 28×28`，y=446 |
| 建议 chip ×4       | `周报总结/报错修复/PPT 制作/闲时任务`，各 `≈103×32`，y=511，间距 ≈17                          |

### 0.3 顶部导航

ZCode 顶左三枚 `28×28` @ y=14：`后退`(x=0) / `前进`(x=32) / `新建任务`(x=64)。

### 0.4 自动化视图（本轮已实现，实测对齐 ✅）

ZCode：主区 `自动化|工作流` 两 tab（90×34）+ 空态 + 「定时任务模板」两列卡（383px 宽）。我们已同构。

## 1 批次

| 批次                         | 内容                                                                                                                                                   | 验收                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Z10-1** 空态               | Logo 占位 mark（中性，非他方商标）+ 6 档时间问候 + 4 建议 chip（点击预填 composer）+ 项目/分支 chip 占位（Z10-2 接真）                                 | 两壳测试 + 浏览器实测各元素在场且文案一致                             |
| **Z10-2** composer 项目/分支 | 桌面：项目名（projects.json）+ `gitBranch` IPC；分支 chip 只读展示（切分支无通道 → 如实）；web：项目名只读 / 分支无通道 disabled                       | 两壳测试；真机看到真实项目名与分支                                    |
| **Z10-3** 顶部导航           | 后退/前进（会话历史栈）+ 新建任务，28×28 @ 顶左                                                                                                        | 后退/前进真生效 + `CmdOrCtrl+[`/`]`                                   |
| **Z10-4** 快捷键扩展         | 按 §0.1 表补齐可兑现项（Shift+P / Ctrl+, / Ctrl+Shift+L / Ctrl+Alt+B / Ctrl+Shift+[ ] / Ctrl+[ ] / Ctrl+O / Ctrl+W / Ctrl+M? / Ctrl+T / Ctrl+Shift+M） | 每条键真触发对应动作；表内不可兑现项如实不绑并登记                    |
| **Z10-5** 审批选项集         | 允许/始终允许/本会话/完全访问/拒绝/始终拒绝 + 反馈输入                                                                                                 | 先查 core 语义支持度，支持几条上几条，其余如实不摆                    |
| **Z10-6** 右栏               | 零 tab 启动器卡片（「打开标签页」+3 卡 156×88）、审查/Git tab 细节、代码查看器 tab                                                                     | 参考端右栏实测不可达 → 依总账审计 + refs 文档；能兑现的上，不能的登记 |
| **Z10-7** 设置补齐           | 外观「代码设置 + 代码预览」；浏览器控制分区                                                                                                            | 依 refs 文档（`refs-zcode.md` §设置 14 分区）+ 总账                   |
| **Z10-8** P2                 | tab 栏「搜索标签页」、tab 右键菜单（关闭/其他/全部）、使用统计、引导向导                                                                               | 同上                                                                  |

## 2 纪律与登记

1. 每批改动前先核 `docs/refs/*` 与 ZCode 源码（AGENTS.md 第 7 条）；
2. 参考端不可达/规格缺失的项（Z10-6/7/8 部分）→ **按审计事实实现 + 在报告显式标注「规格来源=审计而非本轮实测」**；
3. 不可兑现项（如 office/coding 双模式）→ 不绑键、不摆入口，登记差距；
4. 每批完成后编排者亲跑六包验收 + 浏览器复核，再提交并回填 `docs/issue-log/`。

## 3 实施中发现的新缺口（登记，追加批次）

### Z10-2b composer 控件未接壳 + 缺「档位」控件（P1，编排者核查坐实）

- 事实：`ui-shared/.../composer/composer-controls.tsx` 已有 **模型选择**（`composer-model-select`）与 **模式切换**（`composer-mode-switch`）组件，`Composer.tsx` 也渲染它们；但桌面 `useComposerControls`（`composer-controls-bridge.ts`）**全仓无调用点**、web 侧无对应注入 → **两壳实际都不渲染这两个控件**（实测我们的 composer 行只有 添加上下文/引用/附件/发送）。
- 且 ZCode 有而我们**没有**的第三件：**思考档位**（实测 `[1058,446 79×28]`「最高」，命令 `cycleThoughtLevel` = `Ctrl+T`）—— 仓库内连组件都不存在（仅 core config schema 有 `roles.*.effort`）。
- 处方：**Z10-2b** = 接壳（桌面经 `composer-controls-bridge` 注入、web 经 serve 设置端口取 config）+ 新增档位控件（选项与语义照 ZCode 实测/源码）+ 随之把 `Ctrl+M`（模型菜单）、`Ctrl+Shift+M`（模式循环）、`Ctrl+T`（档位循环）**由「不绑」转「真绑」**。

### Z10-9 杂项清理（登记）

- 旧 `ui-shared/renderer/components/ChatEmptyState.tsx` 已被 Z10-1 新空态取代、**无生产引用**（仅其自身测试引用），待清理（会减少 9 例旧测试）；
- 共享设置页 web 侧 `notifyDetails` 措辞（§62 未尽①）随 Z10-7 一并处理。
