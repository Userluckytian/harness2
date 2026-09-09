# 阶段 15-质量收口 · 轨道 A：运行时与后端（A0–A5）

> **状态：** 计划已就绪（2026-09-09），待执行者认领
> **总纲（必读在先）：** `docs/ai-framework/plans/2026-09-09-phase-quality-closeout.md`
> **验收登记：** `docs/ai-framework/plans/2026-09-09-phase-quality-closeout-acceptance.md`
> **对侧轨道：** 轨道 B（工程化与产品面）`…-track-b.md`——**不要动**根 lint 配置、`packages/cli`、`packages/desktop`、`docs/**`、`README.md`、`coding-standards.md`、`CODE_REVIEW.md`
> **元规范：** `docs/ai-framework/phased-plan-driven.md`

**Goal：** 让 harness2 在 Windows 上真正可用、让三端 provider 第一次经过真机验证、让 serve 达到可发布的安全基线，并把 R2 两轨都要动的 `server/sessions.ts` 提前拆开。
**实施档位：** 全能（开发 + 测试 + 代码审查）；A2 为豪华档端到端，由人类签收。
**子代理：** 启用（代码审查 + 验收）；另由轨道 B 执行者做人工交叉审查。
**worktree / 分支：** 从当前 `main`（tip `b5a702d`）建 `feat/runtime-hardening`。

---

## 前置阅读

