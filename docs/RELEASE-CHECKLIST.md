# 发布前回归汇总（v1.0.0）

> 状态：阶段 12 Task 3（2026-09-07）· 覆盖三层：自动化证据 → 手工清单索引 → 发布动作
> 规则：本文件是**证据索引**——自动化层只列可复跑命令与实跑结果；手工层逐项链接 `docs/issue-log/OPEN.md` 行（不在本文复制详情，以 OPEN 为唯一事实源）。

## ① 自动化覆盖声明（命令级，全部可复跑）

| #   | 命令                                           | 覆盖内容                                                                                                                                                                                                       | 通过口径                                                             | 最近实跑结果                                                                |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A1  | `pnpm test`（= `pnpm -r build` + 四包 vitest） | 全部功能测试（mock provider / 127.0.0.1 stub，**零 API key**）：内核投影/undo-redo/loop/工具/Provider 双协议/serve+WS/桌面逻辑/记忆/分叉/压缩/浏览器/cron/插件/MCP/子代理/网关/导出回放/Skills/doctor/性能上限 | 全绿；1 skipped = `H2_GEN_LOOP_DEMO` 门控的 fixture 生成器（非失败） | 回归 Run A / B：**615 项 = 614 passed + 1 skipped**（见下「回归执行记录」） |
| A2  | `pnpm -r typecheck`                            | 四包 TypeScript strict 编译                                                                                                                                                                                    | exit 0                                                               | 见「回归执行记录」（随每次回归同跑）                                        |
| A3  | `pnpm bench`                                   | 10 万事件合成日志六项操作计时（loadSession/computeProjection/list/search/export/replay）                                                                                                                       | 全部 <3s 预算线（基线 ≈0.03–1.4s，见 `architecture.md`「性能预算」） | 基线两次取差值 <10%（`37475aa`；真实大会话复核在 OPEN）                     |
| A4  | `packages/core/test/api-surface.test.ts`       | 公开导出面快照（372 名钉死；删除/改名/种类变更红）+ 运行时导出交叉校验                                                                                                                                         | 6 例全绿                                                             | Task 1（`10c1c1f`）；模拟改名实测变红后恢复                                 |
| A5  | crash-drill（含于 A1）                         | writer 半行截断恢复 / serve 强杀重启 / 截断恢复后 export→replay 往返                                                                                                                                           | core `crash-drill.test.ts` 全绿                                      | 阶段 11（`1e7bbba`），随 A1 持续回归                                        |
| A6  | 口径统一断言（含于 A1）                        | CLI 与 serve 子会话工具集相等（剔除 per-session 绑定类）+ skills 注入                                                                                                                                          | core `subagent.test.ts` 口径统一组全绿                               | 阶段 11（`fd77cc4`）                                                        |
| A7  | CI（`.github/workflows/ci.yml`）               | 三平台 test matrix + build-desktop 三平台打包（unsigned）+ pages 文档站                                                                                                                                        | YAML 语法校验过（js-yaml）；**Actions 真实运行待远程**（OPEN）       | 2026-09-07 本地校验                                                         |
| A8  | workflow 发布链（`release.yml`）               | tag 触发 → 三平台产物附加 Release → npm publish（NPM_TOKEN 条件跳过，失败即红）                                                                                                                                | YAML 语法校验过；真跑待 tag（OPEN）                                  | 2026-09-07 本地校验                                                         |

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

**待远程验证类**（push 后 Actions 首跑确认）：三平台桌面包产物、CI 矩阵、release 链、Pages 首次部署（见 ③）。

## ③ 发布动作 checklist（全部待人类授权，物料已就绪）

| #   | 动作                            | 说明                                                                                                                                                                                                         | 状态                      |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| R1  | push 推送远程（备份）           | ✅ **已授权并持续执行**——push 备份自阶段 1 起获用户授权（origin 的 master 与 feat/phase-1~11 分支均在远程），分支合并后推送同属备份惯例。**发布执行者无需为此请示，也勿据此跳过下方真正的待授权项（R2-R4）** | ✅ 已授权（备份持续执行） |
| R2  | npm 包名占用检查                | `npm view harness2` / `npm view @harness2/core`                                                                                                                                                              | ⬜ 待执行                 |
| R3  | 配置 Actions secret `NPM_TOKEN` | 缺失时 publish 步骤条件跳过（不会误发）；配置后发布失败即红                                                                                                                                                  | ⬜ 待配置                 |
| R4  | 推 tag `v1.0.0`                 | 触发 `release.yml`（npm publish + 三平台产物附加 GitHub Release）；可合并发布（跳过 0.1/0.3/0.6 独立 tag，release note 说明里程碑对应关系）——**这才是待人类授权的发布动作**                                  | ⬜ 待授权                 |
| R5  | 开启 GitHub Pages               | 仓库 Settings → Pages → Source 选 **GitHub Actions**；随后 `pages` job 首次部署生效（渲染级验证随之进行）                                                                                                    | ⬜ 待开启                 |
| R6  | Release 页核对                  | 产物清单（win nsis / mac dmg arm64+x64 / linux AppImage，全 unsigned）与 release note                                                                                                                        | ⬜ 随 R4                  |

## 回归执行记录（本文件随版本更新）

| 轮次  | 提交基线                                        | 命令                             | 结果                                                                                            |
| ----- | ----------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Run A | 阶段 12 Task 1-2 后（0.6.0 + 快照/迁移/文档站） | `pnpm test && pnpm -r typecheck` | ✅ **615 项 = 614 passed + 1 skipped**（core 508+1 / cli 51 / desktop 41 / gateway 14），exit 0 |
| Run B | 同上（连续第二轮）                              | `pnpm test`                      | ✅ 同计数全绿，exit 0                                                                           |

- Run A 附记：首轮 `pnpm -r typecheck` 抓到本阶段新增测试文件 5 处 TS 错误（`noUncheckedIndexedAccess` 下正则匹配组/索引访问为 `| undefined`）——当场修复后复跑 exit 0（测试运行时行为未变，仅类型收窄）。typecheck 门禁有效性的直接证据。
- 1 skipped = `H2_GEN_LOOP_DEMO` 门控的 fixture 生成器（`loop.test.ts`，非失败）。
- 交卷终验（Task 4 版本物料后）另有全量 + typecheck 复跑记录，见 diary 2026-09-07 阶段 12 节。

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
