# HANDOFF — 交接入口（新维护者/AI 从这里开始）

> **🧭 现状（2026-10-31 FIX-1 修复轮后，先读这段）**
>
> - **活跃四包**：`@harness2/core` / `@harness2/gateway` / `harness2`(cli) / `@harness2/zcode-adapter`。旧壳 `packages/desktop` / `packages/ui-shared` / `packages/web` 已于 **2026-10-24 退役**（ZS6-T4 案 B，537 文件删除，归档 tag `pre-zs-retirement`）；产品桌面端 = **ZCode 壳 + harness2 内心**（出包通道 `scripts/zs6/zs6-pack.ps1`，本地出包不入 CI）。
> - **阶段线**：ZS 程序（「ZCode 壳 + harness2 内心」，总纲 `docs/ai-framework/plans/2026-10-20-zs-shell-migration-program.md`）**ZS1–ZS6 全部完成 ✅**（ZS6 收口 = T0–T6 + T4 案 B 旧壳退役 + win 安装包终版 + push CI run `40047614218` 绿；仅剩 V9 人类终验）→ **FIX-1 优化分析修复轮完成**（2026-10-31，计划 `docs/ai-framework/plans/2026-10-31-phase-analysis-fixes-round.md`，14 条发现 13 条直接修复 + F1 单独立计划）。
> - **基线数字（编排者 2026-10-31 终验取证，时点 = FIX-1 末提交 `af36d86`；⚠️ 全量绿门以在途 WIP 收口为准，见下条）**：生产依赖 audit **0 漏洞**（升级前 20：1C/6H/11M/2L）；dev 侧 19 条全在 vitest 工具链（不挡门）；adapter 全量 **159 用例绿**（本地 scratch 环境）+ CI 子集 **23 用例绿**（16 文件依赖 ZS1 scratch 区，CI 显式排除）；gateway **40 用例绿**；core cron **17 用例绿**；本机空闲 `pnpm -r build` 冷 **5.6s**。
> - **⚠️ 在途并行 WIP（诚实登记）**：另一会话在 `fix/perf-startup-render` 分支有 **30+ 文件未提交改动**（core serve/session/tools、cli render 等），当前为**破损中间态**（typecheck 3 错、core 测试局部红）——全量绿门以其收口为准；对 WIP 文件不做任何 git 操作（不 add / 不 stash / 不 checkout）。
> - **待人类事项**：① V9 装机验收 + tag/Release 授权（ZS6 尾巴，材料 `docs/ai-framework/plans/zs6-release-draft.md`）③ 并行会话 WIP 处置（`stash@{0}`，评估结论见 2026-10-31 日志：值得收但需收尾波次）④ F1 拆解计划排期（`docs/ai-framework/plans/2026-10-31-phase-cli-harness-decompose.md`）。（原 ② push 授权已完成：FIX-1 已合 main 并 CI 全绿。）
>
> 开放项一律看 `docs/issue-log/OPEN.md`（只读它即可掌握全部未完成项）。

## 0. 本文件哪些是现状、哪些是历史

| 节                                                                                  | 性质                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 项目一句话 / §2 状态快照 / §3 环境与命令 / §4 文档地图 / §5 标准循环 / §6 已知坑 | **现状**（2026-10-31 对齐四包现实）                                                                                                                                                                                                          |
| §7 历史档案                                                                         | **历史**：ZS6 收口时点快照、Z 程序（旧桌面/Web 壳）、2026-09 契约冻结与 I1 双轨、退役包相关坑。**现状一律以 §2 为准**；本文档 2026-10-31 之前的完整旧版（含六包时代的快照表/命令表/文档地图）经 git 历史可查（`git log -- docs/HANDOFF.md`） |

## 1. 项目一句话

**harness2**：自研跨端 AI agent harness。当前形态 = **四包 monorepo（core / gateway / cli / zcode-adapter）+ ZCode 壳装配桌面端**；CLI 为自研 TUI（next 渲染层 + piped readline），桌面端经 zcode-adapter 把 harness2 内心装进 ZCode 壳（Apache-2.0 上游，patch 纪律见 `docs/ai-framework/upstream-resync.md`）。对标 opencode / hermes / deepseek-harness / grok（调研见 `docs/research/`）。

