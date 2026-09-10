# 阶段 3：真实 Provider + 配置体系 + 审批细化

> **状态：** ✅ 已完成——2026-09-06 编排者验收通过（独立审查 pass-with-fixes → 2 P1 + 6 P2 已修复 +11 回归测试；重跑证据：pnpm test 182 passed + 1 skipped、typecheck 0 错、config check 冒烟正确、密钥/真实端点红线核查通过；真实端点实机验证待用户 key，见 OPEN.md）
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 接入真实模型协议（OpenAI-compatible 覆盖 DeepSeek/智谱等 + Anthropic 原生），建立两级配置与按角色选模型（`{channelId, model}`），审批策略配置化——全程用本地 HTTP stub 测试，CI 零 API key。
**Architecture:** Provider 是 Ph2 已落地的 `ChatProvider` 缝的唯一新实现方；配置是纯数据层（加载/合并/校验/脱敏），loop 与工具系统不感知配置来源；密钥只存 auth.json 与环境变量，绝不入 config/git/日志。
**Tech Stack:** 现有栈；新增运行时依赖仅 `jsonc-parser`（config 允许注释）；无 SDK 依赖（协议手写 fetch，可控且可测）。

---

## 前置阅读（必须）

| 优先级 | 文件                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 本文件、`docs/MASTER-PLAN.md`（Ph3 定位）                                                                                                         |
| P0     | `packages/core/src/provider/types.ts`（ChatProvider 契约——一切实现的基准）、`agent/loop.ts`（取消分类已兼容"结束迭代"与"抛错"两种 provider 行为） |
| P0     | `architecture.md`（不变量边界：invariant 覆盖 messages，tools schema 暂不在内）                                                                   |
| P1     | `docs/issue-log/OPEN.md`、`CODE_REVIEW.md`                                                                                                        |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-3-providers-config`（阶段 2 已验收：109 passed + 1 skipped）

---

## Global Constraints（冲突时以本节为准）

1. **密钥三不**：不进 config.json/git/事件日志/错误消息（错误含 key 时必须脱敏；`grep -rn "sk-\|api.key"` 自查 fixture）。
2. **CI 零真实 API**：所有 provider 测试用 `node:http` 本地 stub server 模拟 SSE；真实端点验证登记 OPEN.md（待用户提供 key 后手工执行）。
3. **契约不变**：不修改 Ph2 的 `ChatProvider`/`StreamChunk`/loop 语义；发现契约不足时先在交卷报告中提出，经最小扩展（可选字段）才允许改。
4. **明确不做（本阶段）**：模型发现（/models 拉取）、CLI chat（Ph4）、计费统计面板、subagent 实际使用 small 角色（Ph6/8）。
5. **Git：** 每 Task 一提交；禁止 push。

---

## 配置契约（本阶段冻结的 schema，v1）

```jsonc
// 全局: ~/.harness2/config.json ；项目: <repo>/.harness2/config.json（深合并，项目覆盖全局）
{
  "providers": {
    "deepseek": {
      "protocol": "openai", // openai | anthropic
      "baseUrl": "https://api.deepseek.com/v1",
      "envKey": "DEEPSEEK_API_KEY", // 可选；key 解析顺序 auth.json > env
      "models": { "deepseek-chat": { "contextWindow": 128000, "maxOutputTokens": 8192 } },
    },
  },
  "roles": {
    // 按场景选模型（Tokeny 式 {channelId, model}）
    "main": { "channel": "deepseek", "model": "deepseek-chat" },
    "small": { "channel": "deepseek", "model": "deepseek-chat" },
    "subagent": { "channel": "deepseek", "model": "deepseek-chat" },
  },
  "approval": {
    "mode": "default", // default | acceptEdits | bypass
    "tools": { "bash": "ask", "write": "ask" }, // per-tool: allow|ask|deny，未列出的 safe=allow / unsafe=ask
  },
}
// 密钥文件: ~/.harness2/auth.json —— { "channels": { "deepseek": { "apiKey": "..." } } }，永不入 git
```

---

## File Structure（预期变更）

| 文件                                                                               | 动作 | 职责                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/config/{schema,load,auth,redact}.ts`                            | 新建 | schema 校验、两级加载深合并、`${VAR}` 展开、auth.json 读写（POSIX chmod 600 尽力）、脱敏工具（`redactSecrets`）                      |
| `packages/core/src/provider/openai.ts`                                             | 新建 | OpenAI-compatible：SSE 流式、tool_calls delta 组装、`reasoning_content`（DeepSeek/GLM）→ reasoning chunk、usage、abort→ProviderError |
| `packages/core/src/provider/anthropic.ts`                                          | 新建 | Messages API：SSE（content_block_delta/message_delta）、tool_use/tool_result 映射、system 顶层参数、x-api-key 头                     |
| `packages/core/src/provider/factory.ts`                                            | 新建 | `createProvider(config, role): ChatProvider`（roles 查找→channel 校验→key 解析→协议分派）；key 缺失抛带脱敏提示的 ConfigError        |
| `packages/core/src/approval/policy.ts`                                             | 新建 | 从 config.approval 构造 ApprovalPolicy（三 mode + per-tool 规则；unmatched safe=allow/unsafe=ask）                                   |
| `packages/core/src/session/types.ts`                                               | 修改 | `AssistantMessagePayload` 增可选 `reasoning?: string`（v1 加性字段，无需代际升级）；loop 透传 reasoning chunk 汇总                   |
| `packages/cli/src/index.ts`                                                        | 修改 | `harness2 config check`：校验合并配置，脱敏打印 channels/roles/key 来源（`auth.json`/`env:XXX`/`missing`），exit 1 一行错误          |
| `packages/core/test/{config,providers,policy}.test.ts`、`test/helpers/sse-stub.ts` | 新建 | 见各 Task                                                                                                                            |
| `.gitignore`                                                                       | 检查 | `auth.json` 已全局忽略（确认即可）                                                                                                   |

