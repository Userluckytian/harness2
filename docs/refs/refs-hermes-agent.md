# refs-hermes-agent —— 功能完整性对标

> 定位：**功能面的对标基准**。当 deepseek-harness 缺少某项能力时，以本文档为准补齐（复刻等级默认「补齐」）。
> 交互样式不以它为准（CLI 看 grok-build，桌面看 deepseek-harness）。

## 分析基线

| 项目         | 值                                             |
| ------------ | ---------------------------------------------- |
| 本地路径     | `D:/AI_Projects/refs/hermes-agent`             |
| 远程         | `https://github.com/NousResearch/hermes-agent` |
| 分析 commit  | `79445a4`                                      |
| 上游提交时间 | `2026-09-04T20:24:51-04:00`                    |
| 分支         | `main`                                         |
| 分析日期     | 2026-09-13                                     |
| 分析者       | 编排会话（Notion AI）                          |

## 定位与仓库结构

Python 内核 + React/Ink TUI + web，MIT，Nous Research。**与我们最接近的形态：一个内核多个壳。**

- 内核层：`cli.py`(212KB)、`run_agent.py`(85KB)、`hermes_constants.py`(48KB)、`hermes_state_*.py`（~25 个：`sessions` 81KB、`messages` 74KB、`search` 71KB、`schema` 64KB、`repair` 62KB、`common` 51KB、`gateway` 39KB、`compression` 36KB、`portability` 28KB、`wal` 28KB、`maintenance` 25KB、`usage` 23KB、`fts` 19KB、`dbfile` 19KB、`telegram` 18KB、`titles`、`registry`、`holders`、`readpool`、`errors`、`guard`）。
- 能力层：`toolsets.py`、`model_tools.py`、`trajectory_compressor.py`、`batch_runner.py`、`mcp_serve.py`、`hermes_startup_watchdog.py`。
- 壳层：`ui-tui/`（TS + Ink）、`tui_gateway/`（Python 侧网关）、`web/`、`gateway/`（多平台）、`hermes_cli/`。
- 资产层：`skills/`、`optional-skills/`、`optional-mcps/`、`plugins/`、`providers/`、`tools/`、`cron/`、`locales/`、`evals/`。
- 契约文档：`AGENTS.md`(29KB)、`CONTRIBUTING.md`(49KB)、`COMPAT_MANIFEST.md`(157KB) + `compat_manifest.json`(284KB)、`cli-config.yaml.example`(113KB)、`.env.example`(27KB)。

## 权威依据

`README.zh-CN.md`（特性矩阵与 CLI 入口）、`ui-tui/README.md`（TUI 架构、键位、prompt flows、本地命令）、目录结构实探。

## 交互 / 布局 / 样式

本文档不以交互样式为权威（CLI 键位看 `refs-grok-build.md`，桌面壳布局看 `refs-deepseek-harness.md`）。与交互相关的条目集中在 **H-5x（TUI 架构）**、**H-6x（输入、支线与 prompt flows）**、**H-7x（命令面）** 三个分组。

## 功能面清单

功能全景即本文档主体：**H-0x～H-4x** 覆盖模型与提供方、会话状态与持久化、记忆与自进化、工具与工具集、执行环境与并行子代理；**H-7x** 汇总 CLI 子命令与 TUI 斜杠命令。

## 复刻矩阵

各 H- 分组内的条目表即复刻矩阵本体，下表为索引（条目数与状态分布按 2026-09-14 P9 归存后正文实际统计；全表 H-01～H-70 共 54 条）。本矩阵条目暂缺独立「依据路径」「落点」列（依据以行内文件名与权威依据小节代偿）；**P9 判定：补列工作随 H- 条目未排期一并延后，不再是「P7 欠账」**（P7 已结束）。

每条 `⬜` 均已在状态列写明归存结论与事实理由（硬规则 #2）；五类汇总见下文「归存汇总（2026-09-14 P9）」小节。

