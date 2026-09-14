# 发布前回归汇总（v1.0.0）

> 状态：阶段 12 Task 3（2026-09-07）· 覆盖三层：自动化证据 → 手工清单索引 → 发布动作
> 规则：本文件是**证据索引**——自动化层只列可复跑命令与实跑结果；手工层逐项链接 `docs/issue-log/OPEN.md` 行（不在本文复制详情，以 OPEN 为唯一事实源）。
> **P9 收口复核（2026-09-14，编排者亲手重跑）：** 新增「②.5 本地核验结果」一节，逐条登记 P0–P8 交付后的可本地核验项（版本号 / 物料 / 包结构 / CHANGELOG / 测试与闸门 / 文档站）。**发布动作（tag / `NPM_TOKEN` / npm publish / 推 remote）一律未执行**，状态见 ③。

## ① 自动化覆盖声明（命令级，全部可复跑）

| #   | 命令                                               | 覆盖内容                                                                                                                                                                                                                                                    | 通过口径                                                                           | 最近实跑结果                                                                               |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A1  | `pnpm test`（= `pnpm -r build` + **六包** vitest） | 全部功能测试（mock provider / 127.0.0.1 stub，**零 API key**）：内核投影/undo-redo/loop/工具/Provider 双协议/serve+WS/桌面逻辑/记忆/分叉/压缩/浏览器/cron/插件/MCP/子代理/网关/导出回放/Skills/doctor/性能上限/**命令注册表/桌面三栅/轨迹/模型配置/web 壳** | 全绿；5 skipped = `H2_GEN_LOOP_DEMO` 门控的 fixture 生成器等**门控跳过**（非失败） | Run C（P9 收口）：**4033 passed + 5 skipped（319 files）**，exit 0（见下「回归执行记录」） |
| A2  | `pnpm -r typecheck`                                | **六包** TypeScript strict 编译                                                                                                                                                                                                                             | exit 0                                                                             | Run C：exit 0（见「回归执行记录」）                                                        |
| A3  | `pnpm bench`                                       | 10 万事件合成日志六项操作计时（loadSession/computeProjection/list/search/export/replay）                                                                                                                                                                    | 全部 <3s 预算线（基线 ≈0.03–1.4s，见 `architecture.md`「性能预算」）               | 基线两次取差值 <10%（`37475aa`；真实大会话复核在 OPEN）                                    |
| A4  | `packages/core/test/api-surface.test.ts`           | 公开导出面快照（**846** 名钉死；删除/改名/种类变更红）+ 运行时导出交叉校验                                                                                                                                                                                  | 全绿（0 removed / 0 kindChanged）                                                  | Run C：846（P0–P9 由 495 纯加性增长）；模拟改名实测变红后恢复                              |
| A5  | crash-drill（含于 A1）                             | writer 半行截断恢复 / serve 强杀重启 / 截断恢复后 export→replay 往返                                                                                                                                                                                        | core `crash-drill.test.ts` 全绿                                                    | 阶段 11（`1e7bbba`），随 A1 持续回归                                                       |
| A6  | 口径统一断言（含于 A1）                            | CLI 与 serve 子会话工具集相等（剔除 per-session 绑定类）+ skills 注入                                                                                                                                                                                       | core `subagent.test.ts` 口径统一组全绿                                             | 阶段 11（`fd77cc4`）                                                                       |
| A7  | CI（`.github/workflows/ci.yml`）                   | 三平台 test matrix（**六包分包独立步骤**）+ build-desktop 三平台打包（unsigned）+ pages 文档站                                                                                                                                                              | 七 job 全绿                                                                        | 已在远程真实运行（P8 后七 job 全绿）；**本轮本地无法代验（`gh` 未认证）**                  |
| A8  | workflow 发布链（`release.yml`）                   | tag 触发 → 三平台产物附加 Release → npm publish（NPM_TOKEN 条件跳过，失败即红）                                                                                                                                                                             | YAML 校验过；真跑待 tag                                                            | 2026-09-14 本地 js-yaml 校验通过（4 job）；真跑待 tag（OPEN）                              |

## ② 手工清单索引（唯一事实源 = `docs/issue-log/OPEN.md`）

> 以下为发布视角的**汇总重排**；详情、命令级步骤与状态以 OPEN.md 对应行为准（链接指向 OPEN 表行）。

