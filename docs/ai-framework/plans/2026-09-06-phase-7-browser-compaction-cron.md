# 阶段 7：内嵌浏览器 + 上下文压缩 + 定时任务 → M2 v0.3 发布

> **状态：** ✅ 已完成——2026-09-06 编排者验收通过（独立审查 pass-with-fixes → 1 P1（cron run 审批旁路）+ 6 P2 修复 `5dc17d7`，含压缩摘要方向修正（尾部优先）与 cron 锁 O_EXCL 原子化；P2-7/8 登记不修。重跑证据：pnpm test **452 passed + 1 skipped**、typecheck 3 包 Done、抽查属实、chat mock 冒烟 exit 0。实现过程备注：Task 1-3 实现代理 + Task 4 编排者接手收尾（修复中断残留的测试 bug）+ Task 5-6 编排者代做留档）。
> **For agentic workers:** 按 Task 顺序执行；每 Task 测完再进下一 Task。
> **交接提示词**见文末「给接手 AI 的完整提示词」。
> **元规范:** `docs/ai-framework/phased-plan-driven.md`

**Goal:** 补齐 M2 三大件——agent 浏览器工具（资源严格管控）、上下文压缩（长会话可用性）、定时任务（hermes 式可靠调度）——并完成 v0.3 发布物料与发布前加固。
**Architecture:** 浏览器是 agent 的工具（Playwright 子进程，惰性加载，非桌面内嵌视图）；压缩是日志上的事件（摘要落盘可重建，Model-visible ⟺ logged 延伸到压缩）；调度器是 serve 内的常驻 tick + 文件锁（hermes 实证：at-most-once）。
**Tech Stack:** 现有栈；新增运行时依赖 `playwright`（浏览器工具，惰性 import；chromium 由 `harness2 browser install` / CI 步骤安装）。

---

## 前置阅读（必须）

| 优先级 | 文件 |
|--------|------|
| P0 | 本文件、`docs/MASTER-PLAN.md`（M2 定义） |
| P0 | `docs/research/2026-09-06-reference-analysis.md` §2.3（浏览器资源管控）§2.7（调度实证） |
| P0 | `packages/core/src/agent/loop.ts`（buildChatMessages/注入缝）、`session/types.ts`（事件扩展先例）、`server/http.ts`（信任域） |
| P1 | `docs/issue-log/OPEN.md`（M2 发布前加固项）、`CODE_REVIEW.md` |

**仓库路径：** `D:\AI_projects\harness2`（默认分支 `master`）
**基线分支：** 从 `master` 拉 `feat/phase-7-browser-compaction-cron`

---

## Global Constraints（冲突时以本节为准）

1. **契约扩展仅一处**：`SessionEventType` 增 `compaction/applied`（payload `{ summary: string; coveredUpToSeq: number }`，均必填校验）。其余 provider/loop/reader 语义不动。
2. **浏览器资源红线**：每会话至多 1 个浏览器上下文；全局并发 ≤2；空闲 5 分钟销毁；dispose/crash 写事件日志；页面只访问用户/模型显式给出的 URL（工具参数即 URL 来源，无自动爬取）。
3. **调度红线**：循环任务**先推进 next_run 再执行**（at-most-once，防 crash 连发）；跨进程 tick 文件锁；连续失败计数与退避；任务上限 50。
4. **密钥/隐私**：浏览器快照/截图不入 git（测试用本地 stub 页面）；定时任务指令与结果属用户数据（~/.harness2/cron）。
5. **发布动作不执行**：v0.3 发布物料备好，实际 publish/tag 待用户授权（沿用 Ph4 口径）。
6. **Git：** 每 Task 一提交；禁止 push。

---

