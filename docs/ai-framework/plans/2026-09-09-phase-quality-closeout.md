# 阶段 15-质量收口：1.0 发布与 R2 开工前欠账清理（单人顺序执行）

> **状态：** 计划已就绪（2026-09-09 · v2，由双轨并行改为**单人顺序执行**），待执行者认领
> **来源：** 2026-09-09 全仓静态审计；对照 `CODE_REVIEW.md`、`coding-standards.md`、`docs/issue-log/OPEN.md`、`docs/HANDOFF.md`、`docs/RELEASE-CHECKLIST.md`
> **角色：** 本文件是**唯一计划文件**——背景、约束、执行顺序、12 个任务细节、验收总表全在这里，从上往下读一遍就能开工。
> **配套文档（只有两份）：**
> - 验收与证据登记：`docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`（你要往里填证据）
> - 代码审查任务书：`docs/ai-framework/plans/2026-09-09-phase-quality-closeout-review-brief.md`（给专职审查者，执行者不必细读）
> **已删除：** `…-track-a.md` / `…-track-b.md`（双轨并行方案，2026-09-09 人类决定改单人后已合并进本文件并删除。任务编号 **A0–A5 / B1–B6 原样保留**，与 acceptance 表格一一对应）
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 在 R2 激进-终端（T0–T5）与激进-桌面（D0–D6）大规模开工、以及 v1.0.0 正式发布之前，清掉四类欠账：**Windows 可用性 P0**、**真实模型端到端零验证**、**serve 发布前安全加固**、**工程规范与文档空账**。
**Architecture：** 不引入新架构。全部为既有模块内的修复、加固、等价拆分与文档补齐。
**Tech Stack：** TS · vitest · pnpm workspace · ESLint(flat) + Prettier（本阶段新引入）
**实施档位：** 全能（开发 + 测试 + 代码审查）。其中 A2 真机验证、B6 发布属**豪华档端到端**，由人类执行，**永远不交子代理**。
**测试环境（人类已提供，A2 不再卡 key）：** 本地统一网关 `http://127.0.0.1:40080/v1` · key `sk-unified-local` · 模型 `big-pickle`（200K 上下文、**纯文本模型**）。2026-09-09 实测：OpenAI 兼容 `/v1/chat/completions` 与 Anthropic 原生 `/v1/messages` **两条协议均 200 且 SSE 正常**，配置写法与 baseUrl 陷阱见任务 5（A2）。
**子代理：** 启用（代码审查 + 验收）。人工审查由**专职审查者**承担（任务书见 `…-review-brief.md`）；审查者缺位时回退为「自评 + 只读子代理」，并在 acceptance 第 5 节注明「无独立人工审查」——这是降级，必须写明。
**基线：** 代码基线 = `main` tip `d38fc4a`（工作树干净），其后只有计划文档的 `📝docs` 提交，不含任何代码改动。仓库 `D:/AI_Projects/harness2`。
**工期：** 约 12 个工作日（单人，不含审查者的等待时间）。

### 为什么改成一个人做（2026-09-09 决策记录）

原方案是双轨并行（约 8 天），代价是 3 个强制同步点 + 目录归属表 + 交界文件三条硬规则。复盘后确认：**12 个任务里真正互斥的只有 B2 的全量 Prettier 格式化**——它会碰到仓库里几乎每个文件，与进行中的逻辑改动（A1 改 tools/agent、A4 拆 73KB 的 `sessions.ts`）相撞时，git 三方合并退化成逐行人肉挑拣，而且拆分类改动的 diff 会被格式化噪音淹没、没法审。

并行只省约 4 天，却要全程维护同步点与归属规则。改单人后：

- **同步点全部取消**，冲突的两件事天然有了先后。
- **B2 提到最前面做**（执行顺序第 3 位，在任何逻辑改动之前）：趁代码没动先一次性格式化干净，后面每个提交的 diff 都清爽。
- 唯一保留的硬约束只剩一条：**全量格式化独占一个 `🎨style` 提交，不掺任何逻辑改动**。
- 若将来要恢复并行，只需守住这一条 + 「格式化窗口期间别人不提交」。

---

## 前置阅读

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件 + `…-acceptance.md` |
| P0 | `AGENTS.md`、`CODE_REVIEW.md`、`docs/ai-framework/phased-plan-driven.md` |
| P0 | `docs/HANDOFF.md`、`docs/issue-log/OPEN.md`（31KB，任务 2 要拆它） |
| P0 | `packages/core/src/tools/`（bash / executor / 内置工具）、`packages/core/src/agent/loop.ts` |
| P0 | `packages/core/src/server/{http.ts,ws.ts,sessions.ts}` |
| P0 | `packages/core/src/provider/{openai.ts,anthropic.ts,factory.ts}`、`packages/core/src/config/schema.ts`（A2 要用：协议路径拼接与 providers/roles 校验） |
| P1 | `architecture.md`（443 行，不变量权威来源）、`coding-standards.md`（重点看「项目专属约定」空白节）、`docs/API-STABILITY.md` |
| P1 | `packages/cli/src/index.ts`、`packages/desktop/src/renderer/App.tsx` |
| P1 | `docs/ai-framework/plans/2026-09-08-phase-aggressive-core-foundation.md`（下游 R2 底座契约，**只读，不改**） |
| P2 | `docs/RELEASE-CHECKLIST.md`、`docs/MIGRATION.md`、`docs/issue-log/2026-09-07.md`（Windows 空回复案发记录）、`docs/diary/2026-09-06.md`、`2026-09-07.md`（release note 素材） |

---

## 阶段地图

| 位置 | 内容 |
|------|------|
| 上游 | 阶段 1–12（v1.0.0 物料就绪，发布待授权）；阶段 14 共享底座 S0–S7 已验收合并 main |
| **本阶段** | 质量收口：12 个任务，一人顺序做完 |
| 下游 | R2 激进-终端 T0–T5、激进-桌面 D0–D6；v1.0.0 正式发布 |
| 明确不做 | ❌ T/D 两轨任何新交互功能 ❌ 修改共享底座已冻结契约 ❌ 架构重构（只做行为等价的文件拆分）❌ 新增依赖，除 lint/format 工具链 |

---

## 执行顺序（照这张表从上往下做，别跳）