| #   | 手工验收域                                    | 摘要                                                                                                                                       | OPEN 行                                                                            | 前置         |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------ |
| M1  | 真实 key 三端 chat                            | DeepSeek/智谱 GLM/Anthropic 各「一条消息 + 一次工具调用」+ M1 手工验收清单（config check → chat 流式 → write/undo/redo → 审批 ask → 搜索） | 2026-09-06「M1 真实模型 chat 手工验收清单」+ 2026-09-06「阶段 3 真实端点手工验证」 | 用户配 key   |
| M2  | 桌面端 GUI 真机                               | 连接角标/分屏拖拽/后台徽标/审批按钮/断线重启/undo 按钮                                                                                     | 2026-09-06「阶段 5 桌面端 GUI 真机验收清单」                                       | Windows 实机 |
| M3  | nsis 安装包实机                               | 安装/启动/卸载/SmartScreen/数据残留                                                                                                        | 2026-09-06「nsis 安装包实机流程」                                                  | Windows 实机 |
| M4  | 桌面真实 provider 端到端                      | 桌面 UI 接真实模型全流程（与 M1 合并执行）                                                                                                 | 2026-09-06「桌面端真实 provider 端到端」                                           | key + config |
| M5  | QQ/飞书真机联调                               | 凭据配置 → gateway 启动 → 群/私聊/审批回复/重连/msg_seq                                                                                    | 2026-09-06「阶段 9 真机联调清单」                                                  | 开放平台凭据 |
| M6  | 阶段 9 复审（fail 闭环条件）                  | P0/P1 修复有效性补复审（生命周期/重连/msg_seq）                                                                                            | 2026-09-06「阶段 9 复审待补」                                                      | 基础设施恢复 |
| M7  | 真实 MCP server / 第三方插件 / 桌面子会话跳转 | filesystem MCP 实测；手写插件从零装载；「子会话 ↗」手感                                                                                    | 2026-09-06「阶段 8 残留手工验收清单」                                              | 用户环境     |
| M8  | skill 真机体验                                | 真实 skill 注入与按需加载行为质量                                                                                                          | 2026-09-06「阶段 10 残留手工验收清单」②                                            | 用户环境     |
| M9  | 真实长会话导出评估                            | 大会话 `export` 体积/耗时 → `replay` 可用性                                                                                                | 2026-09-06「阶段 10 残留手工验收清单」①                                            | 真实会话库   |
| M10 | doctor / 崩溃报告实机                         | 真实 config/auth/MCP/sessions 下 OK/WARN/FAIL 判定；`~/.harness2/crash/` 落盘脱敏、无遥测                                                  | 2026-09-07「阶段 11 残留手工验收」②③                                               | 用户环境     |
| M11 | 真实大会话 bench 复核                         | 用户真实负载环境 `pnpm bench` 对照性能预算表                                                                                               | 2026-09-07「阶段 11 残留手工验收」①                                                | 用户环境     |
| M12 | 记忆三态真实模型                              | off/ask/auto + nudge 复盘（与 M1 合并执行）                                                                                                | 2026-09-06「阶段 6 真实模型记忆三态验证」                                          | key          |
| M13 | Windows Terminal REPL 手感                    | turn 标头/折行/审批内联/Ctrl+C                                                                                                             | 2026-09-06「Windows Terminal 实机 REPL 体验待人工」                                | 实机         |

**留档不修 / 已评估类**（不阻塞发布，详见 OPEN 对应行）：bash 副作用不进快照、redo 中间态口径、审批输入约定、SSE 多行 data、WS 增量影子、cron 记账边角、CLI 子会话防回归模拟注册表漂移、多进程并发追加/陈旧锁 TOCTOU、Anthropic pause_turn 推迟、阶段 5 代审 P2 留档组。

**待远程验证类**：三平台桌面包产物、release 链、Pages 渲染级验证（Pages 已开启并随 main 自动部署，见 ③ R5）——见 ③。

## ②.5 本地核验结果（P9 收口，2026-09-14）

> 逐条过一遍**可在本地核验**的发布项（版本号 / 物料 / 包结构 / CHANGELOG / 测试与闸门 / 文档站）。以下结果均为**本轮编排者亲手重跑或实测**（命令见「方式」列）；**发布动作一律未执行**。
> 基线：`main` = `c7c76a0`（六包结构成型，P0–P8 已合入）。

