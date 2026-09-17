# 阶段 R — 桌面端改造总纲（核心补强 → 壳重做 → 特色放大）

> 立项：2026-09-17
> 编排者：外部评审方（本文件作者），负责各阶段验收
> 执行：子代理分轨实施，**子代理不自行开分支、不 force push、不在 main 上试错**
> 参照物：`D:/AI_Projects/refs/hermes-agent`（Hermes-Agent，MIT，本机完整副本，**不依赖网络**）
> 状态：⬜ 待启动（R0 未开始）

---

## 0. 一句话

**harness2 不是空壳，是「能力铺得宽、每项深度不够」的半成品；桌面壳骨架成型但血肉未长。** 本轮按「先修核、再换皮、后放大特色」三步改造桌面形态，**不碰三端野心**。

---

## 0.1 与「视觉复刻总纲 V0–V6」的并行关系（必读）

同日（2026-09-17）项目已由内部编排者立项 `2026-09-17-visual-parity-program.md`（V0–V6），V0 已在 `chore/v0-baseline` 上跑完。**本 R 计划不取代、不合并、不重排它。** 两个程序并行，分工如下：

| 维度 | V 程序（视觉复刻） | R 程序（本文） |
| --- | --- | --- |
| 形态 | **终端 TUI** | **桌面 Electron** |
| 目标 | 壳像 grok，字符/配色吹合度可签字 | 核心能力补强 + 壳重做 + 特色放大 |
| 主战场 | `packages/cli` | `packages/desktop`、`packages/core` |
| 对 core | 明言全程不改，`api-surface-baseline.json` 0 diff | **R1 会做加性改动**，需解冻窗口 |
| 参照物 | grok-build（抓屏） | hermes-agent（本机副本） |

### 协调规则（三条，冲突时以本节为准）

1. **文件交集必须为 0。** R 程序不得改 `packages/cli/src/tui/**`（V 程序的领地，含 236KB 的 `next-shell.ts` 高危交汇点）；V 程序不得改 `packages/desktop/**`。开工前用 `git merge-tree` 预判。
2. **`api-surface-baseline.json` 是唯一真冲突点。** V 总纲铁律 1 要求它全程 0 diff，而 R1-A/B/C 必然改它。**规则：** R 程序每次更新快照必须（a）仅加性、（b）先合入 main、（c）当场通知 V 程序编排者 rebase，并在本文 §6 验收表登记基线新值。V 程序的「0 diff」改读为「**相对其分支基点** 0 diff」。
3. **串行约束只有一条：** 双方均不得在对方阶段未验收时直推 main。合入顺序由先到先得，后到者 rebase 并重跑六闸门。

### 已接手的 V 程序遗留项（R0 顺带交付）

V0 登记了两条属于 R 程序领地、但卡着 V1 闸门 2 的阻塞项，**本计划接过来当 R0-0 做**：

- **desktop 2 个测试文件收集期红**：`models-page.test.tsx` / `models-section-wiring.test.tsx` 报 `No such built-in module: node:`。已被独立复现三次（P10/P11/V0），属 `main` 既有。**禁止 `.skip` 绕过**。
  - **【2026-09-17 10:54 实测纠正】在当前 `main`（`2477b97`）上不可复现。** 六条独立路径（单文件 ×2 / `test/settings/` 目录 / 包全量 / 仓库根 `pnpm test` / 清缓存冷跑）**全部绿**；根级六包合计 **3905 passed + 5 skipped**，日志 0 处 `No such built-in` ⇒ **闸门 2 已恢复可用**。差额 22 恰等于这两个文件的 21+1 个用例，证明当时是整文件收集失败而非断言失败。机制性脆弱点（文件级 `jsdom` + 顶层 `node:` 内建被 externalize）**仍然存在**，只是当前依赖解析下不触发。
  - ⇒ **R0-0 降级为 R1-D 的加固项**：fixture 挪到 node 环境测试文件，或在 desktop vitest 配置显式声明这些内建不 externalize，并补「externalize 回归即变红」的守卫用例。完整取证见 `docs/issue-log/2026-09-17.md` §四。
- **P10/P11 停在本地分支**：V 程序的 V1 需要对照台（`scripts/tui-parity/`），而它只活在未合入的分支上。**本计划 §8 启动前置已含此项，完成后即解除双方阻塞。**

---

## 1. 评审结论（2026-09-17 外部评审）

### 1.1 先说三条纠偏

评审开始时的假设是「核心破败不堪、毫无特色、壳子是垃圾」。逐条取证后，**前两条不成立，第三条部分成立**：