## 2. 当前状态快照（2026-10-31）

| 项           | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支         | **FIX-1 已闭环（2026-10-31）**：分支 CI 全绿（run 41161248751）→ `--no-ff` 合入 main（`5a62217`）→ main CI 全绿（run 41161592705，quality/三平台 test/audit/pages）。主线 `main` = `origin/main`。分支 `fix/perf-startup-render` 保留作记录。并行会话 WIP 在 `stash@{0}`（人类指令 stash；恢复 `git stash pop`）。分支策略沿旧例：长期 `main`，阶段工作开 `feat/phase-*` / `fix/*` 分支，全绿后 `--no-ff` 合入                                                                                                                                                                                                                                  |
| 活跃包       | **core / gateway / cli（包名 `harness2`）/ zcode-adapter** 四包；`pnpm -r` 即四包                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 退役包       | `desktop` / `ui-shared` / `web`（2026-10-24 删除，归档 tag `pre-zs-retirement` 可复原）；任何文档提及六包（含 ui-shared/web 组件）的均为历史口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 阶段线       | 阶段 1–15（内核→v1.0.0）→ R2/I1/P0–P9（2026-09）→ Z 程序（旧壳 GUI 复刻，已随退役终结）→ **ZS 程序 ZS1–ZS6 ✅**（ZCode 壳迁移）→ **FIX-1 修复轮 ✅**（2026-10-31，10 提交：`0f5b004` core 升级 MCP SDK 1.32.2/zod 4.6.7、`f782b31` gateway 对齐 TS7/vitest5+30s 超时、`cf66c77` adapter 声明 core 依赖去硬编码、`2fab9ac` 清退役壳 eslint/electron 配置、`8bc6a4e` gateway vitest 配置纳入 tsconfig、`9c234ab` cron 月末断言修复、`5531110` CI 拆 quality/audit job+生产依赖审计门、`af36d86` adapter test:ci 去 CI 假绿、`af2d983` tsc 增量构建（试验）→ `77439ae` **回退**——增量 tsbuildinfo 被并行会话 WIP 文件增删污染，静默产出残缺 dist） |
| 测试与门禁   | 实测（2026-10-31，时点 `af36d86`）：adapter 159 绿（本地 scratch）+ CI 子集 23 绿；gateway 40 绿；core cron 17 绿；audit 生产依赖 0 漏洞（dev 19 条 vitest 工具链不挡门）；`pnpm -r build` 冷 5.6s。**⚠️ core/cli 全量与 typecheck 当前受在途 WIP 影响（破损中间态），全量绿门以 WIP 收口为准**                                                                                                                                                                                                                                                                                                                                                 |
| CI           | `.github/workflows/ci.yml` 三 job：**quality**（typecheck + eslint + prettier，单跑）+ **test**（三平台 matrix：core/gateway/cli/adapter test:ci）+ **audit**（`scripts/audit-gate.mjs` 生产依赖漏洞门，critical/high 红灯）+ pages（main push 部署 docsify）。adapter 在 CI 只跑无 scratch 依赖子集（`vitest.ci.config.mts`，4 文件 23 用例）——完整测试须本地 scratch 环境，CI 不再产出假绿                                                                                                                                                                                                                                                    |
| API 稳定承诺 | `docs/API-STABILITY.md`（semver 政策 + 导出面快照更新流程）；core 导出面变更必须同步 `packages/core/test/fixtures/api-surface-baseline.json`（同提交更新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 未关闭事项   | 读 `docs/issue-log/OPEN.md`（零上下文第一读；已决策/已关闭/已知限制归 `docs/issue-log/DECISIONS.md`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 3. 环境与命令（四包现实）

- Node ≥22（实测 v22.23.1）、pnpm 11（实测 11.13.0）、Windows + Git Bash
- 全量命令（根 `package.json`）：
  - `pnpm install` → `pnpm build`（= `pnpm -r build`，本机空闲冷 5.6s）
  - `pnpm typecheck`（= `pnpm -r --no-bail run typecheck`）
  - `pnpm lint`（= `eslint . && prettier --check .`）
  - `pnpm test`（= `pnpm -r build` + 四包 vitest；已 build 后只跑测试可 `pnpm -r --no-bail run test`）
