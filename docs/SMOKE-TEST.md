# 冒烟测试手册（手工验收）

> **适用基线（2026-10-31 FIX-1 修复轮后）**：活跃四包 `@harness2/core` / `@harness2/gateway` / `harness2`(cli) / `@harness2/zcode-adapter`；旧壳 desktop/ui-shared/web 已于 2026-10-24 退役（归档 tag `pre-zs-retirement`）。**桌面端验收改走 ZS6 链路**（§10），旧壳时代的桌面/web 章节**原文保留在文末 §11 历史**（未删，仅供考古）。
> 本手册现行各节的命令、选项、端点、输出文案**全部取自源码与 `--help` 实测**（命令面底本 = 2026-09-14 实测；FIX-1 修复轮未改 CLI 命令面），不含推测；来源见 §9。
> 用途：一名验收人按本手册独立完成一轮端到端冒烟，逐条记录实际结果。自动化测试见 §3。
> **真机项标注**：CLI 的 next 渲染层（`/minimal` `/fullscreen` / palette / 卡片 / 状态行）在 `stdin` 非 TTY（管道/重定向）时**按设计不启用**，只能真机交互验收；本手册在这些条目上注明「真机项」并给出**已由自动化用例覆盖**的用例文件引用（不得用「自动化绿」冒充真机通过）。

---

## 0. 前置环境

| 项                                 | 要求                         | 自检命令                                          |
| ---------------------------------- | ---------------------------- | ------------------------------------------------- |
| Node                               | >= 22（实测 v22.23.1）       | `node -v`                                         |
| pnpm                               | 11.13.0                      | `pnpm -v`                                         |
| 仓库                               | `D:\AI_Projects\harness2`    | `git -C D:\AI_Projects\harness2 log --oneline -1` |
| chromium（浏览器工具用，约 130MB） | 首次使用浏览器工具前必须安装 | `harness2 browser install`                        |

**数据根**：`--home` 缺省为 `~/.harness2`（Windows 下 `C:\Users\<你>\.harness2`）。目录内容：

```
config.json            两级合并配置的用户级部分（providers / roles / approval / memory）
auth.json              凭据（channels.<channel>.apiKey）
sessions/              会话库：sessions/<工作目录编码>/<会话id>/session.v1.jsonl
cron/                  定时任务
serve.lock             serve 运行期才有：{ pid, port, ts, token }（POSIX 下 0600）
desktop-layout.json    （旧桌面壳遗留文件；壳已退役，仅存档不再生成）
desktop-metadata.json  （同上）
desktop-preferences.json（同上）
```

工作目录编码把路径分隔符换成 `--`，例如 `C:\Users\ASUS` → `C--Users--ASUS`；会话 id 形如 `20260907-024839-bcf9d5`。

> **红线**：带破坏性的用例（`memory clear`、`/undo` 的文件恢复、cron 增删）一律加 `--home D:\tmp\h2-smoke-home` 走隔离数据根，**不要在真实 `~/.harness2` 上跑**。

---

## 1. 构建与两种启动入口

### 1.1 构建（必做，所有入口都依赖产物）

```powershell
cd D:\AI_Projects\harness2
pnpm install --frozen-lockfile
pnpm build        # = pnpm -r build（本机空闲冷启动实测 5.6s @ 2026-10-31；tsc 增量试验已回退，见 `77439ae`）
```

正确结果：四个包（core / gateway / cli / zcode-adapter）全部 exit 0，且下列产物存在——

| 产物                                        | 属于                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `packages/core/dist/index.js`               | core（含 api-surface 基线测试依赖）                             |
| `packages/gateway/dist/index.js`            | gateway                                                         |
| `packages/cli/dist/index.js`                | CLI 入口（bin `harness2` 指向它）                               |
| `packages/cli/dist-bundle/harness2-cli.cjs` | 打包用单文件 bundle（`pnpm --filter harness2 bundle` 另行生成） |
| `packages/zcode-adapter/dist/**`            | ZCode 壳内心（经 `scripts/zs1-guard.mjs` 构建）                 |

### 1.2 CLI：全局命令（本机已配置好）

全局 bin 已经 link 完成，**任意终端可直接用**：

```
D:\Programs\nodejs\harness2       →  junction  →  D:\AI_Projects\harness2\packages\cli
harness2 --version                →  1.0.2
```

正确结果：任意目录下 `harness2 --version` 输出 CORE_VERSION（`packages/core/src/version.ts`，当前 `1.0.2`，随版本演进）；`harness2 --help` 列出 §2 的 15 个子命令。

注意三点：

1. `bin` 指向 `dist/index.js`，**改了源码必须重新 `pnpm build`** 才生效（link 是软链，不做编译）。
2. 全局命令指向的是 junction 的那棵树，build 要在**那棵树**里跑。
3. 换树或重装：目标树的 `packages/cli` 里执行 `npm link`；卸载 `npm unlink -g harness2`。

不想用全局命令时，仓库内等价写法：`node packages\cli\dist\index.js <子命令>`。

### 1.3 CLI：本地会话服务

```powershell
harness2 serve --port 46213 --home D:\tmp\h2-smoke-home --root D:\tmp\h2-smoke-root
```

`--port` 缺省 46213，`--port 0` 为随机可用端口；仅监听 127.0.0.1。正确结果：进程常驻，数据根下出现 `serve.lock`，其中 `port` 与实际监听一致。

> **注意**：core 测试固定占用 `127.0.0.1:46213`（`fork.test.ts` 三例）——跑 core 测试期间别占用该端口起 serve。

---

## 2. 命令面（确证）

