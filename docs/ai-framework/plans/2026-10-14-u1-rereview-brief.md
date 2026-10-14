# U1 第二轮独立审查任务书（jam 复审，全四片一次做完）

> **通道状态（2026-10-14 21:0x 终诊断）**：jam 定义模型已指向 `qwork-advanced` 且该路由直连网关健康；但**本会话**的 cat-jam 派发持续 `Provider returned a server error`——判定堵点=当前会话的 agent 定义/provider 连接快照陈旧，**重启 ZCode 客户端即解**（本任务书自含，新会话一句话「续派复审」即可执行）。
> **发版口径补记（V3 自纠）**：T8 版本 bump 使 core/gateway/cli 各 `package.json`+`core/src/version.ts` 共 3 行变更（纯版本字段）；契约面（api-surface 快照+功能代码）经终核仍为 0 行——越界信号未触发，但验收表旧口径「全程零 diff」已按实况改精确。

你是 harness2 仓库（`D:/AI_Projects/harness2`，分支 `feat/phase-u1-desktop-parity-fixes`，HEAD `992e465`）的第二轮独立审查员。**全程只读源码，唯一允许写的文件是本任务书指定的审查报告**。第一轮报告（`2026-10-14-u1-review.md`）仅供对照，你的结论以**自己从零读码**为准。

**环境**：本会话 `pnpm`/`npx` 坏（系统缺 cmd.exe）。跑测试一律 `cd packages/<x> && ./node_modules/.bin/vitest run --maxWorkers=4`。

**必读基准**（先读这几份再开工）：
- `CODE_REVIEW.md`（P0/P1/P2 定义）
- `docs/ai-framework/plans/2026-10-14-phase-U1-desktop-parity-fixes.md`（设计规格摘要+验收表）
- `docs/refs/refs-zcode-layout.md` 的 Z-46/Z-47/Z-48/Z-49 + `docs/refs/refs-zcode.md` 的 Z-96/Z-97

## 片1 主进程面

1. `packages/desktop/src/main/bridge.ts`：穷举 `handleInvoke` switch 的全部 case，列成表——「发 HTTP 的必须分支内取 `serveBase()`」（漏一个=P0）；「不发 HTTP 的不得触 `deps.serve.baseUrl` getter」。逐 case 给 文件:行。
2. `main.ts` + `workspace-root.ts`：打包态=home / dev=仓库根；三个调用点（serve `--root`、bridge `deps.root`、terminal root）一致；dev 上跳 4 级对照实际产物路径核实。
3. `tray.ts`/`window-lifecycle.ts`/`close-window-handler.ts`/`preferences*` vs Z-47：平台门（win/linux）、左键/双击=show、右键菜单序、hide 三重门、markExplicitQuit+回滚、smoke `tray:false`；竞态（hide 后 quit、forceClosing、双 close）；偏好加性字段的读写破坏面。

## 片2 渲染端面

1. `WindowControls.tsx` + `App.tsx` 挂载：单实例（会话头内嵌组是否删净、`seat.tsx` 无孤儿引用）；drag/no-drag 与 pointer-events 层级（overlay 不吃点击）；ErrorBoundary fallback 挂载点。
2. 侧栏：`session-row-menu`/`SessionBrowser`/`shell-seat-contents` vs Z-48/Z-49——项目新建的 cwd 传递链（UI→controller→api.createSession 断点核全）、running 禁用判据实时性、ConfirmDialog 复用既有原语、删除只走 `deleteSession` 软删通道。
3. 发送可见化：`ChatErrorBanner`/`chat-error-model`/`Composer` 的 `onSubmitError` vs Z-96——横幅结构、指纹去重、两壳（desktop+web）接线、草稿保留回归、禁用 tooltip。
4. 3b 模型初值：`composer-config`/桌面桥的 roles.main 优先级实现与 §81 观察一致性。

## 片3 性能/终态面（jam 第一批，复核）

`store.ts` 悬挂收敛（30s 门、事件驱动对表、真帧覆盖合成、`removeSessionFromView` 撤表、审批豁免、无 ts 防御）；`turn-work.tsx`（tick 只在 running、memo 挡父链、完成态锁值）；`ToolCard.tsx` 扫光替换 + CSS 语义 token 与 reduced-motion；`perf-replay-b1.test.ts` 生成器断言非空转。

## 片4 红线/卫生/测试

1. `git diff main...HEAD --stat -- packages/core packages/gateway packages/cli packages/web` 全空（web 应净零：`90fdf5c..b34f327` 一进一退自证）；`api-surface-baseline.json` 零改动。
2. 密钥/凭据扫 diff：`git diff main...HEAD | grep -iE "sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]" | head` 人工判定。
3. `packages/desktop/scripts/manual-pack.mjs`：可读、幂等、无危险动作（不删仓外文件）。
4. 测试复跑：ui-shared 与 desktop 两包 vitest（`--maxWorkers=4`）贴尾部输出；**两条变异**：a) `store.ts` `HUNG_TURN_TIMEOUT_MS` 30_000→3_600_000 → hung 用例红；b) `bridge.ts` serveBase 改回 switch 前无条件求值 → B2 用例红。各贴红输出后恢复，`git status` 干净为终证。

## 产出要求

1. 新建 `docs/ai-framework/plans/2026-10-14-u1-review-jam-rereview.md`：①「与第一轮的分歧表」（逐条：同意/推翻/新增，含第一轮漏查项）；②「新 P0/P1/P2 清单」（文件:行/问题/修法建议——**发现 P0/P1 不要自己修**，你是审查位）；③逐片审查记录（读码→结论→证据）；④测试与变异输出。**先写盘再返回。**
2. 返回（不许空）第一行固定格式：`REVIEW2: P0=x P1=y P2=z`；随后 15 行以内逐条摘要 + 「与第一轮一致/不一致」总结论。
3. 若中途 provider 报错中断：把已完成片的进度写进报告文件（节标题加「（未完，进度：…）」）再退出——编排者按文件续派。

## 派发策略修订（22:0x，实测后）
- **整单派发失败实录**：新 spawn 与 resume 实例各跑 ~9 分钟均死于 `Provider returned a server error`；直连探针得 `FreeTierError`（OpenCode 免费额度间歇放行：今日 13:25/19:55 两窗口成功，21:5x/22:0x 关闭）。
- **改用「单片派发」**：一次 Agent 调用只跑上表一片（几分钟），且**边审边写盘**（每小节 Edit 立即落盘）；通道一开即插即走。片序按约束价值=「先复审非 jam 执行的批次」：**片1 主进程(T1/T2) → 片2 渲染端(T3) → 片4 红线卫生 → 片3 性能终态(jam 自审，最后)**。
^- **片4 增补（§10 教训）**：复核 `dee288b`（gen-icon oy 修复+图标再生）正确性；确认交付 exe（22:11）内嵌图标与 `assets/icon.ico` 一致（resedit 读回或 file 五帧断言）；第一轮「eslint 0 error」漏报已实证，本片须独立全量跑 eslint/prettier 不得引用旧结论。
- 全部片完成后：报告尾部加「总结论」节，P0/P1 清单交编排者派修（修=jam 或按当日授权口径执行），修后仅复跑受影响包 vitest + 红线 git diff 复验，不需重审已通过片。
- 若某片红：等 3-5 分钟重试该片一次；连续两红则该窗放弃、回报编排者改期——不许整单重发浪费放行窗口。
