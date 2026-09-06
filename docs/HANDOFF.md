# HANDOFF — 交接入口（新维护者/AI 从这里开始）

> 更新：2026-09-06（阶段 8 实现完成：插件总线公开化 + MCP 客户端 + subagent——扩展生态三扇门打开，待 `/accept-phase` 验收） · 本文件是唯一交接入口，保持与实际状态同步。

## 1. 项目一句话

**harness2**：自研跨端 AI agent harness（CLI / 桌面 / IM 网关多形态），TypeScript monorepo。对标 opencode / hermes / deepseek-harness / grok（调研见 `docs/research/`）。

## 2. 当前状态快照

| 项 | 状态 |
|----|------|
| 默认分支 | `master`（注意：不是 main） |
| 开发分支 | `feat/phase-8-plugins-mcp-subagent`（阶段 8 工作在此；此前阶段各在其分支，1–7 在 feat/phase-7-*） |
| 阶段 1–7 | ✅ 全部完成并验收（内核 → loop+工具 → Provider+配置 → CLI chat+undo/redo → 服务化+桌面 → 记忆+分叉 → 浏览器+压缩+cron[M2]） |
| 阶段 8 | 🔶 实现+自测完成：Task 1–5 已提交（插件总线 manifest 权限/装载审批/disposer 逆序展开；MCP 客户端 stdio+url/退避重启/namespaced 工具；subagent 独立子会话/深度限制/取消传播；hub/serve/chat 装配 + CLI plugin/mcp 命令 + 桌面前缀渲染/子会话跳转），待 `/accept-phase` 验收 |
| **M1 v0.1 / M2 v0.3** | 🔶 代码/物料就绪；**发布动作未执行**——待人类授权：远程仓库 + push、npm 包名占用检查、`NPM_TOKEN` secret、推 tag（见 OPEN.md） |
| 未关闭事项 | 读 `docs/issue-log/OPEN.md`（保持为零上下文第一读；含真实 MCP server 实测、第三方插件样例清单） |
| 测试 | `pnpm test`（含 build）—— core 434+1 skipped + cli 37 + desktop 41 = **513 项（512 passed + 1 skipped**，`H2_GEN_LOOP_DEMO` 门控的 fixture 生成器非失败；loop.test/tools.test 偶发抖动已登记 OPEN.md，失败先重跑甄别） |
| 远程 | 无（未配置 origin；push 需人类授权） |

## 3. 文档地图（按阅读顺序）

1. `AGENTS.md` —— 协作规范入口：工作模式（编排者/子代理分工）、强制遵循、提交规范
2. `docs/ai-framework/workflow-delegation.md` —— 角色/流程细则（每阶段标准流程、验收规则、交接要求）
3. `docs/MASTER-PLAN.md` —— **总控计划**（里程碑 M1–M4、阶段 Ph2–Ph12、横切线）——批准后为全局实施依据
4. `docs/ROADMAP.md` —— 26 项功能清单 + 架构决策 D1–D6 + 明确不做
5. `architecture.md` —— 技术栈与核心不变量（阶段 3 起：含 Provider 缝 / Agent loop / 工具系统 / 配置体系小节）
6. `docs/ai-framework/plans/` —— 阶段计划（每份含零上下文交接提示词）
7. `docs/diary/YYYY-MM-DD.md` —— 每日日志（发版 release note 素材）
8. `docs/issue-log/` —— 问题日志（README 约定 + OPEN.md 未关闭索引）
9. `docs/research/2026-09-06-reference-analysis.md` —— 四参考项目实证调研

## 4. 如何继续开发（标准循环）

```
读 AGENTS.md + workflow-delegation.md
→ 读 OPEN.md 掌握未关闭项
→ 读下一阶段计划（docs/ai-framework/plans/）
→ 编排者派实现代理（用计划文末的交接提示词）
→ 编排者派只读审查代理 → P0/P1 修复 → 编排者验收（重跑证据）
→ 更新：计划状态 / ROADMAP / diary / issue-log / 本文件快照
```

## 5. 关键决策（详见 ROADMAP D1–D6）

- TS/Node ≥22 + pnpm monorepo；Electron+React 桌面（P1）
- 会话 = append-only JSONL 事件日志（唯一事实源，Model-visible ⟺ logged）；SQLite 只做索引（后期）
- 撤回/分叉 = 同一日志上的投影操作（undo 为主、fork 为辅、grok 三模式为增强）
- 自研轻量插件总线，不引 Cordis；文件快照不依赖 git
- QQ 机器人走官方 Bot API v2（用户已注册）；不做个人号逆向

## 6. 环境与命令

