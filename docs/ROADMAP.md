# harness2 功能清单与路线图

> 制定日期：2026-09-06 · 依据：`docs/research/2026-09-06-reference-analysis.md`
> 原则：实事求是（不确定的不做）；轨迹优先；每个功能尽可能完善后再推进下一个。
> 状态图例：⬜ 未开始 · 🔶 进行中 · ✅ 完成

## 核心架构决策（2026-09-06 用户确认生效）

| #   | 决策           | 定案                                                                  | 备选                                       | 依据                                                               |
| --- | -------------- | --------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| D1  | 技术栈         | **TypeScript / Node ≥22，pnpm monorepo**                              | Python core（打包痛）/ Rust core（迭代慢） | dsh 验证了 TS 多形态可行性；与桌面端同语言                         |
| D2  | 桌面端         | **Electron + React**                                                  | Tauri 2（更轻但 webview 跨平台不一致）     | Tokeny/ZCode/Hermes/opencode 四家全是 Electron，Windows 验证最充分 |
| D3  | 会话存储       | **append-only JSONL 事件日志（代际迁移）+ SQLite（FTS 索引/元数据）** | 全 SQLite                                  | opencode/grok/dsh 三家趋同；轨迹与 undo 免费获得                   |
| D4  | 插件机制       | **自研轻量总线：事件 emit/waterfall + 注册返回 disposer**             | 引入 Cordis（概念密度过高）                | 学 dsh"注册即可逆"，不背其术语税                                   |
| D5  | 会话与 UI 解耦 | **会话内核独立进程/服务，UI 是观察者**                                | UI 直连内核                                | Tokeny stream_runs schema + 用户需求 8/9                           |
| D6  | 文件快照       | **独立文件快照（不依赖 git）**                                        | git-based（opencode 有社区反馈副作用）     | grok rewind 证明独立快照更稳                                       |

补充确认（2026-09-06）：跨端 = 跨操作系统（Win/macOS/Linux）+ 跨形态（CLI→桌面→IM 网关）；用户已在 QQ 开放平台注册机器人（P2 集成时使用）。

---

## P0 地基（必须，做到能用）

> 一次只推进一项；每项完成需有可运行验证命令。

| #   | 功能                           | 说明                                                                                                                   | 主要参考                             | 状态                                                                               |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Monorepo 骨架                  | pnpm workspaces：core / cli / desktop / gateway 四包位形                                                               | dsh 包结构                           | ✅                                                                                 |
| 2   | **事件溯源会话内核**           | JSONL append-only、事件类型 v1、单写者、崩溃一致（fsync/原子 rename）；不变量：Model-visible ⟺ logged                  | dsh session + grok persistence actor | ✅                                                                                 |
| 3   | **轨迹记录与查看器（CLI 版）** | 全事件落盘；`harness2 traj` 命令读日志渲染时间线（turn/step/tool 调用树、耗时、token）；快照回放测试（无需 API key）   | dsh trajectory + session-query       | ✅                                                                                 |
| 4   | Agent loop                     | turn/step 状态机、流式输出、取消、失败尝试单独记录                                                                     | dsh agent-loop + grok sampler        | ✅                                                                                 |
| 5   | 工具系统                       | 注册返回 disposer；pre/execute/post 瀑布管线；并发安全声明；同文件编辑锁键串行                                         | dsh tools + grok tool_dispatch       | ✅（审批分级已随 Ph3 配置化；pre/post 钩子随后续阶段）                             |
| 6   | 基础工具集                     | bash / read / write / edit / grep / glob                                                                               | grok 树内 opencode/codex 移植版      | ✅                                                                                 |
| 7   | Provider 抽象                  | OpenAI-compatible 起步 + DeepSeek/Anthropic；`{channelId, model}` 按场景配置（主模型/小模型/子代理模型）；key 分离存储 | Tokeny schema + ZCode catalog        | ✅（协议层 stub 测试通过；真实端点待用户 key 实机验证，见 OPEN.md）                |
| 8   | 配置体系                       | 全局 + 项目级两层；`$VAR` 展开；错误不回显源码行                                                                       | grok config loader                   | ✅                                                                                 |
| 9   | 审批与权限                     | 工具分级审批（allow/ask/deny）                                                                                         | dsh approval + hermes guardrails     | ✅（三 mode + per-tool 规则，配置化）                                              |
| 10  | CLI 端（能用）                 | 多会话管理、流式渲染、`/undo` `/redo`（opencode 语义：投影截断 + 文件快照恢复）、会话搜索                              | opencode TUI + grok rewind           | ✅（阶段 4：chat REPL + 会话管理器 + 独立文件快照；bash 副作用不进快照已如实声明） |