| 假设 | 取证结论 |
| --- | --- |
| 核心破败不堪 | ❌ **不成立**。`packages/core` 有 agent loop、工具执行器（safe 并发 / unsafe 独占 / lockKey 串行）、审批链、append-only 运行账本、undo/redo + 文件快照、会话分叉、分层压缩、索引化检索、MCP 客户端、cron（含自然语言）、插件总线、Skills、子代理 + 扇出、浏览器工具、轨迹导出/回放、doctor、serve HTTP/WS、三态记忆。测试 4033 passed，导出面有快照基线，红线 8 条成文。工程纪律高于多数同类个人项目 |
| 毫无特色 | ❌ **不成立**，但「零包装」成立。见 §1.4 |
| 壳子是垃圾 | 🔶 **部分成立**。结构上确有数量级差距（见 §1.3），但**至今无任何桌面真机截图**，评审无法做像素级定性 —— 这本身就是 R0 第一件事 |

**评审自我纠偏一条（必须记录）：** 初判「turn 级错误恢复极薄，只有 9.8KB 的 retry-policy」。通读 `packages/core/src/interaction/retry-policy.ts` 后**撤回该判断** —— 该文件包含错误分类、退避档位、确定性种子抖动（mulberry32）、per-turn 次数与累计等待双预算、显式停因枚举（`budget-exhausted`/`timeout`/`retry-after`）、AbortSignal 可取消，且明确尊重 `Retry-After` 不违规提前重试。**这一层写得扎实。** 真正薄的是「重试之外的恢复」，见 §1.2 P0-2。

### 1.2 坐实的核心缺陷（按严重度，含取证）

#### P0-1 完全没有 prompt caching 策略 —— 本轮最高优先

**取证：** 全仓正则搜索 `cache_control|cacheControl|prompt_cache|promptCache|cached_tokens|cacheCreation|ephemeral`（1846 个 `.ts` 文件），**仅 7 处匹配，全部位于 `packages/cli/src/tui/status-line/contract.ts` 的展示字段与其测试**。`packages/core/src/provider/anthropic.ts`、`openai.ts` 中**零匹配**。

**含义：** harness2 会在状态行**显示**模型返回的缓存 token 数，但**从不主动申请缓存**。既不设缓存断点，也没有「缓存边界稳定性」这个概念。

**为什么致命：** Hermes 把「**Per-conversation prompt caching is sacred**」列为全仓第一不变量，唯一允许破坏缓存的例外是上下文压缩；连 slash command 都必须 cache-aware（默认延迟到下一轮生效，需要立即生效得显式 `--now`）。长会话每轮重发全量上下文而不命中缓存，成本是数倍差距，且首 token 延迟显著劣化。**这是 harness 的经济性根基，不是优化项。**

#### P0-2 重试之外的恢复缺失

**取证：** `interaction/retry-policy.ts` 只处理「请求失败 → 退避重试」。仓内无以下路径的处理：

- 模型返回**空响应**（无文本无工具调用）→ 当前会直接走完 turn，用户看到空白
- **工具调用参数畸形**（JSON 截断 / schema 不符）→ 无「回灌错误让模型自纠」的标准环
- **上下文溢出**（请求侧 400 context_length_exceeded）→ 无「就地压缩后重发」路径
- **流中途截断** → `stream_truncated` 被归入可重试，但重试是**整轮重发**，不是续接

**对照：** Hermes `agent/error_classifier.py` 49KB + `agent/turn_recovery.py` 72KB 专门处理这一层。

#### P0-3 Provider 抽象过薄

**取证：** `packages/core/src/provider/` 仅 5 个文件共 ~38KB：`anthropic.ts` 13.1KB、`openai.ts` 13.5KB、`mock.ts` 3.7KB、`factory.ts` 3.8KB、`types.ts` 4KB。

**缺：** 模型元数据（上下文窗口、最大输出、是否支持缓存/推理/视觉/并行工具调用）、定价、凭据池与轮换、限流护栏、reasoning effort 传递、Gemini / Bedrock / Vertex / Azure。

**连带后果：** token 分母当前用 `DEFAULT_CONTEXT_WINDOW` 固定近似（已登记技术债）—— 因为没有模型元数据可查。**P0-1 的缓存断点也是 provider 相关的**（Anthropic 用 `cache_control: ephemeral`，OpenAI 是自动前缀缓存），所以 P0-1 与 P0-3 必须同轨做。

#### P0-4 桌面端阻塞级缺陷（OPEN.md 自陈，评审确认仍在）

