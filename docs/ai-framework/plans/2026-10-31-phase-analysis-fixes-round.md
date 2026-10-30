# 阶段 FIX-1：优化分析修复轮（2026-10-31）

> 输入：2026-10-30 动态工作流「项目优化分析」——6 维度并行分析 + 逐条独立复核，14 条发现全部证实（另 20 条低优先观察未入本轮）。
> 用户指令：「全部进行修一轮」。档位：全能（默认）+ 子代理（**串行**，遵循 `workflow-delegation.md` 调度纪律）。
> 范围：13 条直接修复；**F1 只立拆解计划不动代码**（见 [`2026-10-31-phase-cli-harness-decompose.md`](2026-10-31-phase-cli-harness-decompose.md)）。

## 0. 环境事实（开工时记录，必须知晓）

- 当前分支 `fix/perf-startup-render`（00:38 自 main `f3ccac6` 切出，**无新提交**），工作树有**另一条工作流的未提交 WIP**：`packages/cli/src/tui/next/next-shell.ts`、`packages/core/src/codeindex/store.ts`、`packages/core/src/session/manager.ts`、`packages/core/src/tools/predefined/{browser,common,edit,glob,grep,read,write}.ts`、以及 `spike/tui-renderer-spike/` 整目录删除。最后活动 01:04。
- **本阶段所有提交只落当前分支，绝不移动 HEAD；提交一律 `git add <明确文件列表>`，禁止 `git add -A` / `git commit -a`；对上述 WIP 文件不做任何 git 操作（不 add / 不 stash / 不 checkout / 不 restore）。**
- 本轮提交范围 = `f3ccac6..HEAD`（不含 WIP）；审查与验收均以此为界。
- 默认不 push（push 已有人类授权挂账，CI 实跑验证随之）。

## 1. 输入发现摘要（14 条，全部「已复核」）

| ID  | 维度 | 位置                                         | 一句话                                               |
| --- | ---- | -------------------------------------------- | ---------------------------------------------------- |
| F1  | 质量 | cli/src/tui/next/next-shell.ts:1064-4575     | 3511 行闭包工厂（126 闭包/56 let），本轮只立计划     |
| F2  | 质量 | gateway/package.json:24                      | TS 5.9/vitest 3.2 与其余包 7.0/5.0 双版本分裂        |
| F3  | 质量 | eslint.config.js:96-105、pnpm-workspace.yaml | 退役壳（React/Electron）配置残留活跃路径             |
| F4  | 文档 | docs/HANDOFF.md                              | 快照/命令/文档地图停在 9 月，教跑已退役包命令        |
| F5  | 文档 | docs/issue-log/OPEN.md                       | 148 行半数历史内容，失效条目冒充开放项               |
| F6  | 文档 | docs/SMOKE-TEST.md                           | 冒烟手册钉在 9-14 版本，照做即败                     |
| F7  | 构建 | package.json:11 + tsconfig*                  | 无 incremental，全量重编实测 57.4s                   |
| F8  | 构建 | ci.yml:87-89 + zs1-guard.mjs                 | zcode-adapter CI 测试空跑假绿                        |
| F9  | 构建 | ci.yml:9-11,54-71                            | 平台无关检查三平台各跑一遍；push 无过滤              |
| F10 | 依赖 | core/package.json:29,34                      | MCP SDK/zod/传递依赖成簇 high+critical 漏洞          |
| F11 | 依赖 | ci.yml 全文                                  | 无 audit 环节；npmmirror 默认 registry 下 audit 必败 |
| F12 | 架构 | zcode-adapter core-bridge.ts:31-34           | 未声明 @harness2/core 依赖 + 硬编码绝对路径          |
| F13 | 测试 | core/test/cron.test.ts:126-142               | 月末 `getDate()+1` 溢出断言，当日必红（已抓现行）    |
| F14 | 测试 | gateway（无 vitest.config）                  | 默认 5s 超时，重连用例实测 3037ms 贴线               |

## 2. 执行顺序（串行）

```
T1 (F7) → T2 (F2/F3/F10/F12/F14) → T3 (F13) → T4 (F8/F9/F11)
→ V1 编排者终验（取实测数字）→ T5 (F4/F5/F6) → R1 只读审查 → 收尾文档+提交
```