| 子命令                | 用途                                                                            | 子项 / 关键选项                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`                | 交互式 REPL（流式渲染 / 会话管理 / `/undo` `/redo` `/fork` / 审批交互）         | `--session <id>`、`--fork <id>`、`--at <seq>`、`--provider <name>`、`--mock-script <f>`、`--mock-child-script <f>`、`--root <dir>`、`--home <dir>`、`--no-tui` |
| `serve`               | 本地会话服务（HTTP 控制面 + WS 事件面，仅 127.0.0.1）                           | `--port`（默认 46213）、`--root`、`--home`、`--provider`                                                                                                       |
| `traj <sessionDir>`   | 查看会话轨迹时间线                                                              | `--json`、`--all`（含被回退遮蔽的影子事件）                                                                                                                    |
| `export <sessionDir>` | 导出会话为 ZIP（只读打包，含 `subagents/<id>/`）                                | `-o, --out <file>`（缺省 `./<sessionId>.zip`）                                                                                                                 |
| `replay <zip>`        | 回放校验导出的 ZIP（逐事件解析 + 投影摘要 + 坏行报告，零 key 可跑）             | —                                                                                                                                                              |
| `doctor`              | 环境自检：node 版本 / config+auth 脱敏 / 目录可写 / MCP / 会话库完整性 / skills | `--root`、`--home`、`--probe`（实连 MCP，每 server 超时 5s）                                                                                                   |
| `config`              | 配置管理                                                                        | `check`（校验两级合并配置并脱敏展示 providers/roles/key 来源）                                                                                                 |
| `memory`              | 长期记忆管理                                                                    | `show`、`clear --target memory\|user\|all`、`pending`、`approve <id>`、`reject <id>`                                                                           |
| `skill`               | 项目级 Skills 管理（两级扫描合并 + 经验造技能提案两段式）                       | `list`、`propose --name --description --body/--body-file [--from <ids>]`、`pending`、`approve <id>`、`reject <id>`                                             |
| `tools`               | 工具面管理：列出/查看工具与工具集、切换工具集写回 config.json（P7 H-31）        | `list`、`show <工具名\|工具集名>`、`select <工具集名>`；`--json`、`--dry-run`（select 只打印不落盘）                                                           |
| `plugin`              | 插件管理（manifest 权限 + 装载审批）                                            | `list`、`enable <name>`、`disable <name>`                                                                                                                      |
| `mcp`                 | MCP 服务器管理                                                                  | `list`（默认逐 server 探测，`--no-probe` 只看配置）                                                                                                            |
| `cron`                | 定时任务（serve 运行期间到点自动执行）                                          | `list`、`add <指令> --every 5m \| --at "daily 09:00"`、`remove <id>`、`run <id>`、`history <id>`                                                               |
| `browser`             | 浏览器工具管理                                                                  | `install`（chromium，约 130MB）                                                                                                                                |
| `gateway`             | IM 网关：QQ/飞书消息桥接到本地会话                                              | `--root`、`--home`、`--port`（默认 0）、`--platform <list>`；需先配 `config.gateways` 与 `auth.json.gateways`                                                  |

### TUI 斜杠命令（29 条，core 注册表为唯一来源）

分组（`harness2 chat` 输入 `/help` 实测，P1 命令注册表下沉 core 后由 `CORE_COMMAND_META` 派生）：

- 会话：`/new` `/sessions` `/resume` `/session-info` `/fork` `/export` `/search` `/reindex` `/import` `/title`
- 历史：`/undo` `/redo` `/timeline`
- 通用：`/help` `/exit` `/doctor` `/skills` `/plugins` `/mcps` `/tools`
- 模式：`/mode` `/reasoning` `/minimal` `/fullscreen`
- 上下文：`/context` `/compact` `/compact-layers` `/memory`
- 调度：`/tasks`

别名：`/?`（= `/help`）、`/quit`（= `/exit`）、`/clear`（= `/new`）、`/rewind`（= `/undo`）、`/status` `/info`（= `/session-info`）、`/full`（= `/fullscreen`）、`/terminal-setup` `/terminal-check` `/terminal-info`（= `/doctor`）。

next 渲染层另有壳自持命令（不在 core catalog，TTY 进 TUI 时生效；非 TTY 回退 piped 文本）：`/plan` `/auto` `/always-approve` `/theme`（`/t`）`/search`（转录文本搜索，与 core `/search` 同名、本壳路由优先 local）`/expand`。
标注 `shellOnly` 的命令（`/session-info` `/export` `/timeline` `/doctor` `/skills` `/plugins` `/mcps` `/mode` `/reasoning` `/minimal` `/fullscreen` `/memory`）由壳侧同一份实现承接，core 只注册元数据——**不存在「core 的降级兜底文案冒充真实输出」**（P3 P1-1 已收口）。

---

## 3. 先跑自动化闸门（红了就别做手工）

```powershell
pnpm test        # = pnpm -r build && pnpm -r --no-bail run test（四包）
pnpm typecheck   # = pnpm -r --no-bail run typecheck
pnpm lint        # = eslint . && prettier --check .
node scripts/audit-gate.mjs   # 生产依赖漏洞门（CI audit job 同款；只读 lockfile 无需 install）
```

**基线数字（编排者 2026-10-31 终验取证，时点 = FIX-1 末提交 `af36d86`；⚠️ core/cli 全量与 typecheck 当前受在途并行 WIP 影响——分支 `fix/perf-startup-render` 有另一会话 30+ 文件未提交改动，全量绿门以其收口为准）：**

| 包                        | 实测（2026-10-31）                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@harness2/zcode-adapter` | **全量 159 用例绿**（本地 ZS1 scratch 环境）；**CI 子集 23 用例绿**（`test:ci` 只跑无 scratch 依赖的 4 文件）      |
| `@harness2/gateway`       | **40 用例绿**                                                                                                      |
| `@harness2/core`          | cron **17 用例绿**（月末断言修复后）；全量受在途 WIP 影响，绿门以 WIP 收口为准                                     |
| `harness2`（CLI）         | 受在途 WIP 影响，绿门以 WIP 收口为准                                                                               |
| 生产依赖 audit            | **0 漏洞**（升级前 20：1C/6H/11M/2L；`0f5b004` 升级 MCP SDK 1.32.2 / zod 4.6.7 后清零）                            |
| dev 依赖漏洞              | 19 条（high 7 / moderate 11 / low 1）全在 vitest 工具链——**只报告不挡门**（audit-gate 策略），待工具链升级自然消退 |

- `pnpm -r build` 冷启动（本机空闲）实测 **5.6s**（2026-10-31；tsc 增量试验已回退 `77439ae`——tsbuildinfo 会被多会话并行的文件增删污染，静默产出残缺 dist，风险收益不成立）。
- **adapter 测试口径（F8 假绿治理，`af36d86`）**：包内 `test` script 经 `scripts/zs1-guard.mjs` 门控，依赖本机 ZS1 scratch 构建区（`D:/AI_Projects/harness2-zs1-build/ZCode`），无 scratch 环境会 SKIP——**完整 159 用例只能本地 scratch 跑**；无 scratch 环境（含 CI）用 `pnpm --filter @harness2/zcode-adapter test:ci`（`vitest.ci.config.mts`：无 scratch 依赖的 4 文件 23 用例；其余 16 文件依赖 `@zcode/*` alias，CI 显式排除并在运行时打印排除清单）。**CI 不再产出「zcode-adapter 测试全绿」假信号，结论以本地 scratch 全门为准**。
- `test/api-surface.test.ts` 必须绿：导出面基线为 `packages/core/test/fixtures/api-surface-baseline.json` 当前快照。它红 = 动了 core 公开导出，必须走计划授权流程并同步基线，不能就地改基线文件。
- CI（`.github/workflows/ci.yml`）：**quality**（typecheck + eslint + prettier，平台无关单跑）+ **test**（三平台 matrix：core / gateway / cli / adapter test:ci）+ **audit**（生产依赖漏洞门）+ pages（main push 部署 docsify）。

---

## 4. 零 key 通路（第一条必过的链路）

`--provider mock` 使用内置演示脚本：**不加载配置、不触发审批**，所以不需要任何 API key。

```powershell
harness2 doctor --home D:\tmp\h2-smoke-home
harness2 chat --provider mock --home D:\tmp\h2-smoke-home --root D:\tmp\h2-smoke-root
```

正确结果：

1. `doctor` 输出 node 版本、config/auth（脱敏）、目录可写、会话库完整性、skills 各项，无 FAIL。
2. `chat` 起 TUI，状态栏常驻显示上下文占用。
3. 发一条普通消息后有流式增量渲染。
4. 退出后出现 `D:\tmp\h2-smoke-home\sessions\D--tmp--h2-smoke-root\<会话id>\session.v1.jsonl`。

