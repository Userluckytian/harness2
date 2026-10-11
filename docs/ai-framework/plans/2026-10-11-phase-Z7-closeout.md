# 2026-10-11 阶段 Z7 · 收口（Web 同构 / IM / 真机 / 发布）

> 上位计划：`docs/ai-framework/plans/2026-10-10-phase-zcode-ui-overhaul.md`（Z0–Z7 总纲）§Z7 行。
> 功能总账：`docs/ai-framework/plans/zcode-ui-traceability.md`。
> 本文是 Z7 的**执行计划 + 收口清单**；开工前按台账 §1 规则重跑调研（上游拉取 + 重读 refs 条目）。

## 0 元信息

| 项       | 值                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------- |
| 阶段     | Z7（终段）                                                                                        |
| 目标端   | web（第二宿主）、gateway（IM 面）、docs（README/发布）                                            |
| 前置     | Z0–Z6 主体完成（见 §1 现状快照；Z6 批次 1–7 已收口）                                              |
| 出口条件 | §4 验收总表 V-Z7-x 全绿；未达标项如实登记并按台账规则下放                                         |
| 不碰     | `packages/core` 公开契约不新增（Z7 收口期 core 只读；如需改动须计划授权 + 基线同步 + 编排者验收） |

## 1 现状快照（2026-10-11，Z6 批次 1–7 收口后）

**已完成**：Z0（refs 文档 + 台账 + 总纲）· Z1（Tailwind v4 + shadcn 基建）· Z2 9 项 · Z3 7 项 · Z4 4 行 · Z5 设置页 · Z6 批次 1–6（D02 三开放 / provider 三件套 / A05·A16·A17 / A10+MCP·技能 / A09 Hooks / A14 工作流 / A11 Teams）+ 批次 7-A（A22 符号索引，执行中）。

**core 导出基线**：846 → 1059（批次 1–6，全程 0 removed / 0 kindChanged）。

**测试基线**：ui-shared 276 / desktop 1114（+1 skip）/ core 1491（+2 skip）/ cli 1575（+2 skip）/ web 36 / gateway 40，全仓绿。

**各端形态现状**：

| 端       | 现状                                                                                                    | Z7 要做的                 |
| -------- | ------------------------------------------------------------------------------------------------------- | ------------------------- |
| desktop  | ZCode 复刻主目标：无顶栏浮层、侧栏 264/4px 折叠、右栏零 tab 启器、分屏工作台、设置全屏页、composer 控件 | 无（仅真机核对）          |
| web      | **最小壳**（`packages/web/src/app.tsx` 147 行）：复用 ui-shared 会话席位，无侧栏/右栏/分屏/设置         | **与桌面同构**（见 §3.1） |
| CLI      | grok 复刻（P10/P11 已交付），本轮零改动                                                                 | 无                        |
| IM 网关  | gateway 已有 QQ（`platforms/qq/`）+ 飞书（`platforms/feishu/`）适配器；**无 UI/配置面**                 | 补界面/配置面（见 §3.2）  |
| 真机截图 | 图槽就位（`docs/screenshots/`），未截                                                                   | 人工真机截取（见 §6）     |

## 2 边界与红线

- 沿用 Z 程序全部红线：①Model-visible ⟺ 已落盘 ②append-only + 单写者 ⑨缓存边界 ⑩UI 不显示假状态；D-14 无渲染端持久化（+ 主题/字号两条已登记例外）。
- **Z7 不新增 core 能力**；web 复用桌面已验证的 ui-shared 组件与席位机制，不复制业务逻辑。
- 「无数据面不摆假入口」继续执行：IM 未配凭据就是空态 + 指引，不造假连接状态。

## 3 Z7 工作项

### 3.1 Web 壳与桌面同构（主体工作量）

**目标**：web 具备与桌面**同一套**骨架与页面——侧栏（264/折叠）、主区（对话/三视图架构缝）、右栏（零 tab 启器 + 各 tab）、设置全屏页、分屏工作台、composer 控件、状态面板、审批 dock、队列/恢复条/轮次导航。

**做法**：ui-shared 已承载上述绝大部分（Z2–Z5 落在 ui-shared + desktop 接线）；web 侧补齐**接线层**：

- 侧栏/右栏/overlay 席位装配（桌面在 `packages/desktop/src/renderer/layout/`，web 需等价装配；**优先抽出共享装配**，避免两壳各写一份）。
- 数据通道：web 经 `serve-client.ts` 连 serve（已有）；确认 store/controller 装配与桌面同源。
- 主题/字号：web 已有 `theme-boot.js`（Z5 已补字号），核对与桌面一致。
- 已知差异如实保留并登记（如桌面 `frame:false` 的自绘窗口控制 web 无）。