| # | 任务 | 预计 | 为什么排在这个位置 |
|---|------|------|--------------------|
| 1 | **A0** 仓库卫生与基线 | Day 1 上午 | 先把基线数字记下来，后面所有「全绿」都跟它比 |
| 2 | **B1** OPEN.md 拆分 | Day 1 下午 | 后面每个任务都要往 OPEN.md 里写结论，先把它理顺 |
| 3 | **B2** lint/format + CI + 全量格式化 | Day 2 | **趁代码还没动**一次性格式化完，之后所有 diff 都干净；这是全阶段唯一的排他任务 |
| 4 | **A1** Windows 可用性 P0 | Day 3–5 | 全阶段最高优先级，产品当前最痛的 bug |
| 5 | **A2** 真实模型端到端验证 | Day 6 | 环境已就绪；放在 A1 之后，才能顺带验证 Windows 修复的真机效果 |
| 6 | **A3** serve 发布前安全加固 | Day 7–8 | 发布前必须的安全基线 |
| 7 | **A4** core/server 大文件拆分 | Day 8–9 | 必须在 A3 之后，避免拆分与安全改动混在一起没法审 |
| 8 | **B3** cli / desktop 大文件拆分 | Day 9–10 | 与 A4 同性质，连着做手感一致，审查者也能一起看 |
| 9 | **B4** 规范文档补齐 | Day 10–11 | 必须在 B2 之后：`coding-standards.md` 要填的就是 B2 落地的真实配置 |
| 10 | **A5** 阶段 9（IM 网关）独立复审 | Day 11（半天） | 独立任务，放在文档收尾前，结论正好并进 B5 |
| 11 | **B5** 文档与验收欠账 | Day 11–12 | 收尾：把前面所有结论归位 |
| 12 | **B6** v1.0.0 发布准备 | Day 12 | 最后一步，且逐项等人类授权 |

**只有两条先后关系是硬的：** ①B2 在所有逻辑改动之前 ②A4 在 A3 之后。其余顺序可按手感微调，但改之前先看一眼上表「为什么」列。

---

## 分支与提交

- 一条分支干到底：从最新 `main` 建 `chore/phase15-quality-closeout`（也可以直接在 `main` 上小步提交，二选一，**别中途换**）。
- 每天开工前 `git pull --rebase origin main`（如果远端有更新）；每个任务完成即合流，不要攒大包。
- 提交规范：`<gitmoji><type>(<scope>): <中文描述>`；**只显式 `git add` 本任务文件，禁止 `git add -A`**；小步 commit，一次提交只做一件事。
- **push 先问人类**：本地 `main` 长期领先 `origin/main`（写本计划时 ahead 29），当前口径是**只提交本地**。A0 里的备份 push 要人类点头才做。
- **打 tag、`npm publish`、删分支、reset、force push 一律先问人类。**
- 审查者取码：`git worktree add --detach ../harness2-review <commit>`，**别在主工作树切分支**。若没有 push，审查者就在本机建只读工作树。

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `.gitignore`、根 `package.json` | 修改 | A0（版本号）、B2（lint script） |
| `docs/issue-log/OPEN.md` | 重构 | B1：只留真实待办 |
| `docs/issue-log/DECISIONS.md` | 新建 | B1：已关闭 / 不修 / 口径登记迁入 |
| `eslint.config.js`、`.prettierrc`、`.prettierignore` | 新建 | B2 |
| `.github/workflows/**` | 修改 | B2：lint 入 CI |
| `packages/core/src/tools/`（bash 工具实现） | 修改 | A1-1/A1-2：shell 探测与 UTF-8 解码 |
| `packages/core/src/config/schema.ts` | 修改 | A1-1：新增 `bash.shell` 配置项（可选） |
| `packages/core/src/doctor/**` | 修改 | A1-1：doctor 报告实际使用的 shell |
| `packages/core/src/agent/loop.ts` | 修改 | A1-3：连续工具失败熔断 + 非空 finalText |
| `packages/core/src/tools/executor.ts` | 修改 | A1-4：参数校验错误带 schema 片段与最小示例 |
| `packages/core/src/server/{http.ts,ws.ts,sessions.ts}` | 修改 | A3：Origin/Host 白名单、一次性 token、WS 帧上限 |
| `packages/core/package.json` | 修改 | A3-3：playwright 移出 runtime dependencies |
| `packages/core/src/server/sessions.ts` | 拆分 | A4：hub 装配 / 订阅恢复 / 任务协调 |
| `packages/core/test/{windows-bash,tool-failure-circuit,serve-security}.test.ts` | 新增 | A1 / A3 验收 |
| `packages/cli/src/index.ts` | 拆分 | B3：命令注册 + 各子命令分文件 |
| `packages/desktop/src/renderer/App.tsx` | 拆分 | B3：分栏 / 会话列表 / 消息流 |
| `packages/desktop/src/renderer/components/SettingsDialog.tsx` | 拆分 | B3（评估后决定） |
| `architecture.md`（Provider / Server 小节） | 修改 | A2/A3 结论落盘 |
| `coding-standards.md`、`CODE_REVIEW.md`、`README.md` | 修改 | B4、B5 |
| `docs/HANDOFF.md`、accept-phase 结论文件 | 修改/新增 | B5 |
| `docs/RELEASE-CHECKLIST.md` | 勾选 | B6 |

---

## 任务

### 1. A0 — 仓库卫生与基线（Day 1 上午 · 0.5 天）

- **Files：** `.gitignore`、根 `package.json`、删除 `.tmp-head-check/`
- **行为：**
  1. **先问人类要不要 push 备份**（本地领先 `origin/main` 29 个提交）。同意就 `git push origin main`；不同意就跳过，并告诉审查者要在本机建只读工作树。
  2. 删除根目录 `.tmp-head-check/`（内含断链 node_modules，任何递归扫描都会刷 DirectoryNotFound），加进 `.gitignore`。
  3. 根 `package.json` 版本 `0.1.0` → `1.0.0`，与四个包对齐。
  4. 核对 `.gitignore` 是否覆盖 `dist-bundle/`、`release/`、临时目录。
- **Steps：** 上述四步 → `pnpm -r typecheck` → `pnpm test`，**把通过数与耗时记进 acceptance.md 第 0 节作为全程基线**（core 参考基线：789 passed + 1 skipped）。
- **Commit：** `🔧chore(repo): 清理临时目录并对齐根版本号至 1.0.0（A0）`
- **验收：** `git status` 干净；根与四包版本一致；基线数字已落盘。

---

### 2. B1 — OPEN.md 拆分（Day 1 下午）

**为什么早做：** `docs/issue-log/OPEN.md` 开头写着「已关闭项不在此文件」，但 31KB 里塞满了「已关闭 / 已评估不修 / 口径登记」，真正待办不到三分之一。它是交接时第一份被读的文件，而且后面 11 个任务都要往里追加结论。

- **Files：** `docs/issue-log/OPEN.md`、新建 `docs/issue-log/DECISIONS.md`
- **行为：**
  1. OPEN.md 只留**真实待办**；
  2. 已关闭 / 已评估不修 / 口径登记迁到 `DECISIONS.md`（**只搬不删**，保留原文与日期）；
  3. OPEN.md 顶部加索引链接指向 DECISIONS.md；
  4. 顶部声明本阶段计划文档的位置（本文件 + acceptance + review-brief）。
