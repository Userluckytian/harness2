# harness2 桌面端重设计 · 分析与设计稿

> 目的：盘点现有功能 → 对标市面主流 agent harness → 找出**缺失/可增强点** → 产出一套可落地的重设计方案（HTML 设计稿）。
> 设计系统依据 `<ui-ux-pro-max>` skill 生成（OLED 暗色 + 绿 accent + Inter）。
> 查看设计稿：直接双击打开 `workspace.html` / `agent-trace.html`（无需构建，浏览器即可）。

---

## 1. 现有功能清单（真实能力盘点）

### 1.1 CLI / 内核（packages/core + cli）
| 能力 | 说明 |
|------|------|
| 事件溯源会话内核 | JSONL append-only、单写者、崩溃一致；不变量 Model-visible ⟺ logged |
| Agent loop | turn/step 状态机、流式、取消、失败尝试单独记录（`assistant/attempt`） |
| 工具系统 | 注册返 disposer、pre/execute/post 管线、并发安全声明、同文件编辑锁键串行 |
| 基础工具 | `bash / read / write / edit / grep / glob`（截图/浏览器另计） |
| Provider 抽象 | OpenAI-compatible 起步 + DeepSeek/Anthropic；`{channelId, model}` 按角色配置；key 分离存储 |
| 配置体系 | 全局 + 项目两级；`$VAR` 展开；key 永不入 config |
| 审批与权限 | 三 mode（default/acceptEdits/bypass）+ per-tool 规则（allow/ask/deny） |
| 会话管理 | 多会话、`/resume`、`/fork`（血缘入 header）、会话搜索 |
| undo / redo | 对话投影截断 + 文件快照联动恢复、冲突检测、dry-run 预览 |
| 轨迹 `traj` | 全事件落盘，读日志渲染时间线（turn/step/tool 调用树、耗时、token） |
| `doctor` / `config check` | 环境自检、配置核对（key 只显来源标签） |

### 1.2 进阶能力（阶段 6-10）
| 能力 | 说明 |
|------|------|
| 记忆系统 | 三态 off/ask/auto；MEMORY.md/USER.md 硬预算 + 漂移检测 + nudge 后台复盘 |
| 内嵌浏览器 | `browser_navigate/click/type/snapshot/screenshot/close`，aria 快照引用，资源红线 |
| 上下文压缩 | 75% 阈值、roles.small 摘要、近 6 条原文保留、失败跳过不中断 |
| 定时任务 cron | 60s tick、跨进程锁、at-most-once、连败熔断、history |
| 插件 | manifest 声明式权限、装载审批、事件总线 |
| MCP | stdio / Streamable HTTP、`mcp__<server>__<tool>`、断线退避重启 |
| 子代理 subagent | `subagent_start/continue`、独立子会话完整 runTurn、父取消传播 |
| IM 网关 | QQ（官方 v2）+ 飞书，审批回复式、三态私聊/群策略 |
| 导出 / 回放 | `export`（ZIP 含子代理、幂等）→ `replay`（轨迹即测试夹具，CI 零 key） |
| Skills | 两级目录、frontmatter 简表、每 turn 注入名称列表、`skill` 工具按需取全文 |

### 1.3 桌面端（packages/desktop）
| 能力 | 说明 |
|------|------|
| Electron 壳 | spawn serve（HTTP+WS）、preload 桥（渲染进程零 Node）、断线重连+自动重启 |
| 多会话并行 | 切换不断流；后台会话只记事件不渲染；切换后全量重放 |
| 分屏与拖拽 | 1/2/3 分栏、HTML5 DnD、布局持久化 |
| 会话流渲染 | 流式光标、工具行、审批条、turn 摘要、reasoning 折叠 |

---

## 2. 对标分析（vs 市面主流 agent harness）

对照 **Claude Code · Cursor · OpenCode · Codex CLI · Aider · Gemini CLI**。harness2 的**独有价值**是：事件溯源内核 / 轨迹回放 / 多端（CLI+桌面+IM）/ 权限审批 / 三层记忆。已具备的很多，但**桌面体验层**与头部产品差距明显——目前它更接近"终端 REPL 的 React 皮肤"，而不是"一个完整的工作台"。

---

## 3. 缺失 / 可增强功能分析（按优先级）

> 标注：`[P0]` 直接影响可用性 / `[P1]` 显著提升生产力 / `[P2]` 生态与差异化。