---

## Task 1：配置体系

**Files:** `config/*`、`test/config.test.ts`

**行为:** 两级加载（显式路径注入，默认路径按上表）；深合并（对象递归、数组/标量覆盖）；`${VAR}` 展开（缺失 env → 保留原样并在校验结果中告警）；schema 校验（protocol 枚举、roles 引用存在的 channel/model、未知字段忽略）；**错误消息不回显包含 key 的行**（用 redactSecrets 过滤）。auth.json：读失败容错（不存在=空表）、写时 POSIX chmod 600 尽力、损坏时报一行错误。

**Steps:** 1. 实现+测试（合并优先级/展开/校验/脱敏/auth 读写/损坏容错 ≥10 例）。2. Commit：`✨feat(core): 两级配置体系与密钥分离存储`

## Task 2：OpenAI-compatible Provider

**Files:** `provider/openai.ts`、`test/providers.test.ts`、`test/helpers/sse-stub.ts`

**行为:** `fetch POST {baseUrl}/chat/completions`（stream:true）；SSE 帧解析（`data:`/`[DONE]`、跨 chunk 缓冲）；`delta.content`→text-delta；`delta.tool_calls` 按 index 累积（id/function.name/arguments 字符串拼接，finish 时 JSON.parse 为 args，解析失败→该调用 error）；`delta.reasoning_content`→reasoning-delta；`usage` chunk；abort→ProviderError('cancelled')；HTTP 非 2xx→脱敏错误（含状态码与 body 摘要≤200 字符，过滤 key）。ChatMessage→wire 映射：assistant.toolCalls→`tool_calls:[{id,type:'function',function:{name,arguments}}]`；tool 结果→`{role:'tool', tool_call_id, content}`。

**Steps:** 1. sse-stub helper（可编程帧序列/状态码/断流）。2. 测试：纯文本流、tool_calls 跨帧组装、reasoning_content、usage、401 脱敏、断流半帧、abort。3. Commit：`✨feat(core): OpenAI-compatible provider（SSE/工具增量/思考字段）`

## Task 3：Anthropic Provider

**Files:** `provider/anthropic.ts`、`test/providers.test.ts` 扩展

**行为:** `POST {baseUrl}/v1/messages`（system 顶层、`x-api-key` + `anthropic-version` 头）；SSE 事件映射：`content_block_delta.text_delta`→text、`input_json_delta`→累积 tool args、`message_delta`→usage/stop_reason；`tool_use` 块→tool-call；ChatMessage.tool 结果→ user 消息内 `tool_result` 块；error 事件→脱敏 ProviderError。与 Task 2 共享 sse-stub。

**Steps:** 1. 实现+测试（同 Task 2 维度 + tool_result 映射）。2. Commit：`✨feat(core): Anthropic provider（messages API 流式）`

## Task 4：工厂 + 端到端集成

**Files:** `provider/factory.ts`、`test/providers.test.ts` 扩展

**行为:** `createProvider(config, role)` 按 roles→channel→protocol 分派；`reasoning` chunk 由 loop 汇总进 `assistant/message.reasoning`（session types 加性扩展）。端到端：runTurn × stub server（含一轮工具调用）断言投影与 wire 请求一致（复用 Ph2 不变量测试手法）。