- Node ≥22（实测 v22.23.0）、pnpm 11（实测 11.13.0）、Windows + Git Bash
- `pnpm install` → `pnpm test`（= build + test）→ `pnpm -r typecheck`
- 试轨迹：`node packages/cli/dist/index.js traj packages/core/fixtures/demo-session`（阶段 1 手写样例）；`node packages/cli/dist/index.js traj packages/core/fixtures/loop-demo`（阶段 2 agent loop 实跑生成的会话）
- 查配置：`node packages/cli/dist/index.js config check`（`--root`/`--home` 可重定向路径；key 来源只显示 auth.json / env:XXX / **missing**，不显示明文）
- **服务冒烟（阶段 5）**：`node packages/cli/dist/index.js serve --port 0 --provider mock`——stdout 一行 JSON 端口 → `curl http://127.0.0.1:<port>/api/sessions` / WS `ws://127.0.0.1:<port>/ws`
- **桌面冒烟（阶段 5）**：`pnpm --filter @harness2/desktop smoke`——无头冒烟输出 `{ok,port,rendererLoaded,bridgeReady}`；打包后 `packages/desktop/release/win-unpacked/harness2.exe --smoke` 同样可验；GUI 交互（拖拽手感/多会话实机体验）待真机
- **chat 冒烟（阶段 4）**：`node packages/cli/dist/index.js chat --provider mock --root <临时目录>`——演示 write+read 两轮工具 → `/undo --dry-run` → `/undo`（创建的文件被删）→ `/redo`（内容回放）→ `/sessions` → `/exit`
- **记忆冒烟（阶段 6）**：config 写 `"memory": {"mode":"auto"}` 后 `harness2 chat` 让模型记一条偏好 → `harness2 memory show` 查看；改 `"mode":"ask"` → 让模型记忆 → `harness2 memory pending` → `approve <id>` 落盘；`off`（缺省）时模型看不到 memory 工具
- **插件/MCP/subagent 冒烟（阶段 8）**：①插件：把样例插件放 `~/.harness2/plugins/<name>/`（manifest + ESM index.js）→ `harness2 plugin list` 看权限清单 → `plugin enable <name>` 确认 → config `plugins.allow` 出现该名 → chat/serve 重启后工具可调；②MCP：config 写 `"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}}` → `harness2 mcp list` 探测连接与工具数 → chat/serve 里出现 `mcp__filesystem__*` 工具；③subagent：mock REPL `harness2 chat --provider mock` 让模型派子任务（或真实模型说"派子代理去做 X"）→ 工具行 `subagent_start` → 子会话独立 traj（桌面端工具行「子会话 ↗」跳转）
- **分叉冒烟（阶段 6）**：`harness2 chat --fork <id>`（或 REPL `/fork [seq]`）→ banner 标血缘与复制事件数 → 原会话零改动（traj 对比）；serve 模式 `POST /api/sessions/:id/fork` / WS op `fork`
- 注意：cli 包名已改为 `harness2`（npm 发布名），根工作区更名为 `harness2-monorepo`（避免重名）；`pnpm --filter harness2` 指向 packages/cli
- 注意：`pnpm --filter harness2 test` 在干净检出需先 build（根脚本已串 build）
- 跑一次 loop 演示：任意 node 脚本 `runTurn(dir, { provider, tools, cwd, userText })`；provider 可用 `createProvider(config, role)`（真实协议，需 stub/真实端点）或 `new MockProvider(script)`（见 `packages/core/test/loop.test.ts`、`packages/core/test/providers.test.ts` 的 E2E 用例）

## 7. 已知坑

