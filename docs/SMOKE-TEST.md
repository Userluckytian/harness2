# 冒烟测试手册（手工验收）

> 适用版本：main `7d29acb`（2026-09-12）。
> 本手册的命令、选项、端点、输出文案**全部取自源码与 `--help` 实测**，不含推测；来源见文末 §9。
> 用途：一名验收人按本手册独立完成一轮端到端冒烟，逐条记录实际结果。自动化测试见 §3。

---

## 0. 前置环境

| 项 | 要求 | 自检命令 |
| --- | --- | --- |
| Node | >= 22（实测 v22.23.1） | `node -v` |
| pnpm | 11.13.0 | `pnpm -v` |
| 仓库 | `D:\AI_Projects\harness2` | `git -C D:\AI_Projects\harness2 log --oneline -1` |
| chromium（浏览器工具用，约 130MB） | 首次使用浏览器工具前必须安装 | `harness2 browser install` |

**数据根**：`--home` 缺省为 `~/.harness2`（Windows 下 `C:\Users\<你>\.harness2`）。目录内容：

```
config.json            两级合并配置的用户级部分（providers / roles / approval / memory）
auth.json              凭据（channels.<channel>.apiKey）
sessions/              会话库：sessions/<工作目录编码>/<会话id>/session.v1.jsonl
cron/                  定时任务
desktop-layout.json    桌面端分屏布局
desktop-metadata.json  桌面端会话元数据
desktop-preferences.json
serve.lock             serve 运行期才有：{ pid, port, ts, token }（POSIX 下 0600）
```

工作目录编码把路径分隔符换成 `--`，例如 `C:\Users\ASUS` → `C--Users--ASUS`；会话 id 形如 `20260907-024839-bcf9d5`。

> **红线**：带破坏性的用例（`memory clear`、`/undo` 的文件恢复、cron 增删）一律加 `--home D:\tmp\h2-smoke-home` 走隔离数据根，**不要在真实 `~/.harness2` 上跑**。

---

## 1. 构建与三种启动入口

### 1.1 构建（必做，所有入口都依赖产物）

```powershell
cd D:\AI_Projects\harness2
pnpm install --frozen-lockfile
pnpm build
```

正确结果：四个包全部 exit 0，且下列产物存在——

| 产物 | 属于 |
| --- | --- |
| `packages/cli/dist/index.js` | CLI 入口（bin `harness2` 指向它） |
| `packages/desktop/dist-electron/main/main.js` | 桌面端主进程（package.json `main`） |
| `packages/desktop/dist/renderer/index.html` | 桌面端渲染层（vite `outDir`） |

### 1.2 CLI：全局命令（本机已配置好）

全局 bin 已经 link 完成，**任意终端可直接用**：

```
D:\Programs\nodejs\harness2       →  junction  →  D:\AI_Projects\harness2\packages\cli
harness2 --version                →  1.0.0
```

正确结果：任意目录下 `harness2 --version` 输出 `1.0.0`；`harness2 --help` 列出 §2 的 14 个子命令。

注意三点：

1. `bin` 指向 `dist/index.js`，**改了源码必须重新 `pnpm build`** 才生效（link 是软链，不做编译）。
2. 全局命令指向的是 junction 的那棵树，build 要在**那棵树**里跑。
3. 换树或重装：目标树的 `packages/cli` 里执行 `npm link`；卸载 `npm unlink -g harness2`。

不想用全局命令时，仓库内等价写法：`node packages\cli\dist\index.js <子命令>`。

### 1.3 桌面端：开发态启动

```powershell
pnpm --filter @harness2/desktop dev      # = pnpm build && electron .
pnpm --filter @harness2/desktop smoke    # = pnpm build && electron . --smoke（自动化冒烟模式）
```

启动链路（出问题按这个顺序排查）：桌面端自己 spawn 本地 serve（渲染进程零 Node）→ 解析 serve stdout 的一行 JSON `{"port":N,"pid":M}` → 轮询 `GET /api/config` 做健康检查（**仅 2xx 视为健康**）→ token 每次从 `serve.lock` 重读。若已有 serve 实例，会读 `serve.lock` 直接采纳。

### 1.4 CLI：本地会话服务

```powershell
harness2 serve --port 46213 --home D:\tmp\h2-smoke-home --root D:\tmp\h2-smoke-root
```