**自动化等价路径**（本手册 I/J 组的命令级用例即用它实跑，可直接复现）：管道喂 stdin 走 legacy readline（不启用 next 渲染层），命令经 core 统一分发。

```bash
printf 'hello\n/search hello\n/title --auto\n/exit\n' | node packages/cli/dist/index.js chat --provider mock --no-tui --home D:/tmp/h2-smoke-home --root D:/tmp/h2-smoke-root
```

---

## 5. 手工用例

> 记录方式：每条记 `通过 / 不通过 + 实际输出`。除 SM-23、SM-24 外都在 §4 的隔离数据根里做。
> （旧壳时代的 D 桌面端 / G 桌面三页 / H web 壳三组用例 = SM-29～33、SM-42～47，**原文整体移至 §11 历史**，SM 编号保留。）

### A. 会话、撤销与上下文（TUI）

| 编号  | 步骤                                                            | 正确结果                                                                                                                                                                                                                                           |
| ----- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-01 | `/help`                                                         | 列出上面 29 条命令（按会话/历史/通用/模式/上下文/调度分组）及一句话描述；末尾说明段七条：文件快照（write/edit 可 /undo、bash 不进快照）、`run_script` 子进程与快照/日志边界、redo 语义、append-only、fork 语义、`[a]` 会话级、`/` 开头消息被当命令 |
| SM-02 | `/new`，再 `/sessions`                                          | 每行 `<id>  MM-DD HH:mm  N 条  <首条用户文本>`；当前会话行尾带 ` *`                                                                                                                                                                                |
| SM-03 | `/sessions <关键字>`                                            | 命中会话下方缩进显示 `命中 [role@seq]: 片段`；无命中输出 `（无匹配会话：<关键字>）`                                                                                                                                                                |
| SM-04 | `/resume <id>`；再试 `/resume`（不带 id）                       | 前者切换到该会话；后者输出 `error: 用法 /resume <id>（/sessions 查看 id）`                                                                                                                                                                         |
| SM-05 | `/fork`；再试 `/fork abc`                                       | 前者从当前会话复制**活动事件**到新会话并切换，血缘写入 header，**原会话零改动**，新会话 undo 从零开始（文件快照不复制）；后者输出 `error: 无效的事件序号 "abc"（应为 >= 1 的整数，或省略分叉全部活动事件）`                                        |
| SM-06 | 发 2 轮消息后 `/undo --dry-run`，再 `/undo`                     | dry-run 输出 `预览（未执行）：将撤回 N 条消息，rewind 到 seq X` 且**不产生任何实际改动**；实跑输出 `已撤回 N 条消息（rewind 到 seq X）`                                                                                                            |
| SM-07 | `/undo 0`                                                       | `error: 无效的撤回层数 "0"（应为 1..100 整数）`                                                                                                                                                                                                    |
| SM-08 | 让模型用 write/edit 改一个文件 + 新建一个文件，然后 `/undo`     | 文件行逐条列出：新建的显示 `删除创建的文件`，改过的显示 `恢复内容 "…"`，状态 `已执行`；文件被外部改动过的带 `[外部修改]`；本 turn 没动文件时输出 `文件快照：无（…）`                                                                               |
| SM-09 | 让模型用 bash 改文件，再 `/undo`                                | **不恢复** bash 造成的改动，且输出如实声明这一点（这是设计行为，不是缺陷）                                                                                                                                                                         |
| SM-10 | `/undo` 后再发一条新消息，然后 `/redo`                          | 输出 `已重做 N 条消息（rewind 到 seq X）`；撤销后新输入的那条被移出当前上下文，但仍在日志里（`traj` 可见）                                                                                                                                         |
| SM-11 | 上述操作全程盯 `session.v1.jsonl`                               | **只增不改**：undo/redo 只追加 rewind 标记，历史行永不回改（append-only）                                                                                                                                                                          |
| SM-12 | `/mode`，再 `/mode auto`                                        | 显示/切换审批模式，可选 `normal\|allow-approve\|auto\|plan`                                                                                                                                                                                        |
| SM-13 | 触发一次工具审批，选 `[a] 本会话总是`，重启 chat 再触发同一工具 | 本会话内该工具后续不再询问；**重启后恢复询问**（会话级、仅进程内、不落盘）                                                                                                                                                                         |
| SM-14 | `/context`；`/compact 精简历史`                                 | 前者显示当前上下文占用；后者手动触发压缩。自动压缩阈值 = `contextWindow × 0.75`，压缩后最近 6 条保留原文                                                                                                                                           |
| SM-15 | `/reasoning`，`/reasoning on`                                   | 查看/切换推理过程展示，默认 `off`                                                                                                                                                                                                                  |
| SM-16 | `/tasks`                                                        | 只读列出 cron 任务                                                                                                                                                                                                                                 |
| SM-17 | 直接发一条以 `/` 开头的普通文本                                 | 被当作命令处理，提示 `未知命令 …（/help 查看命令列表）`，不会作为消息发出                                                                                                                                                                          |

### B. 轨迹、导出与回放

| 编号  | 步骤                                                                       | 正确结果                                                                                                              |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SM-18 | `harness2 traj <会话目录>`；再加 `--all`、`--json`                         | 时间线可读；`--all` 额外显示被回退遮蔽的影子事件；`--json` 输出事件 + 投影 + 告警的结构化 JSON                        |
| SM-19 | `harness2 export <会话目录> -o D:\tmp\s1.zip`，再导一次 `-o D:\tmp\s2.zip` | 两个 zip **字节一致**（内部 mtime 固定为 2000-01-01，保证幂等）；原会话目录只读不被改；有子代理时含 `subagents/<id>/` |
| SM-20 | `harness2 replay D:\tmp\s1.zip`                                            | 逐事件解析通过 + 输出投影摘要；若人为破坏 zip 里某行 JSON，应**报告坏行**而不是静默通过                               |

### C. 管理子命令

| 编号  | 步骤                                                                                               | 正确结果                                                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SM-21 | `harness2 config check`                                                                            | 打印两级合并后的 providers / roles / key 来源，**密钥脱敏**；配置非法时明确报错                                                                                                                                                                              |
| SM-22 | `harness2 doctor --probe`                                                                          | 实连每个 MCP 服务器（每个超时 5s），列出状态；无 MCP 配置时明确说明                                                                                                                                                                                          |
| SM-23 | `harness2 mcp list`，再 `harness2 mcp list --no-probe`                                             | 前者含状态与工具数；后者只读配置、不发起连接（明显更快）                                                                                                                                                                                                     |
| SM-24 | `harness2 memory show` / `pending` / `approve <id>` / `reject <id>` / `clear --target user`        | `show` 显示条目与用量（含漂移告警）；ask 模式下模型的记忆写入先进 pending，`approve` 重放执行且预算/漂移校验照常生效，`reject` 丢弃；`clear` 不可恢复。预算：`MEMORY.md` 2200、`USER.md` 1375，pending 上限 200                                              |
| SM-25 | `harness2 skill list`                                                                              | 合并 `.harness2/skills/`（项目级）与 `~/.harness2/skills/`（全局），标出来源；**同名时项目级覆盖全局**                                                                                                                                                       |
| SM-26 | `harness2 plugin list` → `enable <name>` → `disable <name>`                                        | `enable` 先打印权限清单再要确认，确认后写入全局 config 的 `plugins.allow`；`disable` 从中移除                                                                                                                                                                |
| SM-27 | `harness2 cron add "写一句日报" --every 5m` → `list` → `run <id>` → `history <id>` → `remove <id>` | `list` 显示 id/调度/下次执行/启用/连续失败；`run` 立即执行一次且**不改 nextRun、不计入熔断计数**，结果写 history；`history` 显示最近 20 次含 `result.md` 摘要；serve 运行期间按 60s tick 到点自动执行。**自然语言形态（`每天上午9点`）CLI 未接线，见 SM-57** |
| SM-28 | `harness2 browser install`，随后让模型使用浏览器工具                                               | 安装 chromium 后浏览器工具可用；未安装时应给出明确提示而不是崩溃                                                                                                                                                                                             |

