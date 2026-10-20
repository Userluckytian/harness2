# U1 执行者任务书（T1~T6 逐条，粘贴即用）

> 配合 `2026-10-14-phase-U1-desktop-parity-fixes.md` 使用。每段自含零上下文。执行者一律 = cat-jam 子代理。**一次只派一个任务**（同仓写文件，禁止并行写）。派发前确认 `new-provider/cat-jam` 网关路由已恢复（`curl 127.0.0.1:40080/v1/chat/completions` 对 `cat-jam` 返回非 upstream error）。

---

## T1（主进程批 A：R0-3① + cwd + 黑框调研）

你是 harness2（`D:/AI_Projects/harness2`）的实施代理，分支应已在 `feat/phase-u1-desktop-parity-fixes`（若不在则 checkout，不存在则从 main 创建）。先读 `AGENTS.md`、`coding-standards.md`、`docs/issue-log/2026-10-11.md` §81、计划「设计规格摘要」。禁触 `packages/core/**`、`packages/gateway/**`、`api-surface-baseline.json`（V3 红线，`git diff main -- packages/core packages/gateway` 必须为空）。

任务（只改 `packages/desktop/src/main/**` 与 `packages/desktop/test/**`）：

1. **R0-3 第①层**：`bridge.ts` `handleInvoke` 中 `const base = deps.serve.baseUrl;`（约 :422，位于 switch 前）移入**真正需要 HTTP base 的 case 分支内部**（逐个分支检查；`window:*`、`projects:*`、`notify:*`、`settings:*`/`metadata:*`/`drafts:*`、`loadLayout`/`saveLayout`、`gitBranch`、`listDir`、`getStatus`、`terminal:*` 等免 serve 命令必须在 serve 未就绪时照常工作）。注意 `deps.serve.baseUrl` 是同步抛错 getter（`serve-manager.ts:194-196`）。
2. **cwd 默认修正**：`main.ts:31-33 resolveRepoRoot()` 现语义在打包态得到安装目录（缺陷）。改为 `resolveDefaultWorkspaceRoot()`：dev 态=仓库根（现路径推导）；打包态=`homedir()`（用户主目录）。所有调用点（serve root、bridge deps.root、terminal root）同步。serve 无 `--root` 时回落 `process.cwd()` 的行为不变。
3. **B2/B3 预算用例**（vitest，`packages/desktop/test/`）：a) mock serve 未就绪（baseUrl getter 抛错），invoke `window:minimize`/`window:close`/`getStatus` 成功返回且耗时 <200ms；b) `projects:pickFolder` 路径上 mock `dialog.showOpenDialog`，测 handler 进入对话框调用 <50ms；c) `resolveDefaultWorkspaceRoot` 两态断言（注入 isPackaged/__dirname）。
4. **隐藏控制台调研（不写码）**：查 `serve-manager.ts` spawn 是否已 `windowsHide:true`（应已有）；结论一句话写进当日 issue-log（你自己不写文件则报告给编排者）。
   验收：`pnpm --filter @harness2/desktop test` 全绿 + `pnpm --filter @harness2/desktop typecheck` + `pnpm -r build`。按 `<gitmoji><type>(<scope>): 中文` 本地 commit（不 push）。返回：diff 摘要 + 三条命令真实输出 + 新用例清单。

## T2（主进程批 B：托盘全套，Z-47 规格）

前置同上（分支/禁触边界同 T1；先读 `docs/refs/refs-zcode-layout.md` 的 **Z-47** 全节，这是本任务的**行为规格书**，逐条对齐：平台门 win32+linux、图标 `build/icon.ico`（无则新建于 desktop 并同步 electron-builder.yml win.icon 复用）、左键/双击=show 主窗（不 toggle）、右键菜单「打开 harness2 ┃ 新建会话 / 添加项目 ┃ 导出日志 ┃ 退出」、退出=markExplicitQuit+app.quit、关窗 hide 三重门（设置开∧托盘创建成功；win 默认开/linux 关）、`window-all-closed` 不再直接 quit 而按裁决走）。

文件边界：`packages/desktop/src/main/**`（新建 `tray.ts`+`window-lifecycle.ts` 纯函数裁决核）、`src/preload/**` 与 `shared/protocol` 桌面段（加 `tray:status`、`setCloseToTray` invoke + 偏好持久化进 `desktop-preferences.json`）、`packages/desktop/test/**`、`electron-builder.yml`（仅 icon 相关，若需要）。渲染端设置开关**不做**（T3 之后如有任务再说；本阶段开关持久化通道就绪即可）。
单测要求：裁决函数纯函数化（平台×设置×托盘成功×explicitQuit → hide/quit/confirm 决策表全覆盖）；tray 创建在 vitest 环境用注入 mock（不真起 Electron）。
验收：`pnpm --filter @harness2/desktop test`+`typecheck`+`pnpm --filter @harness2/desktop smoke`（**B4 不破**：smoke 仍 `{ok:true}` exit 0，smoke 模式下不建托盘或建后立即销毁，自行设计并注释）。commit 规范同前。

## T3（渲染端批：空态窗控 Z-46 + 侧栏 Z-48/Z-49 + 发送可见化 Z-96）

先读三条规格：`refs-zcode-layout.md` **Z-46/Z-48/Z-49** + `refs-zcode.md` **Z-96**；再读 §81 取证三①③④。改动域：`packages/desktop/src/renderer/**`、`packages/ui-shared/src/renderer/**`（sidebar/composer/conversation 子树）、`packages/desktop/test/**`、`packages/ui-shared/test/**`。禁触 core/gateway；禁改 `seat.tsx` 既有会话态渲染条件以外的行为。