### 3.2 IM 界面与配置面

- gateway 通道已有（QQ/飞书）；Z7 补：**配置/状态面**（配 appId/appSecret 指引、连接状态只读展示——无数据即空态）+ 会话侧标识（IM 来源会话在侧栏可辨）。
- 真机联调（凭 QQ/飞书凭据）归 §6 清单。

### 3.3 文档与发布

- README 更新：Z 程序成果（GUI 复刻范围、双主题、新增能力面）、截图区补图后删占位说明。
- `docs/ROADMAP.md` / `CHANGELOG.md` 同步 Z 程序条目。
- `docs/RELEASE-CHECKLIST.md` 增 Z 程序收口节（导出基线 1059、六包测试计数、lint 0 error）。

## 4 验收标准总表

| 编号    | 验收项                                                               | 证据                         |
| ------- | -------------------------------------------------------------------- | ---------------------------- |
| V-Z7-1  | `pnpm -r build` 六包全过                                             | 终端输出                     |
| V-Z7-2  | `pnpm -r --no-bail run typecheck` 全过                               | 终端输出                     |
| V-Z7-3  | 六包 `test` 全绿（计数不低于基线）                                   | 终端输出（逐包计数）         |
| V-Z7-4  | `pnpm lint` 0 error 0 format 告警                                    | 终端输出                     |
| V-Z7-5  | `packages/core` 公开导出基线**不劣化**（0 removed / 0 kindChanged）  | `api-surface.test.ts` + 比对 |
| V-Z7-6  | core/cli/gateway 契约变更 = 0（除获授权项）                          | `git status` 核查            |
| V-Z7-7  | web 壳与桌面**同构**：侧栏/右栏/设置/分屏/状态面板在同一装配下可渲染 | 抓屏 + 装配级测试            |
| V-Z7-8  | IM 配置面可用且**不摆假状态**（未配置 = 空态 + 指引）                | 抓屏 + 单测                  |
| V-Z7-9  | README/ROADMAP/CHANGELOG/RELEASE-CHECKLIST 已同步 Z 程序             | 文档 diff                    |
| V-Z7-10 | 真机清单（§6）已交付人工并逐项标注状态                               | 清单勾选                     |

## 4.1 验收执行结果（2026-10-11 Z7-1～2c 收口后）

| 编号    | 结果 | 证据（编排者重跑）                                                                                                                         |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| V-Z7-1  | ✅   | `pnpm -r build` 六包全 Done                                                                                                                |
| V-Z7-2  | ✅   | `pnpm -r --no-bail run typecheck` 6/6 干净                                                                                                 |
| V-Z7-3  | ✅   | 六包全绿：core 104 文件/1519（+2 skip）· ui-shared 28/308 · desktop 113/1114（+1 skip）· web 6/67 · gateway 14/40 · cli 93/1575（+2 skip） |
| V-Z7-4  | ✅   | `pnpm lint` 0 error + Prettier 全过（存量 warning 不计）                                                                                   |
| V-Z7-5  | ✅   | core 导出基线 **846 → 1113**，**0 removed / 0 kindChanged**（对比 Z 程序起点 `fe5e522`），+267 纯加性                                      |
| V-Z7-6  | ✅   | `git diff --stat fe5e522..HEAD -- packages/cli packages/gateway` **零文件**；core 改动全经计划授权                                         |
| V-Z7-7  | ✅   | web 与桌面同构：布局/侧栏/右栏（8 tab = 桌面启动器）/设置覆层/命令面板/分屏工作台 全部经 ui-shared 同一实现装配；web 6 测试文件覆盖        |
| V-Z7-8  | ✅   | 「网关 / IM」分区：掩码展示（appSecret 不回显）、连接状态恒「未探测」、未配置给指引——不摆假状态（单测钉住）                                |
| V-Z7-9  | ✅   | README / CHANGELOG / ROADMAP / RELEASE-CHECKLIST 已同步 Z 程序（含可核验数字）                                                             |
| V-Z7-10 | ✅   | §6 真机清单 10 项 + §5 拍板项 10 条已写入本文件并登记 `docs/issue-log/OPEN.md` Z 节                                                        |

**未闭合（如实）**：§5 拍板项 10 条、§6 真机项 10 条均**待人工**；Z7 计划内的实现工作已全部完成。

## 5 人工拍板项汇总（Z 程序累积，需人决定）