### 3.1 工作台级（P0，最影响"像不像一个 agent 工作台"）
| # | 缺失/增强 | 主流做法参考 | 建议落点 |
|---|-----------|--------------|---------|
| G1 | **文件树 / 项目浏览器** | Cursor / OpenCode 左侧文件树，@-引用 | 桌面端加可折叠文件树面板；`@file` 把文件内容带进上下文 |
| G2 | **Diff 审查视图** | 所有主流都"先看 diff 再应用" | write/edit 后显示 unified diff 卡片 + 接受/拒绝/导入快照 |
| G3 | **集成终端面板** | Cursor / Codex 底部终端 | 桌面端加终端 pane（复用 bash 工具），看进程日志 |
| G4 | **上下文/Token 预算指示** | Claude Code 顶部实时 context 余量 | 顶部 context 水条（当前/预算），+角色小模型标记 |
| G5 | **命令面板 Ctrl+K** | 几乎人手一个 | 全局命令面板：新建会话 / 切换模型 / 跳转会话 / 跑工具 |

### 3.2 编排与可视化（P1）
| # | 缺失/增强 | 说明 |
|---|-----------|------|
| G6 | **子代理树可视化** | 子会话独立运行，桌面端加"子代理树"拓扑 + 深链跳转（现只有工具行 ↗） |
| G7 | **工具调用时间线 / 轨迹视图** | `traj` 已有 CLI，桌面端做可视化 timeline（见 `agent-trace.html`） |
| G8 | **模型切换器（运行时）** | 现在 config 驱动，桌面端加会话级模型下拉，不用重启 |
| G9 | **Slash 命令内联补全** | `/` 弹出命令 + 参数提示（/new /resume /fork /undo ...） |
| G10 | **@-mention 上下文引用** | `@file` / `@session` / `@skill` 把对象带进当前 turn |

### 3.3 生态与治理（P2）
| # | 缺失/增强 | 说明 |
|---|-----------|------|
| G11 | **用量/成本估算** | 遥评估算（ROADMAP C3）：token/成本统计卡片，**不回传遥测** |
| G12 | **Web UI** | ROADMAP C2：serve 多消费者已就绪，Web 端复用（信任域扩展是前提） |
| G13 | **MCP/插件市场/浏览** | 现在靠 CLI `list`/`enable`，桌面端可视化安装/启用 |
| G14 | **会话全文搜索** | 现在关键字搜索，加全文索引 + 命中高亮 |
| G15 | **崩溃报告可视化** | doctor/crash 已落地，桌面端查看崩溃报告列表 |

---

## 4. 设计系统（依据 ui-ux-pro-max）

**产出：OLED 暗色（Developer Tool / AI 工作台）**——与"终端 + 绿色 success"气质匹配，深读不发亮、适合长时间编码。

| Token | 值 | 用途 |
|-------|----|------|
| `--bg` | `#020617` | 页面背景（最底层） |
| `--surface` | `#0F172A` / `#1E293B` | 面板 / 卡片 |
| `--muted` | `#1A1E2F` | 分隔 / 强调弱化区 |
| `--border` | `#334155` | 分隔线 |
| `--fg` | `#F8FAFC` | 主文字 |
| `--fg-muted` | `#94A3B8` | 次级文字 |
| `--accent` | `#22C55E` | 主强调（success/连接/accept） |
| `--info` | `#3B82F6` | 信息/链接 |
| `--warn` | `#F59E0B` | 警告/运行中 |
| `--danger` | `#EF4444` | 错误/拒绝 |
| `--ring` | `#0F172A` | 焦点环 |

**字体**：Inter（300–700）；等宽 `JetBrains Mono`（工具/tool call/路径）。

**关键设计原则（来自 skill 预交付检查）**
- 不使用 emoji 当结构图标 → 用 SVG / Phosphor 线性图标（下同）。
- 所有可点元素 `cursor:pointer`，hover/active 150–300ms 过渡，焦点态可见。
- 暗色对比：正文 ≥4.5:1，次级 ≥3:1；分隔线两种模式都可见。
- `prefers-reduced-motion` 尊重；尺寸 1440/1024/768 均适配。

---

## 5. 设计稿说明

| 文件 | 内容 | 亮点 |
|------|------|------|
| **`prototype-v5.html`** ✅✅✅✅ | **V5 暖纸交互原型（当前最佳）**：**暖纸皮色调**（奶油纸底 + 琥珀 accent + 暖石 ink）· chat-first · **先计划再执行 plan 模式**（确认→逐个划掉）· 设置居中弹窗 · Codex 式工作区 · 无遮挡注释 | 见 §11 |
| `prototype-v4.html` | V4 交互原型（保留） | 清空感 chat-first（冷色） |
| `prototype-v3.html` | V3 交互原型（保留） | 对话优先 + 计划划掉 + 设置弹窗 |
| `prototype.html` | V2 交互原型 | 4-Tab 分区版（保留） |
| `workspace.html` / `agent-trace.html` | V1 静态设计稿 | 保留作对比 |