### E. serve / HTTP 面

端点（`base = http://127.0.0.1:<port>`）：

| 方法 + 路径                                   | 说明                                  |
| --------------------------------------------- | ------------------------------------- |
| `GET /api/config`                             | 配置；健康检查端点（仅 2xx 视为健康） |
| `GET /api/sessions[?cwd=<编码后的工作目录>]`  | 列会话                                |
| `POST /api/sessions`                          | 新建会话                              |
| `GET /api/sessions/:id/events`                | 事件流（历史）                        |
| `GET /api/sessions/:id/run-config`            | 运行配置                              |
| `GET /api/sessions/:id/plan-state`            | 计划状态                              |
| `GET /api/sessions/:id/execution-view`        | 执行视图                              |
| `GET /api/sessions/:id/change-review`         | 改动评审                              |
| `POST /api/sessions/:id/fork` `/undo` `/redo` | 分叉 / 撤销 / 重做                    |
| `WS /ws`                                      | 事件面，`protocolVersion=2`           |

鉴权：请求头 `x-harness2-token`，取值优先级 **header > Bearer > `?token=`**；token 在数据根的 `serve.lock` 里（字段 `pid`/`port`/`ts`/`token`，POSIX 下权限 0600）。环境变量 `HARNESS2_SERVE_TOKEN` 可指定 token，`HARNESS2_SERVE_REQUIRE_TOKEN` 可关闭严格模式（关闭时会打印一次性告警）。HTTP 帧上限 1 MiB。

| 编号  | 步骤                                                  | 正确结果                         |
| ----- | ----------------------------------------------------- | -------------------------------- |
| SM-34 | 不带 token 请求 `GET /api/config`                     | **401**（默认严格鉴权）          |
| SM-35 | 带 `x-harness2-token: <serve.lock 里的 token>` 再请求 | 2xx + JSON                       |
| SM-36 | 用一个过期/错误 token 请求                            | 401，且错误信息指向 token 不匹配 |

### F. CLI 单一 TUI / 命令面板 / 阻塞卡片 / 状态行（P2～P3）

> 本组为 next 渲染层交互 → **真机项**（启动：真实 TTY 跑 `harness2 chat --provider mock --home D:\tmp\h2-smoke-home --root D:\tmp\h2-smoke-root`；TTY 自动进 TUI，无开关，`--no-tui` / `HARNESS2_NO_TUI=1` 可强制回退 piped；管道/重定向 stdin 非 TTY 按设计不进 TUI）。每条的自动化等价覆盖见「自动化」列，**不得用自动化结果冒充真机通过**。

| 编号  | 步骤                                                                                                   | 正确结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-37 | `/fullscreen` → `/minimal` → `/fullscreen`（或 `/full`），全程盯会话/草稿是否保留                      | 进程内切换、不重启：会话/草稿/折叠/队列保留（G-02）。fullscreen = alt-screen 全帧（八区域布局）；minimal = 追加式转录写进终端原生滚动区 + 底部 prompt 块（不进 alt-screen、不接管鼠标，G-01）。自动化：`packages/cli/test/tui/render/mode.test.ts`、`test/tui/next/p3d-wiring.test.ts`                                                                                                                                                                                                  |
| SM-38 | minimal 下发 `/theme` `/t` `/search` `/timeline` `/dashboard`；fullscreen 下发 `/expand`               | 被 G-03 谓词拒绝，文案逐字：`当前渲染模式（minimal）下不可用：/theme（仅 fullscreen 模式提供；运行 /fullscreen 切换本会话）`（`/t` 先归一为 `/theme` 再判；`/search` 指本壳转录搜索）；fullscreen 下 `/expand` 同理指向 `/minimal`。自动化：`packages/cli/test/tui/render/minimal.test.ts`、`test/tui/next/p3d-wiring.test.ts`（G-03 门控）                                                                                                                                             |
| SM-39 | `Ctrl+P`（任意时）→ 面板内输入 `t`、↑↓ 选择、Enter 执行；清空草稿后按 `?`；Esc 关闭                    | `Ctrl+P` 恒开 palette；`?` 仅空草稿时开（打字中的 `?` 进草稿，对齐上游）；面板模糊过滤（前缀命中 > 子序列命中）；每行来源 badge 如实标 core/shell（P2-4）；Enter 执行所选且**每一项都有真实行为**（无假入口，P3 退出闸门）；Esc 关闭。自动化：`packages/cli/test/tui/next/p3e-chrome.test.ts`（29 项逐项真执行）、`test/tui/commands/palette-model.test.ts`                                                                                                                             |
| SM-40 | 触发一次工具审批（mock 的 write 演示）→ 卡上 Tab/数字选 y/a/n；再按 Esc、Tab；再开 `Ctrl+O` 触发新审批 | permission 卡（G-21）显示工具名 + 已脱敏参数 + 三选项；优先级固定 `permission > cancel-turn > question > elicitation`（`packages/cli/src/tui/cards/types.ts` 冻结；本壳唯一真实卡源 = core 审批 permission，其余三型无来源、**不造假卡**）；Esc = 寄放（卡保留、审批仍挂起、键盘回 composer）、Tab 回卡、Ctrl+C 取消；`Ctrl+O`/`/always-approve` 开启后**新**审批自动代答 `a`（经核心审批队列，不绕过）。自动化：`packages/cli/test/tui/cards/*.test.ts`、`test/tui/approvals.test.tsx` |
| SM-41 | 在隔离 config.json 写 `[ui].status_line` 三型各一次后重启 chat                                         | disabled（缺省，`off/none/hidden` 同义）：整行不渲染；builtin：显示 `items`（缺省 `cwd`/`model`/`context`）；command：外部脚本经 stdin 收 JSON（**带尾随换行**）并展示 stdout，`refresh_interval=1..86400` 秒定时刷新，10s 超时显逐字 `[status line: timed out]`，取不到的数据省略不造 0。自动化：`packages/cli/test/tui/status-line/*.test.ts`、`test/tui/next/p3e-gaps-wiring.test.ts`（真实子进程、无后续输入下 ≥3 次运行 = 只可能来自定时器）                                       |

`[ui].status_line` 三型最小配置（`config.json`；`ui` 段为 P2-C 加性）：

