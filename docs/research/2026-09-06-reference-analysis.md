# 参考项目调研报告（2026-09-06）

> 目的：为自研跨端 AI agent harness（harness2）收集实证设计依据。
> 原则：实事求是——只记录已验证的事实，标注来源路径；不确定的内容单独列出待查证。
> 分析方式：4 个并行只读代理分别深读四个代码库 + 本机四应用探查 + opencode 官方文档查证。

---

## 一、参考对象总览

| 对象             | 位置                                                       | 技术栈                                             | 许可证/开源                             | 分析深度                |
| ---------------- | ---------------------------------------------------------- | -------------------------------------------------- | --------------------------------------- | ----------------------- |
| grok-build       | `D:\AI_projects\refs\grok-build`                           | Rust（79 crates，ratatui TUI）                     | Apache-2.0（xAI/SpaceXAI 官方快照）     | 深                      |
| hermes-agent     | `D:\AI_projects\refs\hermes-agent`                         | Python（agent core + Electron 桌面 + 20+ IM 网关） | MIT（NousResearch/hermes-agent）        | 深                      |
| deepseek-harness | `D:\AI_projects\refs\deepseek-harness`                     | TypeScript pnpm monorepo（Cordis 插件框架）        | MIT（DeepSeek 官方，developer preview） | 深                      |
| opencode         | 本机安装 `@opencode-aidesktop` + GitHub anomalyco/opencode | TypeScript client/server + Electron                | 开源                                    | 本地数据结构 + 官方文档 |
| Tokeny           | 本机 `D:\Programs\Tokeny`                                  | Electron（asar 未加密）                            | **闭源**（GitHub, Inc. 签名，v1.5.7）   | 数据库 schema 级        |
| ZCode            | 本机 `D:\Programs\ZCode`                                   | Electron（闭源，智谱系）                           | 闭源                                    | 配置/数据结构级         |

---

## 二、按主题的实证结论

### 2.1 撤回/恢复/分叉（用户关注点 1）

三家做法殊途同归，**底层都是"append-only 数据 + 撤回只是投影变化"**：

- **opencode**（`/undo` `/redo`）：撤掉最近一条用户消息及其后所有 assistant 消息，文件改动用快照恢复；`/redo` 反向。官方文档明确："Committing a revert removes messages from the active projection, **not the underlying data**"（opencode.ai/v2/docs/snapshots）。本地数据印证：`~/.local/share/opencode/opencode.db` 含 message + part 两层表和 event_sequence 事件表；`storage/session_diff/` 按会话存 diff，`snapshot/` 存文件快照。
- **grok**（`/rewind`，无 redo）：**每个用户 prompt 就是一个 checkpoint**。三模式：`All / ConversationOnly / FilesOnly`；文件回滚用 before-snapshot 写回 + after-snapshot 做外部修改冲突检测 + dry-run 预览（`crates/codegen/xai-grok-shell/src/session/acp_session_impl/rewind.rs:144-260`）；撤回不删历史，只向 `updates.jsonl` 追加 `RewindMarker`（分支时间线标记）；**ConversationOnly 模式把被丢弃 prompt 的文件快照 merge 进上一个 rewind point**，保证 `/rewind 0` 仍能撤销全部文件改动。前进 = fork + 重新提交。
- **deepseek-harness**：session fork 是 header 里的 `parentSession`/`isSeeded` 血缘字段（`packages/core/session/src/types.ts:91-128`），从任意点派生新会话是事件日志的一等公民。
- **zcode**：分叉（fork），闭源只能从行为层面确认。

**结论（长期推荐）**：三者在数据层可以统一为同一机制——事件溯源日志上做投影截断（undo/redo）、血缘派生（fork）、checkpoint 回滚（rewind）。交互层推荐 **undo/redo 为主（P1）**（线性、高频、符合直觉），**fork 为辅（P1.5）**（同一机制近乎免费获得），grok 的三模式 + 冲突检测 + dry-run 预览作为 undo 的增强语义吸收。结论依据：dsh 的 "Model-visible ⟺ logged" 不变量证明这套数据层能同时支撑历史回放/轨迹/导出/fork。

### 2.2 记忆系统（用户关注点 2，要求做成开关）

**hermes（MIT，最佳参考）双轨制**：

- 存储：`~/.hermes/memories/MEMORY.md`（agent 笔记）+ `USER.md`（用户画像），条目以 `\n§\n` 分隔；**字符硬预算**（memory 2200 / user 1375 字符，模型无关）；文件锁 + 原子写 + 外部漂移检测（防手工编辑被静默覆盖）+ 写入前 prompt 注入扫描（`tools/memory_tool_store.py`）。
- **询问记忆（用户确认）**：`tools/write_approval.py` 统一 gate，三态 `allow / stage / blocked`——前台交互场景 inline 提示 "Save to memory?"（once/session/deny），后台/无 IM 场景 stage 成 pending，事后 `/memory approve <id>` 重放；**只延迟、绝不静默丢弃**。
- **主动记忆**：nudge 计数器（默认每 10 个用户 turn，`agent/agent_init.py:1229`）→ turn 结束在辅助模型上 fork 后台 review agent 回放对话自主写记忆（`agent/background_review.py`），主对话零打断；模型实际调过 memory 工具即重置计数。
- **注入**：会话启动时冻结快照进 system prompt（保护 prefix cache），动态检索结果只拼进当轮 user 消息的 API 副本（`agent/turn_context.py:671`）。
- 短板：内置记忆无衰减/无评分/无语义检索；nudge 与内容无关，安静会话也会周期性起 review。