| 编号 | 缺陷 | 现象 |
| --- | --- | --- |
| D-a | 启动期 `serve 未就绪` invoke 竞态 | 每次启动控制台 5~8 条错误。**根因已定位（2026-09-17）**：`bridge.ts:417` 的 `const base = deps.serve.baseUrl` 在 `switch` 前无条件执行，而该 getter 同步抛错 ⇒ 48 条 invoke 命令（含 **27 条不需 serve 的本地命令**，甚至包括用来探测就绪的 `getStatus`）全部连坐 |
| D-b | 图片/附件字节通道不存在 | `IMAGE_TRANSPORT_MISSING`，`SubmitMessagePayloadShape` 无图片字段，附件如实标 failed |
| D-c | `steeringAvailable` 恒 `true`、`pendingInteraction` 无数据源 | composer 的忙碌态与可转向态**是假的** |
| D-d | `subagent_continue` schema 恒带 `taskId` | **【2026-09-17 取证纠正：原述不准。`subagent.ts:297` 已有 `anyOf` 多选一必填（P1-1 已修），`:310` 执行期也如实报「后台任务协调器未装配」；真实缺陷应重述为「能力面声明与装配状态脉络」，**轻度、非阻塞级**】** 原登记：CLI 未装配 TaskCoordinator，**向模型暴露不存在的字段**，模型必踩误导性报错（`packages/core/src/agent/subagent.ts:284`） |
| D-e | 跨进程配置写入无锁 TOCTOU | **【2026-09-17 取证：确实存在，但 `models-config.ts:590-596` 已如实登记并发边界与影响面（仅覆盖对方配置、不丢 `auth.json` 密钥），修法只能是文件锁（core 冻结区）。**非隐瞒，不入 R1-D**】** 第二实例或 CLI 并发写 `config.json` 会丢更新 |
| D-f | **【2026-09-17 取证纠正：「未接线」不准—— `SidebarRoot.tsx:152` 已调用且有完整优先级表测试；缺口在上游数据源：`shell-seat-contents.tsx:65-71` 写死 `newSessionScope={{}}`（本仓无 Workspace 概念）。**不入 R1-D**】** 新会话作用域四级降级恒落「空白」 | `resolveNewSessionScope` 已就位但未接线（D-21） |

### 1.3 壳的体量差距（结构性事实）

| | harness2 `packages/desktop/src` | hermes `apps/desktop/src` |
| --- | --- | --- |
| 文件总数 | **106** | **1864** |
| renderer / app+components | 85 文件 / 426KB | app 674 文件 6.2MB + components 379 文件 2.2MB |
| 状态层 | 混在 renderer 内 | `store/` 257 文件 1.9MB |
| 主题 | 无独立主题层 | `themes/` 24 文件 149KB |
| 国际化 | 无 | `i18n/` 18 文件 1.2MB |
| 端到端测试 | 无 Playwright | 30+ `.spec.ts` + 33.8KB mock-server + 24.8KB fixtures |
| Electron 主进程 | 15 文件 125KB | 百余文件，含 backend-health / backend-ownership / backend-ready / bundle-skew / connection-registry(54KB) 等 |

**差距不只是量，是缺层：** harness2 没有独立的 store 层、主题层、i18n 层，也没有任何端到端证据。

### 1.4 真实特色（三项，全部被埋没）

1. **轨迹即测试夹具** —— `session/export.ts` + `trajectory/view.ts` + `replay`：逐字节幂等 ZIP 导出 + 零 API key 回放校验，可进 CI。Hermes 有 trajectory，但没有「导出物 = 可回放夹具」这个闭环。
2. **append-only 严格 undo 模型** —— `runtime.v1.jsonl` 单写者 + `rewind_points.jsonl` 标记式回退，**永不回改历史**。语义比常见的 rewind 实现更严格，是可审计的。
3. **双 TUI 抓屏对照台** —— `scripts/tui-parity/`（ConPTY + pyte + Pillow，18 场景矩阵逐格比对）。P10 靠它抓出 `/help` 渲染错位 P0（根因：换行符被当可打印字符写进单元格）。**这是个真硬核的验收工具，但只服务 TUI，没用到桌面。**

**结论：不是没有特色，是零包装、零演示、零对外叙述。** README 至今无一张截图。

---

## 2. 本轮范围

### 做

- 桌面形态（Electron）的核心能力补强与壳重做
- 必要时下沉到 `packages/core`（走解冻窗口，见 §5.2）

### 明确不做

- ❌ 三端统一、移动端、Web 壳增强（`packages/web` 冻结在当前最小壳）
- ❌ IM 网关（`packages/gateway` 本轮**零改动**）
- ❌ 整壳搬运 hermes renderer（理由见 §4.3.0）
- ❌ 发布动作（push / tag / npm）——仍需人类授权