```jsonc
// builtin：壳内渲染
{ "ui": { "status_line": { "type": "builtin", "items": ["cwd", "model", "context"] } } }
// command：外部脚本；~/ 前缀展开为 home
{ "ui": { "status_line": { "type": "command", "command": "~/bin/status.js", "refresh_interval": 2, "padding": 1 } } }
// disabled（缺省；等价 off / none / hidden）
{ "ui": { "status_line": { "type": "disabled" } } }
```

### I. core 会话能力与工具面命令（P7，可自动化）

> 触发路径：`printf '/search hello\n/exit\n' | harness2 chat --provider mock --no-tui`（管道 stdin 走 legacy readline，命令经 core 统一分发；本节命令均为 core 实现，命令面共用）。下表的输出为 2026-09-14 隔离数据根实测。

| 编号  | 步骤                                                                                                                                 | 正确结果                                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-48 | `/search hello`（先发一轮消息）；再试 `--limit N` / `--or`；再搜不存在词                                                             | `命中 1 个会话（查询：hello）` + `- <标题>（<id>）` + `    [user@seq] 片段` + `摘要：未生成（未注入摘要 provider），以上为命中原文片段`；无命中输出 `无命中：x`                                                         |
| SM-49 | `/reindex`                                                                                                                           | `索引重建：1/1 个会话，共 N 条消息`；会话目录出现 `search.index.json`（派生物，可随时重建；`session.v1.jsonl` 字节不变、不入导出 zip）                                                                                  |
| SM-50 | `/title` → `/title --auto` → `/title 冒烟标题` → `/title`                                                                            | 依次：`标题：—（可用 /title --auto 生成或 /title <标题> 设置）` → `标题：hello（auto）` → `已设置标题：冒烟标题` → `标题：冒烟标题（manual）`；`title.json` 落盘                                                        |
| SM-51 | `harness2 export <会话目录> -o D:/tmp/s1.zip` → `/import D:/tmp/s1.zip --dry-run` → `/import D:/tmp/s1.zip` → 再导一次               | dry-run：`导入 s1.zip：1 个会话（包内 2 条目）` + `- <id> [planned] 事件 N`；真导入内容一致时 `[unchanged]`（幂等不写盘）；`--overwrite` 冲突时 `[imported]`。`export` 两次字节一致（SM-19）                            |
| SM-52 | `/compact-layers`（短会话）→ `/compact`                                                                                              | `未执行压缩：未达阈值或无可折叠区域（尾部保护优先）`；达阈值时 `已执行分层压缩（turn 层）：覆盖 seq ≤ X，turn 明细 +N 条`；`/compact` 默认路径 = 同一分层实现（H-12）                                                   |
| SM-53 | `/tools list`、`/tools show coding`                                                                                                  | `工具 11 个（启用 11 / 禁用 0；未指定工具集（全量））` + 分组清单 + `工具集 5 个:`；`show` 显示声明成员/当前命中/当前缺席/是否生效                                                                                      |
| SM-54 | `harness2 tools list`、`show <名>`、`select <工具集> --dry-run`                                                                      | CLI 形态：`工具 6 个（启用 6 / 禁用 0…）`（仅内置注册表；chat/serve 运行时装齐 subagent/skill/run_script 等共 11 个，故数量不同，非缺陷）；`show` 同 SM-53；`select` 写回 config.json（`--dry-run` 只打印片段、不落盘） |
| SM-55 | `harness2 skill list`；`skill propose --name … --description … --body …`；`skill pending`；`skill approve <id>`；`skill reject <id>` | 提案两段式：propose 只暂存并回显 id（`已提交待审批提案 <id>（create <name>）`），approve 才原子写 `SKILL.md`，reject 丢弃；无待审批输出 `（无待审批技能提案）`；同名项目覆盖全局（H-22）                                |

### J. 定时任务：确定性调度与自然语言（H-46）

| 编号  | 步骤                                                                                                   | 正确结果                                                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-56 | `harness2 cron add "写一句日报" --every 5m --home D:\tmp\h2-smoke-home` → `cron list`                  | `已添加 <id>  5m  首次执行 <ISO8601>`；`list` 每任务两行（`<id>  <调度>  next=<ISO>  [已熔断/disabled]  fail=N` + 缩进指令）。`--at "daily 09:00"` 同理（next 为本地 09:00）。FIX-1 `9c234ab` 已修 cron 测试月末日期溢出断言（日历安全写法），cron 17 用例绿（2026-10-31）                                                             |
| SM-57 | `harness2 cron add "每天上午9点提醒我" --home D:\tmp\h2-smoke-home`（自然语言，不带 `--every`/`--at`） | **当前 CLI 未接线（如实登记的缺口，不是通过）**：输出 `error: --every 与 --at 必须二选一`（exit 1）。自然语言解析（H-46）只在 core 就绪（`packages/core/src/cron/natural.ts`：规则兜底 + provider 缝 + `renderCronDraftEcho` 回显 + `confirmed` 二段式落盘），命令面零接线（挂账见 OPEN.md「P7 归存」行）。core 层实测证据见下方代码块 |

SM-57 的 core 层实测（可复跑；证明「解析 + 回显确认」能力本身可用，缺的只是 CLI 入口）：

```bash
node --input-type=module -e "
import { addCronJobFromNatural } from './packages/core/dist/cron/natural.js';
import { CronJobStore } from './packages/core/dist/cron/jobs.js';
const store = new CronJobStore('./tmp-cron');
for (const text of ['每天上午9点','每5分钟','随缘提醒我']) {
  const r = await addCronJobFromNatural(store, { instruction: 'X', text });
  console.log(r.draft ? r.echo : 'REJECT：' + r.failure.reason);
}"
```

正确结果：三条分别输出 `将创建定时任务（确认后才会落盘）：… 调度：每天 09:00（daily 9:00，规则解析）…` / `… 调度：每 5 分钟（5m，规则解析）…` / `REJECT：未能从文本中识别出调度规格`（模糊输入明确拒绝、不猜）。

---

## 6. 接真实模型（本地统一网关）

数据根 `config.json`（当前本机就是这份，可直接照抄到隔离数据根）：

```json
{
  "providers": {
    "local": {
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:40080/v1",
      "models": { "big-pickle": { "contextWindow": 200000 } }
    }
  },
  "roles": { "main": { "channel": "local", "model": "big-pickle" } },
  "approval": { "mode": "default" },
  "memory": { "mode": "off", "nudgeInterval": 10 }
}
```

数据根 `auth.json`：

```json
{ "channels": { "local": { "apiKey": "sk-unified-local" } } }
```

`channels` 的键必须与 `providers` 的键、`roles.main.channel` 三者一致。

**baseUrl 陷阱**：`protocol: "openai"` 时实际请求 `{baseUrl}/chat/completions`；`protocol: "anthropic"` 时请求 `{baseUrl}/v1/messages`。本地网关给的地址已含 `/v1`，所以配 openai 协议是对的；若改用 anthropic 协议，要避免拼出重复的 `/v1/v1`。

其他约束：