**Tokeny（闭源，schema 参考）**：`tokeny.db` 的 `memories` 表带 category/importance/valid_from/valid_until/source_hash，配 `memory_access_stats`（access/hit/helpful 计数）、`memory_links`、`memory_usage_log`（记录每次注入与 outcome）——记忆质量评估闭环值得借鉴。

**ZCode**：`~/.zcode` 未见独立记忆库（其记忆嵌在会话内），不作参考。

**结论**：做 hermes 式（文件记忆 + 硬预算 + 写入 gate 三态 + nudge 后台 review），**用户开关控制 gate 默认值**（off / 询问 / 自动），后续迭代引入 Tokeny 式访问统计评估记忆质量。

### 2.3 内嵌浏览器（用户关注点 3，注意资源销毁）

- Tokeny（Electron）内嵌 Playwright + 独立 webfetch 子进程（`app.asar.unpacked/out/main/webfetch-server.cjs`）。
- ZCode 内嵌 CUA 浏览器控制 + 自带 ripgrep/ugrep 工具（`D:\Programs\ZCode\resources\tools\`）。
- 结论：桌面端用 Electron `WebContentsView`（可精确 create/destroy/内存回收），agent 侧浏览器自动化用 Playwright 子进程（可复用 Tokeny 验证过的形态）。**资源管理策略：空闲超时销毁、上限并发、显式 dispose 事件进轨迹日志**。P1 之后再做，先把销毁语义设计好。

### 2.4 插件化与轨迹（用户关注点 4，轨迹优先级最高）

**deepseek-harness 是两者的事实标准**：

- **一切皆插件**：Cordis 框架（vendor 进仓库）——插件即 Service，Context 是服务仓库，依赖用 `inject` 声明；五种事件分发（emit/waterfall/parallel/serial/bail）；所有贡献通过 `ctx.effect()`/`ctx.on()` 安装并返回 disposer（**注册即可逆**）；产品形态（web/headless/sdk/acp）只是同一插件树的不同 Profile/Bundle 叠加（`docs/architecture.md:15-38`）。
- **轨迹**：每 session 一份 append-only JSONL 事件日志，50+ 事件类型（`packages/core/session/src/known-event-types.ts`）：`request/header`（含生效 prompt 快照）、`step/start|end`、`user|assistant/message`、**失败的尝试单独记 `assistant/attempt`**、`tool/call|result`、`compaction/*`、`approval/*`、`llm/retry`。核心不变量 **"Model-visible ⟺ logged"**（发到模型的内容必须可从日志重建，运行时断言）。代际文件不可变（`session.vN.jsonl[.zstd]`），格式演进靠相邻迁移链。轨迹 UI 是纯消费者插件（turn 感知时间轴 + inspector）；支持导出 ZIP（含子代理日志）、**快照回放测试（无需 API key，轨迹即测试夹具）**。
- 短板（照抄要小心的）：概念密度过高（Cordis 全套术语）、文档税重、无桌面端/TUI、pre-stable API 变更频繁。

**grok 的补充设计**：工具运行时与工具集分离（`xai-tool-runtime` 统一 trait + 流式输出 + 类型化通知，工具集可插拔，树内同时存在 opencode/codex 移植版）；并行工具调用按 file_path 提取锁键串行化同文件编辑；单写者 persistence actor + fsync/barrier 的跨平台崩溃一致性文档（`persistence.rs:1-9`）。

**结论**：采纳 dsh 的**事件日志 + "Model-visible ⟺ logged" + 代际迁移**三件套作为轨迹地基；**不引入 Cordis**，自研轻量插件总线（事件 emit/waterfall + 注册返回 disposer），把复杂度控制在单人可维护范围。

### 2.5 按场景模型配置（用户关注点 5：Tokeny）

**已确认 Tokeny 闭源**（exe 元数据 GitHub, Inc. v1.5.7，内部无自有 repo 引用；但 asar 未加密可读，schema 已提取）：

- 渠道（provider）定义在 settings `channels`：`{id, name, baseUrl, apiProtocol, models:[{name, contextWindow, maxTokens}]}`；**API key 分离存储**在 `secret:ai_channel:<id>`。
- **按用途分模型**：`activeModel / completionModel / subagentModel / memoryModel / goalModel / dictationModel / readFileVisionModel` 等，每个统一 `{channelId, model}` 二元组；会话级覆盖走 `sessions.model_ref`。
- **ZCode 补充**（模型目录最正式）：静态 catalog JSON `{schemaVersion, providers:[{id, models:[{id, modalities, contextWindow, maxOutputTokens, reasoning}]}]}` + provider 级 `systemDisabledReason` 状态机（`model-providers/models_catalog_china_llm_zcode_2026-06-03.json`）。

**结论**：不做闭源逆向集成，只采纳 schema 思想：`{channelId, model}` 二元组挂各用途 + 静态模型目录 + key 分离存储。这是纯 schema 借鉴，无合规风险。

### 2.6 QQ Bot / IM 集成（用户关注点 6，主用 QQ）

**hermes（MIT，可直接参考实现）**：

- 内置 9 平台（**qqbot**、weixin、signal、whatsapp_cloud、bluebubbles、msgraph_webhook、webhook、api_server、yuanbao）+ 插件 15+（telegram、discord、slack、**feishu**、dingtalk、matrix、email…），共 20+。
- **QQ 官方 Bot API v2**：入站 WebSocket gateway（app_id+client_secret 换 token，单飞刷新、断线重连），出站 REST（api.sgroup.qq.com）；DM/群策略（open/allowlist/disabled）、语音转写、**工具审批做成 QQ InlineKeyboard 按钮**（`gateway/platforms/qqbot/keyboards.py`）。不做个人号逆向协议。
- 桥接：`BasePlatformAdapter` 统一抽象 → 按"平台+chat id"路由到会话，每 chat 串行、持久化去重；复用同一 agent core。
- Tokeny 也有 `im_configs`、`scheduled_tasks` 表佐证同路线。

**结论**：gateway 独立进程，QQ 走官方 Bot API v2（用户需在 QQ 开放平台注册机器人），飞书后续同理。P2 做。

### 2.7 定时任务（用户关注点 7：grok）

- **grok**：scheduler-as-tool——`scheduler_create/delete/list` 工具 + 独立 scheduler actor（tokio mpsc + generation 版本化 + occurrence journal 防丢失/防重放）；interval 语法 `"5m"/"2h"/"1d"`；`recurring/durable/foreground/fire_immediately` 语义；上限 50 个 + TTL 过期；宿主不猜排程，注入指令让**模型自己调 scheduler_create**。
- **hermes**：60 秒 tick + 跨进程文件锁；`jobs.json` 持久化；**循环任务先推进 next_run 再执行**（at-most-once，防 crash 后连发补跑）；连续失败进 incidents。
- **Tokeny**：`scheduled_tasks` 表（结构存在，行为不可考）。

**结论**：做 hermes 式调度（简单可靠：tick + 文件锁 + at-most-once），吸收 grok 的"任务即工具、结果以通知事件呈现"语义。P1 末/P2。

### 2.8 分屏/多会话并行（用户关注点 8/9）

- Tokeny 的 `stream_runs` 表（`heartbeat_at`、`pending_interrupts`、`owner_epoch`、`resume_of_stream_id`）给出了**会话内核与 UI 生命周期解耦**的 schema：流是可恢复实体，UI 只是观察者。
- opencode 本地数据：`opencode/locks/` 本地 server 锁，桌面壳只是 client。
- 结论：会话内核（headless 进程/服务）与桌面 UI 分离，多会话 = 多 stream 实体；后台会话可不渲染（只记事件），切换时从事件日志快速重放当前窗口——正好与轨迹机制同源。P1 桌面阶段的核心架构决策。

---

## 三、技术栈决策输入

| 维度        | 事实                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| dsh 证明    | TS pnpm monorepo 可承载 web/headless/sdk/acp 多形态 + 19 个 GH Actions workflows 完整 CI/CD          |
| hermes 证明 | Electron 桌面 + 常驻 gateway + 20+ IM 平台在 Python core 上可行，但桌面打包链路复杂                  |
| grok 证明   | Rust TUI 性能极佳但 79 crates 体量失控、Windows best-effort                                          |
| 本机四应用  | Tokeny/ZCode/Hermes-desktop 全是 Electron；opencode 桌面也是 Electron——该路线在 Windows 上验证最充分 |

**推荐（详见 ROADMAP）：TypeScript/Node monorepo + Electron 桌面 + SQLite/JSONL 存储 + QQ 官方 API 网关**。备选 Tauri 2（更轻，但 webview 跨平台不一致 + Rust 层维护成本）。待用户确认后写入 `architecture.md`。

---

## 四、待查证清单（实事求是原则）

1. QQ 官方 Bot API v2 当前对个人开发者的开放范围（群聊能力需审核？markdown 消息白名单？）——集成前实测。
2. Tokeny 的 runtime-archives（node/python tar.gz 随应用分发）许可证是否允许借鉴其分发方式——倾向自建方案规避。
3. opencode snapshot 的 git 依赖问题（社区反馈 /undo 在 git 项目里有副作用）——我们做快照时应**不依赖 git**（学习 grok 的独立文件快照）。
4. Electron `WebContentsView` 在多窗口拖拽分屏下的内存表现——P1 原型验证。