`--port` 缺省 46213，`--port 0` 为随机可用端口；仅监听 127.0.0.1。正确结果：进程常驻，数据根下出现 `serve.lock`，其中 `port` 与实际监听一致。

---

## 2. 命令面（确证）

| 子命令 | 用途 | 子项 / 关键选项 |
| --- | --- | --- |
| `chat` | 交互式 REPL（流式渲染 / 会话管理 / `/undo` `/redo` `/fork` / 审批交互） | `--session <id>`、`--fork <id>`、`--at <seq>`、`--provider <name>`、`--mock-script <f>`、`--mock-child-script <f>`、`--root <dir>`、`--home <dir>`、`--no-tui` |
| `serve` | 本地会话服务（HTTP 控制面 + WS 事件面，仅 127.0.0.1） | `--port`（默认 46213）、`--root`、`--home`、`--provider` |
| `traj <sessionDir>` | 查看会话轨迹时间线 | `--json`、`--all`（含被回退遮蔽的影子事件） |
| `export <sessionDir>` | 导出会话为 ZIP（只读打包，含 `subagents/<id>/`） | `-o, --out <file>`（缺省 `./<sessionId>.zip`） |
| `replay <zip>` | 回放校验导出的 ZIP（逐事件解析 + 投影摘要 + 坏行报告，零 key 可跑） | — |
| `doctor` | 环境自检：node 版本 / config+auth 脱敏 / 目录可写 / MCP / 会话库完整性 / skills | `--root`、`--home`、`--probe`（实连 MCP，每 server 超时 5s） |
| `config` | 配置管理 | `check`（校验两级合并配置并脱敏展示 providers/roles/key 来源） |
| `memory` | 长期记忆管理 | `show`、`clear --target memory\|user\|all`、`pending`、`approve <id>`、`reject <id>` |
| `skill` | 项目级 Skills 管理 | `list`（两级扫描合并，同名项目覆盖全局） |
| `plugin` | 插件管理（manifest 权限 + 装载审批） | `list`、`enable <name>`、`disable <name>` |
| `mcp` | MCP 服务器管理 | `list`（默认逐 server 探测，`--no-probe` 只看配置） |
| `cron` | 定时任务（serve 运行期间到点自动执行） | `list`、`add <指令> --every 5m \| --at "daily 09:00"`、`remove <id>`、`run <id>`、`history <id>` |
| `browser` | 浏览器工具管理 | `install`（chromium，约 130MB） |
| `gateway` | IM 网关：QQ/飞书消息桥接到本地会话 | `--root`、`--home`、`--port`（默认 0）、`--platform <list>`；需先配 `config.gateways` 与 `auth.json.gateways` |

### TUI 斜杠命令（13 条，注册表为唯一来源）

`/new` `/sessions` `/resume` `/fork` `/undo` `/redo` `/help` `/exit` `/mode` `/context` `/compact` `/reasoning` `/tasks`；别名 `/?`（= `/help`）、`/quit`（= `/exit`）。

---

## 3. 先跑自动化闸门（红了就别做手工）

```powershell
pnpm test        # = pnpm -r build && pnpm -r --no-bail run test
pnpm typecheck
pnpm lint
```

正确结果（main 实测基线，对不上就是回归）：

| 包 | passed | skipped | files |
| --- | --- | --- | --- |
| `@harness2/core` | 844 | 2 | 61 |
| `@harness2/gateway` | 40 | 0 | 14 |
| `harness2`（CLI） | 281 | 2 | 41 |
| `@harness2/desktop` | 304 | 1 | 36 |
| **合计** | **1469** | **5** | **152** |

- `typecheck`：0 错误。
- `lint`：0 error / 46 warnings（warning 是已知存量，不算失败）。
- `test/api-surface.test.ts` 必须绿：导出面基线为 **495** 条。它红 = 动了冻结区（`packages/core/**`、`packages/gateway/**`）的公开导出，必须走 `fix/*` 解冻窗口并同步基线，不能就地改基线文件。

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

---

## 5. 手工用例

> 记录方式：每条记 `通过 / 不通过 + 实际输出`。除 SM-23、SM-24 外都在 §4 的隔离数据根里做。

### A. 会话、撤销与上下文（TUI）

