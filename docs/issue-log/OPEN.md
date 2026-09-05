# 开放事项索引(未关闭项) — harness2

> 规则：每天开工先读本文件掌握未完成事项；每天收工把当天仍未关闭的项同步进来，已关闭的移出。
> 状态：待处理 / 修复中 / 已修复待验证。已关闭项不在此文件，历史留在各日期日志。
> 元约定：`docs/issue-log/README.md`（AGENTS.md 强制遵循第 6 条）

| 日期 | 事项 | 状态 | 详情 |
|------|------|------|------|
| 2026-09-06 | 阶段 3 独立审查 P2-8（评估不修）：SSE 规范允许把单个事件的 data 拆成多行 `data:`（拼接后为一个 JSON），本实现按单行 `data:` 帧解析——多行 data 帧的后续行 JSON.parse 失败被当作坏帧跳过。影响与触发条件：仅当服务端把单个 JSON 事件拆到多行 `data:` 发送时丢帧（主流端 DeepSeek/GLM/Anthropic 实测均为单行，未发现触发路径）；最坏后果是该事件内容缺段或报 `stream_truncated`，不会产生错误内容。待出现真实多行端点再实现跨行 data 拼接 | 已评估不修（留档） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | Anthropic `pause_turn` 续跑：provider 已映射为 `paused`（P2-4），loop 以 `paused` 结束 turn 并在 `TurnResult.warning` 如实告知；「写回暂停原因并重发请求继续同一 turn」的续跑未实现，当前需用户重新发起 | 待处理（阶段 4 CLI chat 时评估） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 阶段 3 真实端点手工验证：provider 协议层已全部用 127.0.0.1 stub 测试覆盖（零真实 API），但 DeepSeek / 智谱 GLM / Anthropic 三端各「一条真实消息 + 一次工具调用」的实机验证待用户在 `~/.harness2/auth.json` 配置 key 后执行（核对：SSE 流式渲染、tool_calls 组装、`reasoning_content`/`thinking` 展示、usage 统计、错误脱敏）。执行方式：`harness2 config check` 确认配置与 key 来源 → 用 provider + runTurn 跑一轮（参考 `packages/core/test/providers.test.ts` 的 E2E 用例） | 待处理（需人类操作：提供 key） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 审查 P2-3（剩余）：多进程并发追加、陈旧锁 TOCTOU、父目录刷新未实现（fsync 默认路径冒烟测试已于阶段 2 补齐） | 部分关闭（带入后续阶段） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 审查 P2-4：大日志全量内存读取、投影 O(事件×marker)，无超大日志预案 | 已知限制（记录，Ph10 消化） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | 阶段 2 独立审查 P2-6：reader 容错口径问题——复核评估为无害行为，决定不修（留档备查） | 已评估不修（留档） | [2026-09-06.md](2026-09-06.md) |
| 2026-09-06 | CI 待远程验证：`.github/workflows/ci.yml` 三平台 matrix 已建并通过本地 YAML 语法校验（2026-09-06 审查修复 P1-1：删除 version 输入改由 packageManager 驱动，待远程一并验证），Actions 真实运行需远程仓库 + push 授权（需人类操作） | 待处理（需人类操作） | [2026-09-06.md](2026-09-06.md) |