- 分包测试：
  - `pnpm --filter @harness2/core test` · `pnpm --filter @harness2/gateway test` · `pnpm --filter harness2 test`（cli 的包名就是 `harness2`，不能写 `@harness2/cli`）
  - **adapter**：`pnpm --filter @harness2/zcode-adapter test` 走 `scripts/zs1-guard.mjs` 门控，**依赖本机 ZS1 scratch 构建区**（`D:/AI_Projects/harness2-zs1-build/ZCode`），无 scratch 环境会 SKIP——完整 159 用例只能本地 scratch 跑；**无 scratch 环境（含 CI）用 `pnpm --filter @harness2/zcode-adapter test:ci`**（`vitest.ci.config.mts`：无 scratch 依赖的 4 文件 23 用例；新增含 `@zcode/*` 依赖的测试文件不要加进 include）
- 生产依赖漏洞门：`node scripts/audit-gate.mjs`（只读 `pnpm-lock.yaml`，无需 install；critical/high 红灯、moderate/low 与 dev 只报告；审计走 `--registry=https://registry.npmjs.org`，npmmirror 无 audit 端点；2026-10-31 实测生产 0 漏洞、dev 19 条全在 vitest 工具链）
- **构建先行（dist 会过期）**：任何引用 `@harness2/core` / `@harness2/gateway` 实现的审查、验收或测试，先 `pnpm -r build`——各包互相引用 dist，本地单独跑测试会静默用旧产物；**禁止对可能过期的 dist 下结论**
- CLI 冒烟（零 key）：`node packages/cli/dist/index.js chat --provider mock --root <临时目录>`；`doctor`（`--probe` 实连 MCP）；`config check`（脱敏）；`serve --port 0 --provider mock`（stdout 一行 JSON 端口）
- 性能基线：`pnpm build && pnpm bench`（10 万事件合成日志；预算表见 architecture.md）
- 注意：`packages/cli` 的 npm 包名是 `harness2`，根工作区名 `harness2-monorepo`；`pnpm --filter harness2` 指向 packages/cli

## 4. 文档地图（按阅读顺序）

1. `AGENTS.md` —— 协作规范入口：工作模式（编排者/子代理）、强制遵循、提交规范
2. `docs/ai-framework/workflow-delegation.md` —— 角色/流程细则（交接必读）
3. **`docs/refs/README.md`** —— 参考项目分析强制规范（改上层壳前必读六步流程）。四份基线：`refs-grok-build.md`（CLI 交互完全复刻）、`refs-zcode.md` + `refs-zcode-layout.md`（GUI 视觉/布局完全还原）、`refs-deepseek-harness.md`（页面布局既有参考）、`refs-hermes-agent.md`（功能完整性补齐）
4. **`docs/ai-framework/plans/2026-10-31-phase-analysis-fixes-round.md`** —— FIX-1 修复轮计划（14 条发现/13 修复/F1 立计划；本轮提交范围 `f3ccac6..af36d86`）
5. **`docs/ai-framework/plans/2026-10-31-phase-cli-harness-decompose.md`** —— F1-DECOMP：next-shell 闭包工厂拆解计划（**只立计划未实施**，排期待人类）
6. **ZS6 收口材料**（V9 装机验收用）：`docs/ai-framework/plans/zs6-release-draft.md`（tag 三选一 + Release 文案粘贴即用 + 装机验收 9 项清单）· `zs6-pack-report.md`（出包报告与产物 SHA256）· `zs6-brand-checklist.md`（品牌装配 11 处 patch 红线）· `zs6-review.md`（独立审查闭环）· `zs6-retirement-proposal.md`（旧壳退役案）
7. **`docs/ai-framework/upstream-resync.md`** —— ZCode 上游 patch 纪律（scratch 装配区 `D:/AI_Projects/harness2-zs1-build/ZCode`，diff 落 `docs/patches/zs-shell-patches.patch`）
8. `docs/issue-log/` —— `README.md`（元约定）+ `OPEN.md`（**未关闭索引，每天第一读**）+ `DECISIONS.md`（已决策/已关闭/已知限制/退役失效归档）
9. `docs/API-STABILITY.md` —— API 稳定承诺与导出面快照流程 · `docs/RELEASE-CHECKLIST.md` —— 发布动作清单（③ 待人类授权项）
10. `docs/SMOKE-TEST.md` —— 冒烟测试手册（2026-10-31 起钉四包基线；桌面验收走 ZS6 链路）
11. `architecture.md` · `docs/ROADMAP.md` · `docs/MASTER-PLAN.md` —— 技术栈/不变量与里程碑记录（M1–M4 与阶段 1–15 为历史口径，现状看 §2）
12. `docs/ai-framework/plans/` —— 全部阶段计划（每份含零上下文交接提示词）。活跃：ZS 总纲 `2026-10-20-zs-shell-migration-program.md` 及 ZS1–ZS6 各阶段计划；历史：Z 程序（2026-10-10）/ V 总纲（2026-09-17）/ R2 与 I1 双轨 / 阶段 1–15（2026-08~09）
13. `docs/tui-parity/`（对照报告）+ `scripts/tui-parity/`（ConPTY 抓屏对照台，Python venv，不进 packages 依赖）