| #   | 事项                           | 现状与选项                                                                                                 | 出处          |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | 右栏比例 45% ↔ 会话列 52% 张力 | 单自由度下右栏 45% ⇒ 会话列 55%。**严格 52% 需把右栏比例改 0.48**                                          | OPEN.md Z 节  |
| 2   | 侧栏宽度持久化                 | 现完全不持久化（D-14）。要保留需经**主进程偏好**落盘（非渲染端）                                           | OPEN.md Z 节  |
| 3   | 分屏布局持久化 vs D-14         | ZCode 落盘分屏布局；本仓禁渲染端落盘。要落盘须先与 D-14 协调（放开通道 + 补迁移）                          | OPEN.md Z 节  |
| 4   | Z1-05 旧偏好归一               | 磁盘上 `warmPaper`/`dark` 现回落 `system`，未按 `Z-66` 映射 `zai-light`/`zai-dark`                         | OPEN.md Z 节  |
| 5   | Z2-07 终端面板（PTY）          | 全仓零 PTY 基础；引入 = node-pty（原生模块）+ xterm.js + 新 IPC，量级归能力补齐                            | 台账 Z2-07    |
| 6   | Z4-04 Codemap                  | 两条候选：①core 代码索引（重）②会话内 `/codemap` 生成流（轻）。**A22 已交付符号索引，路线①前置已具备一半** | 台账 Z4-04    |
| 7   | A15 OS 沙箱                    | 零基础新建（文件边界 + 出网 + 防自提权）；是否本轮做需拍板                                                 | 台账 A15      |
| 8   | A19/A20 ACP server / LSP       | 协议级子系统（零基础）；ACP 优先、LSP 次之；工作量需单独评估                                               | 台账 A19/A20  |
| 9   | 上游 refs/ZCode 拉取           | 三次 `fetch-pack: unexpected disconnect`；仍停 `29628c9`（v3.14.3），refs 文档以该版本为权威               | HANDOFF 顶部  |
| 10  | 子代理额度                     | 批 4 曾 `exceed quota limit`；后续批次存在中断风险（编排者按验收流程接手）                                 | issue-log §33 |

## 6 真机清单（累积，需人工在 Win/Linux + macOS 上跑）

1. `frame:false` 窗口：拖拽/缩放/最小化/最大化/关闭 + mac 红绿灯位置。
2. 明暗切换无首屏闪烁；界面字号 12–20 开关生效（`harness2-font-size` 例外）。
3. 左栏折叠 4px 裁切观感；浮层 56px 与左栏拖拽条 48px 的 8px 覆盖。
4. 嵌套分栏与 6px 横向分隔条；分屏拖拽投放（边缘 32%）手感。
5. 右栏零 tab 启器/拖拽排序/横向滚动观感；864px 轮次导航断点实机切换。
6. 状态面板 1280px 容器查询 mini↔panel 实机切换。
7. 划词「询问」浮层定位（jsdom 无几何）；文件 tab 行「评论」入口手感。
8. 用户提供五张真机截图（README 图槽）：cli-chat / desktop-multi / traj-timeline + 新增 Z 程序（zai 双主题）。
9. IM 真机联调（需 QQ/飞书凭据）：群 @bot/私聊、审批、频率限制、飞书 webhook。
10. README 截图**必须真实**反映当前 UI，禁用 AI 生成或占位图冒充。

## 6.1 自主浏览器验收（2026-10-11 已执行）——可复跑配方

**结论：§6 清单里约 2/3 的项不必等人工——web 端（与桌面同构）可在内置浏览器里自主验收**，且比肉眼看图更可核验（直接读计算样式/几何对照规格数值）。

**配方（零 key，全隔离）**：

1. `node packages/cli/dist/index.js serve --port 46213 --provider mock --home <tmp>/home --root <tmp>/ws`
   —— `--provider mock` 不需要任何 API key，给流式回复；`--home` 指向临时目录，**不碰真实 `~/.harness2`**。
2. token 从 `<tmp>/home/.harness2/serve.lock` 读取；需要会话时 `curl -H "Authorization: Bearer <token>" -X POST .../api/sessions -d '{"cwd":"<tmp>/ws"}'`（web 壳无目录选择通道，零会话时新建按钮如实禁用）。
3. `cd packages/web && npx vite --port 5173`；浏览器打开 `http://localhost:5173/?token=<token>`（dev 代理 `/api` `/ws` 到 serve）。
4. 用真实交互操作 + `evaluate` 读 `getComputedStyle` / `getBoundingClientRect` / `localStorage` 取证；**注意本机若设 `HTTP_PROXY` 会让 curl 打到 localhost 返回 502，用 `--noproxy '*'`**；vite 只监听 IPv6 `[::1]`，用 `localhost` 或 `[::1]`。
5. 跑 core 全量测试前**先停 serve**（`fork.test.ts` 用默认端口 46213，会 `EADDRINUSE`）。