| 小节                           | ID 区间    | 条目数 | 状态分布                    |
| ------------------------------ | ---------- | ------ | --------------------------- |
| H-0x 模型与提供方              | H-01～H-05 | 5      | 3 ⬜ · 1 🟡 · 1 ➖          |
| H-1x 会话、状态与持久化        | H-10～H-16 | 7      | 3 ✅ · 1 🟡 · 2 ⬜ · 1 ➖   |
| H-2x 记忆与自进化              | H-20～H-26 | 7      | 2 ✅ · 1 🟡 · 2 ⬜ · 2 ➖   |
| H-3x 工具与工具集              | H-30～H-34 | 5      | 2 ✅ · 2 🟡 · 1 ⬜          |
| H-4x 执行环境、子代理与并行    | H-40～H-48 | 9      | 2 ✅ · 3 🟡 · 3 ⬜ · 1 ➖   |
| H-5x TUI 架构（`ui-tui`）      | H-50～H-59 | 10     | 7 ⬜ · 3 ➖                 |
| H-6x 输入、支线与 prompt flows | H-60～H-69 | 10     | 5 🟡 · 5 ⬜                 |
| H-7x 命令面                    | H-70       | 1      | 1 🟡                        |
| 合计                           | H-01～H-70 | 54     | 9 ✅ · 14 🟡 · 23 ⬜ · 8 ➖ |

## H-0x 模型与提供方

| ID   | 能力        | 要点                                                                                                     | 等级   | 状态                                                                                                                       |
| ---- | ----------- | -------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| H-01 | 任意模型    | Nous Portal 300+ / OpenRouter / NVIDIA NIM / MiMo / z.ai GLM / Kimi / MiniMax / HF / OpenAI / 自定义端点 | 补齐   | 🟡（归存：自定义 OpenAI 兼容端点与 Anthropic 已落 `core/src/provider/`；Portal/OpenRouter 等聚合目录依赖外部服务，未排期） |
| H-02 | 模型切换    | `hermes model` 交互式切换；会话内 `/model`                                                               | 补齐   | ⬜（归存：后续阶段未排期——core 命令表无 `/model`，无 `harness2 model` 子命令；桌面模型配置页仅覆盖配置写入）               |
| H-03 | 提供方目录  | `providers/` 目录驱动，新增提供方不改内核                                                                | 补齐   | ⬜（归存：后续阶段未排期——提供方为编译期实现 + `factory.ts` 装配，无目录驱动加载）                                         |
| H-04 | 用量与计费  | `hermes_state_usage.py` + `/usage` + `/credits` + `/billing`                                             | 参考   | ⬜（归存：后续阶段未排期——有 token 用量投影（`session/bench.ts`、`/context`、轨迹检查器），无账户计费/额度命令面）         |
| H-05 | Portal 账号 | `hermes portal info`、`hermes setup --portal`                                                            | 不采纳 | ➖                                                                                                                         |

## H-1x 会话、状态与持久化

| ID   | 能力          | 要点                                                                                                       | 等级 | 状态                                                                                                                                                 |
| ---- | ------------- | ---------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-10 | 会话存储      | 专用状态层（sessions / messages / schema / registry / holders / readpool），**WAL + repair + maintenance** | 补齐 | ⬜（归存：后续阶段未排期——本仓 `session/` 已有 JSONL 会话层（writer/reader/snapshots/undo/可重建索引/坏行修复），不引入 hermes 的 WAL 多模块状态层） |
| H-11 | **FTS5 搜索** | 会话全文检索（`hermes_state_fts.py` + `_search.py` 71KB）+ LLM 摘要                                        | 补齐 | ✅                                                                                                                                                   |
| H-12 | 上下文压缩    | `hermes_state_compression.py` + `/compress`；轨迹压缩器独立（`trajectory_compressor.py`）                  | 补齐 | 🟡（归存：P9 后另行排期——分层压缩已落（P7）；`agent/loop.ts` turn 开始自动压缩未切分层）                                                             |
| H-13 | 会话可移植    | `hermes_state_portability.py`：导出/导入/迁移                                                              | 补齐 | ✅                                                                                                                                                   |
| H-14 | 自动标题      | `hermes_state_titles.py`（与 grok `/rename --auto` 同类）                                                  | 补齐 | ✅                                                                                                                                                   |
| H-15 | 启动看护      | `hermes_startup_watchdog.py`：启动例行体检与自修                                                           | 参考 | ⬜（归存：后续阶段未排期——仅有手动 `harness2 doctor`（G-85 ✅）与崩溃日志 `doctor/crash.ts`，无启动例行体检与自修）                                  |
| H-16 | 迁移诊断      | `hermes claw migrate [--dry-run / --preset user-data / --overwrite]`、`hermes doctor`                      | 参考 | ➖（不采纳——`doctor` 面已由 G-85 覆盖（含 `--probe` 实连 MCP）；`claw migrate` 类第三方配置迁移无需求，与 G-90 `/import-claude` 同口径）             |