| #   | 可本地核验项                                                | 方式 / 命令                                                       | 结果                                                                                                                                                                    |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 版本号                                                      | 六包 `package.json` + `node packages/cli/dist/index.js --version` | ✅ **通过**——六包均 `1.0.0`（core/cli/desktop/gateway/ui-shared/web），CLI 输出 `1.0.0`                                                                                 |
| V2  | 包结构                                                      | `ls packages/`                                                    | ✅ **通过**——六包：`core` / `cli` / `desktop` / `gateway` / `ui-shared` / `web`（根工作区 `harness2-monorepo`）                                                         |
| V3  | 发布物料（name/version/private/files/exports）              | 逐包读 `package.json`                                             | ✅ **通过**——可发布：`@harness2/core`（`files:["dist"]` + exports）、`harness2`(cli)（`files:["dist","dist-bundle"]`）；其余四包 `private:true` 不发布                  |
| V4  | CHANGELOG                                                   | `CHANGELOG.md` 顶部                                               | ✅ **通过（口径）**——最新段落为 `1.0.0`，与六包版本一致；**本轮 P0–P8 为内部重构/交互复刻，无对外功能版本变更，故未新增版本段落**——发布前是否补 release note 由人类决策 |
| V5  | 构建                                                        | `pnpm -r build`                                                   | ✅ **通过**——6 包 exit 0                                                                                                                                                |
| V6  | 类型                                                        | `pnpm -r typecheck`                                               | ✅ **通过**——6 包 exit 0                                                                                                                                                |
| V7  | ESLint                                                      | `pnpm exec eslint .`                                              | ✅ **通过**——**0 error / 46 warning**（warning 数为既有基线，未增长）                                                                                                   |
| V8  | 格式                                                        | `pnpm exec prettier --check .`                                    | ✅ **通过**——All matched files use Prettier code style（**含 `.md`**）                                                                                                  |
| V9  | 测试（六包）                                                | `pnpm -r --no-bail run test`                                      | ✅ **通过**——**4033 passed + 5 skipped（319 files）**：ui-shared 70 · core 1232+2 · gateway 40 · web 36 · desktop 952+1 · cli 1703+2                                    |
| V10 | 导出面快照                                                  | `packages/core/test/api-surface.test.ts`（含于 core 测试）        | ✅ **通过**——基线 **846**；P0–P9 由 495 **纯加性**（0 removed / 0 kindChanged）                                                                                         |
| V11 | 文档站（本地结构）                                          | `docs/site/index.html` + `ci.yml` 的 `pages` job staging          | ✅ **通过（本地结构）**——docsify 单页 + 8 页导航；pages job `cp docs/*.md` 覆盖 HANDOFF/ROADMAP/RELEASE-CHECKLIST 等；线上渲染随 main 自动部署                          |
| V12 | workflow YAML 语法                                          | js-yaml 加载 `.github/workflows/{ci,release}.yml`                 | ✅ **通过**——ci 3 job（test 3 平台 / build-desktop 3 平台 / pages = 七 job 实例）；release 4 job                                                                        |
| V13 | **发布动作**（tag / `NPM_TOKEN` / npm publish / 推 remote） | —                                                                 | ⬜ **未执行**（本轮硬约束）——本地 `git tag` 为 **0 个**，无任何发布动作                                                                                                 |
| V14 | CI 七 job 实际绿                                            | GitHub Actions                                                    | ⬜ **本地无法代验**（`gh` 未认证）——以计划记录为准（P8 后七 job 全绿）                                                                                                  |
| V15 | npm 包名占用检查                                            | `npm view harness2` / `npm view @harness2/core`                   | ⬜ **待人类执行**（只读检查，非发布动作）                                                                                                                               |
| V16 | README 三图 / 真机手工清单                                  | 真机                                                              | ⬜ **待人类**（见 ② M1–M13）                                                                                                                                            |

## ③ 发布动作 checklist（全部待人类授权，物料已就绪）