---

## 3. P0 取舍与理由

评审列出 5 条 P0 候选，本轮**拿下 3 条 + 桌面阻塞级一组，降级 1 条，延后 1 条**。取舍理由如下（对项目负责，不贪多）：

| 候选 | 决定 | 理由 |
| --- | --- | --- |
| prompt caching 边界 | ✅ **本轮必做** | 经济性根基，不做则长会话不可用。成本中等，收益最高 |
| 重试之外的恢复 | ✅ **本轮必做** | 直接回答「是不是非常不稳定」。已有 retry-policy 打底，是**增量**不是重写 |
| provider 抽象重做 | ✅ **本轮必做** | 缓存断点与 token 分母都依赖模型元数据，与前两条同根，分开做会返工 |
| 桌面阻塞级 D-a~D-f | ✅ **本轮必做** | 六条里有四条让 UI **显示假状态或如实失败**，壳重做前不修 = 在假地基上砌墙 |
| SQLite 全量存储层 | 🔽 **降级** | 直接替换 JSONL 会冲撞红线 1（model-visible ⟺ logged）与红线 2（append-only 单写者），风险/收益不划算。**改为：JSONL 保持唯一真相源，SQLite 仅作派生索引**（会话列表 + FTS5 全文检索 + 可重建），放 R2 并行轨 |
| docker / ssh 终端后端 | ⏭ **延后 R4** | 是能力广度不是稳定性。桌面单机用户 day-one 不需要。做完 R1–R3 再评估 |

---

## 4. 阶段划分

```
R0 现状取证 ──→ R1 核心补强 ──→ R2 壳重做 ──→ R3 特色放大
  (0.5d)         (主体)          (主体)         (收口)
                    │
                    └─ R1-X 派生索引（并行子轨）
```

**串行约束：R2 不得在 R1 验收通过前启动。** 理由见 §3（假状态地基）。

---

### 4.1 R0 — 现状取证（前置，不可跳过）

**目标：** 用真机证据替换文档推断。**当前所有关于桌面端的判断都基于代码结构与 docs 自陈，没有一张截图。**

#### 子代理任务书 R0

| 任务 | 交付物 |
| --- | --- |
| R0-1 真机跑通桌面端 | `pnpm --filter @harness2/desktop dev` 启动，**全窗口截图 ≥8 张**（冷启动、空会话、对话中、工具卡、审批、轨迹页、模型配置页、设置页），落 `docs/screenshots/2026-09-17-baseline/` |
| R0-2 复现 D-a~D-f 六条 | 每条一份复现记录：操作步骤 + 控制台日志原文 + 截图。**不能复现的要明确标注「未复现」并说明尝试过程**，不许含糊 |
| R0-3 D-a 根因定位 | ✅ **已完成（2026-09-17）**。结论：三项候选里命中**后两项的叠加**—— `main.ts` 先同步 `registerBridgeIpc()` + `win.loadFile()`，**再**异步 `serve.start()`（IPC 面先于就绪开放）；叠加 `bridge.ts:417` switch 前的无条件 `const base = deps.serve.baseUrl`（同步抛错 getter）。就绪窗口 3~18s（采纳 3s + 健康检查 15s）。调用时序与 27 条被连坐命令清单见 `docs/issue-log/2026-09-17.md` §R0-3 |
| R0-4 基线数据 | 🟡 **部分完成（2026-09-17）**。✅ 全量 `pnpm test` = **3905 passed + 5 skipped，六包全绿**（ui-shared 70 / core 1232+2 / web 36 / gateway 40 / desktop 952+1 / cli 1575+2）；✅ renderer 构建 159 modules / **125ms**，产物 js 425.24kB（gzip 131.70）+ css 42.00kB（gzip 8.21）；✅ 无头冡烟 `{ok:true,rendererLoaded:true,bridgeReady:true,port:58285}`。⛔ **真实对话 token/延迟阻塞**：本地 40080 网关 `/v1/chat/completions` 对三个模型均 **502 upstream error**（`/v1/models` 为 200），故障在 `opencode2api` 背后的上游，**非 harness2 侧**。⚪ 待补：`pnpm -r build` 单独耗时、桌面冷启动到可交互毫秒数（需真机 GUI） |
| R0-5 hermes 壳契约提取 | ✅ **已完成（2026-09-17）**。`docs/refs/hermes-desktop/` 下落四件：`AGENTS.md`（原文副本）、`DESIGN.md`（原文副本）、`LICENSE`（MIT 全文）、**`PRIMER-zh.md`**（中文提要：7 条架构不变量 + 7 条设计原则 + z-index 梯子/取消语义/键盘所有权 + 「搬什么/不搬什么」落地表）。基线 commit `79445a4` |