| 优先级 | 文件 |
|--------|------|
| P0 | 总纲 + 本文件 + acceptance.md |
| P0 | `AGENTS.md`、`CODE_REVIEW.md`、`docs/issue-log/OPEN.md` |
| P0 | `packages/core/src/tools/`（bash / executor / 内置工具）、`packages/core/src/agent/loop.ts` |
| P0 | `packages/core/src/server/{http.ts,ws.ts,sessions.ts}` |
| P1 | `architecture.md`、`docs/API-STABILITY.md`、`packages/core/test/{tools,loop}.test.ts` |
| P1 | `docs/ai-framework/plans/2026-09-08-phase-aggressive-core-foundation.md`（S0–S7 契约，**只读，不改**） |
| P2 | `docs/issue-log/2026-09-07.md`（Windows 空回复案发记录） |

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/core/src/tools/`（bash 工具实现） | 修改 | A1-1/A1-2：shell 探测与 UTF-8 解码 |
| `packages/core/src/config/schema.ts` | 修改 | A1-1：新增 `bash.shell` 配置项（可选） |
| `packages/core/src/doctor/**` | 修改 | A1-1：doctor 报告实际使用的 shell |
| `packages/core/src/agent/loop.ts` | 修改 | A1-3：连续工具失败熔断 + 非空 finalText |
| `packages/core/src/tools/executor.ts` | 修改 | A1-4：参数校验错误带 schema 片段与最小示例 |
| `packages/core/src/server/{http.ts,ws.ts,sessions.ts}` | 修改 | A3：Origin/Host 白名单、一次性 token、WS 帧上限 |
| `packages/core/package.json` | 修改 | A3-3：playwright 移出 runtime dependencies |
| `packages/core/src/server/sessions.ts` | 拆分 | A4：hub 装配 / 订阅恢复 / 任务协调 |
| `packages/core/test/windows-bash.test.ts` | 新增 | A1 验收 |
| `packages/core/test/tool-failure-circuit.test.ts` | 新增 | A1 验收 |
| `packages/core/test/serve-security.test.ts` | 新增 | A3 验收 |
| `architecture.md`（Provider / Server 小节） | 修改 | A2/A3 结论落盘 |
| `.gitignore`、根 `package.json` | 修改 | A0 |

---

## 任务

### A0 — 仓库卫生与基线（Day 1 上午 · 同步点 S0 · 0.5 天）

- **Files：** `.gitignore`、根 `package.json`、删除 `.tmp-head-check/`
- **行为：**
  1. `git push origin main`，把 25 个只存在于本机的 commit 落到远程（备份 push 已授权）。
  2. 删除根目录 `.tmp-head-check/`（内含断链 node_modules，任何递归扫描都会刷 DirectoryNotFound），加进 `.gitignore`。
  3. 根 `package.json` 版本 `0.1.0` → `1.0.0`，与四个包对齐。
  4. 核对 `.gitignore` 是否覆盖 `dist-bundle/`、`release/`、临时目录。
- **Steps：** 上述四步 → `pnpm -r typecheck` → `pnpm test`，**把通过数与耗时记进 acceptance.md 作为全程基线**。
- **Commit：** `🔧chore(repo): 清理临时目录并对齐根版本号至 1.0.0（A0）`
- **完成后立刻通知乙**：S0 达成，可以各自开工。

---

### A1 — Windows 可用性 P0（Day 1–3 · 全阶段最高优先级）

**案发记录：** 会话 `20260907-032949-546d13`（检索今日 3 件时政要闻）跑满 25 步 `maxSteps`、`finalText` 为空、用户零回复。根因是 Windows 适配缺陷，**不是任务复杂度**。

#### A1-1 bash 工具的 shell 选择
- 现状：`spawn(command, { shell: true })` 在 Windows 实际走 cmd.exe，`ls`/`head`/`tail`/`pwd` 全部失败并反复烧步数。
- 目标：探测顺序 `config.bash.shell` > Git Bash（`GIT_BASH` 环境变量 / 常见安装路径）> cmd 回退；`harness2 doctor` 输出**实际使用的 shell**。
- **Commit：** `🐛fix(core): Windows bash 工具优先 Git Bash 并在 doctor 中报告（A1-1）`

#### A1-2 输出编码统一 UTF-8
- Windows 控制台默认 GBK，子进程输出必须按 UTF-8 解码，**乱码不得进模型上下文**。
- **Commit：** `🐛fix(core): 子进程输出统一 UTF-8 解码（A1-2）`

#### A1-3 熔断语义改造
- 在 `maxSteps` 之外增加「连续工具失败次数上限」（建议 5）；触发时 turn 以 `stopReason=tool_failures` 结束，并**必须**产出面向用户的 finalText，**禁止空回复**。同时评估默认 `maxSteps=25` 是否上调。
- **边界（勿与底座 S4 混淆）：** 本项是「连续失败熔断」（防烧步/防空回复），与底座 `interaction/retry-policy` 的「有界重试」（单次可重试错误自动重试）是两套独立机制。落点在 agent 控制流（`loop.ts`/turn 组装层），**不改 interaction/ 下的公共契约**。
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
- **审查：** 乙 + 只读子代理。重点：跨平台分支覆盖、进程树击杀、有无新增平台写死判断。
- **验收：** Windows 真机重跑一个同类联网检索任务，要么在步数内给出答案、要么给出明确失败说明；贴 `harness2 traj <会话目录>` 摘要为证。
- **关联：** 与 R2 终端轨 T2「Windows 四场景能力闸门」重叠，**合并做，不要改两遍**；结论同步给 T 轨 owner。
- **⚠️ 完成并合入 main 后立刻通知乙（同步点 S1）**，他要等这个才能格式化 core。

---

### A2 — 三端真实模型端到端验证（Day 4 · 1–2 天 · 需人类提供 key）

**现状：** provider 协议全部只过了 127.0.0.1 stub，DeepSeek / 智谱 GLM / Anthropic **从未实机验证**。这是产品最核心路径，发布前必须补。**开工前找人类要 key；无 key 则本阶段顺延，在 acceptance.md 登记「未执行」，不得用 stub 冒充。**

三端各过一遍：

| # | 项目 | 通过条件 |
|---|------|----------|
| 1 | `harness2 config check` | key 来源正确，**不得打印明文** |
| 2 | `harness2 chat` 一轮对话 + 一次工具调用 | SSE 流式渲染、tool_calls 组装、`reasoning_content`/`thinking` 展示、usage 统计、错误脱敏均正常 |
| 3 | undo/redo/审批/会话 | `/undo --dry-run` → `/undo`（文件复原）→ `/redo`（内容回放）→ 审批 ask 的 y/a/n → `/sessions` 搜索 → `/exit` |
| 4 | 记忆三态 | off / ask / auto + nudge 复盘；手工改坏 `§` 结构应被拒并生成 .bak |
| 5 | MCP 与插件 | filesystem server `mcp list` 探测 + `mcp__filesystem__*` 真实调用；第三方插件从零装载 + `plugin enable` |
| 6 | 桌面端 | 接真实 provider 走一遍对话 / 流式 / 审批 / undo（**找乙配合，他熟 desktop**） |

- **产出：** 当天 `docs/issue-log/<日期>.md` 逐项 pass/fail + 真实输出片段；三端行为差异（reasoning 字段、usage 帧、流式细节）写进 `architecture.md` 的 Provider 小节。
- **Commit：** `📝docs(core): 三端真机验证结论与 provider 差异记录（A2）`
- **验收：** 清单全绿或缺陷已登记；OPEN.md 中「待 key」条目**交由乙同步关闭**。

---

### A3 — serve 发布前安全加固（Day 5–6 · 2 天）

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
- **审查：** 安全类**必须两份审查**，重点确认没有把桌面端和 CLI 自己挡在门外。
- **验收：** `pnpm test` 全绿 + **由乙跑桌面 smoke** + `serve --port 0 --provider mock` 冒烟 + 手工 curl 越权被拒的真实输出。

---

### A4 — core/server 大文件拆分（Day 7 · A3 合入之后再做）

- `packages/core/src/server/sessions.ts` 73KB，是 R2 终端轨与桌面轨都要动的汇合点，**先拆它**：按 hub 装配 / 订阅恢复 / 任务协调 三块切开。顺带评估 `agent/loop.ts` 30KB、`interaction/runtime-journal.ts` 29KB 是否一并处理。
- **要求：纯搬运不改行为**；一次只拆一个文件；每次跑全量 `pnpm test` + `pnpm -r typecheck`；导出面变化同一提交同步 api-surface fixture。
- **审查：** 乙重点验证「零行为变更」——对拆分前后跑同一组测试并对比结果。
- **验收：** `sessions.ts` 单文件降到 25KB 以内，CI 全绿。
- **Commit：** `♻️refactor(core): 拆分 server/sessions.ts 为 hub/订阅恢复/任务协调（A4）`

---

### A5 — 阶段 9（IM 网关）独立复审（Day 7 · 半天）

- 阶段 9 曾判 fail，修复后一直没复审。重点：`startGateway` 生命周期、断线重连重订阅、`msg_seq` 递增。
- 复跑 `packages/gateway` 全部测试并贴输出。
- 结论按 `/accept-phase` 四段格式产出，**文件交由乙在 B5 统一归位**。
- **Commit：** `📝docs(gateway): 阶段 9 独立复审结论（A5）`

---

## 代码审查（阶段级，验收前）

**审查方：** 轨道 B 执行者（人工）+ 独立只读子代理。
**审查面：** 跨平台分支 / 进程树击杀 / 事件溯源不变量 / 密钥脱敏 / 审批不得弱化 / 快照范围 / 导出面快照同步 / 安全边界。
**结论：** ✅ / ⚠️（问题进验收表）/ ❌（阻塞，下放）

---

## 验收标准总表（轨道 A）

| # | 标准 | 通过条件 | 验证责任 |
|---|------|----------|----------|
| A-1 | 仓库卫生 | `git status` 干净；`origin/main` 与本地一致；根与四包版本一致 | 自动化 |
| A-2 | Windows shell 与编码 | `windows-bash.test.ts` 全绿；中文/emoji 无乱码 | 自动化 |
| A-3 | 工具失败熔断 | `tool-failure-circuit.test.ts`：`stopReason=tool_failures` 且 finalText 非空 | 自动化 |
| A-4 | 参数缺失可自纠 | error 含 schema 片段与最小示例 | 自动化 |
| A-5 | 进程树击杀未回归 | 超时/取消用例全绿（Windows） | 自动化 |
| A-6 | Windows 真机 | 同类联网检索任务不再空回复，附 traj 摘要 | 人类 |
| A-7 | 三端真机六项清单 | 逐项 pass 或登记缺陷；key 不落盘 | 人类签收 |
| A-8 | serve 鉴权 | `serve-security.test.ts` 全绿 + curl 越权被拒输出 | 自动化 + 手工 |
| A-9 | playwright 可选 | 无 playwright 环境 import 不报错、`browser_*` 返回指引 | 自动化 |
| A-10 | sessions.ts 拆分 | < 25KB 且拆分前后同组测试结果一致 | 自动化 + 乙复核 |
| A-11 | 阶段 9 复审 | 四段结论 + 网关测试真实输出 | 独立角色 |
| A-12 | 全量回归 | `pnpm test` 真实命中全绿 | 自动化 |
| A-13 | 代码审查 | 两份报告，P0/P1 清零 | 乙 + 子代理 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| Windows shell 探测在他人机器上路径不同 | 探测顺序可配置（`config.bash.shell` 最高优先级）+ doctor 输出实际 shell |
| 熔断阈值误伤长任务 | 阈值可配置；只统计**连续**失败；触发时给出可行动 finalText 而非静默结束 |
| 安全加固挡住自家客户端 | 完成即让乙跑 desktop smoke + CLI serve 冒烟 |
| 无 key 导致 A2 无法进行 | 顺延不阻塞 A3；登记「未执行」，token 充足时补做 |
| sessions.ts 拆分与 R2 两轨未来改动冲突 | 拆分前在群里同步 T/D 轨 owner；拆完当天合流 |

---

## 给接手 AI 的完整提示词（轨道 A 专属）

> 先复制总纲文末的通用提示词，再复制本段。

```
你负责 harness2 阶段 15-质量收口的【轨道 A：运行时与后端】，按 A0→A5 顺序执行。
只动这些路径：packages/core/src/{tools,agent,provider,server,doctor}/**、packages/core/test/**、
packages/gateway/**、architecture.md 的 Provider/Server 小节、根 package.json 的版本号（仅 A0）、.gitignore。
禁止碰：根 lint/prettier 配置、.github/**、packages/cli/**、packages/desktop/**、docs/** 与 README.md、
coding-standards.md、CODE_REVIEW.md（这些属于轨道 B）。

A0（先做，同步点 S0）：push main 备份；删 .tmp-head-check/ 并入 .gitignore；根版本 0.1.0→1.0.0；
跑 pnpm -r typecheck 与 pnpm test 记录基线通过数与耗时。

A1（最高优先级）：修 Windows 可用性四件事——bash 工具优先 Git Bash 并在 doctor 报告实际 shell；
子进程输出统一 UTF-8 解码；在 maxSteps 之外加「连续工具失败上限（建议 5）」且触发时必须产出非空 finalText；
工具参数缺失时返回 schema 片段与最小正确示例。新增 windows-bash.test.ts 与 tool-failure-circuit.test.ts，
并回归 tools.test.ts/loop.test.ts，特别确认超时与取消时 Windows taskkill /T /F 进程树击杀仍生效。
参照案发会话 20260907-032949-546d13（跑满 25 步、finalText 为空）。完成合入后通知轨道 B（同步点 S1）。

A2（需人类给 key，无 key 就顺延并登记「未执行」，不得用 stub 冒充）：DeepSeek/智谱GLM/Anthropic 三端
各跑六项清单（config check 不打印明文 / chat 一轮含工具调用 / undo-redo-审批-sessions / 记忆三态 /
MCP filesystem 与插件装载 / 桌面端一遍），逐项 pass-fail 写 issue-log，三端差异写 architecture.md Provider 小节。

A3：serve 加 Origin-Host 白名单与一次性 token；WS 帧上限对齐 HTTP 1 MiB 且超限断连记账；
playwright 从 core 的 runtime dependencies 移到可选依赖并保留未安装降级。新增 serve-security.test.ts。
安全类必须两份审查，并让轨道 B 跑一遍 desktop smoke 确认没挡住自家客户端。

A4（A3 合入后）：纯搬运拆分 packages/core/src/server/sessions.ts（73KB）为 hub 装配/订阅恢复/任务协调，
目标 <25KB，一次一个文件，每次跑全量测试，拆分前后同组测试结果必须一致。

A5：独立复审阶段 9 IM 网关（曾判 fail 未复审），重点 startGateway 生命周期、断线重连重订阅、msg_seq 递增，
按 /accept-phase 四段格式出结论，文件交轨道 B 归位。

每阶段收尾：pnpm -r typecheck + pnpm test 贴真实输出 → 轨道 B 人工审查 + 只读子代理审查 →
在 2026-09-09-phase-quality-closeout-acceptance.md 的轨道 A 表格填状态/证据/日期 →
在 docs/issue-log/<日期>.md 的「## 轨道A」小节追加四要素记录。OPEN.md 由轨道 B 统一维护，你的条目写在 issue-log 里请他同步。
```

---

## 残留手工验收清单（轨道 A）

1. Windows 真机手感：IME、滚动、Ctrl+C 中断、长输出截断。
2. 三端真机体验签收（人类，含桌面端一轮）。
3. serve 鉴权后，人类在自己机器上确认 CLI 与桌面仍能正常连上。