## File Structure（预期变更）

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/core/src/session/types.ts` | 修改 | `compaction/applied` 事件 + 校验 |
| `packages/core/src/agent/compaction.ts` | 新建 | 触发估算（字符/4 vs config contextWindow×0.75）、aux 摘要调用、尾部保护（近 6 条消息原文） |
| `packages/core/src/agent/loop.ts` | 修改 | buildChatMessages 消费 compaction/applied（最新一条生效：覆盖区替换为摘要消息）；每 turn 前检查触发 |
| `packages/core/src/tools/predefined/browser.ts` | 新建 | browser_navigate/click/type/snapshot/screenshot/close（Playwright 惰性加载、会话级上下文、空闲销毁、并发上限、dispose 事件） |
| `packages/cli/src/index.ts` | 修改 | `harness2 browser install`（playwright install chromium）、`harness2 cron list/add/remove/run/history` |
| `packages/core/src/cron/{scheduler,jobs}.ts` | 新建 | jobs.json 持久化（~/.harness2/cron/jobs.json）、60s tick + 文件锁、at-most-once、失败 incidents（连续 3 次标记） |
| `packages/core/src/server/{http,sessions}.ts` | 修改 | serve 集成调度器；WS 通知帧 `{type:'cron', ...}` |
| `.github/workflows/ci.yml` | 修改 | chromium 安装步骤（browser 测试用） |
| `CHANGELOG.md`、`README.md`、版本号 | 修改 | v0.3.0 物料 |
| `packages/core/test/{compaction,browser,cron}.test.ts` | 新建 | 见各 Task |

---

## Task 1：上下文压缩

**Files:** `agent/compaction.ts`、loop/types 修改、`test/compaction.test.ts`

**行为:** 触发：turn 开始时估算活动消息字符/4 > contextWindow×0.75（contextWindow 取 roles.main 模型配置，缺省 128k）→ 以 roles.small 调 aux 摘要（输入=覆盖区消息的文本折叠，输出≤2000 字符）→ append `compaction/applied {summary, coveredUpToSeq}`（coveredUpToSeq = 倒数第 6 条用户/助手消息的 seq）。buildChatMessages：取**最新**一条 compaction/applied，把 `seq <= coveredUpToSeq` 的活动消息替换为一条 `{role:'user', text:'[对话摘要]\n' + summary}`，其余照旧（role 交替不变量由既有测试锁死，摘要消息后必接原尾部消息——若尾部首条是 user 则摘要消息与其合并为一条）。摘要失败 → 不落事件 + 本轮跳过压缩（下轮重试），turn 不中断。测试：触发/不触发/替换正确性/最新覆盖旧摘要/摘要失败跳过/不变量扩展（含摘要的请求可从日志重建）/role 交替。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core): 上下文压缩（阈值触发/aux 摘要/事件化可重建）`

## Task 2：浏览器工具

**Files:** `tools/predefined/browser.ts`、`test/browser.test.ts`、ci.yml

**行为:**
- 6 工具：`browser_navigate {url}`（http/https only）、`browser_click {ref}`、`browser_type {ref, text}`、`browser_snapshot`（aria 快照文本）、`browser_screenshot {path?}`（png，默认临时目录）、`browser_close`。ref = snapshot 输出的元素引用（aria ref），不暴露裸 selector。
- 资源管控（Global Constraints #2 落地）：`BrowserPool` 单例——每会话 1 上下文（ctx key = 会话 id）、全局并发 2（超限排队）、空闲 5min 销毁（定时器）、crash/销毁 → `tool/result` 附 dispose 说明（经既有工具事件链自动进轨迹）。
- 惰性：`import('playwright')` 动态加载；未安装 → 工具返回错误"请先运行 harness2 browser install"；工具注册不依赖 playwright 可解析（try import 包装）。
- 全部 unsafe（默认审批 ask）。
- 测试：`harness2 browser install` 后跑真实 headless chromium——用**本地 stub HTTP 页面**（node http 起一页含按钮/输入框），覆盖 navigate→snapshot→click→type→snapshot 断言、截图文件存在、close 后池清理、并发排队、未安装时的错误分支（mock import 失败）。CI：chromium 安装步骤。
- config：`browser: { enabled: true, idleDestroyMs?: 300000, maxConcurrent?: 2 }`（enabled=false 不注册）。

**Steps:** 1. 实现+测试（未安装分支必须可测）。2. Commit：`✨feat(core): 浏览器工具（Playwright/资源管控/轨迹 dispose）`

## Task 3：定时任务

**Files:** `cron/{scheduler,jobs}.ts`、cli、server 集成、`test/cron.test.ts`

**行为:**
- jobs.json：`{id, instruction, interval|"daily HH:MM", nextRun, enabled, failCount, createdAt}`；上限 50。
- scheduler：serve 内 60s tick（setTimeout 链）+ `~/.harness2/cron/.tick.lock` 跨进程锁（复用会话锁思路）；到点任务**先推进 next_run 落盘再执行**（at-most-once）；执行 = 独立临时会话跑 runTurn（roles.main + 全量工具 + cwd=serve root），产出写 `~/.harness2/cron/history/<id>/<ts>.md` + WS 通知帧 `{type:'cron', op:'finished', id, ok}`；失败 failCount+1，连续 ≥3 → enabled=false + incident 标记。
- CLI：`cron list/add "instruction" --every 5m|--at "daily 09:00"` / `remove <id>` / `run <id>`（立即执行一次）/ `history <id>`。
- 测试：next_run 推进先于执行（故意让执行挂掉，验证不补跑）/文件锁双进程单 tick/interval 与 daily 解析/上限/failCount 熔断/history 落盘。执行用 mock provider。

**Steps:** 1. 实现+测试。2. Commit：`✨feat(core,cli): 定时任务（at-most-once 调度/熔断/历史）`

## Task 4：信任域加固（M2 发布前项落地）

**Files:** `server/http.ts`、`server/ws.ts`、测试

**行为:** ①Origin 校验：存在 Origin 头且非 `file://` / `http://localhost:*` / `http://127.0.0.1:*` → 403（HTTP 与 WS upgrade 同规则）；②Host 校验：必须为 `127.0.0.1:<port>`（缺省放行无 Host 的非浏览器客户端）；③WS `maxPayload: 1MiB` 对齐 HTTP。登记于 OPEN.md 的加固项就此关闭；loopback token 认证留档不实现（desktop `--port 0` 随机端口已缓解）。

