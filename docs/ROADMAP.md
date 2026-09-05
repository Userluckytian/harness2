# harness2 功能清单与路线图

> 制定日期：2026-09-06 · 依据：`docs/research/2026-09-06-reference-analysis.md`
> 原则：实事求是（不确定的不做）；轨迹优先；每个功能尽可能完善后再推进下一个。
> 状态图例：⬜ 未开始 · 🔶 进行中 · ✅ 完成

## 核心架构决策（待确认后生效）

| # | 决策 | 推荐 | 备选 | 依据 |
|---|------|------|------|------|
| D1 | 技术栈 | TypeScript / Node ≥22，pnpm monorepo | Python core（打包痛）/ Rust core（迭代慢） | dsh 验证了 TS 多形态可行性；与桌面端同语言 |
| D2 | 桌面端 | Electron + React | Tauri 2（更轻但 webview 跨平台不一致） | Tokeny/ZCode/Hermes/opencode 四家全是 Electron，Windows 验证最充分 |
| D3 | 会话存储 | append-only JSONL 事件日志（代际迁移）+ SQLite（FTS 索引/元数据） | 全 SQLite | opencode/grok/dsh 三家趋同；轨迹与 undo 免费获得 |
| D4 | 插件机制 | 自研轻量总线：事件 emit/waterfall + 注册返回 disposer | 引入 Cordis（概念密度过高） | 学 dsh"注册即可逆"，不背其术语税 |
| D5 | 会话与 UI 解耦 | 会话内核独立进程/服务，UI 是观察者 | UI 直连内核 | Tokeny stream_runs schema + 用户需求 8/9 |
| D6 | 文件快照 | 独立文件快照（不依赖 git） | git-based（opencode 有社区反馈副作用） | grok rewind 证明独立快照更稳 |

---

## P0 地基（必须，做到能用）

> 一次只推进一项；每项完成需有可运行验证命令。

| # | 功能 | 说明 | 主要参考 | 状态 |
|---|------|------|----------|------|
| 1 | Monorepo 骨架 | pnpm workspaces：core / cli / desktop / gateway 四包位形 | dsh 包结构 | ⬜ |
| 2 | **事件溯源会话内核** | JSONL append-only、事件类型 v1、单写者、崩溃一致（fsync/原子 rename）；不变量：Model-visible ⟺ logged | dsh session + grok persistence actor | ⬜ |
| 3 | **轨迹记录与查看器（CLI 版）** | 全事件落盘；`harness2 traj` 命令读日志渲染时间线（turn/step/tool 调用树、耗时、token）；快照回放测试（无需 API key） | dsh trajectory + session-query | ⬜ |
| 4 | Agent loop | turn/step 状态机、流式输出、取消、失败尝试单独记录 | dsh agent-loop + grok sampler | ⬜ |
| 5 | 工具系统 | 注册返回 disposer；pre/execute/post 瀑布管线；并发安全声明；同文件编辑锁键串行 | dsh tools + grok tool_dispatch | ⬜ |
| 6 | 基础工具集 | bash / read / write / edit / grep / glob | grok 树内 opencode/codex 移植版 | ⬜ |
| 7 | Provider 抽象 | OpenAI-compatible 起步 + DeepSeek/Anthropic；`{channelId, model}` 按场景配置（主模型/小模型/子代理模型）；key 分离存储 | Tokeny schema + ZCode catalog | ⬜ |
| 8 | 配置体系 | 全局 + 项目级两层；`$VAR` 展开；错误不回显源码行 | grok config loader | ⬜ |
| 9 | 审批与权限 | 工具分级审批（allow/ask/deny） | dsh approval + hermes guardrails | ⬜ |
| 10 | CLI 端（能用） | 多会话管理、流式渲染、`/undo` `/redo`（opencode 语义：投影截断 + 文件快照恢复）、会话搜索 | opencode TUI + grok rewind | ⬜ |

## P1 桌面与体验