## H-2x 记忆与自进化（本项目最大补齐面）

| ID   | 能力           | 要点                                                                                                                                                                                                                                      | 等级   | 状态                                                                                                                                                       |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-20 | 记忆文件       | `MEMORY.md`（事实）+ `USER.md`（用户模型）；记忆目录由 `HERMES_HOME` / `get_memory_dir()`（`<hermes_home>/memories`）定位。2026-09-13 P0 审查修正：`/sethome` 实为网关「投递主频道」指令（`gateway_only=True`，TUI 隐藏），与记忆定位无关 | 补齐   | ✅                                                                                                                                                         |
| H-21 | 主动持久化     | 无需提醒即自行写入记忆（我们现为 `mode off/ask/auto`，默认 off）                                                                                                                                                                          | 补齐   | ✅                                                                                                                                                         |
| H-22 | **经验造技能** | 从会话中提炼可复用 skill，写回 `skills/`；使用中自改进                                                                                                                                                                                    | 补齐   | 🟡（归存：P9 后另行排期——propose/approve 与三壳注册已落；自动提炼 turn 未接）                                                                              |
| H-23 | 技能生态       | 兼容 agentskills.io；`optional-skills/` 可选装                                                                                                                                                                                            | 参考   | ⬜（归存：后续阶段未排期——skills 为两级目录扫描（项目 `.agents/skills` + `~/.harness2/skills`，`skills/store.ts`），无 agentskills.io 兼容层与可选分发包） |
| H-24 | 用户建模       | Honcho 辩证式用户建模 + `/insights [--days N]`                                                                                                                                                                                            | 参考   | ➖（不采纳——Honcho 辩证式用户建模依赖外部付费服务，与 H-26 同因；`/insights` 本地提炼未排期）                                                              |
| H-25 | 人格           | `/personality` + `SOUL.md`                                                                                                                                                                                                                | 参考   | ⬜（归存：后续阶段未排期——记忆面为 `MEMORY.md`/`USER.md`（`memory/store.ts`），无 SOUL.md 与 `/personality`）                                              |
| H-26 | Honcho 云侧    | 外部服务依赖                                                                                                                                                                                                                              | 不采纳 | ➖                                                                                                                                                         |

## H-3x 工具与工具集

| ID   | 能力         | 要点                                                                                            | 等级 | 状态                                                                                                                                             |
| ---- | ------------ | ----------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| H-30 | **40+ 工具** | 文件/搜索/编辑/执行/网络/记忆/会话/调度/子代理等，均可单独启禁                                  | 补齐 | ✅                                                                                                                                               |
| H-31 | 工具集系统   | `toolsets.py` + `toolset_distributions.py`：按场景成套分发（而非逐工具配）；`hermes tools` 管理 | 补齐 | ✅                                                                                                                                               |
| H-32 | MCP 双向     | 既做 MCP 客户端，也能 `mcp_serve.py` 把自己当服务端；`optional-mcps/` 可选装                    | 补齐 | 🟡（归存：客户端已落 `core/src/mcp/client.ts`（McpManager + 重启状态）；服务端面 `mcp_serve` 未排期）                                            |
| H-33 | 模型侧工具   | `model_tools.py`：模型直接调用另一个模型作为工具                                                | 参考 | ⬜（归存：后续阶段未排期——工具面（`tools/inventory.ts`，11 工具/5 工具集）无「模型当工具」条目）                                                 |
| H-34 | 插件         | `plugins/` 目录式接入                                                                           | 补齐 | 🟡（归存：目录式装载 + manifest 校验 + 审批名单已落阶段 8（`plugins/loader.ts`、`harness2 plugin`、`/plugins`）；`optional-*` 可选分发包未排期） |

## H-4x 执行环境、子代理与并行