实现代理：cat-jam（故障时按降级阶梯：20s 重试 → 探针 → general-purpose → 编排者代做并留档）。
每个实现任务完成即按规范 commit；全部完成后由审查代理复审 `f3ccac6..HEAD`，P0/P1 回修，P2 登记。

## 3. 任务书（零上下文）

### T1 — F7 启用 tsc 增量构建

1. 读 core/cli/gateway 的 build script 与 tsconfig*.json，确认构建方式；zcode-adapter 若非 tsc 直编则如实记录不动。
2. 为 tsc 构建的包启用 `"incremental": true` + 显式 `"tsBuildInfoFile"`（不入库、被 .gitignore 覆盖；若无 `*.tsbuildinfo` 规则则追加）。declaration/declarationMap 等现行为不变。
3. 取证：冷跑（删 dist+tsbuildinfo）`pnpm -r build` 计时 → 温跑（无改动直接再跑）计时。期望温跑 <15s 或降幅 ≥50%，达不到如实报告。
4. 红线：不改任何 src；api-surface-baseline.json diff 必须为 0。
5. 提交：`⚡perf(build): ...`。

### T2 — F2/F3/F10/F12/F14 依赖与配置批

- **F10**：core 的 `@modelcontextprotocol/sdk`、`zod` 升到同大版本最新（`pnpm add` 于 core 内）；若 SDK API 变化，只做**保持行为**的适配；前后各跑一次 `pnpm audit --registry=https://registry.npmjs.org`（此命令默认 registry 下必败，属已知），目标：**生产依赖 0 high/critical**，残留如实登记。
- **F2/F14**：gateway devDeps 对齐 typescript `^7.0.2`、vitest `^5.0.0`；新建 `packages/gateway/vitest.config.mts`（testTimeout 30000，参照 core/cli 同款注释口径）；TS7/vitest5 引起的编译/测试报错就地修（行为不变）。
- **F12**：zcode-adapter package.json 声明 `"@harness2/core": "workspace:*"`；core-bridge.ts 兜底链删除硬编码绝对路径（读码后保留 createRequire/相对解析路径），同步 host-bundle 相关注释。
- **F3**：先 grep 证实活跃四包是否还有 React/Electron 消费（cli 的 .tsx 测试若用 ink/React，则把 eslint react-hooks 段 `files` 收窄到实际文件而非删除；若无则删段）；pnpm-workspace.yaml 删 electron 两条 allowBuilds 与 `@electron/get` override（desktop 已退役）；README 若有相关表述顺带核对。
- 验证：一次 `pnpm install`（lockfile diff 审阅）→ `pnpm -r --no-bail typecheck` 0 错 → 定向测试（core/gateway/adapter）→ `pnpm exec eslint .` 0 error → 触碰文件 `prettier --write`。
- 提交：按逻辑分 2-5 个 commit（依赖升级/对齐/退役清理/adapter 依赖各归其位）。

### T3 — F13 cron 月末断言

1. 复现：`pnpm exec vitest run test/cron.test.ts`（core 内）——今天即月末，预期 1 failed（cron.test.ts:133 expected 32），截图留证。
2. 修：改用日历安全写法（同仓库 cron-natural.test.ts 已有正确范例：按日历取下一天而非 getDate()+1），**不放宽断言**，131/141 同病一并修。
3. 验证：该文件 2 连跑全绿；core 全量 `pnpm --filter @harness2/core test` 绿。
4. 提交：`🐛fix(core): ...`（core 冻结区——只动 test 文件，api-surface 零 diff 红线照查）。

### T4 — F8/F9/F11 CI 重构

- **F9**：拆 job——`quality`（单台 ubuntu：install→build→typecheck→eslint→prettier，平台无关检查只跑一次）+ `test`（三平台 matrix：install→build→四包测试）；`on.push` 是否加 `branches` 过滤**不做默认变更**（会影响现行「分支 CI 全绿再合」工作流），在注释里登记权衡。
- **F11**：新增 audit job（ubuntu）：本地先试出可用命令形态（显式 `--registry`），输出报告并在 **critical/high 时非零退出**（pnpm 原生缺该开关就用小段 node 脚本解析 `--json` 输出实现，脚本入 `scripts/`）。
- **F8**：先摸清 zcode-adapter 20 个测试文件对 scratch 区 alias 的依赖面；优先方案=提供 `test:ci`（排除 scratch 依赖子集并在 CI 里跑得了的部分，输出明确「N 个 scratch 依赖用例已排除、须本地跑」）；若子集为空则诚实方案=从 CI 移除该步骤、更正 ci.yml 头部「经 workspace 覆盖」的失实注释、在 HANDOFF 登记该包测试须本地跑。**杜绝假绿**是唯一硬要求。
- 验证：YAML 语法本地可验（prettier + 可用的解析手段）；CI 实跑只能等 push（人类授权），如实登记。
- 提交：`🐳ci: ...`。