**已由该方式闭合（实测数字）**：侧栏 264/折叠 4px · 右栏 457px(=内容区 45%)/零 tab 启器 · 界面字号 12–20 生效与存储例外 · 双主题切换（class/data-theme/color-scheme/存储）· 设置覆层分区按数据面白名单 · 空态问候+建议 chip · 流式回复 · 轮次导航 ≥2 轮出现 · **底色归位 Zai（浅 `#f8f8f8`/深 `#161616`）**。

**仍须人工（浏览器测不了）**：Electron `frame:false` 窗口拖拽/红绿灯（无 OS 窗口）· 真实按键类交互（合成 KeyboardEvent 不触发 React 监听，如命令面板 Ctrl+K 的实际手感）· 审批 dock（mock provider 不触发审批）· 分屏拖拽投放的观感 · IM 真机联调（需凭据）· README 五张正式截图。

**本轮据此外发现并修复 4 个真实缺陷（D1–D4，全部浏览器复测通过）**：D1 遗留 warmPaper 主题表未退役致两壳底色非 Zai；D2 composer 落点提示不清除；D3 提交派发后不从活队列出队（面板常驻「排队」）；D4 恢复账本缺 `queue/dispatched` 标记致重启复活已执行提交。详见 `docs/issue-log/2026-10-11.md` §43–§46。

## 6.2 起 ZCode 官方 web 做实时对照（2026-10-11 已跑通）

**用途**：把我们的实现与**上游真身**并排比对（比只读 refs 文档更硬）。

**前置（一次性，约 40 分钟）**：在 `D:/AI_Projects/refs/ZCode` 装依赖。仓库要求 Node ≥24 / pnpm 10.33.2（本机 Node 22 只 WARN 不阻断）；`.npmrc` 有 `node-linker=hoisted`；`node_modules/` 已 gitignore（**不污染 refs 仓库**）。

```bash
cd D:/AI_Projects/refs/ZCode
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm@10.33.2 install --fetch-retries=6 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=180000 --network-concurrency=8
```

**启动（Windows 两个坑已定位）**：

```bash
cd D:/AI_Projects/refs/ZCode
export npm_config_script_shell='D:/Program Files/Git/usr/bin/bash.exe'
pnpm dev:web      # web [::1]:5173 + 后端 :3030
```

- 坑 1：`corepack pnpm@10.33.2 dev:web` 会让内层 `pnpm --filter` 落到全局 pnpm 11 并报版本不符 → **用裸 `pnpm`**（自切换到 10.33.2）。
- 坑 2：`tsup --watch --onSuccess 'node dist/entry-http.js'` 的 POSIX 单引号被 Windows `cmd.exe` 吞掉 → **用 `npm_config_script_shell` 指到 Git bash**。
- 后端 `authRequired:false`，**无需登录**即可看到完整界面。

**对照要点**：两边默认都占 5173 → 把我们的挪到 **5174**；用 `evaluate` 读 `getComputedStyle` 取 `--color-*`、根字号、字体栈逐项比对（实测表见 `docs/issue-log/2026-10-11.md` §47）；用 `document.fonts.check('16px Inter')` 判断参考端是否真用 Inter。

## 7 交接提示词（零上下文可执行）

```
你在 D:/AI_Projects/harness2 执行阶段 Z7（收口）。先读：
1) docs/ai-framework/plans/2026-10-11-phase-Z7-closeout.md（本计划，含验收表 §4 与拍板项 §5）
2) docs/ai-framework/plans/zcode-ui-traceability.md（功能总账）
3) docs/refs/refs-zcode.md + refs-zcode-layout.md（视觉/布局权威）

按 §3 顺序执行：3.1 web 壳同构（主体）→ 3.2 IM 配置面 → 3.3 文档与发布。
每个工作项：先按台账 §1 重跑调研 → 实现（可派子代理）→ 独立验收（编排者亲自重跑 §4 证据命令）→ 回填台账与当日日志。
硬约束：不新增 core 公开导出；无数据面不摆假入口（红线⑩）；D-14 例外仅主题/字号两条。
§5 的 10 项拍板与 §6 的真机项**不由 AI 自行决定**，汇总交付人类。
```

## 8 变更记录

| 日期       | 变更                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-11 | 首建：Z7 计划 + 验收表（V-Z7-1～10）+ 拍板项 10 条 + 真机清单 10 条 + 交接提示词                                                                                                                                                                                     |
| 2026-10-11 | **与 ZCode 官方 web 实时对照**：装起参考端（§6.2 配方）逐项比对——**侧栏 264px 与深色 token 12/12 完全一致**；发现并修复 **D5–D7**（根字号 14→16、字体栈补 Inter、刻度外 17px 归位），浏览器复测通过（issue-log §47–§48）。文案自拟与侧栏缺失结构登记待用户排优先级。 |