| 编号 | 步骤 | 正确结果 |
| --- | --- | --- |
| SM-01 | `/help` | 列出上面 13 条命令及一句话描述；末尾说明段包含「文件快照 / redo 语义 / append-only / fork 语义 / `[a]` 会话级 / `/` 开头消息被当命令」六条 |
| SM-02 | `/new`，再 `/sessions` | 每行 `<id>  MM-DD HH:mm  N 条  <首条用户文本>`；当前会话行尾带 ` *` |
| SM-03 | `/sessions <关键字>` | 命中会话下方缩进显示 `命中 [role@seq]: 片段`；无命中输出 `（无匹配会话：<关键字>）` |
| SM-04 | `/resume <id>`；再试 `/resume`（不带 id） | 前者切换到该会话；后者输出 `error: 用法 /resume <id>（/sessions 查看 id）` |
| SM-05 | `/fork`；再试 `/fork abc` | 前者从当前会话复制**活动事件**到新会话并切换，血缘写入 header，**原会话零改动**，新会话 undo 从零开始（文件快照不复制）；后者输出 `error: 无效的事件序号 "abc"（应为 >= 1 的整数，或省略分叉全部活动事件）` |
| SM-06 | 发 2 轮消息后 `/undo --dry-run`，再 `/undo` | dry-run 输出 `预览（未执行）：将撤回 N 条消息，rewind 到 seq X` 且**不产生任何实际改动**；实跑输出 `已撤回 N 条消息（rewind 到 seq X）` |
| SM-07 | `/undo 0` | `error: 无效的撤回层数 "0"（应为 1..100 整数）` |
| SM-08 | 让模型用 write/edit 改一个文件 + 新建一个文件，然后 `/undo` | 文件行逐条列出：新建的显示 `删除创建的文件`，改过的显示 `恢复内容 "…"`，状态 `已执行`；文件被外部改动过的带 `[外部修改]`；本 turn 没动文件时输出 `文件快照：无（…）` |
| SM-09 | 让模型用 bash 改文件，再 `/undo` | **不恢复** bash 造成的改动，且输出如实声明这一点（这是设计行为，不是缺陷） |
| SM-10 | `/undo` 后再发一条新消息，然后 `/redo` | 输出 `已重做 N 条消息（rewind 到 seq X）`；撤销后新输入的那条被移出当前上下文，但仍在日志里（`traj` 可见） |
| SM-11 | 上述操作全程盯 `session.v1.jsonl` | **只增不改**：undo/redo 只追加 rewind 标记，历史行永不回改（append-only） |
| SM-12 | `/mode`，再 `/mode auto` | 显示/切换审批模式，可选 `normal\|allow-approve\|auto\|plan` |
| SM-13 | 触发一次工具审批，选 `[a] 本会话总是`，重启 chat 再触发同一工具 | 本会话内该工具后续不再询问；**重启后恢复询问**（会话级、仅进程内、不落盘） |
| SM-14 | `/context`；`/compact 精简历史` | 前者显示当前上下文占用；后者手动触发压缩。自动压缩阈值 = `contextWindow × 0.75`，压缩后最近 6 条保留原文 |
| SM-15 | `/reasoning`，`/reasoning on` | 查看/切换推理过程展示，默认 `off` |
| SM-16 | `/tasks` | 只读列出 cron 任务 |
| SM-17 | 直接发一条以 `/` 开头的普通文本 | 被当作命令处理，提示 `未知命令 …（/help 查看命令列表）`，不会作为消息发出 |

### B. 轨迹、导出与回放

| 编号 | 步骤 | 正确结果 |
| --- | --- | --- |
| SM-18 | `harness2 traj <会话目录>`；再加 `--all`、`--json` | 时间线可读；`--all` 额外显示被回退遮蔽的影子事件；`--json` 输出事件 + 投影 + 告警的结构化 JSON |
| SM-19 | `harness2 export <会话目录> -o D:\tmp\s1.zip`，再导一次 `-o D:\tmp\s2.zip` | 两个 zip **字节一致**（内部 mtime 固定为 2000-01-01，保证幂等）；原会话目录只读不被改；有子代理时含 `subagents/<id>/` |
| SM-20 | `harness2 replay D:\tmp\s1.zip` | 逐事件解析通过 + 输出投影摘要；若人为破坏 zip 里某行 JSON，应**报告坏行**而不是静默通过 |

### C. 管理子命令