打开方式：浏览器直接打开对应 `.html`；`prototype.html` 建议浏览器打开体验交互（切 Tab、点「登录」按钮看 codemap、拖流图、勾 todo、点桌宠）。

---

## 6. V2 原型 · 用户 8 点反馈的设计结论

### 整合为单页交互（点 1）
V1 拆两页显乱 → V2 合并成单页，用 **4 个 Tab** 分区，交互保留（切换、codemap 点选联动、拖拽、todo、桌宠）。

### 会话与对话头（点 2）
- **归档 vs 删除**：建议**归档（软删除/隐藏，可恢复）+ 删除（物理清除）**两级。产品现状：只有删除，无归档。
- **会话编辑**：建议支持**重命名标题**与**编辑会话元信息**。现状：无。
- **对话头元素太少**：已加 **当前目录 / 当前分支 / 当前模型 / 上下文水条 / Todo 入口 / 定时入口**。
- **todo 功能**：harness2 **当前没有** todo/计划清单（主流 harness 如 Claude Code 的 plan、Cursor 的 tasklist 都有）→ 设计稿加了「Todo/计划」面板，可加优先级。**属于缺口，建议补。**

### 代码查看/编辑（点 3）
桌面端缺独立代码查看器/编辑器（V1 只有 diff 卡片）→ 设计稿加入**文件代码卡**（可读、可编辑）。

### codemap「上图下码」（点 4，核心）
选中页面元素（如「登录」按钮）→ 提问「梳理调用逻辑」→
- **上图**：调用链流图（登录按钮 → onClick → useLogin 校验 → authApi.login → 后端接口），每步一张卡片 + 一句解释；**可拖动、可点击**；点击某卡片 → 下方代码**跳到对应代码块并高亮**。
- **下码**：展示该调用链相关代码（非调用链**变暗/灰**），**仍可直接编辑整文件**。
参考：Devin codemap、Cursor 代码引用、Claude Code 追溯。

### 定时任务（点 5 / 7）
- harness2 **已有 cron**（CLI `harness2 cron add`），但**桌面端没暴露** → 设计稿加「定时任务」面板（列任务、开关、新增）。
- **桌宠提醒**（点 7）：预留右下角**桌面宠物**气泡（如「该喝水啦💧」），为后续功能占位。

### 主题（点 6）
V1 纯黑 OLED 太压抑 → **默认改浅色**（`#F1F5F9` 底 / 白卡 / 蓝 accent），暗色为可选切换；规避压抑感。

### QQ / 飞书配置（点 8）
现状：仅**配置文件 + CLI**（`config.json` 的 `gateways` 段 + `auth.json` 的 `gateways` 凭据，`harness2 gateway` 启动），**无 GUI**。设计稿在「设置」里给出**可视化的网关配置入口**（QQ 已配置 / 飞书未启用 + 字段所在路径），方便定位。

---

## 8. V3 修正 · 用户 3 点澄清（当前主推方向）

1. **todo = agent 执行计划（完成一项划掉一项）**：不是通用清单，而是用户+AI 定下**大计划**，AI 列出 todo 项，完成一项**删除线划掉一项**，直到计划完成。已做**内联「执行计划」卡**（进度条 + 完成项删除线 + ✓，进行中/待办状态），AI 随执行实时更新。参考：Claude Code `/plan`、Cursor agent checklist、Codex task list。
2. **对话优先 + 设置=居中弹窗**：用户进来就是一个对话页；其它功能收进**设置**，设置为**居中 dialog 弹窗**（左菜单 + 右内容分节），不占主视图。符合 chat-first + 配置隔离的现代工具习惯（Cursor/Cline/Roo 设置弹窗、Linear/Vercel 对话框）。
3. **站在巨人的肩膀（Codex）**：参考 Codex 桌面端布局 —— **中央对话流 + 左侧会话/任务清单 + 右侧可切换 文件树/Diff/终端 工作区**。据此重排：默认单对话、会话=可折叠左轨、代码/轨迹/终端=右侧工作区、模型/上下文=顶栏、其余配置=设置弹窗。

---

## 10. V4 · 清空感 chat-first（参照用户提供参考图）