| # | 功能 | 说明 | 主要参考 | 状态 |
|---|------|------|----------|------|
| 11 | Electron 桌面壳 | React + 会话内核通过本地服务通信 | hermes desktop（HTTP+WS） | ⬜ |
| 12 | 多会话并行 | 切换不断流；后台会话只记事件不渲染；切换后从日志快速重放 | Tokeny stream_runs | ⬜ |
| 13 | 分屏与拖拽 | 会话列表拖拽成多窗口/分屏布局 | 用户需求 8 | ⬜ |
| 14 | 分叉（fork） | 从任意事件点派生新会话（血缘入 header） | dsh parentSession | ⬜ |
| 15 | 记忆系统 | 开关（off/询问/自动）+ 文件记忆 + 硬预算 + 写入 gate 三态 + nudge 后台 review | hermes（全）+ Tokeny 访问统计（后期） | ⬜ |
| 16 | 内嵌浏览器 | WebContentsView + 空闲销毁 + 并发上限 + dispose 事件进轨迹 | Tokeny Playwright 形态 | ⬜ |
| 17 | 上下文压缩 | 阈值百分比触发、aux 模型摘要、近端原文保留、role 交替不变量 | hermes compression | ⬜ |
| 18 | 定时任务 | tick + 文件锁 + at-most-once；任务即工具（模型自己调 scheduler_create）；结果通知事件 | hermes cron + grok scheduler | ⬜ |
| 19 | undo 增强 | grok 三模式（对话/文件/全部）+ 冲突检测 + dry-run 预览 | grok rewind | ⬜ |

## P2 扩展与生态

| # | 功能 | 说明 | 主要参考 | 状态 |
|---|------|------|----------|------|
| 20 | 插件总线公开化 | 内置能力逐步插件化；第三方插件加载与沙箱边界 | dsh Profile/Bundle 思想（简化） | ⬜ |
| 21 | QQ Bot gateway | 官方 Bot API v2（WS+REST）、审批按钮、每 chat 串行、持久化去重；**集成前实测个人开发者权限** | hermes qqbot adapter | ⬜ |
| 22 | 飞书等其他 IM | 飞书 → Telegram/Discord 按需 | hermes platforms | ⬜ |
| 23 | 轨迹导出/回放 | ZIP 导出（含子代理）；轨迹即测试夹具 | dsh session.export + snapshots | ⬜ |
| 24 | MCP 支持 | 作为工具提供方接入 MCP 生态 | dsh/grok mcp | ⬜ |
| 25 | Subagent | 深度限制、独立日志、消息互通 | dsh subagent + grok task | ⬜ |
| 26 | Skills 系统 | 项目级技能注入 | dsh skill + hermes skills | ⬜ |

---

## GitHub Actions 可行性（用户关注点 5）

**结论：完全可行，且有直接先例**（dsh 仓库 19 个 workflows 验证了 TS monorepo 全流程）。

| 事项 | 方案 | 风险/对策 |
|------|------|-----------|
| CI 门禁 | matrix（windows/macos/ubuntu）× Node 22；lint+typecheck+test | Windows runner 免费可用 |
| 桌面打包 | electron-builder 三平台；缓存 electron 二进制加速 | macOS 签名公证需证书，初期 unsigned + 自更新走 GitHub Releases |
| CLI 发布 | npm publish（tag 触发，workflow_dispatch 手动确认） | npm token 存 Actions secrets |
| 快照回放测试 | 轨迹回放无需 API key，CI 里零成本跑 | 需 P0-3 先落地 |
| 版本管理 | changesets + 每日日志作为 release note 素材 | — |

## 明确不做（实事求是）

- ❌ Tokeny 功能逆向集成（闭源；只借鉴已读出的 schema 思想）
- ❌ QQ/微信个人号逆向协议（封号风险；QQ 只走官方 Bot API）
- ❌ Cordis 全套引入、dsh 文档税流程照搬
- ❌ Rust core / Tauri（除非 TS/Electron 路线验证失败）
- ❌ 跨端 UI 一次做全：先 CLI 能用 → 桌面 → IM