## 5. 如何继续开发（标准循环）

```
读 AGENTS.md + workflow-delegation.md
→ 读 OPEN.md 掌握未关闭项（已决策类查 DECISIONS.md）
→ 读下一阶段计划（docs/ai-framework/plans/）；大块工作先写阶段计划再实现
→ 编排者派实现代理（用计划文末的交接提示词）
→ 编排者派只读审查代理 → P0/P1 修复 → 编排者验收（重跑证据）
→ 更新：计划状态 / issue-log（当日日志 + OPEN.md）/ 本文件快照
```

## 6. 已知坑（现行有效，四包）

- Windows 下 tsc/commit 有 CRLF warning，无害
- **会话日志写入依赖「换行即提交」语义**（未以 \n 结尾的尾行视为未提交丢弃），改 writer 前先读其测试
- **redo 的投影复活依赖 reason 前缀 `redo` 的标记链语义**：手工构造 rewind 标记时不要用 `redo` 前缀，除非明确想触发复活（见 reader.ts computeProjection 注释与测试）
- **bash 副作用不进文件快照**（write/edit 才有 before/after）：对外已如实声明（README、chat /help），改快照范围时同步这两处
- **core 测试固定占用端口 `127.0.0.1:46213`**（`packages/core/test/fork.test.ts` 三例）：本机正跑 `harness2 serve --port 46213` 会 EADDRINUSE（技术债，建议改 `--port 0`）
- **chat 审批内联提示**：ask 等待期间下一行输入即答案（含 `/` 开头行）；取消用 Ctrl+C / Ctrl+D——改 chat.ts 的 askUser/answerResolver 前先读 chat-cancel.test.ts
- grep 工具优先 spawn ripgrep，无 rg 自动回退纯 JS 扫描（行为一致但大目录更慢）
- **记忆文件（~/.harness2/memories/）属用户私有数据**：绝不入 git、不出现在错误出口；写入按 `§` 条目结构 + 字符硬预算（memory 2200 / user 1375）校验
- **memory/snapshot 事件 = ChatRequest.system 的唯一来源**（Model-visible ⟺ logged）：改注入逻辑前先读 loop.test.ts 的「记忆开关与冻结注入」组
- **nudge 复盘不落主会话日志**（临时会话跑完即删）；改 hub 的 buildTurnTools/bumpNudge 前先读 nudge.test.ts
- **分叉不复制 rewind/marker 与影子事件、不迁移文件快照**：改 fork.ts 前先读 fork.test.ts
- **打包后 serve 子进程 = esbuild 单文件 bundle**（packages/cli/dist-bundle/harness2-cli.cjs）：jsonc-parser 必须走 ESM 入口（bundle 脚本带 `--alias:jsonc-parser=…`）；改 cli 依赖后先 `pnpm --filter harness2 bundle` 并本地跑一次 bundle serve 验证；**bundle 必须 `--external:playwright`**（browser 工具进 core 导出图后 chromium-bidi require 打不进 cjs 单文件）
- **插件 v1 进程内非隔离**：manifest 权限是 API 层约束不是强制隔离——改插件层时不得弱化 allow 审批与权限清单展示
- **MCP 工具名 sanitize 后撞名 = 后者跳过**（`mcp__<server>__<tool>` 须满足 ^[a-z0-9_]+$；server 名在 config 校验同规则）
- **MCP SDK 已升级至锁 ^1.32.2 / zod ^4.6.7（FIX-1 `0f5b004`，清 high/critical）**：客户端只依赖 listTools/callTool 两面，SDK 升级先跑 mcp.test.ts
- **subagent 深度红线的实现点**：`buildSubagentChildTools` 重挂时血缘重绑——改 subagent.ts 前先读 subagent.test.ts；hub 侧每次 turn 按会话 id 重绑，改 SessionHub 装配前先读 assembly.test.ts
- **导出幂等依赖固定 mtime**（2000-01-01；zip DOS 时间仅支持 1980-2099）；**importReplay 有 256 MiB 解压上限**（双闸门，`maxDecompressedBytes` 可覆盖）；core 运行时 zip 依赖 `fflate`——改 export.ts 前先读 export.test.ts 与 bench.test.ts
- **skills 列表不落事件**（唯一事实源 = 磁盘目录，每 turn 重扫、turn 内冻结）：改注入逻辑前先读 skills.test.ts
- **时序敏感测试的写法约定**：并行/取消类断言优先用事件相对时序而非绝对墙钟上限；必须用墙钟时给足余量并注释依据
- **公开导出面变更必须同步快照基线**：改 `packages/core/src/index.ts` 导出后跑 `pnpm build && H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts` 并在同一提交更新 fixture——删除/改名是 breaking（走 major），流程见 `docs/API-STABILITY.md`
- **终端只有一个 TUI**：CLI 只有 `src/tui/next/**`（TTY）与 piped readline（非 TTY/CI）两条路，**不要再引入 React/ink**；**终端宽度必须用 `displayWidth`/`charWidth`**（把 `.length` 当显示宽度会 CJK 错位）；渲染层改动必须补**版面级断言**并做变异验证
- **抓屏对照台**：`scripts/tui-parity/` 产物是「ConPTY 抓屏 + 本地重绘」**不是系统截图**；grok 侧每跑一次消耗额度（`--allow-grok` 显式授权）；抓屏产物会进 prettier 门禁
- **别用 stdin 管道验证 prettier**（不加载项目配置，会得假结论）；对照基线用 `git checkout <ref>` 后跑 `prettier --check .`
- 密钥只在 `~/.harness2/auth.json`（不入 git）与环境变量；config/日志/错误消息里疑似密钥一律经 `redactSecrets` 脱敏——新增错误路径记得过这个闸门
- **pnpm 11 的构建脚本白名单/overrides 在 pnpm-workspace.yaml**（allowBuilds / overrides），package.json 的 pnpm 字段被忽略
- CI：`.github/workflows/**`、根 `package.json`、`tsconfig.base.json`、eslint/prettier 配置属**编排者独占**，并行轨不得改；release.yml publish 步骤为条件跳过语义（无 `NPM_TOKEN` → notice 跳过）
- **1.0 发布动作清单在 `docs/RELEASE-CHECKLIST.md` ③**（npm publish/NPM_TOKEN 等）——待人类授权，勿自行执行