- **Commit：** `📝docs(issue-log): OPEN.md 只留待办，决策与已关闭项迁入 DECISIONS.md（B1）`
- **验收：** OPEN.md 逐条都是待办；行数显著下降；无信息丢失（diff 可核）。

---

### 3. B2 — lint/format 基建 + CI + 全量格式化（Day 2 · **必须在任何逻辑改动之前做完**）

**现状：** `coding-standards.md` 写着「格式化交给工具」，但仓库里**没有任何 lint/format 配置**，全靠人肉自觉。

1. 引入 ESLint（flat config）+ Prettier，新增 `pnpm lint`，接进 CI。
2. 首轮**放宽 warning**：只把明显错误（未使用变量、`any` 泄漏、floating promise 等）设为 error，**存量正常代码不得因新规则误标红**；新规则先 `warn`，后续再收紧。
3. 根 `package.json` 加 script 单独一次提交。
4. **全量格式化独占一个 `🎨style` 提交，不掺任何逻辑改动。**
5. `.prettierignore` 至少排除：`packages/core/test/fixtures/**`（含 `api-surface-baseline.json`，格式化它会污染快照比对）、`dist*`、`release/`、`node_modules`。
6. 格式化后**立即**跑 `pnpm -r typecheck` + `pnpm test`，通过数必须与 A0 基线一致；`api-surface.test.ts` 必须仍绿。
7. 顺手加 `.gitattributes`（`*.md text eol=lf`），消掉 Windows 上每次提交都刷屏的 `LF will be replaced by CRLF` 警告。

- **Commit：** `🔧chore(repo): 引入 ESLint(flat) 与 Prettier 并接入 CI（B2）` / `🎨style(repo): 全量格式化（B2 · 无逻辑改动）`
- **验收：** 本地 `pnpm lint` 干净；CI 上 lint 为必过项且绿；`🎨style` 提交 diff 中无逻辑变更（审查方抽查）；测试通过数与基线一致。

> 做完这一步后，**后续任何提交都不许再夹带格式化噪音**。编辑器开 format-on-save 即可自然保持。

---

### 4. A1 — Windows 可用性 P0（Day 3–5 · 全阶段最高优先级）

**案发记录：** 会话 `20260907-032949-546d13`（检索今日 3 件时政要闻）跑满 25 步 `maxSteps`、`finalText` 为空、用户零回复。根因是 Windows 适配缺陷，**不是任务复杂度**。

#### A1-1 bash 工具的 shell 选择
- 现状：`spawn(command, { shell: true })` 在 Windows 实际走 cmd.exe，`ls`/`head`/`tail`/`pwd` 全部失败并反复烧步数。
- 目标：探测顺序 `config.bash.shell` > Git Bash（`GIT_BASH` 环境变量 / 常见安装路径）> cmd 回退；`harness2 doctor` 输出**实际使用的 shell**（而非配置里写的）。
- **Commit：** `🐛fix(core): Windows bash 工具优先 Git Bash 并在 doctor 中报告（A1-1）`

#### A1-2 输出编码统一 UTF-8
- Windows 控制台默认 GBK，子进程输出必须按 UTF-8 解码，**乱码不得进模型上下文**。
- **Commit：** `🐛fix(core): 子进程输出统一 UTF-8 解码（A1-2）`

#### A1-3 熔断语义改造
- 在 `maxSteps` 之外增加「连续工具失败次数上限」（建议 5）；触发时 turn 以 `stopReason=tool_failures` 结束，并**必须**产出面向用户的 finalText，**禁止空回复**。同时评估默认 `maxSteps=25` 是否上调。
- **边界（勿与底座 S4 混淆）：** 本项是「连续失败熔断」（防烧步/防空回复），与 `interaction/retry-policy` 的「有界重试」是两套独立机制。落点在 agent 控制流（`loop.ts`/turn 组装层），**不改 `interaction/` 下的公共契约**。
- **Commit：** `✨feat(core): 连续工具失败熔断与非空终态回复（A1-3）`

#### A1-4 工具参数校验反馈
- 缺必填参数时（案例里 `write` 漏 `file_path`），error 中带该参数的 schema 片段 + 一个最小正确调用示例。
- **Commit：** `✨feat(core): 工具参数缺失时返回 schema 与最小示例（A1-4）`

#### A1-5 browser 工具提示语核对
- `browser_*` 未安装 chromium 时提示应明确指向 `harness2 browser install`。
- **Commit：** `📝fix(core): 校正 browser 工具未安装提示（A1-5）`

- **测试（新增，全部 mock/stub，零 API key）：**
  - `windows-bash.test.ts`：Windows 下 `ls`/`pwd`/`head` 经 Git Bash 成功；无 Git Bash 时回退 cmd 且错误可读
  - 编码用例：输出含中文与 emoji 不乱码（构造 GBK 控制台环境）
  - `tool-failure-circuit.test.ts`：连续 5 次工具失败 → `stopReason=tool_failures` 且 finalText 非空
  - 参数示范用例：`write` 漏 `file_path` → error 含示例
  - **回归**：`tools.test.ts` / `loop.test.ts` 全绿，**重点确认超时与取消时的进程树击杀（Windows `taskkill /T /F`）仍生效**
- **审查：** 人工 + 只读子代理，**阻塞合入**。重点：跨平台分支覆盖、进程树击杀、有无新增平台写死判断。
- **验收：** Windows 真机重跑一个同类联网检索任务，要么在步数内给出答案、要么给出明确失败说明；贴 `harness2 traj <会话目录>` 摘要为证。
- **关联：** 与 R2 终端轨 T2「Windows 四场景能力闸门」重叠，**合并做，不要改两遍**；结论同步给 T 轨 owner。

---

### 5. A2 — 真实模型端到端验证（Day 6 · 1–2 天 · 环境已就绪，无需外部 key）

**现状：** provider 协议此前只过了 127.0.0.1 stub，真实模型**从未实机验证**。这是产品最核心路径，发布前必须补。

#### A2-1（必做）本地统一网关 — 人类已提供，2026-09-09 实测通过

| 项 | 值 |
|----|----|
| Base URL | `http://127.0.0.1:40080/v1` |
| Key | `sk-unified-local`（本地网关口令，非云端机密；仍只写 auth.json 或环境变量，**不入库、不进日志**） |
| 模型 | `big-pickle` |
| 上下文 | 200K → `contextWindow: 200000` |
| 模态 | **纯文本大模型**（无视觉/多模态；相关用例直接记 ➖，不要伪造） |