| ID   | 能力             | 要点                                                                                                    | 等级   | 状态                                                                                                                         |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| H-40 | **六种终端后端** | local / Docker / SSH / Daytona / Singularity / Modal（Daytona 与 Modal 支持休眠唤醒）                   | 参考   | ⬜（归存：后续阶段未排期——执行仅本地（`tools/shell.ts`/`executor.ts` spawn），无 Docker/SSH/Daytona/Singularity/Modal 后端） |
| H-41 | 隐离子代理       | 委派给独立上下文的子代理，主会话不被污染                                                                | 补齐   | ✅                                                                                                                           |
| H-42 | **并行扇出**     | 一次派多个子代理并行；`spawnHistoryStore` 缓最近 10 次 fan-out 供 `/replay`                             | 补齐   | 🟡（归存：P9 后另行排期——并行扇出与 spawnHistory 已落；`/replay` 入口缺）                                                    |
| H-43 | **零开销轮次**   | Python 脚本经 RPC 直调工具（工具结果不进模型上下文）——**这是 hermes 最值得学的一条**                    | 补齐   | ✅                                                                                                                           |
| H-44 | 审批与安全       | 命令审批、DM 配对、容器隔离、`sudo.request`、`secret.request`                                           | 补齐   | 🟡（归存：P9 后另行排期——core 契约/状态机/用例齐备，CLI/serve/桌面零接线，接线清单见 OPEN.md）                               |
| H-45 | 批量与评测       | `batch_runner.py`、`mini_swe_runner.py`、`evals/`                                                       | 参考   | ⬜（归存：后续阶段未排期——仅 `session/bench.ts` 性能基准，无 `batch_runner`/`mini_swe_runner`/`evals/`）                     |
| H-46 | 内置 cron        | 自然语言定时任务，可投递到任意平台（`cron/`）                                                           | 补齐   | 🟡（归存：P9 后另行排期——自然语言 cron 已落 core（`cron/natural.ts`）；`--natural` 确认面与桌面任务卡未接）                  |
| H-47 | **多平台网关**   | 单进程同时跑 Telegram / Discord / Slack / WhatsApp / Signal / Email / CLI + 语音转写 + 跳平台会话连续性 | 待定   | ⬜（归存：需人类决策——P7 开头未拍板，gateway 零改动（当前仅 `gateway/src/platforms/{qq,feishu}`）；拍板前不得扩大范围）      |
| H-48 | Nous 专有链路    | Portal 计费、`contributors/`、`website/`                                                                | 不采纳 | ➖                                                                                                                           |

> **决策点 H-47**：多平台网关是否纳入 harness2，由计划阶段 P7 开头由人类拍板；我们已有 `packages/gateway`，但当前只有少量平台。**未拍板前不得自行扩大范围。** **2026-09-14 P9 归存：⬜（需人类决策）——P7 开头未拍板（计划 §P7 执行记录第 310 行明示），P8/P9 亦未拍板；gateway 本轮零改动，条目维持 ⬜ 待人类决策，不计入「未排期」类。**

## H-5x TUI 架构（`ui-tui`）—— 进程拆分的参考