## 7. 历史档案（以下各节为历史程序记录，现状以 §2 为准）

> **🧭 2026-10-23 时点快照（ZS6 收口，原文保留）**：主线=**ZS 程序**「ZCode 壳 + harness2 内心」。进度：ZS1–ZS3.5 ✅ → ZS4 ✅ → ZS4.5 全系 ✅（用户真机复验 2026-10-22）→ **ZS5 观测性 ✅**（双独立审查 P0=0/P1 全清偿，含 ZS4 V8 六次欠账）→ **ZS6 全部执行完毕**——T0–T6 ✅ / T4 案 B 退役已执行（2026-10-24：旧 desktop/ui-shared/web 537 文件删除，归档 tag `pre-zs-retirement`；CI=四包 test+pages，release.yml 产物改手动附加）/ win 安装包终版就绪 / push CI 全绿（run `40047614218`）。剩=仅 V9 人类终验：装机验收（9 项清单 `zs6-release-draft.md`）→ 过则 tag/Release。
> **关键门与纪律（ZS 线）**：① UI patch 基线=**11 处**（P1 desktopRuntimeEnv / P2 ProviderCardSections 获取模型面板 / P3 settingsNavigation 隐藏 usage+remoteDevices / P4 预设卡表置空 / P5 空组标题 / P6 Help 运营外链隐藏 / P7 packaged 应用名 / P8 关于窗+版权 / P9 shared 托盘·菜单标签 / P10 UI i18n help.about / P11 index.html 壳标题；明细 `docs/ai-framework/plans/zs6-brand-checklist.md`；diff 落 `docs/patches/zs-shell-patches.patch`，scratch 载体提交 `247b4c0e`+审查闭环 `48915dd1`），再+1 须人类拍板；② `subscribeSessionsIndexV4` 现为轮询 diff 降级，core 事件原语提案已获批并实施（6cba49d）；③ 子代理声称改文件必过编排者 `git diff` 独立核验（2026-10-22 两例谎报实证，issue-log §14）；④ 一切门禁/矩阵/soak 命令清单在各阶段计划「验收表」。