#### R0 验收闸门（编排者执行）

- [ ] 截图 ≥8 张且能看清真实内容（非空白窗口、非 mock）—— **阻塞中**：需真机 GUI 会话，且「非 mock」要求被上游 502 卡住
- [ ] 六条缺陷每条有明确「已复现 / 未复现 + 理由」
- [x] D-a 根因有确定结论，不接受「疑似」—— 已定位到行（`bridge.ts:417` + `main.ts` 注册时序）
- [ ] hermes 契约提要准确（编排者抽查 3 条不变量对原文）

**R0 不通过则整个计划暂停重评。**

---

### 4.2 R1 — 核心补强

**冻结影响：** 全部落在 `packages/core`，必须走解冻窗口（§5.2）。预期导出面**纯加性**。

#### R1-A prompt caching 边界

| 项 | 内容 |
| --- | --- |
| 新增 | `packages/core/src/provider/cache-policy.ts` —— 缓存断点计算（system / tools / 历史前缀三段），provider 无关 |
| 改 | `provider/anthropic.ts` 注入 `cache_control: { type: 'ephemeral' }`；`provider/openai.ts` 保证请求前缀稳定（不在头部插入变动内容） |
| 不变量 | **每会话缓存边界神圣**：唯一允许破坏缓存的是上下文压缩。slash command、记忆注入、系统时间戳等**一律不得插在缓存前缀内** |
| 验证 | 连续 5 轮对话，从第 2 轮起 `cache_read_input_tokens > 0` 且随轮次单调增长；对照组（关闭策略）成本差 ≥50% |
| 埋点 | 真实缓存命中数回填到已有的 `cacheCreationInputTokens` 状态行字段（该字段目前无真实来源） |

> **给子代理的硬要求：** 必须写一条「缓存边界破坏检测」测试 —— 构造一轮注入了动态内容（时间戳）到 system 段的请求，断言测试**失败**。没有这条负向测试，视为未完成。

#### R1-B 重试之外的恢复

| 场景 | 要求行为 |
| --- | --- |
| 空响应 | 检测「无文本 + 无工具调用」→ 一次有界自纠重发（计入已有 retry budget），仍空则以明确错误终止，**不得静默产出空白 turn** |
| 工具调用畸形 | JSON 解析失败 / schema 不符 → 把结构化错误作为 tool result 回灌，最多 2 次自纠，超限升级为 turn 错误 |
| 上下文溢出 | 捕获 provider 的 context_length 类错误 → 触发就地分层压缩 → 重发一次。**这是唯一允许破坏缓存的路径**，须在日志中显式标记 |
| 流截断 | `stream_truncated` 保持整轮重发（续接需 provider 支持，本轮不做），但须在 UI 明示「已重发」而非静默 |
| 复用 | **不重写 `retry-policy.ts`**。新增 `interaction/turn-recovery.ts` 消费其预算与停因，禁止另起一套预算 |

#### R1-C provider 抽象

| 项 | 内容 |
| --- | --- |
| 新增 | `provider/model-metadata.ts` —— 上下文窗口、最大输出、能力位（缓存/推理/视觉/并行工具调用）、定价。**数据与代码分离**，元数据用独立 JSON 便于更新 |
| 改 | token 分母从 `DEFAULT_CONTEXT_WINDOW` 固定近似改为按模型查表（销号一条已登记技术债） |
| 新增 | 凭据池 + 轮换（同一 channel 多 key 轮询，429 自动切换），接现有 `config/auth.ts` |
| 不做 | Gemini / Bedrock / Vertex / Azure 本轮**不加**。只把抽象做对，留出接入位 |

#### R1-D 桌面阻塞级修复（D-a ~ D-f）

> **【2026-09-17 R0-2 取证后的范围收窄（权威，以此为准）】** 六条逐条做完代码级复现后：
>
> | 分批 | 项 | 理由 |
> | --- | --- | --- |
> | **首批（阻塞级）** | **D-a**、**D-c** | D-a 根因已定位到行；D-c 的能力**已实现、只缺接线**（`submit-policy` 已有 `steeringAvailable:false` 完整用例，但 `packages/desktop/src/**` 零处传该 prop），性价比最高且直接违反红线 10 |
> | **次批** | **D-b** | 需改提交协议 shape ⇒ 走 core 解冻窗口；验收必须真机一轮，**现被上游 502 阻塞** |
> | **加固项** | **D-d**、**R0-0** | 不影响用户可用性；D-d 改动在 core，性价比不如 D-c |
> | **不入 R1-D** | **D-e**（需文件锁，core 冻结区，已如实登记）、**D-f**（需先引入工作区概念，属 R3/P7） |
>
> **收益：** 按原登记会把三条「已如实登记 / 已修过 / 需前置概念」的项当成阻塞缺陷去改，会白耗一个子代理轮次并白动两次 core 解冻窗口。完整取证见 `docs/issue-log/2026-09-17.md` §R0-2。