- Windows 下 tsc/commit 有 CRLF warning，无害
- 会话日志写入依赖「换行即提交」语义（未以 \n 结尾的尾行视为未提交丢弃），改 writer 前先读其测试
- **redo 的投影复活依赖 reason 前缀 `redo` 的标记链语义**（按 `rewindToSeq+1` 精确中立化被重做的 undo 标记）：手工构造 rewind 标记时不要用 `redo` 前缀，除非明确想触发复活（见 reader.ts computeProjection 注释与测试）
- **bash 副作用不进文件快照**（write/edit 才有 before/after）：对外已如实声明（README、chat /help），改快照范围时同步这两处
- **真实 API 未实机验证**（阶段 3 起）：provider 协议全部经 127.0.0.1 stub 测试，DeepSeek/智谱/Anthropic 真实端点行为（含 reasoning 字段、usage 帧、流式细节的厂商差异）与 M1 chat 全流程待用户配置 key 后按 `docs/issue-log/OPEN.md` 清单手工验证
- 密钥只在 `~/.harness2/auth.json`（不入 git，.gitignore 已含 `auth.json`）与环境变量；config/日志/错误消息里出现疑似密钥一律经 `redactSecrets` 脱敏——新增错误路径时记得过这个闸门
- 外部脚手架（.opencode/、ai-framework 文档）由项目负责人维护，更新时注意与 `workflow-delegation.md` 的角色约定保持一致
- CI（ci.yml）与 release.yml 本地只做过 YAML 语法校验，Actions 真实运行待远程仓库与 push 授权（见 `docs/issue-log/OPEN.md`）。release.yml 的 publish 步骤为**条件跳过**语义：无 `NPM_TOKEN` → 明确 notice 跳过；有 token 但发布失败 → workflow 红（2026-09-06 审查修复 P1-1，勿再加 continue-on-error）
- chat 审批内联提示：ask 等待期间下一行输入即答案（含以 / 开头的行）；取消等待用 Ctrl+C / Ctrl+D（ask 与 turn 取消信号竞速，abort 后按拒绝处理且不再吞行）——改 chat.ts 的 askUser/answerResolver 前先读 chat-cancel.test.ts
- grep 工具优先 spawn ripgrep，CI 镜像若未装 rg 会自动回退纯 JS 扫描（行为一致但大目录更慢）
- **记忆文件（~/.harness2/memories/）属用户私有数据**：绝不入 git（测试全临时目录）、不出现在错误消息出口；写入按 `§` 条目结构 + 字符硬预算（memory 2200 / user 1375）校验，改 store.ts 前先读 memory.test.ts（round-trip/漂移/原子批量语义都在那）
- **memory/snapshot 事件 = ChatRequest.system 的唯一来源**（Model-visible ⟺ logged 扩展到 system）：loop 会话内冻结（活动投影已有快照就复用不重读文件）——改注入逻辑前先读 loop.test.ts 的「记忆开关与冻结注入」组
- **nudge 复盘不落主会话日志**（一次性临时会话预置系统提示、跑完即删）；计数在 SessionHub（turn 内调过 memory 工具即归零）；改 hub 的 buildTurnTools/bumpNudge 前先读 nudge.test.ts
- **分叉不复制 rewind/marker 与影子事件、不迁移文件快照**（新会话 undo 从零开始，README 已注明）；改 fork.ts 前先读 fork.test.ts（字节级零变化/投影一致断言在那）
- **sandbox preload 不能 require 相对模块**：IPC 通道名在 preload.ts 内联，与 shared/protocol.ts 的同名常量有静态一致性测试（test/protocol.test.ts）——改通道名先看这个测试
- **pnpm 11 的构建脚本白名单/overrides 在 pnpm-workspace.yaml**（allowBuilds / overrides），package.json 的 pnpm 字段已被忽略；electron 二进制下载失败可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重跑 install
- **electron-builder 26 需要 @electron/get ≥4**（ElectronDownloadCacheMode）：已用 workspace overrides `@electron/get: ^5.1.0` 钉住，动依赖版本时注意
- **打包后 serve 子进程 = esbuild 单文件 bundle**（packages/cli/dist-bundle/harness2-cli.cjs，经 extraResources）：jsonc-parser 必须走 ESM 入口（bundle 脚本带 `--alias:jsonc-parser=jsonc-parser/lib/esm/main.js`，UMD 运行时动态 require 打不进单文件）；改 cli 依赖后先 `pnpm --filter harness2 bundle` 并本地跑一次 bundle serve 验证
- **插件 v1 进程内非隔离（阶段 8）**：manifest 权限是 API 层约束不是强制隔离，恶意代码可绕过——改插件层时不得弱化 allow 审批与权限清单展示；worker/isolate 隔离留档评估（见 architecture.md 插件小节）
- **MCP 工具名 sanitize 后撞名 = 后者跳过**（`mcp__<server>__<tool>` 必须满足工具名约束 ^[a-z0-9_]+$，config 层拦 server 名，tool 名非法字符折叠 `_`）；MCP server 名在 config 校验里必须匹配 ^[a-z0-9_]+$
- **subagent 深度红线的实现点**：`buildSubagentChildTools` 重挂时血缘重绑（parentSessionId=子会话 id、depth+1）——改 subagent.ts 前先读 subagent.test.ts（孙会话血缘/深度断言在那）；hub 侧每次 turn 按会话 id 重绑（buildTurnTools），改 SessionHub 装配前先读 assembly.test.ts
- **阶段 8 新增依赖 `@modelcontextprotocol/sdk`（锁 ^1.30.0）**：客户端只依赖 listTools/callTool 两面（适配层薄封装，SDK 升级先跑 mcp.test.ts）；stateless Streamable HTTP server 夹具每请求新建 transport（web-standard 传输禁止跨请求复用）
