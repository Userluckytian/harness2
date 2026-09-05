# harness2 总控计划（Master Plan）

> 制定：2026-09-06 · 状态：**已批准（2026-09-06 用户确认）** · 批准后作为全局实施依据
> 已确认决策：①v0.1 纯 CLI 首发，桌面在 M2；②首批 Provider = OpenAI-compatible + DeepSeek 原生 + Anthropic + 智谱/GLM；③按公开发布准备（MIT，GitHub public；远程仓库待用户创建授权）；④产品名沿用 harness2（CLI 命令名 `harness2`）；⑤QQ 机器人在 M3；⑥节奏改为**连续逐阶段推进**——每阶段完成（实施/测试/审查/验收）后直接进入下一阶段，无需逐阶段确认；无法自主完成的测试（如需远程/真机/密钥）在 issue-log 与 HANDOFF 标记。
> 细粒度功能清单见 `docs/ROADMAP.md`（26 项）；单阶段执行计划开工前另立 `docs/ai-framework/plans/YYYY-MM-DD-phase-N-*.md`
> 执行模式：编排者（主会话）规划/验收/文档，实现/测试/审查由子代理承担（见 `docs/ai-framework/workflow-delegation.md`）

## 一、产品愿景与最终形态

**一句话**：一个会话内核（事件溯源），三个入口（CLI / 桌面 / IM 网关），一套插件机制，轨迹贯穿全程。

| 最终形态 | 说明 |
|----------|------|
| CLI `harness2` | 终端对话 + 工具执行 + undo/分叉 + 轨迹查看，npm 分发 |
| 桌面 App | Electron：多会话并行、分屏拖拽、内嵌浏览器、记忆开关 |
| IM 网关 | QQ（主）/飞书：官方 Bot API，审批按钮，定时任务投递 |
| 插件生态 | 内置能力插件化 + 第三方插件 + MCP 接入 |

**核心不变量（贯穿所有阶段）**：Model-visible ⟺ logged；append-only；会话内核与 UI 解耦；密钥不入库不入日志。

## 二、里程碑（发版视图，素材来自每日日志）

| 里程碑 | 版本 | 用户可感知的"能用"标准 | 对应阶段 |
|--------|------|------------------------|----------|
| **M1 CLI 可用** | v0.1 | 终端里接真实模型对话：能读写文件、跑命令、流式输出、`/undo` `/redo`、轨迹可查、审批可控 | Ph2–Ph4 |
| **M2 桌面可用** | v0.3 | 桌面多会话并行切换不断流、分屏拖拽、记忆开关、内嵌浏览器、定时任务 | Ph5–Ph7 |
| **M3 连接外部** | v0.6 | QQ/飞书机器人可用、MCP 工具接入、subagent、插件可装、轨迹导出 | Ph8–Ph10 |
| **M4 稳定生态** | v1.0 | 三端全量、安装分发（npm+安装包）、性能稳定化、文档站、API 稳定承诺 | Ph11–Ph12 |

## 三、阶段拆解（执行视图）

> 顺序即依赖；每阶段 = 计划 → 实现代理 → 审查代理 → 验收 → 文档更新。规模 S/M/L 为相对工作量。