| ID   | 条目           | 要点                                                                                                                      | 等级 | 状态                                                                                                                          |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| H-50 | 职责划分       | **TS 只管画屏，Python 管会话/工具/模型调用**；壳不重实现业务                                                              | 参考 | ➖（不适用——本仓单进程纯 TS，无 Python 内核/TS 壳双进程；「壳不重实现业务」已由 P1 内核下沉达成）                             |
| H-51 | 传输层         | `src/entry.tsx`（非 TTY 直接退出）→ `GatewayClient` spawn `python -m tui_gateway.entry`；**换行分隔 JSON-RPC over stdio** | 参考 | ➖（不适用——无 `python -m tui_gateway.entry` stdio JSON-RPC；跨端走 `core/src/server/` HTTP/WS protocolVersion=2）            |
| H-52 | 解释器解析顺序 | `HERMES_PYTHON` → `PYTHON` → `$VIRTUAL_ENV/bin/python` → `./.venv` → `./venv` → `python3` / `python`                      | 参考 | ➖（不适用——纯 TS 无 Python 解释器解析链；与「不采纳清单·Python 运行时本身」同因）                                            |
| H-53 | 错误隔离       | 坏行发 `gateway.protocol_error`；stderr 进内存环发 `gateway.stderr`（不污染屏幕）                                         | 参考 | ⬜（归存：后续阶段未排期——本仓靠 serve 帧校验/protocolVersion 与进程日志隔离，无 gateway.protocol_error 帧与 stderr 内存环）  |
| H-54 | 自恢复         | `gatewayRecovery`：**60 秒内最多重连 3 次**，超限改为人工提示                                                             | 参考 | ⬜（归存：后续阶段未排期——serve 客户端只有重连状态机（P8 web 契约），无「60 秒内最多 3 次」壳级上限）                         |
| H-55 | 状态店拆分     | `turnStore` `overlayStore` `uiStore` `delegationStore` `spawnHistoryStore` `inputSelectionStore`                          | 参考 | ⬜（归存：后续阶段未排期——桌面按本仓分域（`renderer/{layout,conversation,settings,trajectory}`），不按 hermes 六店拆分）      |
| H-56 | 配置同步       | `useConfigSync`：`config.get full` + **5 秒 mtime 轮询**                                                                  | 参考 | ⬜（归存：后续阶段未排期——配置变更走 IPC/事件（P6 设置域通道），无 5 秒 mtime 轮询）                                          |
| H-57 | 长工具提示     | `useLongRunToolCharms`：超 **8 秒**才出现安抚动画                                                                         | 参考 | ⬜（归存：后续阶段未排期——工具卡有运行态渲染，无 8 秒阈值安抚动画）                                                           |
| H-58 | 渲染树         | Ink `Static` transcript + 流式助手行 + overlay + 队列预览 + status rule + 输入行 + 补全列表                               | 参考 | ⬜（归存：后续阶段未排期——CLI 渲染树按 grok G-04 八区域实现（P2/P3），不按 hermes Ink 树重排）                                |
| H-59 | ANSI 分流      | 含 ANSI 走 `messageLine.tsx` 原样输出，否则走 `components/markdown.tsx`（标题/列表/引用/表格/围栏/diff 着色/行内码/链接） | 参考 | ⬜（归存：后续阶段未排期——CLI 走自有 markdown→ANSI 渲染（`cli/src/render.ts`、`tui/render/`），无「含 ANSI 则原样输出」分流） |

## H-6x 输入、支线与 prompt flows

