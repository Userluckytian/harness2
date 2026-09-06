# 阶段 9：QQ / 飞书 IM 网关

> **状态：** ✅ 已完成——2026-09-06 编排者验收通过。过程：实现代理两次并发中断（接手代理收尾）→ 独立审查 **verdict: fail**（P0 网关聋哑 + 7 P1，审查引用 QQ 官方文档纠正 msg_seq/token 契约）→ 修复代理两次中断后编排者代修（`fb837bb`：生命周期/重连重订阅/msg_seq 递增/飞书策略与鉴权/CLI 飞书分支）→ 全量复验 540 passed + 1 skipped。**复审待基础设施恢复后补做**（fail 阶段闭环条件）；真实联调待用户 QQ/飞书凭据，见 OPEN.md
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 让用户在 QQ 里直接用 harness2（主场景），飞书同架构跟进。网关是 serve 的另一个"观察者"（D5 一致：经 HTTP/WS 桥接，零新写入路径）；QQ 走**官方 Bot API v2**（不做个人号逆向）。
**Architecture:** `packages/gateway` 独立常驻进程：连接本地 serve（复用桌面端同款 HTTP/WS 桥）+ 平台适配器（收消息 → 会话路由 → WS user-message；事件帧 → 平台出站渲染）。平台适配器统一接口（对照 hermes `BasePlatformAdapter`），新增平台 = 新增一个适配器文件。
**Tech Stack:** 现有栈 + `ws`（QQ 官方 WS 网关复用）+ 飞书走官方 HTTP webhook/长连接（实现时按当期官方 SDK/文档定，优先零重依赖）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件、`docs/research/2026-09-06-reference-analysis.md` §2.6（QQ 官方 API v2 实证：WS 网关/token 刷新/审批 InlineKeyboard） |
| P0 | `packages/core/src/server/{http,ws,sessions}.ts`（服务 API 契约 v1）、`packages/desktop/src/main/{serve-manager,bridge}.ts`（serve 客户端先例） |
| P1 | QQ 官方 Bot 文档（bot.q.qq.com/wiki，当期版本）、hermes `gateway/platforms/qqbot/`（MIT 参考）、`docs/issue-log/OPEN.md` |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-9-im-gateway`

---

## Global Constraints（冲突时以本节为准）

1. **零新写入路径**：网关对会话的一切操作经 serve API（与桌面同权）；平台消息内容属会话数据，不入 git。
2. **密钥**：QQ appSecret / 飞书凭证存 `~/.harness2/auth.json`（新增 channels 之外的 `gateways` 段），出口脱敏照旧。
3. **QQ 红线**：只走官方 Bot API v2（appid+secret 换 token、WS 网关心跳、REST 出站 api.sgroup.qq.com）；token 单飞刷新；断线指数退避重连；**遵守平台消息频率限制**（出站队列 + 最小间隔）。
4. **会话路由**：`<platform>:<chatId>` → harness2 会话 id 的映射持久化（`~/.harness2/gateway/routes.json`）；每 chat 串行（复用 hub 排队）；DM/群策略：`open | allowlist | disabled`（缺省 allowlist，防滥用）。
5. **明确不做（本阶段）**：个人号协议、语音/图片收发（文本先行）、多账号、飞书卡片全量（基础文本消息即可）。
6. **Git：** 每 Task 一提交；禁止 push。

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/gateway/src/{types,serve-client,router}.ts` | 新建 | 平台适配器接口、serve HTTP/WS 客户端（桌面同款）、路由表 |
| `packages/gateway/src/platforms/qq/{adapter,gateway-ws,api}.ts` | 新建 | QQ 官方 Bot API v2：鉴权/token 单飞、WS 网关（心跳/分片确认）、REST 出站（频率限制队列） |
| `packages/gateway/src/platforms/feishu/adapter.ts` | 新建 | 飞书基础适配器（长连接/webhook 二选一，按官方当期推荐） |
| `packages/gateway/src/render.ts` | 新建 | 事件帧 → 平台消息渲染（精简：助手文本、工具行一行、turn 摘要、审批请求） |
| `packages/gateway/src/index.ts` | 新建 | 入口：读配置 → 起 serve 客户端 → 启用各平台适配器 |
| `packages/cli/src/index.ts` | 修改 | `harness2 gateway [--platform qq,feishu]`（网关常驻入口； serve 未起时自动 spawn，桌面同款逻辑复用） |
| `packages/core/src/config/schema.ts` | 修改 | `gateways` 段（qq/feishu：凭据 envKey、策略） |
| `packages/gateway/test/*.test.ts` | 新建 | 见各 Task |
| 文档（architecture/ROADMAP/HANDOFF/diary/OPEN） | 修改 | 整备 |

---

## Task 1：网关骨架与 serve 桥接

**Files:** gateway `types/serve-client/router`、`test/serve-client.test.ts`

**行为:** 平台适配器接口（`start/stop/onMessage/send(platform, chatId, text)`）；ServeClient 复用桌面桥逻辑（HTTP 控制 + WS 订阅/发送/审批应答，可从 desktop 抽公共模块或复制精简——实现者定，注明取舍）；路由表持久化 + `resolve(platform, chatId)`（无映射 → 自动建会话并入表）。`harness2 gateway` 入口：serve 未起 → spawn（桌面 serve-manager 逻辑复用）。

**Steps:** 1. 实现+测试（路由建表/复用/持久化、ServeClient 对本地 stub serve 的全链：发消息→收事件帧→审批应答）。2. Commit：`✨feat(gateway): 网关骨架（适配器接口/serve 桥接/会话路由）`

## Task 2：QQ 适配器（官方 Bot API v2）

**Files:** `platforms/qq/*`、`test/qq.test.ts`