实测结论（写计划时用 PowerShell 直连，可复现）：

| 端点 | 协议 | 实测结果 |
|------|------|----------|
| `GET /v1/models` | — | 200，列表含 `big-pickle` |
| `POST /v1/chat/completions`（`Authorization: Bearer …`） | OpenAI 兼容 | 200；非流式带 `reasoning_content` 与 `usage{prompt_tokens,completion_tokens,total_tokens}`；`stream:true` 返回 `text/event-stream`，delta 先 `reasoning_content` 后 `content`，收尾依次是 `finish_reason=stop` 帧 → `choices:[]` 的 usage 帧 → `data: [DONE]` |
| `POST /v1/messages`（`x-api-key` + `anthropic-version: 2023-06-01`） | Anthropic 原生 | 200；content 块为 `thinking` + `text`，`stop_reason=end_turn`，`usage{input_tokens,output_tokens}`；流式事件序列 `message_start` → `ping` → `content_block_start/delta(thinking_delta)/stop` → `content_block_start/delta(text_delta)/stop` → `message_delta`（带 stop_reason 与 usage）→ `message_stop` |

**⚠️ baseUrl 最容易踩的坑（写错就是 404，先看 `config/schema.ts` 第 18 行注释）：**
- `protocol: "openai"` → 代码请求 `{baseUrl}/chat/completions`，baseUrl **要带 `/v1`**：`http://127.0.0.1:40080/v1`
- `protocol: "anthropic"` → 代码请求 `{baseUrl}/v1/messages`，baseUrl **不能带 `/v1`**：`http://127.0.0.1:40080`

**配置（用 `--home` 指向临时目录，不许改人类的 `~/.harness2`，见下文 Global Constraints 第 6 条）：**

新建独立 home，例如 `D:/tmp/h2-a2-home`，写 `D:/tmp/h2-a2-home/.harness2/config.json`：

```json
{
  "providers": {
    "local-oai": {
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:40080/v1",
      "envKey": "LOCAL_UNIFIED_KEY",
      "models": { "big-pickle": { "contextWindow": 200000, "maxOutputTokens": 8192 } }
    },
    "local-ant": {
      "protocol": "anthropic",
      "baseUrl": "http://127.0.0.1:40080",
      "envKey": "LOCAL_UNIFIED_KEY",
      "models": { "big-pickle": { "contextWindow": 200000, "maxOutputTokens": 8192 } }
    }
  },
  "roles": {
    "main": { "channel": "local-oai", "model": "big-pickle" },
    "small": { "channel": "local-oai", "model": "big-pickle" }
  },
  "approval": { "mode": "default", "tools": { "bash": "ask" } }
}
```

再写 `D:/tmp/h2-a2-home/.harness2/auth.json`（key 解析顺序 auth.json > env）：

```json
{ "channels": { "local-oai": { "apiKey": "sk-unified-local" }, "local-ant": { "apiKey": "sk-unified-local" } } }
```

验 anthropic 渠道时把 `roles.main.channel` 改成 `local-ant` 再跑一遍。所有命令都加 `--home D:/tmp/h2-a2-home`——`config check`、`doctor`、`chat`、`serve`、`mcp list`、`plugin`、`memory` 均支持 `--home`，`config check` 与 `doctor` 还支持 `--root`。

**开工第一步：** 直连 `http://127.0.0.1:40080/v1/models`（带 `Authorization: Bearer sk-unified-local`）确认 200；网关没起来就找人类，别改代码猜错误。

两个渠道（`local-oai` / `local-ant`）各过一遍下面八项：

| # | 项目 | 通过条件 |
|---|------|----------|
| 1 | `harness2 config check --home <临时home> --root .` | 两渠道各显示 protocol 与 baseUrl、`models: big-pickle`、`main -> local-oai/big-pickle`；key 来源显示 `auth.json`（或 `env:LOCAL_UNIFIED_KEY`）；**输出里不得出现 `sk-unified-local` 明文** |
| 2 | `harness2 chat` 一轮对话 + 一次工具调用 | SSE 流式渲染、tool_calls 组装、`reasoning_content`/`thinking` 展示、usage 统计、错误脱敏均正常 |
| 3 | undo/redo/审批/会话 | `/undo --dry-run` → `/undo`（文件复原）→ `/redo`（内容回放）→ 审批 ask 的 y/a/n → `/sessions` 搜索 → `/exit` |
| 4 | 记忆三态 | off / ask / auto + nudge 复盘；手工改坏 `§` 结构应被拒并生成 .bak |
| 5 | MCP 与插件 | filesystem server `mcp list` 探测 + `mcp__filesystem__*` 真实调用；第三方插件从零装载 + `plugin enable` |
| 6 | 桌面端 | 接本地网关走一遍对话 / 流式 / 审批 / undo |
| 7 | 上下文与压缩 | 声明 200K 时压缩阈值 ≈ 150K token，**别真堆长文**：临时把该渠道 `contextWindow` 改成 4000 触发一次压缩，确认压缩事件与摘要落盘、后续回答不崩，再改回 200000 |
| 8 | 失败与降级 | 故意把 baseUrl 写错（如 anthropic 渠道错带 `/v1`）→ 报错可读且不含 key 明文；停掉网关 → `network` 类错误经有界重试（2/10/30s）后给出**非空** finalText，不得空回复 |

#### A2-2（可选，缺 key 就记 ➖）真实云端厂商

DeepSeek / 智谱 GLM / Anthropic 官方各过同一份清单。**本地网关通过 ≠ 云端通过**——它是路由器（响应 id 形如 `router-…`），覆盖不了各家 reasoning 字段命名、429/配额限流、错误码与脱敏文案、超长上下文真实行为、tool_calls 细节差异。无云端 key 时在 acceptance.md 第 7 节登记 ➖ 并写明补做条件，**不得用 A2-1 或 stub 顶替**。

- **产出：** 当天 `docs/issue-log/<日期>.md` 逐项 pass/fail + 真实输出片段（先脱敏）；两条协议的行为差异（`reasoning_content` vs `thinking` 块、usage 帧位置、`[DONE]` vs `message_stop`）写进 `architecture.md` 的 Provider 小节；跨人可见的结论同时填 acceptance.md 的 A-7 / A-7b；OPEN.md 里「待 key」条目改写为「只剩云端厂商待补」。
- **Commit：** `📝docs(core): 真机验证结论与 provider 双协议差异记录（A2）`
- **验收：** A2-1 八项全绿或缺陷已登记；A2-2 有 key 同样处理、无 key 记 ➖。

---

### 6. A3 — serve 发布前安全加固（Day 7–8 · 2 天）

