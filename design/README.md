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
| `workspace.html` | 主工作区重设计（单文件，内联 CSS/字体/SVG） | 顶部 context 水条 + 模型切换 + Ctrl+K；左侧会话+搜索+新建；中部多分栏 + Diff 审查 + 子代理树；底部 slash 补全 + 审批 + undo/redo |
| `agent-trace.html` | 工具调用时间线（traj 可视化） | 按 turn/step 展开工具调用树、耗时、成功/失败/取消、token，供复盘/回放 |

打开方式：浏览器直接打开对应 `.html`。

---

## 6. 落地建议（如果要做）

1. **先做 G1 文件树 + G4 context 水条 + G5 命令面板** —— 三者改动集中在桌面端，ROI 最高。
2. **次做 G2 diff 审查 + G7 轨迹视图** —— 复用已有 `traj`/快照/undo 能力，纯 UI 层。
3. 其余按 ROADMAP 优先级（C3 遥估、C2 Web UI）推进。