## P1 桌面与体验

> **M2 状态（2026-09-06）：代码层面达成**——#11–18 全部交付并通过阶段验收（#11–15 阶段 5/6，#16–18 阶段 7）；v0.3.0 发布动作待授权（见 issue-log OPEN），信任域加固已落地。

| #   | 功能            | 说明                                                                               | 主要参考                              | 状态                                                                                                                                                                                                                                          |
| --- | --------------- | ---------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | Electron 桌面壳 | React + 会话内核通过本地服务通信                                                   | hermes desktop（HTTP+WS）             | ✅（阶段 5：spawn serve + preload 桥 + 断线重启 + win nsis 打包；GUI 手感项待真机）                                                                                                                                                           |
| 12  | 多会话并行      | 切换不断流；后台会话只记事件不渲染；切换后从日志快速重放                           | Tokeny stream_runs                    | ✅（阶段 5：每会话独立事件缓冲 + /events 重放判重 + 后台徽标；实机多会话体验待真机）                                                                                                                                                          |
| 13  | 分屏与拖拽      | 会话列表拖拽成多窗口/分屏布局                                                      | 用户需求 8                            | ✅（阶段 5：1/2/3 分栏引擎 + HTML5 DnD + 布局持久化 ~/.harness2/desktop-layout.json；拖拽手感待真机）                                                                                                                                         |
| 14  | 分叉（fork）    | 从任意事件点派生新会话（血缘入 header）                                            | dsh parentSession                     | ✅（阶段 6：`forkSession` 活动投影重放 + atSeq 截取 + 三端入口（REPL `/fork`、`chat --fork`、HTTP/WS op）；rewind/影子事件/文件快照不复制，新会话 undo 从零）                                                                                 |
| 15  | 记忆系统        | 开关（off/询问/自动）+ 文件记忆 + 硬预算 + 写入 gate 三态 + nudge 后台 review      | hermes（全）+ Tokeny 访问统计（后期） | ✅（阶段 6：config.memory 三态 + MEMORY.md/USER.md 硬预算（2200/1375 字符）+ 漂移检测/注入扫描 + memory 工具 + memory/snapshot 冻结注入 + SessionHub nudge 复盘 + ask 模式 pending 审批（CLI）；真实模型行为待 key 实机验证，访问统计留后期） |
| 16  | 内嵌浏览器      | agent 侧 Playwright 工具（快照引用操作）+ 空闲销毁 + 并发上限 + dispose 事件进轨迹 | Tokeny Playwright 形态                | ✅（阶段 7：6 工具 + 每会话 1 上下文/全局并发 2/空闲 5min 销毁/dispose 进轨迹；真实站点待真机；桌面内嵌视图不在范围）                                                                                                                         |
| 17  | 上下文压缩      | 阈值百分比触发、aux 模型摘要、近端原文保留、role 交替不变量                        | hermes compression                    | ✅（阶段 7：75% 阈值 + roles.small 摘要 + 近 6 条原文保留 + compaction/applied 事件可重建 + 失败跳过不中断）                                                                                                                                  |
| 18  | 定时任务        | tick + 文件锁 + at-most-once；结果通知事件                                         | hermes cron + grok scheduler          | ✅（阶段 7：60s tick + 跨进程锁 + 先推进 next_run 再执行 + 连败熔断 + history；CLI 全套 + serve 通知帧；IM 投递在 Ph9、桌面展示待接入）                                                                                                       |
| 19  | undo 增强       | grok 三模式（对话/文件/全部）+ 冲突检测 + dry-run 预览                             | grok rewind                           | ✅（阶段 4：undo/redo = 对话投影截断 + 文件快照联动恢复，冲突检测与 dry-run 预览齐备；三模式合一为单一 undo/redo 流，独立分模式留作后续增强）                                                                                                 |

> **M3 状态（2026-09-06）：代码层面达成**——#20–26 全部交付（#20/24/25 阶段 8，#21/22 阶段 9，#23/26 阶段 10）；v0.6.0 发布动作待授权（见 issue-log OPEN）。真机类残留（QQ/飞书联调、MCP/插件实测、skill 真机体验）见 OPEN.md 各清单。