| #   | 动作                            | 说明                                                                                                                                                                                                                       | 状态                                |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| R1  | push 推送远程（备份）           | ✅ **已授权并持续执行**——push 备份自阶段 1 起获用户授权；历史分支已并入 main 后删除，**现远程仅 `main`**（`c7c76a0`），阶段分支合入后推送同属备份惯例。**发布执行者无需为此请示，也勿据此跳过下方真正的待授权项（R2–R4）** | ✅ 已授权（备份持续执行）           |
| R2  | npm 包名占用检查                | `npm view harness2` / `npm view @harness2/core`                                                                                                                                                                            | ⬜ 待执行（只读，可由人类先做）     |
| R3  | 配置 Actions secret `NPM_TOKEN` | 缺失时 publish 步骤条件跳过（不会误发）；配置后发布失败即红                                                                                                                                                                | ⬜ 待配置                           |
| R4  | 推 tag `v1.0.0`                 | 触发 `release.yml`（npm publish + 三平台产物附加 GitHub Release）；可合并发布（跳过 0.1/0.3/0.6 独立 tag，release note 说明里程碑对应关系）——**这才是待人类授权的发布动作**。**当前本地 `git tag` 为 0 个，未推任何 tag**  | ⬜ 待授权                           |
| R5  | 开启 GitHub Pages               | 仓库 Settings → Pages → Source 选 **GitHub Actions**；`pages` job 随 main push 自动部署                                                                                                                                    | ✅ 已开启（2026-09-07 由 API 完成） |
| R6  | Release 页核对                  | 产物清单（win nsis / mac dmg arm64+x64 / linux AppImage，全 unsigned）与 release note                                                                                                                                      | ⬜ 随 R4                            |

## 回归执行记录（本文件随版本更新）

| 轮次  | 提交基线                                         | 命令                                                                                                     | 结果                                                                                                                                                                                                       |
| ----- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run A | 阶段 12 Task 1-2 后（0.6.0 + 快照/迁移/文档站）  | `pnpm test && pnpm -r typecheck`                                                                         | ✅ **615 项 = 614 passed + 1 skipped**（core 508+1 / cli 51 / desktop 41 / gateway 14），exit 0                                                                                                            |
| Run B | 同上（连续第二轮）                               | `pnpm test`                                                                                              | ✅ 同计数全绿，exit 0                                                                                                                                                                                      |
| Run C | **P9 收口**：`c7c76a0`（P0–P8 合入后，**六包**） | `pnpm -r --no-bail run test` / `pnpm -r typecheck` / `eslint .` / `prettier --check .` / `pnpm -r build` | ✅ **4033 passed + 5 skipped（319 files）**（ui-shared 70 · core 1232+2 · gateway 40 · web 36 · desktop 952+1 · cli 1703+2）· typecheck 0 · eslint 0 error/46 warning · prettier 全绿 · build 0，均 exit 0 |

- Run A 附记：首轮 `pnpm -r typecheck` 抓到本阶段新增测试文件 5 处 TS 错误（`noUncheckedIndexedAccess` 下正则匹配组/索引访问为 `| undefined`）——当场修复后复跑 exit 0（测试运行时行为未变，仅类型收窄）。typecheck 门禁有效性的直接证据。
- 1 skipped = `H2_GEN_LOOP_DEMO` 门控的 fixture 生成器（`loop.test.ts`，非失败）；Run C 的 5 skipped 同为门控/环境跳过（非失败）。
- 交卷终验（Task 4 版本物料后）另有全量 + typecheck 复跑记录，见 diary 2026-09-07 阶段 12 节。
- Run C 为 P9 收口复核（2026-09-14，编排者亲手重跑），覆盖六包；导出面快照同轮为 **846**（0 removed / 0 kindChanged），workflow YAML 经 js-yaml 校验。

## doctor 实机输出（本机 Windows 10.0.22631 x64 / Node v22.23.0，脱敏由 doctor 设计保证）

Task 4 版本物料（1.0.0）后复跑（版本行 = 1.0.0，`harness2 --version` 同输出 1.0.0）：

```text
harness2 doctor（1.0.0，2026-09-06T18:50:30.949Z）
[OK]  node: Node v22.23.0（≥22）
[WARN] config: 未找到配置文件（全新环境——真实 provider 前先配置 config.json + auth.json，可用 harness2 config check 核对）
[OK]  home: 用户数据根可写：C:\Users\hp\.harness2
[OK]  mcp: 未配置 MCP 服务器（config.mcpServers）
[OK]  sessions: 会话库 711 个会话全部可解析（坏行 0）
[OK]  skills: skills 0 个（无告警）
结果：5 OK / 1 WARN / 0 FAIL → exit 0
```

- Task 3 时点（0.6.0 构建）同机实跑结果形态一致（5 OK / 1 WARN / 0 FAIL；当时 699 会话）——doctor 判定跨版本稳定。
- WARN 属环境事实（本机未配置 config.json/auth.json——密钥三不，CI 与测试环境同理零 key），doctor 判定与脱敏口径符合设计；真实 config 环境的实机核对在 OPEN（M10）。
