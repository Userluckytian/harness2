# 开放事项索引(未关闭项) — harness2

> 规则：每天开工先读本文件掌握未完成事项；每天收工把当天仍未关闭的项同步进来，已关闭的移出。
> 状态：待处理 / 修复中 / 已修复待验证。已关闭项不在此文件，历史留在各日期日志。
> 元约定：`docs/issue-log/README.md`（AGENTS.md 强制遵循第 6 条）

| 日期 | 事项 | 状态 | 详情 |
|------|------|------|------|
| 2026-09-06 | **npm 发布待授权**（M1 v0.1）：包名 `harness2`（CLI）+ `@harness2/core` 已备好发布物料（files/engines/publishConfig、CHANGELOG、README、`.github/workflows/release.yml` tag 触发）。执行前待人类：①创建远程仓库并授权 push；②在 npm 检查包名占用（`npm view harness2` / `npm view @harness2/core`）；③配置 Actions secret `NPM_TOKEN`；④推 tag `v0.1.0` 触发 release workflow（NPM_TOKEN 缺失时 workflow 只构建不发布并告警，不会误发） | 待处理（需人类操作：授权 + NPM_TOKEN） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | **M1 真实模型 chat 手工验收清单**（用户配 key 后逐项核对，命令级）：①`harness2 config check` key 来源正确 → ②`harness2 chat`（roles.main）发一条消息看 SSE 流式直写与 turn 摘要行 → ③让模型写/改文件：`> write (...)` / `< ok [callId]` 行与文件真实落盘 → ④`/undo --dry-run` 预览含文件清单 → `/undo` 文件复原（创建的文件被删除）→ `/redo` 内容回放 → ⑤审批 ask：`config.approval` 下 write 触发 `允许执行 <tool>? [y/a/n]`，`a` 后本会话不再提示 → ⑥`/sessions 关键字` 搜索命中、`/exit` 干净退出。DeepSeek/GLM/Anthropic 三端各过一遍（协议层已由 stub 全覆盖，见下行阶段 3 条目） | 待处理（需人类操作：提供 key） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | **Anthropic `pause_turn` 续跑（阶段 4 评估结论：推迟，不实现）**。评估依据：①pause_turn 是 Anthropic 服务端长时操作（server tools/长运行工具）的暂停信号，续跑需把含 pause 块的原始 content blocks 原样回传重发，与现有「每 step 从日志投影重建 ChatRequest」的上下文组装模型不同构——需要在日志与请求映射层为「原始块回传」开新通道，改动面大于收益；②当前产品形态（CLI 单请求 turn）真实触发概率低：主流用法不涉及服务端长时工具；③现有行为已如实安全：turn 以 `paused` 结束 + `TurnResult.warning` 告知 + 日志完整（用户重新发消息即可继续，上下文经投影无损）。重启条件：引入 Anthropic server-side tools / 长时任务（Ph8 subagent 与 Ph7 定时任务附近）时再实现「写回暂停原因并续发同一 turn」 | 已评估推迟（留档，重启条件见左） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 阶段 3 真实端点手工验证：provider 协议层已全部用 127.0.0.1 stub 测试覆盖（零真实 API），但 DeepSeek / 智谱 GLM / Anthropic 三端各「一条真实消息 + 一次工具调用」的实机验证待用户在 `~/.harness2/auth.json` 配置 key 后执行（核对：SSE 流式渲染、tool_calls 组装、`reasoning_content`/`thinking` 展示、usage 统计、错误脱敏）。执行方式：`harness2 config check` 确认配置与 key 来源 → `harness2 chat` 跑一轮（与上方 M1 清单合并执行） | 待处理（需人类操作：提供 key） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 快照恢复的已知边界（阶段 4 实现口径，非缺陷）：①undo/redo 之间若发生了新的 write/edit（有快照条目），redo 的冲突检测会标记 externallyModified——恢复本身是最新 after 的幂等写，无数据风险；②快照条目缺失（崩溃/未 commit）的文件在恢复时静默跳过（不中断整体恢复），日志不受影响；③bash 副作用不进快照已在 chat /help 与 README 如实声明 | 已知限制（记录，留档） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 阶段 3 独立审查 P2-8（评估不修）：SSE 规范允许把单个事件的 data 拆成多行 `data:`（拼接后为一个 JSON），本实现按单行 `data:` 帧解析——多行 data 帧的后续行 JSON.parse 失败被当作坏帧跳过。影响与触发条件：仅当服务端把单个 JSON 事件拆到多行 `data:` 发送时丢帧（主流端 DeepSeek/GLM/Anthropic 实测均为单行，未发现触发路径）；最坏后果是该事件内容缺段或报 `stream_truncated`，不会产生错误内容。待出现真实多行端点再实现跨行 data 拼接 | 已评估不修（留档） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 审查 P2-3（剩余）：多进程并发追加、陈旧锁 TOCTOU、父目录刷新未实现（fsync 默认路径冒烟测试已于阶段 2 补齐） | 部分关闭（带入后续阶段） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 审查 P2-4：大日志全量内存读取、投影 O(事件×marker)，无超大日志预案 | 已知限制（记录，Ph10 消化） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 阶段 2 独立审查 P2-6：reader 容错口径问题——复核评估为无害行为，决定不修（留档备查） | 已评估不修（留档） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | CI 待远程验证：`.github/workflows/ci.yml` 三平台 matrix 已建并通过本地 YAML 语法校验（2026-09-06 审查修复 P1-1：删除 version 输入改由 packageManager 驱动，待远程一并验证），Actions 真实运行需远程仓库 + push 授权（需人类操作）。新增 `release.yml` 已过本地 YAML 语法校验（js-yaml），真实运行同待远程 | 待处理（需人类操作） | [2026-09-06.md](2026-09-06.md) |