- **落地页**：中央大标题「我们该做什么？」+ 大输入框 + 3 张建议卡（梳理调用逻辑 / 检索要闻 / 重构成代码）+「进入项目工作」；输入框内联「替我审批」（审批模式）+ 模型选择 + 麦克风/发送。
- **左侧极简导航**：新对话 / 搜索 / 插件 / 自动化 + 「项目」+「对话」+ 底部「设置」。
- **保留 harness2 能力**：计划划掉卡、代码高亮块、右侧 文件/Diff/终端 工作区、设置居中弹窗（QQ/飞书/定时/模型/主题）、审批内联。
- **桌宠**：仅记录参考 u-tools 喵提醒（§9），不做设计。

---

## 11. V5 · 暖纸皮色调 + plan 模式（当前最佳）

- **暖纸皮色调**（ui-ux-pro-max「warm paper」）：背景 `#F6EFE3` 奶油纸（带细点纹理）、surface `#FFFCF6`、琥珀 accent `#C7743B`、暖石 ink `#3B2E21`、olive 成功、Calistoga 标题 + Inter 正文。柔和护眼，摒弃冷灰。
- **plan 模式（新）**：执行模式选择器含「③ 先计划再执行」——agent 先出计划卡 + 「确认执行」，用户确认后才执行，执行中逐项划掉计划卡（实测点击确认 → 4 项逐个 ✓ 划掉 → 展示 edit/代码）。对应 opencode/Claude Code 的 plan 模式。
- **无遮挡**：去掉了 V4 右下角浮动 legend（曾挡住设置按钮）；设计说明全部收进本 README。

---

## 9. 权限模式对比（用户问：我们做权限限制了吗 + 调研本地 harness）

**harness2 现状（已有审批）**：`packages/core/src/approval/policy.ts` —— `approval.mode` 三态：`default`（safe=放行/其余询问）、`acceptEdits`（write/edit 放行，其余同 default）、`bypass`（全放行）；**per-tool 规则**（allow/ask/deny）可覆盖任何 mode；safe 集合 = 只读工具（可注入覆盖）。CLI REPL 有 `允许执行 <tool>? [y/a/n]`，桌面端有审批条（允许/拒绝/本会话总是允许）。

**本地 harness 权限模式（`~/` 下找到 .claude / .cursor / .config/opencode / .gemini / .windsurf；它们的配置多为默认值；opencode 已装包中二进制含权限模式字符串）**：

| 工具 | 权限模式 | 说明 |
|------|---------|------|
| **opencode** | `ask / accept / bypass / plan` | `permission.mode` + per-tool；`plan` = 先出计划再确认执行 |
| **Claude Code** | `default / acceptEdits / bypassPermissions / plan` | `permissions`(allow/deny/ask 列表) + 权限模式；`/plan` 计划模式 |
| **Cursor** | allow/deny/ask + acceptEdits + Agent 计划模式 | settings 配置 |
| **Gemini / Windsurf** | 类似 ask/accept/bypass | — |

**结论 / 缺口**：harness2 的 `default/acceptEdits/bypass` 已覆盖「每次执行前询问」与「完全控制」；**缺一个独立的「计划模式（plan）」**——让 agent 先输出执行计划、等用户确认后再逐项执行（OpenCode/Claude Code 都有）。我们 V4 已做「计划划掉卡」，但**没有把执行门禁绑到计划确认上**。建议后续：新增 approval mode `plan`（agent 先给计划 → 用户确认/修改 → 再执行，执行中同步划掉计划卡）。

---

## 10. 桌宠提醒参考（仅记录，不分析）

- 用户点名参考：**u-tools 喵提醒**（https://www.u-tools.cn/plugins/detail/喵提醒/ ）—— 仅作为「桌面宠物提醒（如喝水）」的功能参考记录在此，**不做分析/设计**，后续如需实现再单独评估。

---

## 7. 桌面端可落地优先级（对应用户反馈）
1. **rich 对话头**（cwd/分支/模型/上下文/todo）—— 纯 UI，最快。
2. **会话归档 / 重命名 / 删除** —— 会话层增强。
3. **Todo 面板** —— 补产品缺口。
4. **cron 面板接入桌面** —— 复用已有 cron。
5. **代码查看器 + codemap 上图下码** —— 重头戏，复用 traj/快照/undo 能力。
6. 桌宠提醒 / QQ·飞书网关 GUI —— 后续。

---

## 6. 落地建议（如果要做）

1. **先做 G1 文件树 + G4 context 水条 + G5 命令面板** —— 三者改动集中在桌面端，ROI 最高。
2. **次做 G2 diff 审查 + G7 轨迹视图** —— 复用已有 `traj`/快照/undo 能力，纯 UI 层。
3. 其余按 ROADMAP 优先级（C3 遥估、C2 Web UI）推进。