| 缺陷 | 修复要求 |
| --- | --- |
| D-a | 按 R0-3 根因修，**三层缺一不可**：① 删掉 switch 前的 `const base`，改为只在走 HTTP 的分支内惰求；② 需 serve 的分支改 `await serve.whenReady(timeout)`（新增，复用现有 status/退避链），超时返回**带类型的** not-ready 结果而非抛错；③ `getStatus` 永不抛错，UI 走 connecting 态（红线 10）。**验收：连续 10 次冷启动 0 条 `serve 未就绪`；`port === null` 时 27 条本地命令逐条可用；变异验证（`const base` 改回 switch 前）必须变红** |
| D-b | 打通图片字节通道：`SubmitMessagePayloadShape` 加图片字段 → serve → provider 多模态。**核心红线：不得伪造成功**，provider 不支持视觉时须明示拒绝 |
| D-c | `steeringAvailable` 接真实来源；`pendingInteraction` 接 approval-queue。**恒真的假状态必须消灭** |
| D-d | `subagent.ts:284` **【降级为加固项，非阻塞级】** schema 按是否装配 TaskCoordinator 条件化 `taskId`。CLI 路径下该字段不得出现在给模型的 schema 里 |
| D-e | 配置写入加跨进程文件锁（**【已移出 R1-D ⇒ 顺延至 R4：需 core 冻结区的文件锁，且源码已如实登记边界与影响面】**（复用已有锁文件 0600 方案），读-改-写原子化 |
| D-f | 接线 `resolveNewSessionScope`，四级降级至少前两级（**【已移出 R1-D ⇒ 归 R3/P7：实测已接线，真正缺的是工作区概念作为上游数据源】**）要有真实数据源 |

#### R1-X 派生索引（并行子轨，可与 R1-A/B/C 同时进行）

- SQLite 作为**派生只读索引**：会话列表、FTS5 全文检索
- **JSONL 仍是唯一真相源**，索引可随时删除重建（须提供 `harness2 reindex` 且验证重建后结果一致）
- 销号：`session/searchIndex.ts` 的子串匹配检索
- **红线校验：** 此改动不得使 `runtime.v1.jsonl` 出现第二个写者

#### R1 验收闸门

六闸门（§5.1）之外追加：

- [ ] 缓存命中真机证据：5 轮对话的 usage 原始 JSON，第 2 轮起 `cache_read > 0`
- [ ] 缓存边界负向测试存在且有效（编排者手动破坏边界，确认测试变红）
- [ ] R1-B 四场景各有一条**变异验证**：注掉修复代码，对应测试必须红
- [ ] D-a 十次冷启动零错误（附录屏或十份日志）
- [ ] D-b 图片链路真机一轮：发一张图 → 模型正确描述内容
- [ ] 导出面 diff **0 removed / 0 kindChanged**（加性允许，须同步 `api-surface-baseline.json`）

---

### 4.3 R2 — 壳重做

#### 4.3.0 为什么不整壳搬运 hermes（决策记录）

评审明确否决「直接把 hermes 的壳换上来」，理由：

1. **协议不兼容。** hermes renderer 讲的是 Python 后端的 JSON-RPC（`tui_gateway/server.py` + `methods_*.py`）+ REST + WS，还绑定 connection-registry、profiles、bot mode、fleet、pairing、OAuth 一次性 ticket。harness2 的 serve 是另一套 HTTP/WS 帧契约，**且已冻结**。
2. **体量倒挂。** 整壳 = 移植 1864 个文件 + 写一层把 harness2 core 伪装成 hermes gateway 的适配器。**这个工作量大于重写 harness2 桌面端本身。**
3. **上游速度。** hermes 主干推进极快，整壳搬运等于永久 fork 一个高速移动的目标。
4. **许可。** MIT，法律上可行，但须保留 LICENSE 与署名 —— 这一条不是障碍，前三条才是。

**采纳路线：搬契约 + 搬主题组件，骨架自己重写。**

#### 4.3.1 从 hermes 搬什么

