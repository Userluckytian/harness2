# 阶段 15-质量收口 · 代码审查任务书（专职审查者 丙）

> **状态：** 就绪（2026-09-09），待审查者认领
> **总纲（必读在先）：** `docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md`
> **被审对象：** 轨道 A `…-track-a.md`（甲）、轨道 B `…-track-b.md`（乙）
> **结论落盘：** `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md` 第 5 节
> **元规范：** `docs/ai-framework/phased-plan-driven.md`（§4.2 阶段级代码审查在验收前）
> **本文件是自包含的**：零上下文可读，不需要先了解项目历史。

---

## 0. 角色与三条铁律

你是本阶段的**专职代码审查者**，不写业务代码。甲、乙并行开发，你在他们各阶段合入前做人工审查并把结论落盘。设专职审查者的原因：避免「实现者自评全绿」，也避免甲乙互审时互相放水或被对方进度拖住。

| # | 铁律 | 含义 |
|---|------|------|
| 1 | **只读** | 不改代码、不「顺手修一下」、不提交到甲乙分支、不 push、不打 tag。发现问题只写报告，由对应执行者自己改 |
| 2 | **不接受「应该能过」** | 任何声称通过的测试/验证，你必须自己重跑并贴真实输出 |
| 3 | **不碰真实环境** | 不读写 `~/.harness2/auth.json`（真 API key）、不改人类全局配置与审批模式、不执行 `npm publish` / `git tag` / `git push` |

---

## 1. 项目速览

harness2：本地优先的 AI coding agent 工具链。pnpm monorepo + TypeScript + vitest。

| 包 | npm 名 | 内容 |
|----|--------|------|
| `packages/core` | `@harness2/core` | 全部核心逻辑：agent 循环、provider、工具执行、会话持久化、审批、记忆、MCP、插件、HTTP/WS server |
| `packages/cli` | `harness2` | 终端界面 |
| `packages/desktop` | — | Electron 桌面端 |
| `packages/gateway` | — | IM 网关 |

规模约 232 个 TS 文件 / 46000 行（含测试）。core 测试基线 **789 passed + 1 skipped**。pnpm@11.13.0，Node >= 22。开发机 Windows 10 / PowerShell 5.1：**命令分行写，不要用 `&&` 串联，每条查 `$LASTEXITCODE`**。

仓库根常用命令：

| 命令 | 用途 |
|------|------|
| `pnpm -r typecheck` | 全包类型检查 |
| `pnpm test` | 构建 + 全部测试（主闸门） |
| `pnpm build` | 仅构建 |
| `pnpm lint` | 乙在 B2 新增；若不存在说明 B2 未完成 |

---

## 2. 环境准备（只读工作树）

**前提：** 本仓库本地 `main` 长期领先 `origin/main` 且默认不 push。甲的 A0 第一件事就是 push 备份，在那之前远端拿不到本阶段代码。所以：

- 若甲已完成 A0：`git fetch --all` 后按下面建工作树。
- 若尚未 push：在开发机上操作，或让对方先推分支。

```
git -C <仓库路径> worktree add --detach ../harness2-review <commit 或分支>
cd ../harness2-review
pnpm install
pnpm -r typecheck
pnpm test
```

审完一批用 `git worktree remove ../harness2-review` 清掉。**别在主工作树切分支**（会打断开发者）。只看差异时更省事：`git log --oneline main..<分支>`、`git diff main...<分支> --stat`、`git show <commit>`。

---

## 3. 必读文件（按顺序，约 40 分钟，别跳）

| # | 文件 | 为什么 |
|---|------|--------|
| 1 | `…-phase-quality-closeout.md` | 总纲：分工、目录归属、同步点、审查窗口、全局约束 |
| 2 | `…-track-a.md` | 甲的任务书 A0–A5 |
| 3 | `…-track-b.md` | 乙的任务书 B1–B6 |
| 4 | `…-acceptance.md` | 你要填的验收登记表 |
| 5 | `AGENTS.md` | 仓库总规约、提交信息格式 |
| 6 | `CODE_REVIEW.md` | 现有审查清单（注意 B4-2 会给它补专属红线，届时你要判断补得对不对） |
| 7 | `coding-standards.md` | 编码规范（「项目专属约定」整节现为空白模板，B4-1 要填实） |
| 8 | `architecture.md` | 443 行，架构与不变量的权威来源 |
| 9 | `docs/issue-log/OPEN.md` | 未决问题清单（B1 会拆成 OPEN.md + DECISIONS.md） |