#### A3-1 本地信任域加固
- 现状：HTTP/WS 只监听 127.0.0.1 但**无鉴权、无 Origin/Host 白名单**，任意本地进程都能驱动 agent 执行工具。OPEN.md 里挂着「M2 发布前加固项」，已顺延到 M4。
- 目标：Origin/Host 白名单 + 启动时生成的一次性 token（CLI 与桌面自动携带）；拒绝非 127.0.0.1。
- **Commit：** `🔒feat(core): serve 增加 Origin 白名单与一次性 token 鉴权（A3-1）`

#### A3-2 WS 帧大小上限
- 对齐 HTTP 的 1 MiB，超限断连并记账（WS 侧目前无 cap）。
- **Commit：** `🔒feat(core): WS 帧大小上限与超限断连记账（A3-2）`

#### A3-3 playwright 依赖瘦身
- 现状：playwright 是 `@harness2/core` 的 **runtime dependency**，任何 `npm i -g harness2` 的用户都会拖一份。
- 目标：改 `optionalDependencies` 或运行时动态 import；未安装时 `browser_*` 走既有「未安装指引」降级（bundle 侧已 `--external:playwright`，降级路径本就存在）。
- **Commit：** `⚡chore(core): playwright 改为可选依赖并保留降级路径（A3-3）`

- **测试：** `serve-security.test.ts`（跨 Origin 被拒 / 无 token 被拒 / 超大 WS 帧断连）；无 playwright 环境下 `import @harness2/core` 不报错且 `browser_*` 返回指引；导出面变更同步 api-surface fixture。
- **审查：** 人工 + 只读子代理，安全类**必须两份审查**，重点确认没有把桌面端和 CLI 自己挡在门外。
- **验收：** `pnpm test` 全绿 + **自己跑一遍 desktop smoke 与 CLI `serve --port 0 --provider mock` 冒烟** + 手工 curl 越权被拒的真实输出。

---

### 7. A4 — core/server 大文件拆分（Day 8–9 · A3 合入之后再做）

- `packages/core/src/server/sessions.ts` 73KB，是 R2 终端轨与桌面轨都要动的汇合点，**先拆它**：按 hub 装配 / 订阅恢复 / 任务协调 三块切开。顺带评估 `agent/loop.ts` 30KB、`interaction/runtime-journal.ts` 29KB 是否一并处理。
- **要求：纯搬运不改行为**；一次只拆一个文件；每次跑全量 `pnpm test` + `pnpm -r typecheck`；导出面变化同一提交同步 api-surface fixture。
- **审查：** 重点验证「零行为变更」——要提供拆分前后同一组测试的结果对比。
- **验收：** `sessions.ts` 单文件降到 25KB 以内，CI 全绿。
- **Commit：** `♻️refactor(core): 拆分 server/sessions.ts 为 hub/订阅恢复/任务协调（A4）`

---

### 8. B3 — cli / desktop 大文件拆分（Day 9–10）

**为什么现在做：** 违反自家编码规范「单文件保持合理长度」，而且这两个文件正是 R2 终端轨 T0–T5 与桌面轨 D0–D6 要重度改动的地方，先拆开后面才好并行。

| 文件 | 当前 | 拆分方向 |
|------|------|----------|
| `packages/cli/src/index.ts` | 39KB | 命令注册 + 各子命令分文件 |
| `packages/desktop/src/renderer/App.tsx` | 31KB | 分栏 / 会话列表 / 消息流 组件 |
| `packages/desktop/src/renderer/components/SettingsDialog.tsx` | 30KB | 评估后决定是否拆 |

- **要求：纯搬运不改行为**；一次只拆一个；每次跑全量 `pnpm test` + `pnpm -r typecheck`。
- 如果动到 `@harness2/core` 的导出面：**同一提交**更新 api-surface fixture。
- **验收：** 目标文件都降到 20KB 以内；桌面 smoke 通过；CLI 主要子命令手工走一遍。
- **Commit：** `♻️refactor(cli): 拆分 index.ts 为命令注册与子命令模块（B3-1）` / `♻️refactor(desktop): 拆分 App.tsx 为分栏与会话组件（B3-2）`

---

### 9. B4 — 规范文档补齐（Day 10–11）

#### B4-1 `coding-standards.md` 的「项目专属约定」
整节还是 `____________` 空白模板（技术栈、构建命令、包管理器、测试命令、分层结构、lint 配置全空）。这是 AI 子代理协作的地基，必须按 B2 落地的真实配置填实。**写进去的每条命令都要亲自跑一遍**——写错命令比空白更坏。
- **Commit：** `📝docs(standards): 填实项目专属约定（B4-1）`

#### B4-2 `CODE_REVIEW.md` 增补 harness2 专属红线
现在这份是通用清单，对本项目零针对性。需增补：
- 四条不变量（Model-visible ⟺ logged / append-only 单写者 / core 与 UI 解耦 / 文件快照独立于 git）
- 密钥脱敏闸门
- 快照范围（bash 副作用不入快照）
- 审批机制不得弱化
- 导出面变更必须同步 api-surface 快照
- 顺手修掉「缓存在的使用」这个错字
- **Commit：** `📝docs(review): 增补 harness2 专属审查红线（B4-2）`

#### B4-3 插件边界如实声明
v1 插件是**同进程非隔离**，manifest 权限只是 API 层约束。在 README、文档站、`plugin list` 输出三处显著位置写明，避免用户默认有沙箱。（`plugin list` 输出文案落点在 core，一并改掉。）任何暗示「有沙箱 / 已隔离」的措辞都是安全误导。
- **Commit：** `📝docs(plugins): 声明 v1 插件同进程非隔离边界（B4-3）`

---

### 10. A5 — 阶段 9（IM 网关）独立复审（Day 11 · 半天）

- 阶段 9 曾判 fail，修复后一直没复审。重点：`startGateway` 生命周期（重复启动、异常退出、资源释放）、断线重连重订阅、`msg_seq` 严格递增无跳号。
- 复跑 `packages/gateway` 全部测试并贴输出。
- 结论按 `/accept-phase` 四段格式产出，文件在 B5 统一归位。
- **Commit：** `📝docs(gateway): 阶段 9 独立复审结论（A5）`

---

### 11. B5 — 文档与验收欠账（Day 11–12）

1. 补形式验收 `/accept-phase`：**阶段 5、6、8**（当时按档位跳过，属「未执行 ➖」而非「不通过」——**不得写成已通过 ✅，那是造假**）；并归位 A5 产出的阶段 9 复审结论。
2. README 三张截图：终端 chat 流式与工具行、桌面多会话分屏、traj 时间线；补完**删掉 HTML 占位注释**。
3. `docs/HANDOFF.md` 状态快照更新到当前（含本阶段进展与三份计划文档索引）。
4. 汇总本阶段 `docs/diary/` 记录。
- **验收：** 三份 accept-phase 四段结论落盘；README 图可见；HANDOFF 读完能零上下文接手。
- **Commit：** `📝docs(plans): 补齐阶段 5/6/8 形式验收与交接快照（B5）`