**行为（对照 hermes qqbot 实证 + 官方文档）:**
- 鉴权：appid+secret → access_token（提前 60s 单飞刷新，并发共享）。
- 入站：官方 WS 网关（wss url 由 REST 获取）——连接→Identify（intents：群聊@/私聊 C2C）→心跳（按服务端 hello 间隔）→断线指数退避重连（resume 失败重新 Identify）；payload op 分发（0 事件/10 hello/11 ack）。
- 出站：REST `api.sgroup.qq.com`（消息发送 v2 接口）；**频率限制队列**（令牌桶/最小间隔，429 退避）；msg_id 被动回复关联（官方要求）。
- 策略：群 open/allowlist/disabled + 私聊同；`@` 触发（群）或直接（私聊）；消息去重（官方可能重推）。
- 测试：本地 HTTP stub 模拟鉴权/网关握手/事件推送（ws 客户端直连测试服）+ REST 出站捕获断言；全部离线可跑。

**Steps:** 1. 实现+测试（鉴权单飞/心跳/重连/出站队列/去重/策略 ≥14 例）。2. Commit：`✨feat(gateway): QQ 官方 Bot API v2 适配器（WS 网关/REST 出站/频率限制）`

## Task 3：渲染与审批桥接

**Files:** `render.ts`、平台适配器扩展、测试

**行为:** 事件帧 → 平台消息（合并策略：流式 delta 不逐条发——turn 结束一次性发最终文本 + 工具行摘要 ≤N 行 + 审批请求单独一条）；审批请求渲染为"工具 X 请求执行，回复「1 允许 / 2 拒绝」"→ 用户回复解析 → approval-response（映射 pending 表，超时提示）；错误帧一行。消息长度超平台上限 → 截断 + 提示用 traj 看全文。

**Steps:** 1. 实现+测试（渲染各帧型/审批往返/超长截断/频率队列下合并）。2. Commit：`✨feat(gateway): 渲染与审批桥接（回复式决策/合并策略/截断）`

## Task 4：飞书适配器（基础）

**Files:** `platforms/feishu/adapter.ts`、`test/feishu.test.ts`

**行为:** 官方长连接模式（或 webhook 回调 + 本地端口，按当期官方推荐，实现者查证后定并在代码注明依据）；文本收发 + 相同渲染/审批/策略管线（与 QQ 共用 router/render）。凭据 envKey。

**Steps:** 1. 实现+测试（stub 收发/策略/去重 ≥8 例）。2. Commit：`✨feat(gateway): 飞书基础适配器（文本收发/同管线）`

## Task 5：整备与交接

cron 投递登记为后续项（WS 通知帧已具备，接平台渲染即可）；architecture（网关小节）、ROADMAP（P2-21/22 → ✅，注明真实环境验证待用户）、HANDOFF、diary、OPEN（QQ 真机联调清单：开放平台凭据配置 → 群 @ 触发 → 私聊 → 审批回复 → 频率限制观察）。

---

## 验收标准总表

| # | 标准 | 通过条件 |
|---|------|----------|
| 1 | 骨架 | 路由持久化/ServeClient 全链（stub serve）测试通过 |
| 2 | QQ 适配器 | 鉴权单飞/心跳/重连/出站队列/去重/策略测试通过（全离线 stub） |
| 3 | 渲染审批 | 帧渲染/审批往返/截断测试通过 |
| 4 | 飞书 | stub 收发/策略/去重测试通过 |
| 5 | 红线 | 零新写入路径（仅经 serve API）；appSecret 不入 git/不出现在日志；官方 API only |
| 6 | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| QQ 官方 API 变动/文档滞后 | 适配器薄封装 + stub 测试锚定行为；真机联调清单在 OPEN（用户提供凭据后执行） |
| 平台消息上限/频率限制 | 出站队列 + 截断 + 合并策略（Task 3） |
| WS 网关心跳时序平台差异 | 参数化心跳间隔 + 断线重连测试 |
| 飞书长连接模式不确定 | 实现者查证当期官方推荐并注明依据；webhook 回退方案在 Task 4 内取舍 |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 9 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-9-im-gateway`
- 已完成（勿重做）：阶段 1-8 均验收（……服务化+桌面、记忆+分叉、浏览器+压缩+cron、插件+MCP+subagent），当前 526 passed + 1 skipped
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-9-im-gateway.md`
- 必读：本计划、`packages/desktop/src/main/{serve-manager,bridge}.ts`（serve 客户端先例）、`server/ws.ts`（帧契约）、`docs/research/…§2.6`、`AGENTS.md`

### 做
1. 严格按 Task 1→5 顺序执行；每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
2. 遵守 Global Constraints：零新写入路径（仅经 serve API）；QQ 官方 API only + 频率限制 + token 单飞；平台消息不入 git；appSecret 走 auth.json/脱敏
3. QQ/飞书全部测试离线可跑（本地 stub），真实联调清单登记 OPEN（用户提供开放平台凭据后执行）
4. Task 5 更新 architecture/ROADMAP（P2-21/22 → ✅）/HANDOFF/diary/OPEN

### 不做
- 个人号逆向协议、语音图片收发、多账号、飞书卡片全量
- 提交密钥；任何 `git push`

### 工作方式
1. 先跑基线 `pnpm test` 确认全绿再动工
2. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
3. 简体中文回复；代码标识符原样

### 交卷
分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 5。

---

## 残留手工验收清单

1. （用户提供 QQ 开放平台凭据后）真机联调：群 @ 触发对话、私聊、审批回复、频率限制观察、断线重连
2. 飞书企业自建应用真机联调
3. cron 结果投递到 QQ（Task 5 登记的后续项）