- 模型 `big-pickle` 是**纯文本**模型（上下文 200K），不要用它跑图片/多模态用例。
- E2E 闸门开关：CLI 侧 `H2_E2E_LOCAL=1`；adapter 侧 e2e 矩阵（ZS 线 `run-e2e.ps1` 的 `-Fresh`/`-Approval`/`-Crash` 等轮次）走真实 provider 渠道。
- 重试策略：单次请求最多重试 3 次（退避 2s / 10s / 30s），整个 turn 最多 6 次且总时长 <= 120s。
- 每个回合结束的 `turn-end` 事件**恒带** `textOutcome`：正常收尾 `final`、被中断 `partial`、空回复 `empty`。

验证步骤：`harness2 config check` → `harness2 chat`（不带 `--provider`，走配置的 `roles.main`）→ 发一条消息 → 正常收尾时 CLI 打印 `[end_turn · steps N · toolCalls M]`。

**关于 `turn-end`/`textOutcome`（2026-09-14 实测更正）**：`turn-end` 是 **serve 的 WS 事件帧**（`packages/core/src/server/ws.ts`：`{type:'turn-end', sessionId, stopReason, finalText?, partialText?, textOutcome, error?, warning?}`），**不是会话日志事件**——`harness2 traj <会话目录> --json` 的 `events` 只有 `session/header` `user/message` `assistant/message` `assistant/attempt` `step/start` `step/end` `tool/call` `tool/result` `rewind/marker`（本机实测确认，无 `turn-end`）。要观察 `textOutcome`（`final`/`partial`/`empty`）须连 serve WS（`/ws`、`protocolVersion=2`，带 token）跑一轮看 `turn-end` 帧；自动化口径见 `packages/core/test/finaltext-network.test.ts`、`ws.test.ts`。
CLI 侧管道触发真实回合的可行写法（**stdin 必须在回合结束前保持打开**，否则回合会被取消）：

```bash
(printf '只回复两个字：好的\n'; sleep 25; printf '/exit\n') | harness2 chat --no-tui --home D:/tmp/h2-smoke-home --root D:/tmp/h2-smoke-root
# 实测输出：> 好的 / [end_turn · steps 1 · toolCalls 0]   （provider: local/big-pickle）
```

---

## 7. 常见失败与判读

| 现象                                                 | 原因 / 处置                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 健康检查 401                                         | `serve.lock` 与实际实例不匹配（旧实例残留）。结束残留进程并删除 `serve.lock` 后重启                                                                               |
| 改了代码 `harness2` 没变化                           | 忘了在全局 junction 指向的那棵树里 `pnpm build`                                                                                                                   |
| 引用实现/审查取证出现「与源码不符」                  | 大概率 dist 过期：先 `pnpm -r build` 再取证；**禁止对可能过期的 dist 下结论**（P7 审查曾对过期产物误报 P0）                                                       |
| core 的 browser 用例失败                             | 缺 chromium：`harness2 browser install` 或 `pnpm --filter @harness2/core exec playwright install chromium`（POSIX 还需 `install-deps`）                           |
| `api-surface` 用例红                                 | 碰了 core 公开导出面；走计划授权流程同步基线：`H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`                    |
| 单文件复测报 `No test files found`                   | 必须进包目录再跑：`cd packages\cli ; pnpm exec vitest run <文件>`                                                                                                 |
| TUI 显示异常                                         | 用 `--no-tui`（或 `HARNESS2_NO_TUI=1`）退回 legacy readline 路径对比，判断是渲染层还是逻辑层问题                                                                  |
| next 渲染层「看不到新 UI」                           | next 层需真实 TTY（P10 起 TTY 即进 TUI，无开关）；管道/重定向 stdin（非 TTY）按设计回退 piped 文本 → 换真实终端跑                                                 |
| `pnpm exec vitest` 报 adapter 用例全 SKIP            | adapter `test` script 走 zs1-guard 门控，本机无 ZS1 scratch 区（`D:/AI_Projects/harness2-zs1-build/ZCode`）时跳过——属设计行为；无 scratch 环境改跑 `test:ci` 子集 |
| `pnpm audit` 报 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS` | 默认 registry（npmmirror）无 audit 端点；审计走 `node scripts/audit-gate.mjs`（显式 `--registry=https://registry.npmjs.org`）                                     |
| `skill` 子命令报 `unknown option '--home'`           | `skill pending/approve/reject/propose` 只收 `--root`（提案暂存在项目根）；`--home` 仅 `list` 支持                                                                 |
| core 三例 `EADDRINUSE`（端口 46213）                 | 本机正跑 `harness2 serve --port 46213`；杀进程或换 serve 端口后复跑（技术债：测试固定端口，见 OPEN.md）                                                           |

（旧壳时代桌面/web 的判读条目——桌面白屏 `base:'./'`、桌面健康检查等待、web 未连接/401 等——原文见 §11。）

---

## 8. 签收表

| 组           | 用例                                                                                                                                  | 结果 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 构建与启动   | §1.1 构建产物五项、§1.2 全局命令、§1.3 serve                                                                                          |      |
| 自动化闸门   | §3：adapter 159（本地 scratch）/ CI 子集 23 · gateway 40 · core cron 17 · audit 0 漏洞（时点 `af36d86`；全量绿门以在途 WIP 收口为准） |      |
| 零 key 通路  | §4 四项                                                                                                                               |      |
| A 会话与撤销 | SM-01 ~ SM-17                                                                                                                         |      |
| B 轨迹导出   | SM-18 ~ SM-20                                                                                                                         |      |
| C 管理子命令 | SM-21 ~ SM-28                                                                                                                         |      |
| E serve 鉴权 | SM-34 ~ SM-36                                                                                                                         |      |
| F CLI 交互   | SM-37 ~ SM-41（真机；自动化等价覆盖见附注）                                                                                           |      |
| I core 命令  | SM-48 ~ SM-55（可自动化，管道 legacy chat + CLI 子命令）                                                                              |      |
| J 定时任务   | SM-56 ~ SM-57（SM-57 为**未接线缺口**，如实登记）                                                                                     |      |
| 真实模型     | §6 验证步骤                                                                                                                           |      |
| 桌面端       | §10 ZS6 链路（出包 + 装机验收，材料人类签收）                                                                                         |      |

本手册 F 组标注「真机项」的条目（CLI next 渲染层）需在真实 TTY 完成；自动化用例只作等价覆盖证明，不能替代真机签收。桌面端 GUI 验收整体走 §10 的 ZS6 链路（旧壳 D/G/H 组已随退役移入 §11 历史）。

仍需真机/人工完成、不在本手册范围内的：README 真机截图残余两张（cli-chat / traj-timeline，见 OPEN.md）、云端厂商 API key 一轮（A2-2，见 OPEN.md）、QQ/飞书网关真机联调（待凭据，见 OPEN.md）、CLI IME / raw-mode / alt-screen 真机签收（见 OPEN.md「next 壳真机验收」行）。

---

---

## 9. 本手册的事实来源