**判断标准优先级：** 本阶段计划 > `architecture.md` > `AGENTS.md` / `coding-standards.md` > 个人偏好。你的个人风格偏好只能记 P2，不得用来阻塞合并。

---

## 4. 不变量红线 —— 违反任意一条即 P0

这是本项目的地基，比通用代码规范重要得多。

1. **Model-visible ⟺ logged**：凡进入模型上下文的内容必须落进会话日志，反之日志里不该有模型没见过的东西。看新增的错误提示、工具输出、截断/降级路径两边是否一致。
2. **会话日志 append-only + 单写者 + fsync**：`session.v1.jsonl` 只追加，不原地改写、不重排、不删行；同一会话只能一个写者。任何「修正历史」的写法都是 P0。`rewind` / `marker` 是靠**投影**实现的，不是删除。
3. **redo 的中立化语义**：redo 依赖 `reason` 字段以 `redo` 前缀中立化 `rewindToSeq+1`。动这块要格外小心。
4. **文件快照的范围边界**：快照写在 `rewind_points.jsonl`（`{v, seq, file, before, after}`）。**bash 工具的副作用不进快照**——这是有意设计，不是缺陷。「顺手把 bash 也纳入快照」是 P0；文档或提示语暗示 bash 可回滚是 P1（误导用户）。
5. **core 与 UI 解耦**：core 不得反向依赖 cli/desktop。
6. **密钥不得泄漏**：密钥在 `~/.harness2/auth.json`（`channels.<id>.apiKey`）或环境变量 `envKey`。日志、报错、trajectory、`config check` 输出里出现明文 key 或可拼出 key 的片段 = P0。
7. **审批机制不得弱化**：工具审批（y/a/n）是安全边界。新增工具或执行路径绕过审批队列 = P0。
8. **导出面快照必须同步**：`@harness2/core` 有 372 个导出被 `test/api-surface.test.ts` 钉死。改导出面必须**在同一提交内**更新 fixture：
   `H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`
   fixture 变了却没说明原因 = P1；导出面改动与 fixture 更新分在两个提交 = P1。
9. **阶段 14 已冻结契约不得修改**：`submit` / `resumeSubscription` / `approval` / `cancel` / `task` / `steer`、`protocolVersion=2`、`runtime.v1.jsonl`。
10. **其他硬数值**（要么保持，要么在计划里有明确依据）：HTTP 帧上限 1 MiB；`importReplay` 解压上限 256 MiB；导出幂等固定 mtime `2000-01-01`；记忆 `MEMORY.md` 2200 字符 / `USER.md` 1375 字符，mode 三态 `off|ask|auto`，pending 上限 200；重试策略单次最多 +3 次（2/10/30s 指数+抖动）、整 turn 最多 +6 次且 ≤120s，且 401/403/参数错/quota/用户取消/用户拒绝/内容过滤一律不重试。

---

## 5. 审查窗口（与总纲一致）

| 时机 | 审查对象 | 阻塞合入 | 说明 |
|------|----------|----------|------|
| Day 1 上午 | 读文档、建只读 worktree、跑出自己的基线 | — | 与 S0 并行 |
| Day 1 傍晚 | A0、B1 | **否（事后核）** | S0 当天必须合入否则两轨开不了工；重点只核 B1「只搬不删、零信息丢失」 |
| Day 3 | **A1** | 是 | 最细一批；A1 不过则同步点 S1 不成立，乙不得格式化 `packages/core/**` |
| Day 4–5 | B3 | 是 | 零行为变更 |
| Day 6 | **A3**、B2 | 是 | 安全类最严 |
| Day 7 | A4、A5、B4、B5 | 是 | 拆分与文档 |
| Day 7 末 / Day 8 | 联合验收 J-1～J-6 | 阻塞发布 | 唯一需要两轨都完成的一批 |

**SLA：** 对方声明「完成待审」后 24 小时内出结论。P0 立即直达执行者，不要只写文档。总投入约 4 个半天。

---

## 6. 逐批审查清单

### A1 · Windows 可用性 P0（最重要）

**背景：** bash 工具用 `spawn(command, {shell:true})`，Windows 上落到 cmd.exe，`ls`/`head`/`tail`/`pwd` 全部失败，agent 反复重试烧完 25 步 `maxSteps` 后**空回复**收场。案发会话 `20260907-032949-546d13`（任务「检索今日 3 件时政要闻」），同会话还有 `write` 工具漏传 `file_path` 的连带问题。