| 搬 | 具体 | 方式 |
| --- | --- | --- |
| ✅ 工程不变量 | `apps/desktop/AGENTS.md` 的 7 条：状态按权威归属、server truth 是缓存不是所有权、切换上下文是 re-home 不是 reboot、可观测降级阶梯、身份不可混淆、能力属于 session 不属于进程、尊重用户注意力 | 改写为 `packages/desktop/AGENTS.md`，作为桌面端宪法 |
| ✅ 视觉与交互契约 | `apps/desktop/DESIGN.md` | 提炼为 `docs/desktop-design-contract.md` + 检查清单 |
| ✅ 主题层 | `themes/` 的 token 体系与切换机制 | 移植结构，配色可自定 |
| ✅ 组件模式 | `components/` 中协议无关的那部分（列表虚拟化、流式文本、工具卡、差异视图、命令面板） | **按模式重写，不逐文件复制**，保留出处注释 |
| ✅ e2e 范式 | `e2e/` 的 mock-server + fixtures 结构 | 移植结构，接 harness2 的 serve 契约 |
| ❌ 不搬 | `store/`（绑 hermes 协议）、`plugins/`（另一套 ABI）、`sdk/`、`api/`、`i18n/`（本轮不做多语言）、connection-registry / bot mode / fleet / pairing | — |

#### 4.3.2 子代理任务书 R2

| 任务 | 内容 |
| --- | --- |
| R2-1 | 立宪：写 `packages/desktop/AGENTS.md`（7 条不变量，中文，对齐 harness2 现有红线不冲突） |
| R2-2 | 补 store 层：按「状态跟随权威」原则拆出 backend-truth 缓存 / electron 机器事实 / renderer 呈现态三类，消灭当前混在组件里的状态 |
| R2-3 | 补主题层：token 化，至少 2 套主题可切换，切换不闪屏 |
| R2-4 | 重写对话页：流式渲染、长会话虚拟化（**用真实长会话验证，空 demo 不算数**）、工具卡、审批卡、图片附件（依赖 R1-D/D-b） |
| R2-5 | 重写导航与会话列表：接 R1-X 的 FTS 检索；merge 而非 clobber 刷新；乐观更新 + 失败回滚 |
| R2-6 | 补 Playwright e2e：≥12 条 spec（冷启动、发消息、工具审批、取消、转向、图片、检索、主题切换、重连、断网降级、大会话恢复、关窗口） |
| R2-7 | 迁移对照台：把 `scripts/tui-parity/` 的抓屏对照能力扩展到桌面（Playwright 截图 + 像素 diff），形成桌面视觉回归基线 |

#### R2 验收闸门

- [ ] 六闸门全绿
- [ ] Playwright ≥12 条 spec 全绿，且**在 CI 里跑**（本地绿不算）
- [ ] 长会话性能：1000+ 消息会话滚动 60fps、输入无掉帧（附 profile 截图）
- [ ] 对照 `docs/desktop-design-contract.md` 检查清单逐条签字
- [ ] 与 R0 基线截图做前后对比，落 `docs/screenshots/2026-09-17-after/`
- [ ] **越界检查：** R2 不得改 `packages/core`（若必须，回到解冻窗口流程重走）

---

### 4.4 R3 — 特色放大（收口）

目标：把 §1.4 那三项从「埋在 docs 里」变成「一眼能看见」。

| 任务 | 内容 |
| --- | --- |
| R3-1 | **轨迹回放产品化**：桌面端加「导出轨迹 / 载入轨迹回放」入口，零 key 可回放他人会话。这是 hermes 都没有的闭环，是真卖点 |
| R3-2 | **可审计历史可视化**：把 append-only + rewind 标记做成时间线视图，展示「历史永不被改写」 |
| R3-3 | **README 重写**：三张真机截图（对话 / 轨迹回放 / 审批）+ 60 秒 GIF + 一句话定位。当前 README 零截图是最大的自我伤害 |
| R3-4 | **版本号纠正**：六包当前全是 `1.0.0`，与实际成熟度严重不符。建议回退到 `0.x` 并在 `docs/API-STABILITY.md` 说明。**这是诚信问题，不是面子问题** |
| R3-5 | 文档收口：更新 `HANDOFF.md`、`docs/issue-log/OPEN.md`、`ROADMAP.md`，销号本轮已修条目 |

---

## 5. 通用纪律

### 5.1 六闸门（每阶段每次交付都必须过）

1. `pnpm lint` 0 error + prettier 全绿
2. `pnpm -r typecheck` 0 error
3. `pnpm test` 全量通过（不允许新增 skip）
4. `pnpm -r build` 全绿
5. 越界文件 0（改动不得溢出本阶段声明的包范围）
6. `packages/core/test/fixtures/api-surface-baseline.json` diff：**0 removed / 0 kindChanged**（加性须同步快照）