---

### 12. B6 — v1.0.0 发布准备（Day 12 · **逐项等人类授权，不要自行执行**）

1. `npm view harness2` / `npm view @harness2/core` 包名占用检查（**只读，可先做**，结果告知人类）。
2. `NPM_TOKEN` secret 由人类配置；你把需要的字段与步骤列清单给他。
3. tag `v1.0.0` **等明确授权后再推**；release note 说明 M1/M2/M3 合并进 1.0.0 的对应关系（素材取自 `docs/diary/`）。
4. 对照 `docs/RELEASE-CHECKLIST.md` ③ 逐项打勾，把勾好的清单发人类。
- **发布后核对：** release workflow 全绿；npm 两包可安装；干净机器上 `npm i -g harness2` 后 `harness2 config check` 可跑。

---

## 代码审查（阶段级，验收前）

**审查方：** ①**专职审查者**（人工，按 `CODE_REVIEW.md` + `…-review-brief.md`）②独立只读子代理（非实现者）。两份都要，**安全类（A3）与拆分类（A4/B3）一份都不能省**。
**审查面：** 跨平台分支 / 进程树击杀 / 事件溯源不变量 / 密钥脱敏 / 审批不得弱化 / 快照范围 / 导出面快照同步 / 安全边界 / 拆分零行为变更 / lint 规则合理性 / 文档与实现一致。
**结论：** ✅ 通过 / ⚠️ 有条件通过（问题进验收表）/ ❌ 不通过（阻塞，按元规范 §4.1 下放）

### 审查窗口（边做边审，不是最后一次总审）

| 时机 | 审查对象 | 阻塞合入 | 说明 |
|------|----------|----------|------|
| Day 1 | 审查者读文档、建只读工作树、跑自己的基线 | — | 与 A0 并行 |
| Day 2 | A0、B1、B2 | 否（事后核） | 重点：B1 只搬不删；B2 的 `🎨style` 提交抽查有无夹带逻辑 |
| Day 5 | **A1** | 是 | 全阶段最细一批 |
| Day 6 | A2 的证据 | 否 | 只核证据真实性：有无 mock 冒充、有无 key 明文、anthropic baseUrl 是否配对 |
| Day 8 | **A3** | 是 | 安全类最严 |
| Day 10 | A4、B3 | 是 | 两批拆分一起看，重点零行为变更 |
| Day 12 | B4、A5、B5 | 是 | 文档与复审 |
| Day 12 末 | 联合验收 J-1～J-6 | 阻塞发布 | 全部合入后 |

**SLA：** 声明「完成待审」后 24 小时内出结论。P0 当面/群里直达，不能只写在文档里等人看。审查者预计投入约 5 个半天，散在 12 天内。

### 每个任务「完成」的统一定义

1. `pnpm -r typecheck` 与 `pnpm test` **实跑并贴输出**（禁止「应该能过」；测试名必须真实命中 >0，不得 `--passWithNoTests` 造假绿）
2. 两份审查报告 P0/P1 清零
3. 同步 `docs/issue-log/<日期>.md`（需求描述 / 处理过程 / 修改结果 / 遗留风险四要素）、`OPEN.md`、`docs/diary/`
4. 在 `…-acceptance.md` 对应行填状态、证据命令、日期

---

## Global Constraints（冲突时以本节为准）

1. **四条不变量不得破坏**：Model-visible ⟺ logged；永久会话事件 append-only + 同会话单写者；core 与 UI 解耦；文件快照独立于 git（bash 副作用不入快照）。碰到这四条先停下来问人类。
2. **保留已有安全边界**：`provider/openai.ts` 的 `[DONE]` 检查与「半截工具参数不能执行」；`tools/executor.ts runWave` 的 safe 并发 / unsafe 独占 / 同 lockKey 串行；审批机制不得弱化。
3. **公共事件类型变更须同步** parser/projector/export/replay/fixture 与迁移策略。
4. **不动阶段 14 已冻结的 S0–S7 契约**（`submit/resumeSubscription/approval/cancel/task/steer`、`protocolVersion=2`、`runtime.v1.jsonl`）。
5. 改动前先读对应测试：`agent/loop.ts`→loop.test.ts；`tools/*`→tools.test.ts；`session/reader.ts`→reader 与 undo/redo 测试；`trajectory/export.ts`→export.test.ts；`core/src/index.ts` 导出面→api-surface.test.ts。
6. 密钥/真实用户会话/附件/prompt 日志**不上传、不入库**；测试一律用本地 stub 或本地网关 + 临时 HOME/cwd；**不改人类的全局配置、`~/.harness2/auth.json` 与审批模式**。
7. 命令用 PowerShell 5.1 分行写（不连 `&&`），每条查 `$LASTEXITCODE`。
8. **YAGNI**：本阶段只清欠账，不顺手加功能；拆分类改动必须是行为等价的纯搬运。
9. `docs/issue-log/<日期>.md` **不入库**（`.gitignore` 第 13 行已忽略 `docs/issue-log/*`，仓库内只跟踪 `OPEN.md` 与 `README.md`）。它只是本机留痕，**别人看不到**；凡是需要跨人可见的结论，必须落到 `…-acceptance.md` 与 `OPEN.md`。

---

## 阶段开头：上阶段遗留（元规范 §4.1）

| 遗留项 | 来源 | 未通过/未做原因 | 承接 |
|--------|------|----------------|------|
| 阶段 5 / 6 / 8 未做形式验收 | 阶段 12 收口 | 当时按档位跳过，登记为「未执行」 | ⬜ B5-1 |
| 阶段 9（IM 网关）曾判 fail，修复后未复审 | 阶段 9 验收 | 修复后无独立复审 | ⬜ A5 |
| serve 本地信任域加固（M2 发布前项） | OPEN.md | 一路顺延至 M4 仍未做 | ⬜ A3-1 |
| 真实模型端到端零验证 | OPEN.md「待 key」 | 原因是缺 API key；**2026-09-09 人类已提供本地统一网关，依赖解除**，只剩云端厂商差异待补 | ⬜ A2 |
| `coding-standards.md`「项目专属约定」整节空白 | 静态审计 | 从未填写 | ⬜ B4-1 |
| Windows bash 工具不可用导致空回复（会话 `20260907-032949-546d13`） | issue-log | 定位后未修 | ⬜ A1 |

---