- [ ] shell 探测顺序为 `config.bash.shell` > Git Bash（`GIT_BASH` 环境变量 / 常见安装路径）> cmd 回退；找不到时报错人类可读，不是静默降级
- [ ] `harness2 doctor` 输出**实际选中**的 shell（而非配置里写的）
- [ ] 输出统一按 UTF-8 解码（Windows 控制台默认 GBK）；**乱码不得进模型上下文**
- [ ] 熔断语义：`maxSteps` 之外新增「连续工具失败上限」（建议 5）；触发时 `stopReason=tool_failures` 且**必须产出非空 finalText**。熔断路径仍可能返回空 finalText = P0（这正是本次要修掉的症状）
- [ ] **边界正确**：A1-3 的「连续失败熔断」与底座 `interaction/retry-policy` 的「有界重试」是两套独立机制；落点应在 `loop.ts` / turn 组装层，**不改 `interaction/` 公共契约**。改了就是越界，P0
- [ ] 缺必填参数时 error 带 schema 片段 + 最小正确示例
- [ ] `browser_*` 未安装 chromium 时提示指向 `harness2 browser install`
- [ ] **回归红线**：超时/取消时 Windows 下用 `taskkill /T /F` 做**进程树**击杀，不得退化成只杀父进程
- [ ] 新增测试全 mock/stub、零 API key、CI 可跑：Git Bash 命中 / 缺失时回退且错误可读 / 中文与 emoji 不乱码（**要构造 GBK 环境，不能只在 UTF-8 下测**）/ 连续 5 次失败熔断且 finalText 非空 / 缺参 error 含示例
- [ ] `tools.test.ts`、`loop.test.ts` 无回归

### A3 · serve 安全加固（要求最严）

**背景：** HTTP/WS 只监听 127.0.0.1，但**无鉴权、无 Origin/Host 白名单**，本机任意进程（含浏览器里的恶意页面）都能驱动 agent 执行工具。OPEN.md 里挂着「M2 发布前项」，已顺延到 M4。

- [ ] Origin/Host 白名单 + 启动时一次性 token；CLI 与桌面端自动携带
- [ ] **反向确认：别把自己人挡在门外**。加固后本机 CLI、桌面端仍能正常连接与对话，必须有实测证据，不能只看单元测试
- [ ] WS 帧上限对齐 HTTP 的 1 MiB，超限断连并记账
- [ ] playwright 从 runtime dependency 改为 `optionalDependencies` 或运行时动态 import；未安装时 `browser_*` 走既有降级路径，且 `import @harness2/core` 不报错（bundle 侧已有 `--external:playwright`，注意不要冲突）
- [ ] 测试：跨 Origin 被拒 / 无 token 被拒 / 超大帧断连 / 无 playwright 环境导入正常
- [ ] token 不出现在日志、报错、trajectory 里

### A4 · `server/sessions.ts` 拆分（73KB → <25KB）

- [ ] **纯搬运、零行为变更**；要求对方提供拆分前后同一组测试的结果对比
- [ ] 有无夹带「顺手优化」？夹带即 P1，要求拆成单独提交
- [ ] 导出面变化是否同一提交同步 fixture
- [ ] 一次只拆一个文件，每次全量 `pnpm test` + `pnpm -r typecheck`

### A5 · 阶段 9 网关复审（曾判 fail、修复后从未复审）

- [ ] `startGateway` 生命周期（重复启动、异常退出、资源释放）
- [ ] 断线重连后重新订阅是否完整
- [ ] `msg_seq` 严格递增、无重复无跳号
- [ ] 结论按 `/accept-phase` 四段格式落盘

### B1 · OPEN.md 拆分（事后核）

- [ ] **只搬不删**：迁入 `DECISIONS.md` 的条目保留原文与日期，逐段核 diff 确认零信息丢失
- [ ] 留在 `OPEN.md` 的条目逐条确认都是真待办

### B2 · lint/CI 基建 + 全量格式化

- [ ] `🎨style` 格式化提交**不得夹带任何逻辑改动**——抽查若干文件 diff
- [ ] 规则合理性：首轮只把未使用变量、`any` 泄漏、floating promise 等设 error；**存量正常代码不得因新规则误标红**，新规则先 `warn` 后收紧
- [ ] 同步点遵守：core 格式化晚于 A1 合入 main；全量格式化在 S2 窗口内
- [ ] CI 里 lint 是必过项且为绿

### B3 · cli / desktop 拆分（39KB、31KB → 各 <20KB）