**Steps:** 1. 实现+测试（合法三种来源放行、恶意 Origin 403、Host 错误 403、WS 超限帧断开）。2. Commit：`🔒fix(core): 信任域加固（Origin/Host 校验/WS 上限）`

## Task 5：M2 发布物料（不执行发布）

CHANGELOG v0.3.0（自 diary 素材）、README 增浏览器/cron 章节、版本号 0.3.0、`harness2 browser install` 文档、OPEN.md 登记 v0.3 发布待授权清单。

**Steps:** 1. 物料。2. Commit：`🔧chore(release): M2 v0.3.0 发布物料`

## Task 6：整备与交接

architecture（压缩/浏览器/调度小节）、ROADMAP（P1-16/17/18 → ✅，M2 达成标注）、HANDOFF、diary、OPEN。

---

## 验收标准总表

| # | 标准 | 通过条件 |
|---|------|----------|
| 1 | 压缩 | 触发/替换/失败跳过/不变量（含 system 与摘要）测试通过 |
| 2 | 浏览器 | 本地 stub 页面全链（navigate→click→type→snapshot）+ 资源管控（并发/空闲销毁/close）测试通过；未安装分支可测 |
| 3 | 定时任务 | at-most-once/文件锁/熔断/解析/history 测试通过 |
| 4 | 信任域 | Origin/Host/maxPayload 测试通过 |
| 5 | 发布物料 | v0.3.0 CHANGELOG/README/版本号就绪；发布未执行 |
| 6 | 红线 | 契约扩展仅 compaction/applied；浏览器/截图/任务数据不入 git；密钥三不 |
| 7 | 单测/构建 | `pnpm test && pnpm -r typecheck` exit 0 |

---

## 风险与降级

| 风险 | 缓解 |
|------|------|
| Playwright 安装体积大（~130MB chromium） | 惰性依赖 + `browser install` 显式安装；CI 单独步骤缓存 |
| headless 测试在 Windows 本机抖动 | stub 页面纯本地 + 重试容忍；CI 与本地分离报告 |
| 摘要质量差导致上下文丢失 | 尾部 6 条原文保护 + 失败跳过；摘要 prompt 可迭代 |
| cron 执行占用主服务资源 | 临时会话串行 + 全局并发 1（调度执行不与用户 turn 抢浏览器池） |

---

## 给接手 AI 的完整提示词

将下面整段粘贴给实现 AI 即可开工：

---

你是 **harness2** 阶段 7 的实现代理。请**完整执行本阶段**，不要只写方案。

### 基线
- 目录：`D:\AI_projects\harness2`（默认分支 `master`）；从 master 创建并切换 `feat/phase-7-browser-compaction-cron`
- 已完成（勿重做）：阶段 1-6 均验收（内核/loop+工具/Provider+配置/CLI chat+undo-redo/服务化+桌面/记忆+分叉），当前 397 passed + 1 skipped
- 唯一实施计划：`docs/ai-framework/plans/2026-09-06-phase-7-browser-compaction-cron.md`
- 必读：本计划、`agent/loop.ts`、`session/types.ts`（事件扩展先例）、`docs/research/…§2.3/§2.7`、`AGENTS.md`

### 做
1. 严格按 Task 1→6 顺序执行：压缩 → 浏览器工具 → 定时任务 → 信任域加固 → M2 物料 → 整备
2. 每 Task 测试通过后规范 commit（gitmoji 中文，禁止 push）
3. 遵守 Global Constraints：契约扩展仅 compaction/applied；浏览器资源红线（1 上下文/会话、并发 2、空闲销毁、dispose 进轨迹）；调度 at-most-once；发布不执行只备料
4. Task 6 更新 architecture/ROADMAP（P1-16/17/18 → ✅、M2 标注）/HANDOFF/diary/OPEN

### 不做
- 桌面内嵌浏览器视图、语义记忆检索、IM 投递（Ph9）、自动更新
- 提交密钥；任何 `git push`

### 工作方式
1. 先跑基线 `pnpm test` 确认全绿再动工
2. 浏览器测试先 `harness2 browser install`（或 npx playwright install chromium），全部用本地 stub 页面
3. 证据优先：交卷前重跑 `pnpm test && pnpm -r typecheck`，粘贴真实输出
4. 简体中文回复；代码标识符原样

### 交卷
分支名、提交列表、验收表逐项自评（带命令与真实结果）、新增测试数、残留风险与未关闭项。

现在开始：读完本阶段计划，从 Task 1 执行到 Task 6。

---

## 残留手工验收清单

1. （用户 key）真实长会话触发压缩：摘要后对话连贯性人工评估
2. （真机）浏览器工具访问真实站点（如 example.com）截图与交互
3. （真机）cron 任务到点触发与 WS 通知在桌面端呈现
4. （授权后）v0.3.0 发布执行