| 编号 | 步骤 | 正确结果 |
| --- | --- | --- |
| SM-21 | `harness2 config check` | 打印两级合并后的 providers / roles / key 来源，**密钥脱敏**；配置非法时明确报错 |
| SM-22 | `harness2 doctor --probe` | 实连每个 MCP 服务器（每个超时 5s），列出状态；无 MCP 配置时明确说明 |
| SM-23 | `harness2 mcp list`，再 `harness2 mcp list --no-probe` | 前者含状态与工具数；后者只读配置、不发起连接（明显更快） |
| SM-24 | `harness2 memory show` / `pending` / `approve <id>` / `reject <id>` / `clear --target user` | `show` 显示条目与用量（含漂移告警）；ask 模式下模型的记忆写入先进 pending，`approve` 重放执行且预算/漂移校验照常生效，`reject` 丢弃；`clear` 不可恢复。预算：`MEMORY.md` 2200、`USER.md` 1375，pending 上限 200 |
| SM-25 | `harness2 skill list` | 合并 `.harness2/skills/`（项目级）与 `~/.harness2/skills/`（全局），标出来源；**同名时项目级覆盖全局** |
| SM-26 | `harness2 plugin list` → `enable <name>` → `disable <name>` | `enable` 先打印权限清单再要确认，确认后写入全局 config 的 `plugins.allow`；`disable` 从中移除 |
| SM-27 | `harness2 cron add "写一句日报" --every 5m` → `list` → `run <id>` → `history <id>` → `remove <id>` | `list` 显示 id/调度/下次执行/启用/连续失败；`run` 立即执行一次且**不改 nextRun、不计入熔断计数**，结果写 history；`history` 显示最近 20 次含 `result.md` 摘要；serve 运行期间按 60s tick 到点自动执行 |
| SM-28 | `harness2 browser install`，随后让模型使用浏览器工具 | 安装 chromium 后浏览器工具可用；未安装时应给出明确提示而不是崩溃 |

### D. 桌面端

| 编号 | 步骤 | 正确结果 |
| --- | --- | --- |
| SM-29 | `pnpm --filter @harness2/desktop dev` | 窗口正常渲染（**不白屏**），自动拉起 serve 并通过健康检查 |
| SM-30 | 新建 2 个会话 → 分屏 → 左右各选一个会话 | **右侧六个页签全部有数据**（run-config / plan-state / execution-view / change-review 等），切换会话后各页签随之刷新。这是 2026-09-11 修复的阻塞级缺陷 P1-1 的回归点，必须重点看 |
| SM-31 | 在桌面端做一次 undo / redo | 与 CLI 语义一致；轨迹时间线可回看 |
| SM-32 | 关闭窗口 | 弹出确认对话框，确认后进程退出、serve 随之清理 |
| SM-33 | 先 `harness2 serve` 再启动桌面端 | 桌面端读 `serve.lock` **采纳既有实例**，不重复 spawn |

### E. serve / HTTP 面

端点（`base = http://127.0.0.1:<port>`）：

| 方法 + 路径 | 说明 |
| --- | --- |
| `GET /api/config` | 配置；也是桌面端的健康检查端点（仅 2xx 视为健康） |
| `GET /api/sessions[?cwd=<编码后的工作目录>]` | 列会话 |
| `POST /api/sessions` | 新建会话 |
| `GET /api/sessions/:id/events` | 事件流（历史） |
| `GET /api/sessions/:id/run-config` | 运行配置 |
| `GET /api/sessions/:id/plan-state` | 计划状态 |
| `GET /api/sessions/:id/execution-view` | 执行视图 |
| `GET /api/sessions/:id/change-review` | 改动评审 |
| `POST /api/sessions/:id/fork` `/undo` `/redo` | 分叉 / 撤销 / 重做 |
| `WS /ws` | 事件面，`protocolVersion=2` |

鉴权：请求头 `x-harness2-token`，取值优先级 **header > Bearer > `?token=`**；token 在数据根的 `serve.lock` 里（字段 `pid`/`port`/`ts`/`token`，POSIX 下权限 0600）。环境变量 `HARNESS2_SERVE_TOKEN` 可指定 token，`HARNESS2_SERVE_REQUIRE_TOKEN` 可关闭严格模式（关闭时会打印一次性告警）。HTTP 帧上限 1 MiB。