- `harness2 --help` 与各子命令 `--help`（`packages/cli/dist/index.js` @ `c7c76a0` 底本；FIX-1（`f3ccac6..af36d86`）未改 CLI 命令面）
- `packages/core/src/commands/catalog.ts`（`CORE_COMMAND_META`，29 条命令 = TUI 斜杠命令唯一源）、`packages/core/src/session/capabilities.ts`（`SESSION_CAPABILITY_COMMANDS` 与 `/search` `/reindex` `/import` `/title` `/compact-layers` 输出文案）
- `packages/cli/src/commands/tools.ts`、`commands/cron.ts`、`commands/skill.ts`（子命令选项与输出）；`packages/core/src/tools/manage.ts`（工具集 list/show/select）；`packages/core/src/skills/authoring.ts`（propose/pending/approve/reject）
- `packages/core/src/cron/natural.ts`（H-46 自然语言解析、`renderCronDraftEcho` 回显、`addCronJobFromNatural` 二段式；**CLI 未接线**）、`packages/core/test/cron/*.test.ts`（FIX-1 `9c234ab` 月末断言修复，17 用例绿）
- `packages/cli/src/tui/next/next-shell.ts`（全屏命令门控拒绝文案、palette 键位、`NEXT_COMMANDS`）、`tui/render/minimal.ts`（`FULLSCREEN_ONLY_COMMANDS` / `commandSupportInMode`）、`tui/cards/types.ts`（`CARD_PRIORITY` 冻结顺序）、`tui/status-line/{config,contract}.ts`（三型与 stdin JSON 契约常量）
- `packages/core/src/server/http.ts`（路由）、`ws.ts`（`WS_PATH`）、`security.ts`（`x-harness2-token`、`HARNESS2_SERVE_TOKEN`、`HARNESS2_SERVE_REQUIRE_TOKEN`）
- **adapter 测试口径**：`packages/zcode-adapter/vitest.ci.config.mts` 头注释（F8 假绿治理取证：16 文件 scratch 依赖 / 4 文件 23 用例子集）、`scripts/zs1-guard.mjs`（test 门控）
- **audit 门**：`scripts/audit-gate.mjs` 头注释（门禁策略与实测依据）；`.github/workflows/ci.yml`（quality/test/audit 三 job 结构）
- 根 `package.json` 脚本；`docs/HANDOFF.md` §2/§3（2026-10-31 基线数字与命令）；`packages/core/test/fixtures/api-surface-baseline.json`（导出面快照）
- **桌面端（ZS6 链路）**：`scripts/zs6/zs6-pack.ps1`、`docs/ai-framework/plans/zs6-pack-report.md`、`zs6-release-draft.md`、`zs6-brand-checklist.md`、`docs/ai-framework/upstream-resync.md`

---

## 10. 桌面端验收（ZS6 链路）

> 产品桌面端 = **ZCode 壳 + harness2 内心**（2026-10-24 起旧 Electron 壳退役）。出包与验收**不入 CI**，走本地装配通道：

1. **出包**：`scripts/zs6/zs6-pack.ps1`（ZCODE_ENV=production 全链重建 → 打包 NSIS + portable；通道障碍与对策实录见 `docs/ai-framework/plans/zs6-pack-report.md`）。
2. **产物核对**：`zs6-pack-report.md` 记录终版 NSIS `77325B1C…C62238` / portable `F723A616…411F9C2`（171.8/171.4MB）+ SHA256；**打包体 smoke GATE=PASS 6/6**（英文 locale 下 UA=Harness2Desktop/3.16.2、Help「About Harness2 Desktop」、关于窗版权行）。
3. **装机验收**：按 `docs/ai-framework/plans/zs6-release-draft.md` 的 9 项清单由人类真机执行（V9）；通过后 tag（三案选一）+ GitHub Release（文案粘贴即用）。
4. **patch 红线**：UI patch 基线 11 处（`docs/ai-framework/plans/zs6-brand-checklist.md`），diff 落 `docs/patches/zs-shell-patches.patch`；再 +1 须人类拍板；上游同步纪律见 `docs/ai-framework/upstream-resync.md`。

---

## 11. 历史（pre-2026-10-24 旧壳时代——⚠️ 以下内容描述的 desktop / ui-shared / web 三包已删除，仅考古，现状以本文档其余各节为准）

> 归档范围：旧 §1.3 桌面 dev/smoke、旧 §1.5 web 壳、六包测试基线表、D 桌面端（SM-29~~33）、G 桌面三页（SM-42~~44）、H web 壳（SM-45~~47）与旧 §7 的桌面/web 判读条目。**原文保留、未删改**（SM 编号保持原样，故现行手册 SM 号在 29~~36 / 37~~41 / 48~~57 连续，历史组占 29~~33 与 42~~47 两段空洞）。

### 11.1 旧 §1.3 桌面端：开发态启动（已退役）

```powershell
pnpm --filter @harness2/desktop dev      # = pnpm build && electron .
pnpm --filter @harness2/desktop smoke    # = pnpm build && electron . --smoke（自动化冒烟模式）
```

启动链路（出问题按这个顺序排查）：桌面端自己 spawn 本地 serve（渲染进程零 Node）→ 解析 serve stdout 的一行 JSON `{"port":N,"pid":M}` → 轮询 `GET /api/config` 做健康检查（**仅 2xx 视为健康**）→ token 每次从 `serve.lock` 重读。若已有 serve 实例，会读 `serve.lock` 直接采纳。

### 11.2 旧 §1.5 web 壳：启动入口（P8，已退役）

```powershell
# 终端 1：起 serve（严格鉴权，token 在数据根 serve.lock）
harness2 serve --port 46213 --home D:\tmp\h2-smoke-home --root D:\tmp\h2-smoke-root

# 终端 2：起 web 壳 dev（vite 代理 /api 与 /ws 到 serve，避开 CORS）
$env:VITE_HARNESS2_PROXY = "http://127.0.0.1:46213"
pnpm --filter @harness2/web dev            # 默认 http://localhost:5173
```

浏览器打开 dev 输出的地址，并带上 serve token（严格模式必需，二选一）：
`http://localhost:5173/?token=<serve.lock 的 token>`，或构建/启动前置 `VITE_HARNESS2_TOKEN=<token>`。

正确结果：页面顶部显示「已连接」；控制台无鉴权错误。`pnpm --filter @harness2/web build` 产出 `packages/web/dist/index.html`。
（自动化已验证：dev server 起 200 + `packages/web` 36 例测试全绿；浏览器内的真实对话一轮见 SM-46，属真机项。）

### 11.3 旧 §3 六包测试基线（main `c7c76a0` 本机实测，2026-09-14）

正确结果（main `c7c76a0` 本机实测基线，对不上就是回归）：

| 包                    | passed   | skipped | files   |
| --------------------- | -------- | ------- | ------- |
| `@harness2/core`      | 1232     | 2       | 85      |
| `@harness2/gateway`   | 40       | 0       | 14      |
| `harness2`（CLI）     | 1703     | 2       | 112     |
| `@harness2/desktop`   | 952      | 1       | 96      |
| `@harness2/ui-shared` | 70       | 0       | 8       |
| `@harness2/web`       | 36       | 0       | 4       |
| **合计**              | **4033** | **5**   | **319** |