更新导出面快照：

```
H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts
```

### 5.2 冻结与解冻窗口

`packages/core/**` 与 `packages/gateway/**` 自 2026-09-11 契约冻结（冻结 commit `3c9b31f`）。

- **R1 全程在解冻窗口内作业**，由编排者开 `fix/*` 或 `feat/phase-r1-*` 分支统一管控
- 子代理**不得**自行改 core/gateway，也不得复制逻辑绕过
- 窗口关闭条件：三平台 CI 全绿 → `--no-ff` 合入 main
- `packages/gateway` 本轮**零改动**

### 5.3 子代理规约

- 不自行开分支、不 force push、不在 main 上试错
- **引用实现行为前必须先 `pnpm -r build`** —— P7 审查曾对过期 `dist/tools/script.js` 误报 vm 沙箱逃逸 P0，此教训必须遵守
- 每个任务交付必须附：改动文件清单、六闸门输出、**变异验证证据**（注掉修复代码，对应测试必须红）
- 无法完成的项目必须明确标「未完成 + 原因」，**不许用含糊措辞掩盖**
- 涉及真机的项目不得用 mock 冒充

### 5.4 不可动摇的红线（`CODE_REVIEW.md` 八条，本轮追加两条）

沿用原八条，另加：

9. **缓存边界不得被非压缩路径破坏**（R1-A 引入）
10. **UI 不得显示假状态**（恒真的 `steeringAvailable` 这类问题不许再出现）

---

## 6. 验收总表

| 阶段 | 关键验收物 | 编排者签字 |
| --- | --- | --- |
| R0 | 8+ 真机截图、6 条缺陷复现记录、D-a 根因、hermes 契约提要 | ⬜ |
| R1 | 缓存命中 usage 原始证据、4 场景变异验证、10 次冷启动零错误、图片链路真机一轮、导出面加性 | ⬜ |
| R1-X | reindex 重建一致性验证、单写者红线未破 | ⬜ |
| R2 | 12+ Playwright spec 在 CI 绿、长会话 60fps profile、设计契约清单、前后对比截图 | ⬜ |
| R3 | README 三图 + GIF、轨迹回放桌面入口可用、版本号纠正 | ⬜ |

---

## 7. 风险登记

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| R1 需大量改 core，与冻结纪律冲突 | 高 | 编排者统一开窗口，单点管控；坚持纯加性 |
| 无可用 API key 导致真机验证阻塞 | 高 | R0-4 提前暴露；无 key 则 R1 缓存验收顺延，**但不得用 mock 冒充通过** |
| R2 重写对话页引入回归 | 中 | 先补 e2e（R2-6 前置于 R2-4 的验收）再重写 |
| 已存在两条未 push 分支（P10/P11） | 中 | **R0 启动前必须先处理**，否则基线不明。见 `2026-09-15-p12-backlog.md` §A |
| 子代理夸大完成度 | 中 | 变异验证 + 编排者抽查实现，不看自述 |
| hermes 上游变更 | 低 | 只搬契约与模式，不跟踪代码 |

---

## 8. 启动前置

R0 开始前必须完成：

- [ ] 处理 `feat/phase-p10-next-only` 与 `feat/phase-p11-tui-polish` 两条未 push 分支（需人类授权）
- [ ] 确认工作树干净、`main` 与 origin 同步
- [ ] 确认至少一个 provider 的可用 API key（否则 R1 验收顺延）

---

## 附录 A：参照物索引

| 内容 | 路径 |
| --- | --- |
| hermes 桌面工程指南 | `refs/hermes-agent/apps/desktop/AGENTS.md` |
| hermes 桌面设计契约 | `refs/hermes-agent/apps/desktop/DESIGN.md` |
| hermes 错误分类 | `refs/hermes-agent/agent/error_classifier.py` |
| hermes turn 恢复 | `refs/hermes-agent/agent/turn_recovery.py` |
| hermes 上下文压缩 | `refs/hermes-agent/agent/context_compressor.py` |
| hermes 模型元数据 | `refs/hermes-agent/model_metadata.py` |
| hermes 终端环境 | `refs/hermes-agent/tools/environments/` |
| 既有对标矩阵 | `docs/refs/refs-hermes-agent.md`（54 条 H-） |

> 参照仓为本机完整副本，**不依赖网络**。历史上 `refs-hermes-agent.md` 基于旧快照 `79445a4`（当时 fetch 失败），本轮可直接对新副本取证。