**Steps:** 1. 实现+测试（含 role 缺失/引用不存在 channel 的错误路径）。2. Commit：`✨feat(core): provider 工厂与端到端 stub 集成`

## Task 5：审批策略配置化

**Files:** `approval/policy.ts`、`test/policy.test.ts`

**行为:** mode 三态 + per-tool 规则（优先级：per-tool > mode 推导）；`default`：safe=allow、unsafe=ask；`acceptEdits`：write/edit=allow 其余同 default；`bypass`：全 allow。与 Ph2 executor 的审批缝直接对接（ApprovalInput→决策）。

**Steps:** 1. 实现+测试（每 mode × 代表工具矩阵）。2. Commit：`✨feat(core): 审批策略配置化（三模式+按工具规则）`

## Task 6：CLI config check + 整备

**Files:** `packages/cli/src/index.ts`、文档

**行为:** `harness2 config check [--root <dir>]`：加载合并→校验→打印 providers（baseUrl/protocol/models）、roles、key 来源（`auth.json`/`env:XXX`/`**missing**`，永不打印明文）；任何错误一行输出 exit 1。文档：architecture.md（配置/Provider 小节）、diary、HANDOFF 快照、OPEN.md。

**Steps:** 1. 实现+测试（含 missing key 的输出断言）。2. 全量验证。3. Commit：`✨feat(cli): config check（校验与脱敏展示）`

## Task 7：登记无法自主验证项 + 交接

OPEN.md 登记：「真实端点手工验证待用户在 auth.json 配置 key 后执行（DeepSeek/智谱/Anthropic 各一条消息+一次工具调用）」；HANDOFF 已知坑补「真实 API 未实机验证」。

---

## 验收标准总表

| #   | 标准          | 通过条件                                                                      |
| --- | ------------- | ----------------------------------------------------------------------------- |
| 1   | 配置体系      | 合并/展开/校验/脱敏/auth 读写测试通过                                         |
| 2   | OpenAI-compat | SSE 流式/tool 组装/reasoning/错误脱敏/abort 测试通过（stub）                  |
| 3   | Anthropic     | 同维度测试通过（stub）                                                        |
| 4   | 工厂+E2E      | role 分派正确；runTurn×stub 不变量测试通过                                    |
| 5   | 审批配置      | 三 mode × 工具矩阵测试通过                                                    |
| 6   | config check  | 正常/异常路径输出与 exit code 断言通过                                        |
| 7   | 红线          | 密钥不出现在 config/日志/错误/fixture（grep 自查）；ChatProvider 契约未被破坏 |
| 8   | 单测/构建     | `pnpm test && pnpm -r typecheck` exit 0                                       |

---

## 风险与降级

| 风险                                        | 缓解                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| SSE 帧边界/多字节跨 chunk                   | stub 用例专测半帧+中文跨 chunk                               |
| 真实端点与 stub 行为偏差（如 GLM 特有字段） | 协议字段白名单+未知字段忽略；真实验证登记 OPEN.md 待用户 key |
| auth.json Windows 权限                      | chmod 尽力而为 + 文档注明 Windows 依赖目录 ACL               |
| 契约不足需改 provider/types.ts              | 可选字段扩展 + 测试先行 + 交卷报告说明                       |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 3 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线

- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-3-providers-config`
- 已完成（勿重做）：阶段 1（会话内核）+ 阶段 2（agent loop/工具系统/MockProvider/CI）均已验收，当前 109 passed + 1 skipped
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-3-providers-config.md`
- 必读：本计划（含配置契约 schema）、`packages/core/src/provider/types.ts`、`agent/loop.ts`、`architecture.md`、`AGENTS.md`

### 做

1. 严格按 Task 1→7 顺序执行；每 Task 测试通过后按规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：密钥三不（config/git/日志/错误消息）；CI 零真实 API（全部用本地 HTTP stub）；不修改 ChatProvider/loop 契约语义
3. Task 7 在 OPEN.md 登记真实端点手工验证项，更新 HANDOFF/diary/architecture

### 不做

- 模型发现、CLI chat、subagent 角色实际消费、任何真实网络调用（测试除外——仅 127.0.0.1 stub）
- 提交密钥；任何 `git push`

### 工作方式

1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷

分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、密钥 grep 自查结果、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 7。

---

## 残留手工验收清单

1. （用户提供 key 后）DeepSeek / 智谱 / Anthropic 三端各发一条真实消息 + 一次工具调用，核对流式渲染与 reasoning 展示
2. （远程可用后）CI 三平台绿灯（含 Ph2 遗留项一并验证）