- `typecheck`：0 错误。
- `lint`：0 error / 46 warnings（warning 是已知存量，不算失败）。
- `test/api-surface.test.ts` 必须绿：导出面基线为 **495** 条。它红 = 动了冻结区（`packages/core/**`、`packages/gateway/**`）的公开导出，必须走 `fix/*` 解冻窗口并同步基线，不能就地改基线文件。
- 两个新包已进 CI：`pnpm -r --no-bail test` 覆盖 ui-shared / web（.github/workflows/ci.yml 的 test job 有独立步骤，单点红不遮蔽其余包）。

### 11.4 旧 D 组：桌面端（SM-29 ~ SM-33，已退役）

| 编号  | 步骤                                    | 正确结果                                                                                                                                                                        |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-29 | `pnpm --filter @harness2/desktop dev`   | 窗口正常渲染（**不白屏**），自动拉起 serve 并通过健康检查                                                                                                                       |
| SM-30 | 新建 2 个会话 → 分屏 → 左右各选一个会话 | **右侧六个页签全部有数据**（run-config / plan-state / execution-view / change-review 等），切换会话后各页签随之刷新。这是 2026-09-11 修复的阻塞级缺陷 P1-1 的回归点，必须重点看 |
| SM-31 | 在桌面端做一次 undo / redo              | 与 CLI 语义一致；轨迹时间线可回看                                                                                                                                               |
| SM-32 | 关闭窗口                                | 弹出确认对话框，确认后进程退出、serve 随之清理                                                                                                                                  |
| SM-33 | 先 `harness2 serve` 再启动桌面端        | 桌面端读 `serve.lock` **采纳既有实例**，不重复 spawn                                                                                                                            |

### 11.5 旧 G 组：桌面：三栅让步链 / 轨迹页 / 模型配置（P4～P6，已退役）

> GUI 交互为**真机项**；每条给自动化等价覆盖。启动：`pnpm --filter @harness2/desktop dev`（无头冒烟 `pnpm --filter @harness2/desktop smoke` 已实测输出 `{"ok":true,"rendererLoaded":true,"bridgeReady":true,"port":N}` exit 0）。

| 编号  | 步骤                                                                             | 正确结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-42 | 拖侧栏/右栏手柄调宽；逐步缩窗到 <1024px、直到可用宽 <300；刷新应用               | 侧栏 264～420px（默认 280）；右栏首开 = 视口 45%、上限 70%；缩窗时**让步链按上游次序**：可用宽 <300 → 右栏轨道摘除（宽度归零）并把 `canShow=false` 交给占用方由其自关（壳不代关）→ 只有无右栏轨道时中栏才可能 <400；**偏好宽度不被改写**；窗口 <1024px 侧栏自动收起并保留 56px 轨道；几何不持久化（无 localStorage）。自动化：`packages/desktop/test/layout/geometry.test.ts`、`app-frame.test.tsx`、`no-persistence.test.ts`、`test/sidebar/d22-collapse-animation.test.tsx` |
| SM-43 | 打开某会话「轨迹」标签；悬停时间概览中的助手条；在工具卡点 `inspect`             | 记录表初始只挂尾部 50 行、向前滚动按页补（虚拟化）；时间概览的助手条**区分 TTFT 与解码段**——TTFT 只来自运行时观测，未观测到留空、**绝不用「总耗时一半」估算**；悬停 500ms 出详情（499/500 边界）；工具卡 `inspect` 带 `callId`/`seq` → 轨迹页**定位并选中对应记录**（真跳转，不是空标签页）。自动化：`packages/desktop/test/trajectory/**`（`timing.test.ts` / `virtual-window.test.ts` / `inspect-focus.test.ts` / `use-hover-detail.test.tsx`）                             |
| SM-44 | 设置 → 模型：新增提供方（id/协议/baseUrl）→ 填密钥 → 「发现模型」勾选添加 → 保存 | **全程不手改文件**（本阶段唯一硬指标）：`config.json` 只落具名引用、**零密钥值**；密钥只写 `auth.json`（**只写不回显**，渲染层仅输入框瞬时持有）；发现模型走真实端点、可搜索勾选；密钥四类非法（非 ASCII / `NAME=value` / 引号包裹 / 空或重复 id）被拒并不写盘；`revision` 冲突有提示。自动化：`packages/desktop/test/settings/models/models-section-wiring.test.tsx`（真主进程函数 + 临时 home/root）、`models-document.test.ts`、`discover`/`validate` 对应用例             |

### 11.6 旧 H 组：web 壳（P8，已退役）

> 浏览器内交互为**真机项**；启动入口见 §11.2。自动化已验证：`packages/web` 36 例全绿 + dev server 起 200 + `pnpm --filter @harness2/web build` 通过。

| 编号  | 步骤                                                                               | 正确结果                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM-45 | 按 §11.2 起 serve + web dev，浏览器打开带 `?token=` 的地址                         | 顶部显示「已连接」；会话列表来自真实 serve（`GET /api/sessions`，带 `x-harness2-token`）；无可用 cwd 时「新会话」**如实置灰并给出原因**（不造假入口）。自动化：`packages/web/test/web-app.test.tsx`、`serve-client.test.ts`                                                     |
| SM-46 | 选中会话 → Chat 标签 + composer → 发送一条长任务 → 观察流式与工具卡 → 点「■ 停止」 | 真实模型多步工具调用与流式渲染（转录含工具卡/exit/耗时）；繁忙中主按钮由「发送」切为「■ 停止」（D-36 单按钮）；点停止后会话日志出现 `assistant/attempt {"error":"cancelled"}` 且按钮回「发送」。自动化：`packages/web/test/stream-stop.test.ts`、`web-app.test.tsx`（停止三态） |
| SM-47 | 检查 token 传递路径；阅读 `docs/API-STABILITY.md` 的 web 边界                      | 三条路径均客户端可见（构建期 `VITE_HARNESS2_TOKEN` 内联 / 页面 URL `?token=` / WS 握手 `?token=`）；明文口径：web token **仅用于本地/受信网络**，生产须同源反代注入鉴权（如实声明，非缺陷）。自动化：`packages/web/test/degradation.test.ts`（降级真实性）                      |

### 11.7 旧 §7 的桌面/web 判读条目（已退役）

| 现象                     | 原因 / 处置                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面端白屏               | 渲染层没构建，或有人把 vite 的 `base: './'` 改成了绝对路径（2026-09-07 白屏事故根因，**不要改**）。先 `pnpm --filter @harness2/desktop build` |
| 桌面端卡在等健康检查     | 没先 build，或 serve 起不来；看 `dist-electron/main/main.js` 是否存在                                                                         |
| web 页「未连接」/ 401    | URL 缺 `?token=`，或 `VITE_HARNESS2_PROXY` 未指向实际 serve 端口；serve 默认严格鉴权，token 在数据根 `serve.lock`                             |
| 模型配置「发现模型」失败 | 旧壳 `discoverModelsFor` 读 `auth.json`/env，须先保存密钥再发现（与上游「表单草稿密钥直接探测」的已知差异 D-55）——口径已被 ZS4.5 重设计取代   |

本手册旧版（2026-09-14 基线，适用 main `c7c76a0`）的 F/G/H 组真机签收说明与签收表原文，经 git 历史（`git log -- docs/SMOKE-TEST.md`）可查。