## 验收标准总表（逐项明细与证据填 `…-acceptance.md` 第 2/3 节）

| # | 标准 | 通过条件 | 验证方式 |
|---|------|----------|----------|
| 1 | Windows 四类缺陷闭环 | `windows-bash`、`tool-failure-circuit`、编码与参数示范用例全绿 | 自动化 |
| 2 | 真机清单 | **A2-1（必做）** 本地网关 openai + anthropic 两渠道八项逐项 pass 或已登记缺陷；**A2-2（可选）** 云端厂商差异，无 key 记 ➖ | 人类签收 |
| 3 | serve 越权被拒 | `serve-security` 全绿 + 手工 curl 输出 | 自动化 + 手工 |
| 4 | core/server 拆分零行为变更 | `sessions.ts` < 25KB 且拆分前后同组测试结果一致 | 自动化 + 审查复核 |
| 5 | 阶段 9 网关复审结论落盘 | 四段结论 + 复跑输出 | 独立角色 |
| 6 | OPEN.md 只剩真实待办 | 逐条为待办，已决策项迁入 DECISIONS.md | 人工审阅 diff |
| 7 | lint 进 CI 且绿 | `pnpm lint` 本地与 CI 均通过；`🎨style` 提交无逻辑变更 | 自动化 + 抽查 |
| 8 | cli/desktop 拆分零行为变更 | 目标文件 < 20KB + 桌面 smoke 通过 | 自动化 + 手工 |
| 9 | 两份规范文档无空白占位 | `coding-standards.md`、`CODE_REVIEW.md` 项目专属内容落地且命令实测可用 | 人工 |
| 10 | 文档欠账清零 | accept-phase 5/6/8 落盘 + README 三图 + HANDOFF 更新 | 人工 |
| 11 | 全量回归 | `pnpm test` 真实命中全绿，通过数不低于 A0 基线 | 自动化 |
| 12 | 阶段级代码审查 | 每批两份报告，结论 ✅/⚠️；❌ 下放 | 审查者 + 子代理 |
| 13 | 红线 | 无密钥入库；`git ls-files` 无敏感文件；未改人类全局配置 | 自检 + 审查 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 全量格式化前置产生一个超大 diff，审查者看不动 | 它是纯 `🎨style` 提交，用 `git diff --ignore-all-space` 与 `pnpm prettier --check` 复核即可，不必逐行读；且放在最前面意味着后面所有业务 diff 都干净 |
| 新 lint 规则把存量正常代码判红，CI 长期红 | 首轮只把明显错误设 error，其余 warning；先跑通再收紧 |
| 格式化污染 api-surface fixture 导致快照测试炸 | `.prettierignore` 排除 `packages/core/test/fixtures/**`；格式化后立刻跑全量测试与 `api-surface.test.ts` |
| Windows shell 探测在他人机器上路径不同 | 探测顺序可配置（`config.bash.shell` 最高优先级）+ doctor 输出实际 shell |
| 熔断阈值误伤长任务 | 阈值可配置；只统计**连续**失败；触发时给出可行动 finalText 而非静默结束 |
| 安全加固挡住自家客户端 | A3 完成即自己跑 desktop smoke + CLI serve 冒烟才算通过 |
| 本地网关通过 ≠ 云端厂商通过 | A2-1 必做（环境已就绪）；A2-2 缺 key 记 ➖，不得由 A2-1 或 stub 顶替 |
| 本地网关未启动 / 端口 40080 被占 | 先直连 `/v1/models` 确认 200 再动 harness2；网关不可用则 A2 顺延，不阻塞 A3 |
| 200K 上下文导致压缩路径测不到 | 临时把渠道 `contextWindow` 调成 4000 触发压缩，验完改回，别真堆 15 万 token |
| 拆分意外引入行为变更 | 纯搬运；一次一个文件；拆分前后跑同一组测试并贴对比 |
| 单人执行没人交叉发现问题 | 这正是设专职审查者的原因；审查者缺位必须在 acceptance 第 5 节写明「无独立人工审查」 |
| 结论只写在本机 issue-log，别人看不到 | 跨人可见的结论必须进 `…-acceptance.md` 与 `OPEN.md`（两者入库） |
| 12 天工期被打断后忘记进度 | 每完成一个任务立刻在 acceptance 填状态，进度以那张表为准，不以记忆为准 |

---

## 给接手 AI 的完整提示词（单人版 · 可直接复制）