### T5 — F4/F5/F6 文档三件套（在 V1 终验取数后执行）

- **F5**：OPEN.md 按其自身元规则收缩——「只搬不删」：已关闭/已被退役取代的条目迁 `DECISIONS.md`（带日期与去向），仍真开放的保留（含各「待人类/真机/凭据」项与 V 总纲项）；文件回到「只读它即可掌握全部未完成项」的小文件状态。禁止丢失任何条目的历史（历史在各日期日志本就存在）。
- **F4**：HANDOFF.md——状态快照改为当前（ZS6 完成、FIX-1 本轮、待人类=V9 装机验收+tag/Release+push 授权）；「环境与命令」改为四包现实；文档地图刷新。
- **F6**：SMOKE-TEST.md——旧桌面/web 壳章节标记为历史（或移除），以四包现状 + `scripts/zs6/zs6-pack.ps1` 装机链路 + `zs6-release-draft.md`/`zs6-pack-report.md` 材料重写适用版本；测试基线表引用 V1 终验实测数字。
- 验证：三份文档事实与仓库现状交叉核对（git log、包列表、材料文件存在性）；prettier 通过。
- 提交：`📝docs: ...`。

### R1 — 只读审查

审查代理（只读，不修改文件）：范围 `f3ccac6..HEAD`，对照本计划 + `CODE_REVIEW.md`，输出 P0/P1/P2 报告。P0/P1 → 派修复；P2 → 登记。

### V1 — 编排者终验（不可委托）

亲自重跑：`pnpm -r build`（温跑计时）、`pnpm -r --no-bail typecheck`、`pnpm exec eslint .`、`pnpm exec prettier --check .`、`pnpm test`（全量，当天=月末可验证 F13）、audit 命令、`git diff f3ccac6 HEAD -- packages/core/test/fixtures/api-surface-baseline.json`（必须空）、`git status`（除他人 WIP 外干净）。结论写入当日日志。

## 4. 验收表