| 阶段 | 目标 | 覆盖 ROADMAP | 关键产出与验收要点 | 规模 |
|------|------|--------------|--------------------|------|
| ✅ Ph1 | 事件内核 + 轨迹 | P0-1/2/3 | 已完成验收（33 测试） | — |
| **Ph2** | **Agent loop + 工具系统** | P0-4/5/6 | turn/step 状态机、取消、失败尝试记录；工具注册/审批瀑布/并发声明；基础工具集（bash/read/write/edit/grep/glob）；**mock provider 测试基建（CI 零 API key 跑真实 loop）**；GH Actions CI 骨架（typecheck+test） | L |
| **Ph3** | Provider 抽象 + 配置 + 审批 | P0-7/8/9 | `{channelId,model}` 按场景配置（主/子代理/小模型）；OpenAI-compatible + DeepSeek 原生 + Anthropic + 智谱；key 分离存储；全局/项目两级配置；工具分级审批 | M |
| **Ph4** | CLI 完整体验 → **M1 发布** | P0-10、P1-19、审查 P2 消化 | 会话管理/流式渲染/会话搜索；`/undo` `/redo`（投影截断+文件快照，含 rewindToSeq 校验）；渲染 callId/turn 标头/exhaustive 保护；npm 发布 + CHANGELOG（自日志生成）+ release 自动化 | M |
| **Ph5** | 会话服务化 + 桌面壳 | P1-11/12/13 | 内核独立进程（本地 HTTP+WS，D5 落地）；多会话并行切换不断流（后台只记事件）；Electron+React 壳；分屏与拖拽布局 | L |
| **Ph6** | 记忆 + 分叉 | P1-14/15 | fork（血缘入 header）；记忆系统：开关三态（off/询问/自动）+ 文件记忆硬预算 + 写入 gate + nudge 后台复盘 | M |
| **Ph7** | 浏览器 + 压缩 + 定时 → **M2 发布** | P1-16/17/18 | WebContentsView 内嵌浏览器（空闲销毁/并发上限/dispose 进轨迹）；上下文压缩（阈值+aux 摘要+近端保留）；定时任务（tick+文件锁+at-most-once）；桌面安装包 CI | M |
| **Ph8** | 插件化 + MCP + subagent | P2-20/24/25 | 插件总线公开 API（事件 emit/waterfall + disposer）；内置能力逐步插件化；MCP 客户端；subagent（独立日志/深度限制） | L |
| **Ph9** | QQ/飞书网关 | P2-21/22 | QQ 官方 Bot API v2（WS+REST、审批按钮、每 chat 串行、去重）；飞书次之；**集成前实测个人开发者权限** | M |
| **Ph10** | 轨迹增强 + Skills → **M3 发布** | P2-23/26 | 轨迹 ZIP 导出（含子代理）、回放夹具库；skills 项目级注入；性能基线（大日志流式处理，消化审查 P2-4） | M |
| **Ph11** | 稳定化 + 分发 | — | 三平台安装包/安装器、崩溃恢复演练、性能预算、错误上报（opt-in） | M |
| **Ph12** | 1.0 收口 → **M4 发布** | — | 文档站、API 稳定承诺、迁移指南、全面回归 | S |

## 四、横切线（每阶段必做，不单列阶段）

1. **测试**：核心不变量测试随功能走；mock provider 保证 CI 无 key；快照回放测试持续积累。
2. **CI/CD（GitHub Actions，可行性已论证——dsh 19 workflows 先例）**：Ph2 建 CI 骨架（三平台 matrix + typecheck + test）→ Ph4 npm 发布 → Ph7 桌面包 → Ph11 安装器。macOS 签名公证初期跳过（unsigned + GitHub Releases）。
3. **文档**：每阶段更新 ROADMAP 状态列、architecture.md、HANDOFF.md 快照；每日日志 = release note 素材；OPEN.md 未关闭项随清随结。
4. **审查与验收**：每阶段实现代理 → 只读审查代理 → P0/P1 修复 → 编排者重跑证据 → 才算完成。
5. **风险前置**：每阶段计划文档列风险与降级；集成类（QQ/浏览器/打包）先做最小 spike 再全量。

## 五、关键依赖与顺序理由

- loop/工具（Ph2）在 provider（Ph3）前：用 mock 先把循环语义钉死，避免"边接真模型边改循环"。
- CLI（Ph4）在桌面（Ph5）前：CLI 先证明内核可用，且桌面壳依赖 Ph5 的会话服务化而不是直接 import 内核。
- 网关（Ph9）在桌面（Ph5）后：复用会话服务化层，IM 只是一个"另一个 UI"。
- 插件公开化（Ph8）在 M1 后：先让内置能力稳定，再抽象扩展点——避免过早冻结错误接口。

## 六、明确不做（重申）

闭源逆向集成；QQ/微信个人号逆向协议；Cordis 全套引入；Rust/Tauri 换芯；一次做全三端 UI。

## 七、变更控制

- 本计划批准后，里程碑与阶段顺序变更需用户确认；阶段内部细化（计划文档）由编排者定。
- 每完成一阶段：diary + HANDOFF 快照 + ROADMAP 状态列同步，保证任何时点交接无损。