子任务（全部要有断言真实的 vitest）：

1. **空态 overlay 窗控**：桌面壳层（AppFrame 顶层）常驻三键（win/linux；复用既有 `ConversationHeader` 内组件或提为共享组件），空态/多态并存时不得出现两套窗控（会话头部内嵌的那组在 overlay 存在时隐藏——选一种收敛方案并全仓一致）。drag/no-drag 分区与 28px 键、136px 右安全区按 Z-46。断言：`selectedId=null` 时 `data-testid="window-controls"` 在 DOM。
2. **侧栏操作面**：a) 项目组头 hover 出现「在此项目新建会话」→ `createSession(projectCwd)`（controller→`api.createSession` 现带 cwd 参数，见 `bridge.ts:433-440`，渲染层只是传参）；b) 会话行 hover/⋯菜单加「删除」：running 禁用（Denia 语义）；点击=ConfirmDialog → 调用已存在的 `controller.deleteSession(id)`（软删，零新后端）；c) 「移出项目」加确认（组内有 running 会话才弹，Z-49 文案口径）。
3. **发送可见化**：composer 上方错误横幅（新组件，样式对齐 Z-96 结构：图标+单行截断+查看详情 Dialog+复制报错+右上 X；ZCode 视觉语言内实现）；`onSubmitError` 在**桌面与 web 两壳**接到横幅（现全仓零调用点）；发送失败草稿保留（现还原逻辑已有，补断言）；禁用发送钮补 tooltip 说明原因（connecting/无会话/锁定）。
   3b. **默认模型一致性（排查+修，§81 观察项）**：用户实机 `config.json roles.main = buddyhub/global:deepseek-v4.1-flash`，实际会话却是 `local/big-pickle`。查桌面 composer 模型选择器初值来源（大概率取 models 列表首项而非 roles.main）；修法=首选项读 roles.main、找不到才回落列表首项，并让选择器如实显示当前通道/模型名。只动 renderer/ui-shared 与 desktop 主进程桥，禁触 core。
   验收：ui-shared+desktop 两包测试全绿；`pnpm --filter @harness2/desktop smoke` B4 不破；typecheck/eslint/prettier 过。commit 可按子任务拆 2-3 个。

## T4（性能/终态批：Z-97 + Denia 手法 + B1）

先读 **Z-97** 全节 + `docs/design-inputs/denia-ui-analysis.md`「⑤」与「性能手法」节。域：`packages/ui-shared/src/renderer/**`（对话渲染/store）、`packages/desktop/src/main/bridge.ts`（仅 pickFolder 审计）、两包 test。

1. **轮次耗时行**：会话面板回合头显示「工作中 {duration}」（1s tick，**memo 叶子自持计时、起点取事件时间戳**——Denia WorkIndicator 法）；完成「已工作 {duration}」；数据源=store 现有事件时间戳，无终态不显示完成值。
2. **悬挂回合兜底（痛点⑤核心）**：store/replay 路径中，`running` 且无 `turn-end` 的回合，若会话 WS 无该 turnId 活帧超过 30s（或重放时事件流尾部 step/end 后无任何后续且非 running 会话）→ 本地合成终态 `interrupted`（仅 UI 态，不落盘、不改 core）。测试：构造无 turn-end 的事件流 + fake timers 推进 30s → `turnEnds[turnId].stopReason==='interrupted'` 且 spinner 消失。
3. **工具行渲染核对（已预查，直接照办）**：`packages/ui-shared/src/renderer/tool/ToolCard.tsx:339` 现实现为 `status==='running' && <LoaderIcon className="animate-spin">` → 按 Z-97 替换为「静态图标 + kindLabel 文案扫光」（CSS 动画类走 transform/opacity，尊重 `prefers-reduced-motion`；running→completed 边沿自动收起展开若已有则不动，无则补）。改完锁断言。
4. **B1 微基准**：vitest 用例——构造 1000 事件会话流，`store` 重放/投影（`projectChatItems` 路径）耗时 ≤200ms（性能断言用 `expect(Date.now()-t0).toBeLessThanOrEqual(200)`，jsdom 计时宽容可设 250ms 并在注释说明）。若不过 → 停下报告（触发 T7 条件任务，勿自行上虚拟化）。
5. pickFolder 零 await 审计：静态 grep 证明 handler 到 showOpenDialog 间无 await/HTTP（报告给编排者，不强制改码）。
   验收：两包测试 + typecheck + smoke B4。

## T5（变异验证）/ T6（审查）

T5：逐条审 T1-T4 新增用例做变异验证（临时改坏被测实现→用例必红→恢复→绿），输出 `docs/ai-framework/plans/u1-mutation-notes.md`（每条用例：变异点/预期红/实际输出）。T6：只读审查 `git diff main..HEAD` 按 `CODE_REVIEW.md` 出 P0/P1/P2 报告；P0/P1 修复另起 commit；P2 清单返回编排者登记。

---

## 派发顺序与依赖

T1 → T2（同域 main，串行）→ T3（依赖 T1 的 cwd；域不同可紧随）→ T4（依赖 T3 的 DOM 结构）→ T5 → T6 → 编排者验收（V1-V5）→ T8 打包。**每任务返回后编排者亲自复跑验收命令才进下一个。**