| 项  | 修复动作                    | 证据命令                                     | 期望                                      | 状态                                                                                                                             |
| --- | --------------------------- | -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| F7  | incremental+tsBuildInfoFile | 温跑 `pnpm -r build` 计时                    | exit 0 且耗时显著下降（记录数值）         | ✅ af2d983：冷 5.6s / 温 5.0s；57.4s 原基线系与并行会话负载撞车的污染数字（已更正登记），增量配置保留（CI 慢 runner 受益）       |
| F2  | gateway 版本对齐            | `pnpm -r --no-bail typecheck` + gateway 测试 | 0 错 / 全绿                               | ✅ f782b31：TS7/vitest5 零适配通过，gateway 40 用例绿 ×2                                                                         |
| F3  | 退役配置清理                | `pnpm exec eslint .` + grep 复核             | 0 error，无 react-hooks/electron 残留消费 | ✅ 2fab9ac：React 取证 0 命中→整删段+移除 plugin；electron 两行 allowBuilds+override 删除；eslint 0 error                        |
| F4  | HANDOFF 刷新                | 人工核对+交叉引用                            | 与现状一致                                | ✅ aa4cebe：快照/命令/文档地图四包化，9 提交号逐一核实                                                                           |
| F5  | OPEN.md 收缩                | 逐条核对去向                                 | 真开放项完整保留，历史可溯                | ✅ b621e5d：94 项 → 22 留 + 7 新登记 + 72 迁 DECISIONS.md，程序化核对 73/73 命中；P10/P11、cmd.exe 两条经 git/系统取证后改判关闭 |
| F6  | SMOKE-TEST 重写             | 人工核对                                     | 照做可走通（本地可验部分）                | ✅ 5fd8c11：四包基线+ZS6 装机链路；旧壳章节整段历史化保留                                                                        |
| F8  | CI 去假绿                   | ci.yml 审读 + 本地 test:ci（如适用）         | 无假绿信号                                | ✅ af36d86：取证 16/20 文件依赖 scratch；CI 真跑 4 文件 23 用例 + 16 文件显式排除声明，release.yml 同口径                        |
| F9  | CI 拆 job                   | ci.yml 审读                                  | 平台无关检查仅 1 次                       | ✅ 5531110：quality 单 job（typecheck/eslint/prettier），test matrix 纯测试；`on.push` 分支过滤不动（权衡已注释登记）            |
| F10 | 依赖升级                    | `pnpm audit --registry=...`                  | 生产依赖 0 high/critical（残留登记）      | ✅ 0f5b004：MCP SDK 1.32.2 + zod 4.6.7 + 传递链刷新；prod audit 20（1C/6H）→ 0                                                   |
| F11 | audit job                   | 本地跑同款命令                               | 命令可用，gate 逻辑就位                   | ✅ 5531110：scripts/audit-gate.mjs（prod C/H 挡门、dev 报告不挡），正常/注入双路径实测 exit 0/1                                  |
| F12 | adapter 依赖声明            | adapter 测试 + 读码                          | 无硬编码绝对路径，解析有据                | ✅ cf66c77：声明 workspace:* 依赖、删硬编码盘符路径；159 用例绿；顺带证伪并改写「workspace 链接自然解析」不实注释                |
| F13 | cron 断言修复               | `vitest run test/cron.test.ts`（当日月末）   | 全绿 ×2                                   | ✅ 9c234ab：月末当日复现红（expected 32/received 1）→ 日历安全写法（断言升级为整时间戳相等），17/17 ×2                           |
| F14 | gateway vitest 配置         | gateway 全量测试                             | 30s 超时生效，全绿                        | ✅ f782b31：vitest.config.mts（30s+R10 注释口径），gateway 绿                                                                    |
| F1  | 拆解计划                    | 计划文档评审                                 | 计划成立待排期                            | 📋 立项完成：`2026-10-31-phase-cli-harness-decompose.md`（refs 闸门 G0+状态域分批+变异验证），待人类排期                         |

## 5. 红线

1. `packages/core/test/fixtures/api-surface-baseline.json` 全程零 diff（core/gateway 冻结区纪律）。
2. 密钥不进 git；不 push 远程。
3. 他人 WIP 不触碰（§0 文件清单）；提交只 `git add <明确列表>`。
4. 验收认证据：所有「已关闭」必须有实际命令 exit code/输出支撑；CI 变更的实跑验证明确标注「待 push」。
5. `packages/cli` 交互面本轮不动（F1 只立计划）；实施前须走 `docs/refs/README.md` §2 流程（已写入拆解计划前置闸门）。

## 6. 状态

**代码与文档面完成（2026-10-31）**：13 项修复落地 9 个提交（af2d983 / 0f5b004 / f782b31 / cf66c77 / 2fab9ac / 8bc6a4e / 9c234ab / 5531110 / af36d86）+ 文档三件套 3 提交（aa4cebe / b621e5d / 5fd8c11），F1 立项待排期。

**V1 终验结论（编排者亲跑）**：

- 绿灯：eslint 0 error；audit-gate exit 0（生产依赖 0 漏洞）；api-surface-baseline 全程 0 diff；cron 17/17；gateway 40 用例绿；adapter test:ci 23/23（16 文件显式排除）；prettier 本轮触碰文件全过。
- 被 WIP 阻塞（按归因留证）：`pnpm -r build` exit=2、`pnpm -r --no-bail typecheck` exit=1（恰 3 错：core http.ts:347、cli render.ts:25 及其 adapter 同源连坐——行级核实全部位于并行会话未提交改动）；core 全量测试局部红（49 failed 集中于 WIP 重构区域）；gateway 唯一红用例为该会话自建未跟踪测试。**全量绿门以该 WIP 收口为准**。
- 排除项：`pnpm test` 全量与 CI 实跑（后者待 push 授权）。

**R1 审查（已完成）**：**有条件通过**——P0=0，五条红线全过；P1-1（SMOKE-TEST 版本预期）与 P2-3/P2-4 已当场修正，P2-1/2/5 登记至当日日志。