| ID   | 条目           | 要点                                                                                                                          | 等级 | 状态                                                                                                                                         |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| H-60 | 提交与换行     | `Enter` 提交；空 `Enter` 两次提示；`Shift/Alt+Enter` 换行；行尾 `\` + `Enter` 继续                                            | 参考 | ⬜（归存：后续阶段未排期——CLI 输入语义以 refs-grok-build.md 为准（G-07/G-26/G-72）；hermes 的「空 Enter 两次提示」「行尾反斜杠续行」未实现） |
| H-61 | shell 直达     | `!cmd` 单行、`{!cmd}` 多行（与 grok G-11 同类，可合并设计）                                                                   | 参考 | ⬜（归存：后续阶段未排期——行首 `!` 按 G-11 落（🟡）；`{!cmd}` 多行形态未实现）                                                               |
| H-62 | 队列/转向/中断 | `useSubmission` 统一处理 queue / steer / interrupt；`/queue`（`/q`）预览                                                      | 补齐 | 🟡（归存：队列/转向/中断语义已落 core 并由 CLI（G-26～G-30 ✅）与桌面（D-35 🟡）共用；hermes 的 `/queue` 预览命令未注册）                    |
| H-63 | 补全           | `Tab` 补全；`Up/Down` 优先级 **补全 → 队列 → 历史**；防抖 60ms；`complete.slash` / `complete.path`（`./` `../` `~/` `/` `@`） | 参考 | ⬜（归存：后续阶段未排期——本仓为前缀补全 + 菜单模糊筛选（G-50～G-53），无 Up/Down 优先级（补全→队列→历史）与 60ms 防抖路径补全）             |
| H-64 | 行编辑键       | `Home`/`Ctrl+A`、`End`/`Ctrl+E`、`Ctrl+W`/`Ctrl+U`/`Ctrl+K`、`Meta+B`/`Meta+F`                                                | 参考 | ⬜（归存：后续阶段未排期——行编辑按 G-07～G-10 键位表（vim 模式 🟡），无 `Meta+B/F` 等 Emacs 族）                                             |
| H-65 | 历史持久       | `~/.hermes/.hermes_history`                                                                                                   | 参考 | ⬜（归存：后续阶段未排期——CLI 无持久历史文件（无 `~/.harness2/history`），历史回看走会话与队列面板）                                         |
| H-66 | 审批 flow      | `approval.request`：`o` 一次 / `s` 会话内永久 / `a` 全局 / `d` 拒绝                                                           | 补齐 | 🟡（归存：P9 后另行排期——审批 flow 契约与状态机已落；三壳渲染（next 审批层/桌面 approval）未接）                                             |
| H-67 | 澄清 flow      | `clarify.request`：数字选项 + Other 自由文本（对应 grok G-21）                                                                | 补齐 | 🟡（归存：P9 后另行排期——clarify flow 契约已落；三壳渲染未接）                                                                               |
| H-68 | 特权 flow      | `sudo.request` / `secret.request`（机密不回显，不写日志）                                                                     | 补齐 | 🟡（归存：P9 后另行排期——sudo/secret 特权流已落 core；三壳渲染未接）                                                                         |
| H-69 | 会话选择器     | `session.list` → SessionPicker，`1-9` 直选                                                                                    | 参考 | 🟡（归存：CLI 会话选择器已落（G-34 `Ctrl+R`、`/resume`），桌面会话列表归 D-23；hermes 的 `1-9` 数字直选未实现）                              |

## H-7x 命令面（CLI 子命令 + TUI 斜杠）

CLI 入口：`hermes`、`hermes --tui`、`hermes model`、`hermes tools`、`hermes config set`、`hermes gateway [setup / start]`、`hermes setup [--portal]`、`hermes claw migrate`、`hermes update`、`hermes doctor`、`hermes portal info`。

TUI 本地命令（注册顺序 core → billing → credits → session → ops → setup → debug，**未识别的经 `slash.exec` + `command.dispatch` 下沉到内核**）：

| 分组     | 命令                                                                                                                                                                                                                                                                         | 等级 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| core     | `/help` `/quit`（`/exit`） `/update` `/clear`（`/new`） `/density` `/copy` `/paste` `/details`（`/detail`） `/statusbar`（`/sb`） `/queue`（`/q`） `/logs` `/history` `/save` `/undo` `/retry` `/steer` `/mouse`（`/scroll`） `/status` `/title` `/redraw` `/terminal-setup` | 补齐 |
| session  | `/model` `/sessions` `/compress` `/usage` `/insights [--days N]` `/skills` `/<skill-name>` `/stop` `/personality`                                                                                                                                                            | 补齐 |
| ops      | `/platforms` `/reset`                                                                                                                                                                                                                                                        | 待定 |
| debug    | `/heapdump` `/mem`                                                                                                                                                                                                                                                           | 参考 |
| 网关专属 | `/sethome`（别名 `/set-home`）——网关投递主频道指令，`gateway_only=True`、TUI 隐藏（2026-09-13 P0 审查修正）                                                                                                                                                                  | 补齐 |
| 不采纳   | `/billing` `/credits` `/fortune`                                                                                                                                                                                                                                             | ➖   |

**H-70** 🟡：一个关键设计——斜杠命令分“本地处理”与“下沉内核”两层，壳只拦真正需要 UI 的（如 `/density` `/redraw`），其余统一交给内核。**harness2 必须照这个分层做，否则 CLI/桌面/web 三份命令表会分叉。**（必刻）harness2 侧落点：由 `packages/core` 命令注册表承接（见主线计划 P1）。**2026-09-13 P1 回填：已落 `packages/core/src/commands/`（CoreCommand/CoreCommandContext/parseCoreCommand/runCoreCommand/describeCapabilities，13 条命令，mode+reasoning 为 shellOnly 元数据）+ cli 三入口统一分发（`case '/` 清零）；🟡 因桌面/web 壳接线待 P5/P6/P8。** **2026-09-14 P9 归存：🟡（P9 后另行排期——core 命令注册表（13 条）与 CLI 三入口分发已落；P5/P6/P8 已结束仍未接桌面/web 命令面，`describeCapabilities` 在 `packages/desktop`、`packages/web` 零引用，接线需另行排期）。**

## 归存汇总（2026-09-14 P9）

本小节为硬规则 #2（每条 G-/D-/H- 编号必须有归存）在本文档的收口登记，供 `docs/issue-log/OPEN.md` 交叉引用。五类口径与 `docs/refs/README.md` §3 状态符号一致：已完成 = ✅（有证据）；部分完成待续 = 🟡（剩余部分有明确接收方或明确条件）；未排期 = ⬜（能力未实现、且不在本轮十阶段内）；不采纳/不适用 = ➖（含事实理由）；待人类决策 = ⬜ + 需人类拍板。

### ① 已完成（✅ 9 条）