## P2 扩展与生态

| #   | 功能           | 说明                                                                                         | 主要参考                        | 状态                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 20  | 插件总线公开化 | 内置能力逐步插件化；第三方插件加载与沙箱边界                                                 | dsh Profile/Bundle 思想（简化） | ✅（阶段 8：manifest 声明式权限 + allow 装载审批 + disposer 逆序展开 + 事件总线；v1 进程内非隔离如实声明，worker 隔离留档评估；内置能力插件化与插件市场不在范围）                                                                                                                                                                                      |
| 21  | QQ Bot gateway | 官方 Bot API v2（WS+REST）、审批按钮、每 chat 串行、持久化去重；**集成前实测个人开发者权限** | hermes qqbot adapter            | ✅（阶段 9：官方 v2 已实现（审查 fail→修复闭环：生命周期/重连重订阅/msg_seq 递增/429 退避）+ 回复式审批 + 频率限制队列 + 重推去重 + 三态策略；**真机联调待用户开放平台凭据**，个人开发者权限实测后收口）                                                                                                                                               |
| 22  | 飞书等其他 IM  | 飞书 → Telegram/Discord 按需                                                                 | hermes platforms                | ✅（阶段 9：飞书基础适配器（webhook 挑战/事件解析 + im/v1 出站 token 单飞 + 策略闸门 + token 校验 + reply API）；Telegram/Discord 按需）                                                                                                                                                                                                               |
| 23  | 轨迹导出/回放  | ZIP 导出（含子代理）；轨迹即测试夹具                                                         | dsh session.export + snapshots  | ✅（阶段 10：exportSession 只读打包（session.v1.jsonl + rewind_points.jsonl/snapshots/ 白名单；子代理按 parentSession 全库扫描递归入 subagents/<id>/，lock 永不入包）+ 固定 mtime 幂等；importReplay 逐行解析（坏行计数/告警）+ 投影摘要；CLI `export`/`replay`；全量内存口径与 P2-4 同档留档，真实长会话体积待用户环境评估）                          |
| 24  | MCP 支持       | 作为工具提供方接入 MCP 生态                                                                  | dsh/grok mcp                    | ✅（阶段 8：官方 SDK + stdio/Streamable HTTP + `mcp__<server>__<tool>` namespaced + 断线退避重启上限 3 + 崩溃不拖垮主进程；resources/prompts 仅 tools；真实第三方 server 待用户环境实测）                                                                                                                                                              |
| 25  | Subagent       | 深度限制、独立日志、消息互通                                                                 | dsh subagent + grok task        | ✅（阶段 8：subagent_start/continue 工具 + 独立子会话完整 runTurn（零新增事件类型）+ 深度默认 1 + 父取消传播 + 审批上抛同缝；子会话跳转桌面端支持）                                                                                                                                                                                                    |
| 26  | Skills 系统    | 项目级技能注入                                                                               | dsh skill + hermes skills       | ✅（阶段 10：两级目录（项目 .harness2/skills/ > 全局 ~/.harness2/skills/，同名覆盖+告警）+ frontmatter 简表（name/description 必填）+ 上限 50 + 坏文件跳过；每 turn 重扫仅「名称: 描述」列表进 system（本轮内冻结），全文经 `skill` 工具按需加载（现读磁盘）；零新增事件类型；`skill list` CLI；文本指令型、无可执行脚本；真机体验待用户，见 OPEN.md） |

---

## 26 项之后：交互复刻与收口（2026-09-08 起）

