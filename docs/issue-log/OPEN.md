# 开放事项索引(未关闭项) — harness2

> 规则：每天开工先读本文件掌握未完成事项；每天收工把当天仍未关闭的项同步进来，已关闭的移出。
> 状态：待处理 / 修复中 / 已修复待验证。已关闭项不在此文件，历史留在各日期日志。
> 元约定：`docs/issue-log/README.md`（AGENTS.md 强制遵循第 6 条）
> **已决策/已关闭事项：** 已关闭 / 已评估不修 / 已评估推迟 / 已知限制 / 口径登记 / 已被取代 等已决策事项，统一迁入 [`DECISIONS.md`](DECISIONS.md)（B1 只搬不删，保留原文与日期）。
> **本阶段（阶段 15 质量收口，2026-09-09）：** 总纲 [`2026-09-09-phase-quality-closeout.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout.md) · 验收表 [`…-acceptance.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md) · 审查任务书 [`…-review-brief.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md) · 执行者任务书 [`…-executor.md`](../ai-framework/plans/2026-09-09-phase-quality-closeout-executor.md)
>
> **当前主方向（2026-09-08 用户确认）：采用 R2「Grok 终端复刻 + 功能优先桌面 harness」**，主流成为 `docs/ai-framework/plans/2026-09-08-phase-aggressive-{core-foundation,cli-interaction,desktop-interaction}.md`（共享底座 S0–S7 / 终端 T0–T5 / 桌面 D0–D6），依据 `docs/research/notion-ai-20260908-0056/`。原「09-07 终端 T0–T9 / 桌面 B0–B9 优化」与「阶段 13 交互复刻」方向已废止。
>
> **共享底座 S0–S7 ✅ 已完成（2026-09-08）**，验收不通过项已闭环（FixA–D）。
>
> **阶段 15 质量收口（2026-09-09）结论：⚠️ 有条件通过**（见验收表第 9 节）。本阶段范围内 A0/A1/A2自动化/A3/A4/B1/B2/B3/B4/B5-文档 已完成并独立验收；剩下**人类授权/真机项**如下表。

| 日期 | 事项 | 状态 | 详情 |
|------|------|------|------|
| 2026-09-09 | **B6 — v1.0.0 发布准备（逐项等人类授权，不得自行执行）**：①`npm view harness2` / `npm view @harness2/core` 包名占用检查（**只读，可先做**，结果告知人类）；②配置 `NPM_TOKEN` secret（人类操作，列出字段/步骤）；③推 tag `v1.0.0`（合并发布，跳过 0.1/0.3/0.6 独立 tag）；④push 远端（阶段 15 口径：只提交本地，push 待人类授权）。清单 = `docs/RELEASE-CHECKLIST.md`。**此项永不交子代理，等人类授权** | 待处理（需人类操作） | [2026-09-09.md](2026-09-09.md) |
| 2026-09-09 | **README 三张截图（真机项，图槽已就位）**：`docs/screenshots/{cli-chat,desktop-multi,traj-timeline}.png`（终端 chat 流式+工具行 / 桌面多会话分屏 / traj 时间线）。README 图槽结构与命名约定已就位（B5-13，`docs/screenshots/README.md`）。**图必须真实反映当前 UI，由人类真机运行后截取，不得用 AI 生成或占位图冒充**；补图后删除 README 顶部「截图区（待真机截图补入）」说明 | 待处理（需真机环境） | [2026-09-09.md](2026-09-09.md) |
| 2026-09-09 | **A2 桌面端真机一轮（验收表第 8 节·人类）**：桌面端接本地网关（`local-oai`/`local-ant`）走对话/流式/审批/undo 一轮真机体验 | 待处理（需真机） | 验收表第 8 节 |
| 2026-09-09 | **A2-2 云端厂商真机差异（➖，待 key）**：拿到 DeepSeek / 智谱 GLM / Anthropic 官方 key 后按 A2-1 同一份八项清单逐家跑，覆盖 reasoning 字段/限流/错误码/超长上下文/tool_calls 差异；**不得用本地网关或 stub 冒充** | 待处理（需 key） | 验收表第 7 节 / A-7b |
| 2026-09-09 | **A3 下放 P1（发布前必闭环）**：P1-1 让 desktop/CLI/gateway 携带 serve token → 默认切严格模式；P1-2 严格模式下 desktop 健康检查把 `401` 当健康的误判。见验收表第 6 节 | 待处理（下放 B6/联合验收） | 验收表第 6 节 |
| 2026-09-09 | **A5 下放 P1（下阶段「上阶段遗留」）**：P1-1 feishu 端口冲突挂死（listen error 不落定）；P1-2 并发建双会话（无在途去重）；P1-3 阶段 9 「测试缺口」未闭环（补心跳/重连/msg_seq/startGateway 回归测试）。见验收表第 6 节 | 待处理（下阶段） | 验收表第 6 节 |
| 2026-09-09 | **cli 全量 spawn 型用例超时 flaky（环境）**：`crash-drill`/`export`/`memory` 在默认 5s 超时下因机器高负载（vmware-vmx 占 CPU）超时失败；`--testTimeout=20000~30000` 复跑全绿（17/71）。机器负载降后可回归默认超时观察 | 已知限制（非缺陷，记 B-6/B-9） | 验收表 B-6/B-9 |
| 2026-09-07 | **v1.0.0 发布动作待授权**（同上 B6，本行为历史登记，以 B6 为准）：①npm 包名占用检查；②配 `NPM_TOKEN`；③推 tag `v1.0.0`；④GitHub Pages 开启（**2026-09-07 已由 API 完成**）。**push 备份已授权** | 待处理（需人类操作） | [2026-09-07.md](2026-09-07.md) |
| 2026-09-06 | **阶段 9 真机联调清单**（待 QQ/飞书凭据）：auth.json.gateways 配 appId/appSecret → `harness2 gateway` → QQ 群 @bot/私聊 → 审批「1/2」→ 频率限制与 msg_seq 递增真机观察 → 飞书 webhook + verificationToken。**msg_seq 与 QQ token/心跳契约真机行为无法离线证明（A5 已如实声明）** | 待处理（需凭据 + 真机） | [2026-09-06.md](2026-09-06.md) §17 |
| 2026-09-08 | **S0–S7 移交桌面/CLI —— 风险第 3 项：assistant/attempt 半截文本字段展示语义未定**；桌面渲染需显式区分半截 attempt 与完整 assistant 消息，不得误当完整正文 | 已修复待验证（core 侧归属信息已足，归 D 阶段消费确认） | [2026-09-08.md](2026-09-08.md) §5 |
| 2026-09-06 | **阶段 5/6/8 真机/外部依赖**（其余真机与手工验收，合并见验收表第 8 节）：阶段 5 桌面 GUI 真机；阶段 6 真实模型记忆三态（A2-1 第 2 批已补本地网关口径，云端待 key）；阶段 8 真实 MCP/第三方插件（A2-1 第 3 批已补做）；阶段 10 段真实大会话导出/回放；阶段 11 bench 复核/doctor 实机/崩溃演练；阶段 3 真实端点验证；Windows Terminal 实机 REPL；nsis 安装包流程；桌面系统通知真机；阶段 9 真机联调 | 待处理（需用户环境/key/真机） | [2026-09-06.md](2026-09-06.md) 等 |
| 2026-09-06 | **CI 与 release 待远程验证**：`.github/workflows/ci.yml` 三平台 test matrix + build-desktop + `release.yml` 三平台产物（本地 YAML 已过校验），Actions 真实运行需远程仓库 + push 授权 | 待处理（需人类操作） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 审查 P2-3（剩余）：多进程并发追加、陈旧锁 TOCTOU、父目录刷新未实现 | 部分关闭（带入后续阶段） | [2026-09-06.md](2026-09-06.md) |