> **🚨 历史（2026-10-11 立项，已随 2026-10-24 旧壳退役终结）：Z 程序 —— GUI（桌面/Web）按 ZCode 完全还原 + 能力补齐** ——
> 总纲 [`2026-10-10-phase-zcode-ui-overhaul.md`](ai-framework/plans/2026-10-10-phase-zcode-ui-overhaul.md)（Z0–Z7）·
> **功能总账（每项状态/证据）** [`zcode-ui-traceability.md`](ai-framework/plans/zcode-ui-traceability.md) ·
> 视觉/布局权威 [`refs-zcode.md`](refs/refs-zcode.md)（Z-60～95）+ [`refs-zcode-layout.md`](refs/refs-zcode-layout.md)（Z-01～45）·
> 按天日志 [`2026-10-10.md`](issue-log/2026-10-10.md) / [`2026-10-11.md`](issue-log/2026-10-11.md)。
> **进度**：Z0 ✅（两份 refs 文档 + 台账 + 总纲 + 规范修订）· Z1 ✅（Tailwind v4 + shadcn 基建，八项验收全绿）·
> Z2/Z3/Z4/Z5 四个阶段全部收口 ·
> **Z 程序（Z0–Z7）实现已全部收口**（2026-10-11）：
> Z0 ✅ · Z1 ✅ · Z2 ✅ 9 项骨架 · Z3 ✅ 7 项对话页 · Z4 ✅ 轨迹页+代码面 · Z5 ✅ 设置页全屏骨架 · Z6 ✅ 批次 1–7 · Z7 ✅ 收口（web 与桌面同构：布局/面板/轨迹/设置/命令面板/分屏全部下沉 ui-shared 两壳共用）。
> **core 导出基线 846 → 1113（+267，0 removed / 0 kindChanged，全程纯加性）**；`packages/cli` / `packages/gateway` 自 Z 程序起点起零改动。
> **测试基线（Z7-3 收口，六包时代历史数字）**：core 1519(+2skip) · ui-shared 308 · desktop 1114(+1skip) · web 67 · gateway 40 · cli 1575(+2skip)。
> **收口文档**：Z7 计划 [`2026-10-11-phase-Z7-closeout.md`](ai-framework/plans/2026-10-11-phase-Z7-closeout.md) · 功能总账 [`zcode-ui-traceability.md`](ai-framework/plans/zcode-ui-traceability.md)。
> **未闭合 = 待人工（历史，多随退役失效或转 ZS 线）**：§5 拍板项 10 条与 §6 真机项 10 项，处置记录见 `docs/issue-log/DECISIONS.md`。
> **⚠️ 上游（历史）**：refs/ZCode 曾三次拉取失败停 `29628c9`（v3.14.3）——后经 ZS 线补拉并日更（见 `docs/ai-framework/upstream-resync.md`）。
> **注**：Z 程序在 ZCode 会话中执行时项目 `.opencode/agents/` 命名子代理不可用，改用通用子代理模拟分工（未达 H12 角色独立，已登记）。