> 上表 26 项是**功能面**清单（已全部交付）。此后不再新增功能编号，工作转为交互手感打磨 + 质量收口 + 发布；逐项未关闭状态以 `docs/issue-log/OPEN.md` 为准，当前快照见 `docs/HANDOFF.md`。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 共享底座 S0–S7 | `runtime.v1.jsonl` 运行账本、submit/resumeSubscription/approval/cancel/task/steer 契约、`protocolVersion=2`、任务协调器 | ✅ 已合入 main |
| 阶段 13–14 方向 | 终端 T0–T5 / 桌面 D0–D6 的交互复刻目标拆解 | ✅ 已由阶段 I1 执行完毕 |
| 阶段 15 质量收口 | 仓库卫生与 lint 基建、Windows 可用性、serve 安全加固、大文件拆分、规范文档、网关复审 | ⚠️ 有条件通过（余项下放 OPEN.md） |
| 地基补丁 P0–P4 | 网关双会话与挂死、serve token 三端贯通+默认严格、401 误判健康、playwright 降级、锁文件 POSIX 0600、turn 终态文本语义 → **core/gateway 契约冻结 `3c9b31f`** | ✅ 2026-09-11（`ad12a08`） |
| **阶段 I1 双轨** | **甲＝终端**（只动 `packages/cli`） · **乙＝桌面**（只动 `packages/desktop`）；冻结期内并行，解冻只走编排者 `fix/*` 窗口（已用 #1 gateway 竞态、#2 core 抖动+加性导出） | ✅ 2026-09-12 按 D→T `--no-ff` 合入 main（`a0686fb` / `6330f76`） |
| CI 可观测性 | `test` job 拆成分包独立步骤，消除「单点红掩盖其余包」 | ✅ 2026-09-12（`ce79bf0` → `1b12223`，run #72/#73 全绿） |
| 收尾 | v1.0.0 发布动作（包名占用 / `NPM_TOKEN` / 推 tag）+ 真机手工签收（README 三图、桌面真机一轮、云端厂商 key） | ⬜ 待人类操作 |

---

## GitHub Actions 可行性（用户关注点 5）

**结论：已实证可行**（2026-09-06 论证，2026-09-10 起在远程真实运行；最新 run #73 七 job 全绿——三平台 test × 三平台 desktop build + pages 部署，站点 https://userluckytian.github.io/harness2/ ）。原论证依据：dsh 仓库 19 个 workflows 验证了 TS monorepo 全流程。

| 事项         | 方案                                                         | 风险/对策                                                      |
| ------------ | ------------------------------------------------------------ | -------------------------------------------------------------- |
| CI 门禁      | matrix（windows/macos/ubuntu）× Node 22；lint+typecheck+test | Windows runner 免费可用                                        |
| 桌面打包     | electron-builder 三平台；缓存 electron 二进制加速            | macOS 签名公证需证书，初期 unsigned + 自更新走 GitHub Releases |
| CLI 发布     | npm publish（tag 触发，workflow_dispatch 手动确认）          | npm token 存 Actions secrets                                   |
| 快照回放测试 | 轨迹回放无需 API key，CI 里零成本跑                          | 需 P0-3 先落地                                                 |
| 版本管理     | changesets + 每日日志作为 release note 素材                  | —                                                              |

## 明确不做（实事求是）

- ❌ Tokeny 功能逆向集成（闭源；只借鉴已读出的 schema 思想）
- ❌ QQ/微信个人号逆向协议（封号风险；QQ 只走官方 Bot API）
- ❌ Cordis 全套引入、dsh 文档税流程照搬
- ❌ Rust core / Tauri（除非 TS/Electron 路线验证失败）
- ❌ 跨端 UI 一次做全：先 CLI 能用 → 桌面 → IM

---

## v1.x 展望（草案，未批准）

> 状态：**草案，未批准**——仅 backlog 池，无承诺顺序与时间表；启动前需用户确认并另立总控计划。
> 来源：阶段 12（M4 收口）期间梳理的候选方向，1.0 发布（tag + npm + Pages）与真机清单消化后再议优先级。

| #   | 候选                   | 一句话说明                                                              | 备注                                               |
| --- | ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| C1  | 任务排队与并行会话编排 | 跨会话任务队列 + 并行子任务编排（cron/subagent 之上的调度层）           | 与 cron 记账边角（OPEN 留档）一并重估              |
| C2  | Web UI                 | 浏览器访问 serve（serve 契约已具备多消费者形态）                        | 信任域模型需先扩（当前 127.0.0.1 无鉴权假设）      |
| C3  | 遥评估算               | token 用量/成本统计与展示（Tokeny 式访问统计的延伸）                    | 仅统计，不回传遥测（无遥测红线不变）               |
| C4  | worker 隔离插件        | 插件从进程内迁到 worker/isolate（architecture.md 插件小节留档的重启项） | 触发条件已留档：跨 worker 传输工具/审批/事件复杂度 |
| C5  | 更多 IM 适配           | Telegram/Discord 等（ROADMAP #22 的按需延伸）                           | 沿用网关适配器接口（onMessage/send/start/stop）    |