H-11 会话全文检索（P7 索引化检索，`/search`/`/reindex`）、H-13 会话可移植（导出/导入，P7）、H-14 自动标题（`/title --auto`，P7）、H-20 记忆文件（`MEMORY.md`/`USER.md`）、H-21 主动持久化（策略唯一出口）、H-30 工具面（11 工具）、H-31 工具集与 `harness2 tools`、H-41 隐离子代理（隔离断言）、H-43 零开销轮次（RPC 子进程，messages-only 23.8×）。

### ② 部分完成待续（🟡 14 条）

| ID   | 已落部分                                                          | 剩余部分与归口                                       |
| ---- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| H-01 | 自定义 OpenAI 兼容端点 + Anthropic（`core/src/provider/`）        | 聚合模型目录（Portal/OpenRouter）未排期              |
| H-12 | 分层压缩（P7，`/compact-layers` 手动与命令路径）                  | `agent/loop.ts` turn 开始自动压缩未切分层            |
| H-22 | 经验造技能 propose/approve + 三壳注册                             | 自动提炼 turn 未接                                   |
| H-32 | MCP 客户端（`core/src/mcp/client.ts`）                            | MCP 服务端（`mcp_serve`）未排期                      |
| H-34 | 目录式插件装载 + manifest 校验 + 审批名单（阶段 8）               | `optional-*` 可选分发包未排期                        |
| H-42 | 并行扇出 + spawnHistory(10)（P7）                                 | `/replay` 入口缺                                     |
| H-44 | 审批/特权 flow 契约 + 状态机 + 用例（core）                       | CLI/serve/桌面零接线（清单见 OPEN.md）               |
| H-46 | 自然语言 cron（`cron/natural.ts`，P7）                            | `cron add --natural` 确认面 + 桌面任务卡未接         |
| H-62 | 队列/转向/中断语义（core，CLI G-26～G-30 ✅ / 桌面 D-35 🟡 共用） | hermes 的 `/queue` 预览命令未注册                    |
| H-66 | 审批 flow（`approval.request`）契约/状态机                        | 三壳渲染（next 审批层/桌面 `renderer/approval`）未接 |
| H-67 | 澄清 flow（`clarify.request`）契约/状态机                         | 三壳渲染未接                                         |
| H-68 | 特权 flow（`sudo.request`/`secret.request`，P7）                  | 三壳渲染未接                                         |
| H-69 | 会话选择器（CLI G-34 `Ctrl+R`、`/resume`；桌面 D-23）             | `1-9` 数字直选未实现                                 |
| H-70 | core 命令注册表 + CLI 三入口统一分发（P1）                        | 桌面/web 命令面接线未做                              |

### ③ 未排期（⬜ 22 条）

H-02 模型切换、H-03 提供方目录、H-04 用量与计费、H-10 WAL 状态层、H-15 启动看护、H-23 技能生态（agentskills.io）、H-25 人格（SOUL.md）、H-33 模型侧工具、H-40 六种终端后端、H-45 批量与评测、H-53～H-59（TUI 错误隔离 / 自恢复 / 状态店 / 配置同步 / 长工具提示 / 渲染树 / ANSI 分流）、H-60/H-61/H-63/H-64/H-65（输入与补全细节，CLI 以 `refs-grok-build.md` 为准）。**共性事实**：本仓无对应模块或契约——个别条目（如 H-53 错误隔离、H-56 配置同步）已有等价物，但做法与 hermes 不同且不按该机制补齐，故归「未排期」而非 ✅；后续若要启动，需先按 `docs/refs/README.md` §2 重新拉取上游并判定过期（hermes 参考仓本轮仍未拉取，见 OPEN.md）。

### ④ 不采纳 / 不适用（➖ 8 条）

H-05 Portal 账号（与厂商绑定）、H-16 第三方配置迁移（`doctor` 已覆盖自检，G-90 同口径）、H-24 Honcho 用户建模（外部付费服务，与 H-26 同因）、H-26 Honcho 云侧、H-48 Nous 专有链路、H-50/H-51/H-52（Python 内核—TS 壳进程拆分机制：本仓单进程纯 TS，原则由 P1 内核下沉达成，机制不适用）。

### ⑤ 待人类决策（⬜ 1 条）

H-47 多平台网关：P7 开头应拍板而未拍板，P7/P8/P9 三轮均维持 gateway 零改动；条目维持 ⬜，**不计入「未排期」**，等人类明确「纳入/不纳入」后按结果转为实施或 ➖。