```
你负责 harness2「阶段 15-质量收口」的全部实施，一个人按顺序做完 12 个任务。仓库 D:/AI_Projects/harness2。

先完整读（缺一不可）：
- docs/ai-framework/phased-plan-driven.md（元规范）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md（唯一计划文件：执行顺序、12 个任务细节、全局约束）
- docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md（验收登记表，你要往里填证据）
- AGENTS.md、CODE_REVIEW.md、docs/HANDOFF.md、docs/issue-log/OPEN.md

基线：代码基线 main tip d38fc4a（其后只有计划文档提交），工作树干净。从最新 main 建一条分支
chore/phase15-quality-closeout 干到底，别中途换分支。

执行顺序（硬性）：
1) A0 仓库卫生与基线：push 备份先问人类（本地 ahead 29，当前口径只提交本地）；删 .tmp-head-check/ 并入 .gitignore；
   根 package.json 版本 0.1.0→1.0.0；跑 pnpm -r typecheck 与 pnpm test，把通过数与耗时记进 acceptance 第 0 节。
2) B1 OPEN.md 拆分：31KB 里大部分是已关闭/不修/口径登记，与文件开头声明矛盾。OPEN.md 只留真实待办，
   其余只搬不删地迁到同目录 DECISIONS.md，顶部加索引。
3) B2 lint/format 基建（必须在任何逻辑改动之前做完）：引入 ESLint(flat)+Prettier，新增 pnpm lint 并接入 CI；
   首轮只把明显错误设 error；.prettierignore 要排除 packages/core/test/fixtures/**；
   全量格式化独占一个 style 提交、不掺逻辑；格式化后立刻跑全量测试确认通过数与基线一致；
   顺手加 .gitattributes（*.md text eol=lf）。此后任何提交都不许再夹带格式化噪音。
4) A1 Windows 可用性 P0（最高优先级）：bash 工具探测顺序 config.bash.shell > Git Bash > cmd 回退，
   doctor 报告实际使用的 shell；子进程输出统一 UTF-8 解码；在 maxSteps 之外加「连续工具失败上限（建议 5）」，
   触发时 stopReason=tool_failures 且必须产出非空 finalText；工具参数缺失时返回 schema 片段与最小正确示例；
   校正 browser 工具未安装提示。新增 windows-bash.test.ts 与 tool-failure-circuit.test.ts，
   回归 tools.test.ts/loop.test.ts，特别确认超时与取消时 Windows taskkill /T /F 进程树击杀仍生效。
   参照案发会话 20260907-032949-546d13（跑满 25 步、finalText 为空）。
   注意边界：这条熔断与 interaction/retry-policy 的有界重试是两套机制，落点在 loop.ts，不改 interaction/ 公共契约。
5) A2 真机验证（环境已就绪，无需外部 key）：人类提供了本地统一网关 http://127.0.0.1:40080/v1，key sk-unified-local，
   模型 big-pickle（200K 上下文、纯文本，多模态用例直接记 ➖）。已实测 /v1/models、/v1/chat/completions、
   /v1/messages 三个端点均 200 且 SSE 正常。建两个渠道各测一遍：local-oai（protocol openai，baseUrl 带 /v1）
   与 local-ant（protocol anthropic，baseUrl 不带 /v1——代码自己拼 /v1/messages，写错就是 404）。
   配置写进临时 home（如 D:/tmp/h2-a2-home）并给所有命令加 --home，禁止改人类的 ~/.harness2。
   八项清单：config check（不打印明文）/ chat 一轮含工具调用 / undo-redo-审批-sessions / 记忆三态 /
   MCP filesystem 与插件装载 / 桌面端一遍 / 临时把 contextWindow 改 4000 验压缩 /
   错误与降级（baseUrl 写错、网关停掉都必须给非空 finalText 且不泄 key）。
   逐项 pass-fail 写 issue-log，结论填 acceptance 的 A-7，两协议差异写 architecture.md Provider 小节。
   A2-2（云端 DeepSeek/智谱GLM/Anthropic 官方）需真 key，无 key 就在 acceptance 第 7 节记 ➖；本地网关通过不等于云端通过。
6) A3 serve 安全加固：Origin/Host 白名单 + 一次性 token；WS 帧上限对齐 HTTP 1 MiB 且超限断连记账；
   playwright 从 core 的 runtime dependencies 移到可选依赖并保留未安装降级。新增 serve-security.test.ts。
   完成后自己跑 desktop smoke 与 CLI serve 冒烟，确认没把自家客户端挡在门外。
7) A4（A3 合入后）：纯搬运拆分 packages/core/src/server/sessions.ts（73KB）为 hub 装配/订阅恢复/任务协调，
   目标 <25KB，一次一个文件，每次跑全量测试，拆分前后同组测试结果必须一致。
8) B3：同样纯搬运拆分 packages/cli/src/index.ts（39KB）与 packages/desktop/src/renderer/App.tsx（31KB），
   评估 SettingsDialog.tsx（30KB）；目标各 <20KB；若动到 core 导出面，同一提交更新 api-surface fixture。
9) B4：填实 coding-standards.md 的「项目专属约定」（现为 ____ 空白模板，写进去的命令要亲自跑过）；
   给 CODE_REVIEW.md 增补 harness2 专属红线（四条不变量、密钥脱敏、快照范围、审批不得弱化、导出面快照同步，
   并修掉「缓存在的使用」错字）；在 README/文档站/plugin list 三处如实声明 v1 插件同进程非隔离，不得暗示有沙箱。
10) A5：独立复审阶段 9 IM 网关（曾判 fail 未复审），重点 startGateway 生命周期、断线重连重订阅、msg_seq 递增，
    按 /accept-phase 四段格式出结论。
11) B5：补阶段 5/6/8 的 /accept-phase 形式验收（当时属「未执行 ➖」而非「不通过」，写成 ✅ 就是造假），
    归位阶段 9 复审结论；补 README 三张截图并删占位注释；更新 docs/HANDOFF.md 状态快照。
12) B6（逐项等人类授权，不自行执行）：只读检查 npm 包名占用；列出 NPM_TOKEN 配置步骤交人类；
    tag v1.0.0 等授权；对照 docs/RELEASE-CHECKLIST.md ③ 逐项打勾。

铁律：
- 四条不变量不得破坏：Model-visible ⟺ logged / 永久事件 append-only 且单写者 / core 与 UI 解耦 /
  文件快照独立于 git（bash 副作用不入快照）。碰到就停下来问人类。
- 不修改阶段 14 已冻结的 S0-S7 交互契约与 protocolVersion=2。
- 改 core/src/index.ts 导出面必须在同一提交更新 api-surface fixture
  （H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts）。
- 密钥/真实会话/附件/prompt 日志不入库；测试用 stub 或本地网关 + 临时 HOME/cwd；不改人类全局配置与审批模式。
- 命令用 PowerShell 5.1 分行（不连 &&），每条查 $LASTEXITCODE。
- Git：只显式 add 本任务文件（禁止 git add -A），小步 commit；push/tag/publish/reset/force push/删分支必须先问人类。
- 测试名必须真实命中 >0，禁止 --passWithNoTests 造假绿；通过数不得低于 A0 基线。

每个 Task：先写失败用例 → 最小实现 → 跑对应包测试 → 贴「实际命令 + 真实输出」→ 小步 commit。
每个任务收尾：跑 pnpm -r typecheck 与 pnpm test → 请专职审查者人工审查 + 只读子代理审查 →
在 acceptance.md 填状态/证据/日期 → 更新 docs/issue-log/<日期>.md（四要素：需求描述/处理过程/修改结果/遗留风险）。
注意 docs/issue-log/* 不入库、别人看不到，凡是跨人可见的结论必须填进 acceptance.md 与 OPEN.md。

验收只认证据，禁止「应该能过」。P0/P1 未闭环就给「不通过/明确阻塞」，不宣称完成。
完成后交付：分支名、commit 清单、逐 Task 与逐验收项结果、真实测试输出、已知风险、已启动进程的 PID 归属。
```

---

## 残留手工验收清单（人类执行）

1. **真机体验签收**（A2）：本地网关 `big-pickle` 的 `local-oai`（openai 协议）与 `local-ant`（anthropic 协议）各一轮真实对话 + 工具调用 + undo/redo + 审批（**必做**）；云端 DeepSeek / 智谱 GLM / Anthropic 官方各一轮（有 key 才做，否则记 ➖）。
2. **Windows 真机手感**（A1）：重跑一个联网检索类任务确认不再空回复；另核 IME、滚动、Ctrl+C 中断、长输出截断。
3. **安全加固后确认**（A3）：本机 CLI 与桌面端仍能正常连接与对话。
4. **README 截图**（B5）：三张图由人类确认是否真实反映当前 UI。
5. **发布授权**（B6）：NPM_TOKEN 配置、tag v1.0.0 推送、发布后 24h 观察。
6. **干净机器验证**（B6）：`npm i -g harness2` 后 `harness2 config check` 实跑。