- [ ] 同 A4：纯搬运、零行为变更、前后测试对比
- [ ] CLI 主要子命令手工走一遍；桌面端 smoke 通过
- [ ] 若动到 core 导出面，同一提交更新 fixture

### B4 · 规范文档

- [ ] `coding-standards.md` 的「项目专属约定」内容与**实际命令一致**——亲自跑一遍写进去的命令，**写错命令 = P1，比空白更坏**
- [ ] `CODE_REVIEW.md` 新增红线覆盖：四条不变量、密钥脱敏、快照范围（bash 副作用不入快照）、审批不得弱化、导出面快照同步
- [ ] 插件边界声明**如实**：v1 插件是同进程、非隔离，manifest 权限只是 API 层约束。任何暗示「有沙箱 / 已隔离」的措辞 = P1（安全误导）

### B5 · 文档欠账

- [ ] 补的阶段 5/6/8 验收有没有把「当时按档位跳过（未执行 ➖）」写成「已通过 ✅」——这是造假，P0
- [ ] README 截图真实反映当前 UI，HTML 占位注释已删净
- [ ] `docs/HANDOFF.md` 能支撑零上下文接手

---

## 7. 每批都要过的通用维度

- [ ] **错误处理**：失败路径可观测、错误信息可自纠、无静默 catch 吞异常
- [ ] **取消与超时**：新增异步路径能被取消，不泄漏进程/句柄/监听器
- [ ] **并发**：会话写入仍是单写者，无竞态
- [ ] **边界值**：空输入、超长输出（截断策略）、非 ASCII（中文/emoji）、路径含空格与反斜杠
- [ ] **跨平台**：Windows 路径分隔符、行尾（仓库目前无 `.gitattributes`，注意 CRLF 噪音）
- [ ] **提交规范**：`<gitmoji><type>(<scope>): <中文描述>`；小步提交；只显式 `git add` 本任务文件，**出现 `git add -A` 直接记 P1**
- [ ] **一次提交只做一件事**：重构与功能不混在一个提交

---

## 8. 「自证造假」专项核查（本项目最容易出问题的地方）

执行者会自己声明「测试通过」，你要验的是**这个声明本身**站不站得住：

- [ ] 测试**真实命中 >0 个用例**。空跑、被 skip、名字写错导致 0 命中，都算无效
- [ ] 有无 `--passWithNoTests` 之类造出的假绿？出现即 **P0**
- [ ] 有无把断言改松、把失败用例注释掉、把 `expect` 改成 `toBeDefined` 来「修好」测试？**P0**
- [ ] 声明的通过数与基线（core 789 passed + 1 skipped）对比，**只增不减**；减少必须有解释
- [ ] 有无把「需真实 API key 的验证」用 stub 冒充完成？A2 三端真机只能由人类用真 key 做，**stub 通过 ≠ 真机通过**，冒充即 P0
- [ ] 贴出的「输出」是不是真跑出来的？可疑就自己重跑对比

---

## 9. 严重度定义

| 级别 | 判定 | 处理 |
|------|------|------|
| **P0** | 破坏第 4 节任意不变量 / 安全问题 / 数据丢失或损坏 / 造假绿 / 把自己人挡在门外之类可用性硬伤 | **阻塞合并**，立即直达执行者 |
| **P1** | 行为回归、测试无效或覆盖缺失、文档与实现不一致、提交规范违规 | **本阶段必修** |
| **P2** | 命名、可读性、非必要优化、个人风格偏好 | 记录，不阻塞 |

P0/P1 必须清零才算通过。

---

## 10. 输出格式（每批一份）

**结论只写三种之一：** ✅ 通过 / ⚠️ 有条件通过（附必改项）/ ❌ 不通过（附阻塞项）

问题清单用这张表，**每条必须能指到具体文件行**，「感觉不太好」不算问题：

| 编号 | 严重度 | 文件:行 | 问题 | 证据（命令 + 真实输出） | 建议改法 |
|------|--------|---------|------|--------------------------|----------|
| | | | | | |

还要附上你自己重跑的证据：`pnpm -r typecheck` 结果、`pnpm test` 结果（贴通过数与耗时并与基线对比）、`pnpm lint` 结果（B2 之后）、安全类另附实测命令与输出（如跨 Origin 请求被拒的实际返回）。

---

## 11. 结论落盘位置

> ⚠️ **重要：`docs/issue-log/<日期>.md` 不入库**（`.gitignore` 已忽略 `docs/issue-log/*`，仓库内只跟踪 `OPEN.md` 与 `README.md`）。它只是本机留痕，**别人看不到**。凡是需要跨人可见的结论，必须写进入库文件。