## 与 harness2 当前实现的差距

> **口径提示（2026-09-14 P9）**：下表为 2026-09-13 首版快照，**未随 P1～P8 实施结果刷新**（例如 H-11/H-30/H-31/H-41/H-43 已 ✅、H-20～H-22 记忆面已落 core）。本表刷新归存「P9 后另行排期」，当前判断以各条目表状态列为准，不以本表为准。

| 维度        | harness2 现状                                                      | 目标                                              |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| 工具数量    | 基础文件/执行/搜索类，无工具集成套分发                             | H-30、H-31                                        |
| 记忆        | `MEMORY.md`/`USER.md` 已有，但**无经验造技能、无主动持久化默认开** | H-20～H-22                                        |
| 会话搜索    | 只有 `/sessions [kw]` 关键字过滤，无全文索引                       | H-11                                              |
| 子代理      | 深度默认 1，无并行扇出、无 `/replay`、**无零开销轮次**             | H-41～H-43                                        |
| 执行环境    | 仅本地                                                             | H-40（分阶段）                                    |
| cron        | 已有 `cron` 子命令（60s tick），无自然语言解析、无跳平台投递       | H-46                                              |
| 网关        | `packages/gateway` 已存在，平台较少                                | H-47（待拍板）                                    |
| 壳/内核边界 | 斜杠命令写在 CLI 包里（`command-registry.ts`），**桌面用不上**     | H-70（必须下沉）——P1 已下沉 core，🟡 待三壳全接线 |

## 不采纳清单

| 项                               | 理由                                                    |
| -------------------------------- | ------------------------------------------------------- |
| Nous Portal 账号/计费/`/credits` | 与厂商绑定                                              |
| Honcho 云侧用户建模              | 外部付费服务                                            |
| Python 运行时本身                | 我们是纯 TS，**只学进程拆分与 RPC 思路，不引入 Python** |
| `/fortune` 等彩蛋                | 无工程价值                                              |
| `contributors/` `website/`       | 仓库运营类                                              |

> **2026-09-14 P9 归存补充 ➖（理由见「归存汇总」④）**：H-16（第三方配置迁移；`doctor` 自检已由 G-85 覆盖）、H-50/H-51/H-52（Python 内核—TS 壳进程拆分机制，本仓不适用）。H-24 的 Honcho 部分与上表第 2 行同因。

## 本轮更新记录

| 日期       | 执行者                        | 上游 commit | 变更摘要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-13 | 编排会话（Notion AI）         | `79445a4`   | 首版：建立 H-01～H-70 功能对标清单，含记忆自进化、工具集、并行子代理与零开销轮次、TUI 进程拆分、斜杠命令两层分层；标记决策点 H-47                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-13 | 开发子代理 P0-C（编排者派工） | `79445a4`   | 本轮 git fetch 三次失败（完整 fetch、--shallow-since、HTTP/1.1 降级均 early EOF），未能拉取；`git ls-remote` 显示远端 main 已前移（`b6b53c69`…），沿用 commit `79445a4`，条目未按新上游更新，下轮开工优先补拉并重新判定过期；本轮另修正 H-20（`/sethome` 误读）、补 H-70 状态符号、补模板锚点小节                                                                                                                                                                                                                                                   |
| 2026-09-14 | 编排会话（P9 收口 A）         | `79445a4`   | **硬规则 #2 收口：为 32 条 ⬜ 逐条补归存（含 H-47 明示「需人类决策」）+ 8 条悬空 🟡 重述为「P9 后另行排期」**；新增「归存汇总（2026-09-14 P9）」小节（五类：✅9 · 🟡14 · ⬜未排期22 · ➖8 · 待决策1，合计 54）；索引摘要表按正文实际统计重算（旧表记「⬜44+」等已失真，新表 9 ✅ · 14 🟡 · 23 ⬜ · 8 ➖）；补 H-47 决策段 / H-70 段 / 不采纳清单 / 差距表口径提示的 P9 归存标注。**状态符号变更**：⬜→🟡：H-01/H-32/H-34/H-62/H-69；⬜→➖：H-16/H-24/H-50/H-51/H-52（理由均指到事实）。上游参考仓本轮仍未拉取（fetch 失败未解），未按新上游判定过期 |