> **🆕 2026-09-17 立项（历史）：桌面端改造总纲** —— 外部评审定性与取证见 `docs/ai-framework/plans/2026-09-17-phase-desktop-overhaul.md` §1。路线「先修核 → 再换皮 → 后放大特色」，只做桌面形态，`packages/gateway` 零改动。本轮新增红线：⑨缓存边界不得被非压缩路径破坏 ⑩UI 不得显示假状态。

> 更新链（历史）：2026-09-15（P10 单轨化 + P11 界面拉齐完成——旧终端壳零残留，CLI 只剩 next TUI + piped readline；对照台 `scripts/tui-parity/`；修 1 P0 + 6 P1；cli 1575 passed；**两分支后已合入 main**，接手事项见 `docs/ai-framework/plans/2026-09-15-p12-backlog.md`）· 2026-09-14（内核下沉与三壳复刻 P0–P8 合入 main `c62721d`→`c7c76a0`：core 吸走命令注册表与能力面、CLI 单一 TUI、桌面 slot 四席位、新增 ui-shared 与 web 壳，六包结构成型）· 2026-09-12（I1 交互复刻双轨甲 CLI/乙桌面各自独立验收 `--no-ff` 合入 main；解冻窗口 #1/#2 闭环）· 2026-09-11（地基补丁 P0–P4 闭环，core/gateway 契约冻结）· 2026-09-09（阶段 15 质量收口）· 2026-09-06/07（阶段 1–12 与 v1.0.0 收口）· 本文件是唯一交接入口，保持与实际状态同步。

### 7.1 🔒 冻结公告：core/gateway 契约冻结（2026-09-11，历史）

- **冻结 commit：** `3c9b31f`——地基补丁 P0–P4 中 `packages/core` / `packages/gateway` 的最后变更点。
- **冻结范围：** serve HTTP/WS 帧形状、默认严格鉴权 + 一次性 token、`turn-end` 的 `finalText`/`partialText`/`textOutcome` 展示语义、`api-surface-baseline.json` 导出面快照。契约文本：`docs/API-STABILITY.md`「跨端展示语义」节。
- **冻结的接续（2026-09-13/14）**：core 由获批主线计划二次开放——命令注册表下沉（P1）、会话能力/工具/子代理/flows（P7）均改 core 且为纯加性导出（495→846）。纪律存续：任何并行轨不得私改 core/gateway；改动须「计划授权 + 基线同步 + 编排者验收」。
- 已用解冻窗口：#1 gateway `ServeClient` 孤儿 WS 竞态（`1dd40d8`→`05c3cd7`）；#2 core 测试抖动屏障化 + steer 加性导出（`a442f4b`+`d7834c8`→`5aa1ff2`/`34354d2`）。

### 7.2 退役包时代的坑（pre-2026-10-24，仅考古）

- **web 壳 token 暴露面**：`VITE_HARNESS2_TOKEN` 构建期内联 / URL `?token=` / WS 握手 `?token=` 三条路径客户端可见（口径已入 `docs/API-STABILITY.md`）
- **ui-shared 是壳层共享包**：零 electron/node 依赖，线协议以它为唯一事实源；业务语义一律在 core（该包已退役，纪律对 adapter 内的壳装配仍可类比）
- **desktop `frame:false` 窗控行为 / 三栅让步链 / 虚拟化轨迹页 / 模型配置页**等交互规格：见 `docs/refs/refs-deepseek-harness.md` 与 Z 程序台账（退役留档）
- **electron 链**：pnpm 构建脚本白名单曾为 electron 二进制下载服务（`ELECTRON_MIRROR` 可解下载失败）；electron-builder 26 需 `@electron/get ≥4`（workspace overrides 钉住）；sandbox preload 不能 require 相对模块（IPC 通道名与 shared/protocol.ts 有静态一致性测试）——**均已随 2026-10-24 退役失效**，现桌面出包走 `scripts/zs6/zs6-pack.ps1`（ZCode 壳装配）
- **`--ink` 是配色 token 不是库**（ui-shared styles 里的颜色名，非 ink 库）
- 旧桌面 dev/smoke 命令（`pnpm --filter @harness2/desktop dev|smoke|dist:win`）与 web dev（`pnpm --filter @harness2/web dev`）随退役删除，不要再引用