1. **摘要（必须）** → `…-acceptance.md` 第 5 节「代码审查结论登记」：把该行「人工审查方」填成你的名字，写结论、P0/P1 是否清零、日期。
2. **详细问题清单** → 本机 `docs/issue-log/<日期>.md` 的 `## 代码审查` 二级标题下（与 `## 轨道A` / `## 轨道B` 分区并列，只追加不重排）。**同时把 P0/P1 的要点摘进 acceptance 第 5 节或第 6 节**，否则等于没记录。
3. 每条记录带四要素：**现象 / 定位 / 处理 / 验证方式**。
4. **发现 P0 立刻直接找执行者**，不要只写文档等人看。
5. 判 ❌ 不通过的项，同时写进 `…-acceptance.md` 第 6 节「不通过项与下放」，它会被带到下一阶段（R2 终端/桌面）计划开头优先处理。
6. 待办与决策类结论交给乙同步进 `OPEN.md`（他是唯一维护人）。

---

## 12. 你不需要做的事

- ❌ 三端真机验证（需真 API key，人类负责）
- ❌ 发布相关操作（`npm publish`、`git tag`、配置 `NPM_TOKEN`）
- ❌ 改代码、提交到甲乙分支、push
- ❌ 评估「该不该做这个阶段」——范围已定，你只审执行质量

---

## 给审查 AI 的完整提示词（可直接复制）

```
你是 harness2「阶段 15-质量收口」的专职代码审查者，不写业务代码。仓库 D:/AI_Projects/harness2。

先完整读：
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md（本任务书，最重要）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md（总纲：分工/同步点/审查窗口/全局约束）
- 被审那一轨的任务书（track-a 或 track-b）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md（你要填第 5 节）
- AGENTS.md、CODE_REVIEW.md、architecture.md、coding-standards.md

铁律：
- 只读。不改代码、不提交到他人分支、不 push、不打 tag、不 npm publish。
- 不读写 ~/.harness2/auth.json，不改人类全局配置与审批模式。
- 不接受「应该能过」：声称通过的测试必须自己重跑并贴真实输出。
- 用 git worktree add --detach 建只读工作树，别在主工作树切分支。
- 命令用 PowerShell 5.1 分行（不连 &&），每条查 $LASTEXITCODE。

判定优先级：本阶段计划 > architecture.md > AGENTS.md/coding-standards.md > 个人偏好。
个人风格偏好只能记 P2，不得阻塞合并。

P0（阻塞）判定：破坏四条不变量（Model-visible⟺logged / 会话日志 append-only 且单写者 /
core 与 UI 解耦 / 文件快照独立于 git 且 bash 副作用不入快照）、密钥泄漏、审批被弱化、
修改阶段 14 冻结契约、安全问题、数据丢失、造假绿（--passWithNoTests、改松断言、注释掉失败用例、
stub 冒充真机验证）、熔断路径仍可能空回复。
P1：行为回归、测试无效或覆盖缺失、文档与实现不一致、提交规范违规（如用了 git add -A）、
coding-standards 写错命令、插件边界声明暗示有沙箱、导出面改动与 api-surface fixture 不同提交。
P2：命名、可读性、非必要优化。

每批产出：结论（✅通过 / ⚠️有条件通过 / ❌不通过）+ 问题表（编号|严重度|文件:行|问题|证据|建议改法）
+ 自己重跑的 pnpm -r typecheck / pnpm test / pnpm lint 真实输出，并与 core 基线 789 passed + 1 skipped 对比。
每条问题必须指到具体文件行。

落盘：摘要填 acceptance.md 第 5 节（含你的名字、结论、P0/P1 是否清零、日期）；
详细清单写本机 docs/issue-log/<日期>.md 的「## 代码审查」小节——注意该文件不入库、别人看不到，
所以 P0/P1 要点必须同时摘进 acceptance 第 5/6 节。判 ❌ 的项写进第 6 节「不通过项与下放」。
发现 P0 立即直接通知执行者，不要只写文档。

不做：三端真机验证（需真 key，人类负责）、发布操作、改代码、评估阶段范围。
```

---

## 残留说明

1. 丙缺位时才回退为甲乙互审，并在 `…-acceptance.md` 第 5 节注明「回退互审」。
2. 本阶段结束后，本任务书可作为后续阶段（R2 终端 T0–T5 / 桌面 D0–D6）审查任务书的模板，只需替换第 6 节逐批清单。