| 编号 | 步骤 | 正确结果 |
| --- | --- | --- |
| SM-34 | 不带 token 请求 `GET /api/config` | **401**（默认严格鉴权） |
| SM-35 | 带 `x-harness2-token: <serve.lock 里的 token>` 再请求 | 2xx + JSON |
| SM-36 | 用一个过期/错误 token 请求 | 401，且错误信息指向 token 不匹配（桌面端对应文案：`serve 健康检查 401：token 无效（serve.lock 与实例不匹配）`） |

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
- E2E 闸门开关：CLI 侧 `H2_E2E_LOCAL=1`；桌面侧 `LOCAL_UNIFIED_KEY`。
- 重试策略：单次请求最多重试 3 次（退避 2s / 10s / 30s），整个 turn 最多 6 次且总时长 <= 120s。
- 每个回合结束的 `turn-end` 事件**恒带** `textOutcome`：正常收尾 `final`、被中断 `partial`、空回复 `empty`。

验证步骤：`harness2 config check` → `harness2 chat`（不带 `--provider`，走配置的 `roles.main`）→ 发一条消息 → `harness2 traj <会话目录> --json` 确认 `turn-end` 的 `textOutcome` 为 `final`。

---

## 7. 常见失败与判读

| 现象 | 原因 / 处置 |
| --- | --- |
| 桌面端白屏 | 渲染层没构建，或有人把 vite 的 `base: './'` 改成了绝对路径（2026-09-07 白屏事故根因，**不要改**）。先 `pnpm --filter @harness2/desktop build` |
| 桌面端卡在等健康检查 | 没先 build，或 serve 起不来；看 `dist-electron/main/main.js` 是否存在 |
| 健康检查 401 | `serve.lock` 与实际实例不匹配（旧实例残留）。结束残留进程并删除 `serve.lock` 后重启 |
| 改了代码 `harness2` 没变化 | 忘了在全局 junction 指向的那棵树里 `pnpm build` |
| core 的 browser 用例失败 | 缺 chromium：`harness2 browser install` 或 `pnpm --filter @harness2/core exec playwright install chromium`（POSIX 还需 `install-deps`） |
| `api-surface` 用例红 | 碰了冻结区导出面；走 `fix/*` 解冻窗口 + 三平台 CI 绿 + `--no-ff` 合并，并用 `H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts` 同步基线 |
| 单文件复测报 `No test files found` | 必须进包目录再跑：`cd packages\cli ; pnpm exec vitest run <文件>` |
| TUI 显示异常 | 用 `--no-tui`（或 `HARNESS2_NO_TUI=1`）退回 legacy readline 路径对比，判断是渲染层还是逻辑层问题 |

---

## 8. 签收表

| 组 | 用例 | 结果 |
| --- | --- | --- |
| 构建与启动 | §1.1 构建产物三项、§1.2 全局命令、§1.3 桌面端 dev、§1.4 serve | |
| 自动化闸门 | §3：1469 passed + 5 skipped、typecheck 0、lint 0 error、基线 495 | |
| 零 key 通路 | §4 四项 | |
| A 会话与撤销 | SM-01 ~ SM-17 | |
| B 轨迹导出 | SM-18 ~ SM-20 | |
| C 管理子命令 | SM-21 ~ SM-28 | |
| D 桌面端 | SM-29 ~ SM-33（SM-30 为 P1-1 回归点，必测） | |
| E serve 鉴权 | SM-34 ~ SM-36 | |
| 真实模型 | §6 验证步骤 | |

仍需真机/人工完成、不在本手册范围内的：README 三张真机截图、Windows 真机联网一轮、桌面端真机一轮、云端三家 API key 一轮、CLI 的 IME / raw-mode / alt-screen 签收、桌面端关窗口对话框真机确认。

---

## 9. 本手册的事实来源

- `harness2 --help` 与各子命令 `--help`（`packages/cli/dist/index.js` @ `7d29acb`）
- `packages/cli/src/command-registry.ts`（斜杠命令注册表）、`packages/cli/src/commands.ts`（`HELP_TEXT` 与 undo/redo/fork 输出文案）
- `packages/core/src/server/http.ts`（路由）、`ws.ts`（`WS_PATH`）、`security.ts`（`x-harness2-token`、`HARNESS2_SERVE_TOKEN`、`HARNESS2_SERVE_REQUIRE_TOKEN`）
- `packages/desktop/package.json`（`dev` / `smoke` / `dist:*`）、`vite.config.mts`（`dist/renderer`、`base: './'`）、`src/main/serve-manager.ts`（健康检查与 `serve.lock` 采纳）
- 根 `package.json` 脚本；main 分支实测测试与 lint 数字；`packages/core/test/fixtures/api-surface-baseline.json`（495 条）
