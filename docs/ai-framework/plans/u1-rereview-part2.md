# U1 二轮独立复审 · 片2 渲染端（从零读码）

- 仓库/分支/HEAD：`D:/AI_Projects/harness2` · `feat/phase-u1-desktop-parity-fixes` · `63607ae`（工作树干净，仅 `.zcodeignore` 未跟踪；全程只读，未动 packages/）
- 规格依据：`docs/refs/refs-zcode-layout.md` Z-46/Z-48/Z-49 + `docs/refs/refs-zcode.md` Z-96 + 计划设计规格摘要（`2026-10-14-phase-U1-desktop-parity-fixes.md` §49-52、`2026-10-14-u1-executor-briefs.md` T3）
- 复审人：第二轮片2 审查代理（2026-10-14）

## 片2 渲染端

### 1. Z-46 窗控 —— OK（1 项第一轮 P2 未修，如实带过）

**单实例**：

- `WindowControlsOverlay` 全仓挂载点恰两处：`packages/desktop/src/renderer/App.tsx:485`（壳层常驻）与 `packages/desktop/src/renderer/ErrorBoundary.tsx:69`（fallback 内）。两处互斥渲染（fallback 触发时 App 子树整体不渲染），屏上恒一套。grep `WindowControls|window-controls` 全仓（desktop/web/ui-shared，排除 css）无其他挂载。
- `WindowControls.tsx:59-94` 本体（三键 28px、aria-label/title 中文、`data-testid="window-controls"`）仅被 overlay（`:102-113`）引用，无内嵌第二实例。
- `ConversationHeader.tsx` 残留核：文件内**零**窗控代码（import、 JSX、通道调用均无；`:5-7` 只剩说明注释指明「三键不再内嵌本头」，右侧动作区只剩右栏开关 `:143-156`）——**无残留，不判 P1**。反向断言在测试里：`packages/desktop/test/conversation-header.test.tsx:204,212` `queryByTestId('window-controls')` 为 null；`window-controls-overlay.test.tsx:125`「选中会话后屏上仍恰有一套」。
- `seat.tsx`（`packages/ui-shared/src/renderer/conversation/seat.tsx`，606 行）grep `WindowControls|window-controls|isDesktop|variant="draft"` **零命中**——无孤儿引用；header 缝 `:516` 只渲染注入的 `header?.()`，空态（`selectedId=null`）时整条 chat 席位由 overlay 覆盖，不依赖 header。装配点 `packages/desktop/src/renderer/conversation/assembly.tsx:127-128,173` 注入 `ConversationHeader`（会话态），与 ZCode「draft 只隐藏标题区」不同但 overlay 模式下行为等价（计划 §49 认可的落点二：壳层常驻）。

**overlay 交互分区**：

- CSS `packages/desktop/src/renderer/layout/desktop-window.css:57-81`：overlay 容器 `pointer-events: none`（`:70`）、z-130（高于设置 z-[100]/面板 z-[110]，注释 `:60-61` 说明是刻意为之）；drag 条 `position:absolute; inset:0; -webkit-app-region: drag` + `pointer-events:auto`（`:72-76`）；键体 `.window-controls-overlay .window-controls { position:relative; pointer-events:auto; -webkit-app-region:no-drag }`（`:78-82`）——drag 条在键体之下（DOM 序 `:109` drag span 在前 + 键体 relative 提层），不吃三键点击。分区结构正确。
- 让位规则：`.window-controls-active .pane-header` / `[data-testid='side-pane-tabstrip']` 各 `padding-right:140px`（`:113-120`），根类由 `App.tsx:453-459` 同一判据挂载。

**ErrorBoundary fallback**：`ErrorBoundary.tsx:69` 挂 overlay，注释 `:3-4` 明指按 Z-46「复刻时补上」执行（ZCode 自身三处缺口之一，harness2 已补）。测试 `window-controls-overlay.test.tsx:169` 断言错误页窗控在场。启动 HTML loading 壳为主进程侧窗口（非本审查面渲染端），不计。

**win/linux 门**：`WindowControlsOverlay` 判据 `usesCustomWindowControls(platform)`（`platform.ts:23-25`：仅 win32/linux）`&& typeof api.windowMinimize === 'function'`（`WindowControls.tsx:106`）；mac/web/缺通道 → null。测试 `window-controls-overlay.test.tsx:138`（darwin 不渲染、linux 常驻）、`:153`（无通道不摆假按钮）。`desktopPlatform()`（`platform.ts:10-15`）缺 platform 通道返回 null → 不启用任何平台特化（web 宿主零变化），判据诚实。

**第一轮 P2-3 未修（带过，不重复立案）**：设置页（`SettingsShell.tsx:99` z-[100] 全屏）与命令面板右上 136×48 无让位——overlay z-130 透明 drag 带盖过该角：文案不可选中/拖动落该区会拖走窗口。已核设置页关闭钮在**左栏**「返回工作区」（`SettingsShell.tsx:105-113`），右上无交互控件，故维持 P2 级（视觉/交互毛刺，非吞按钮）。修法照旧：覆层打开时禁用 drag 带或两覆层头加 padding-right:140px。

**结论**：Z-46 实现与规格一致，单实例/门/fallback/让位四项全 OK。

### 2. Z-48/Z-49 侧栏 —— OK（cwd 链核全；1 项注释/实现不符，P2）

**「在此项目新建会话」cwd 传递链（逐环核全，无断点 = 不判 P1）**：

1. `SessionBrowser.tsx:420-436` `ProjectGroupHead`：hover/focus mount（`shouldMountRowActions` `:139-141`，非 CSS 隐藏，对齐 ZCode `WorkspaceSidebarItem.tsx:275-281`），显式组（`source==='project' && cwd!==undefined` `:390-391`）才出钮，点击 `ctx.onNewSessionInProject?.(group.cwd as string)`（`:430`）——**cwd 入参第一环，带上**。
2. `shell-seat-contents.tsx:207-214`：`onNewSessionInProject={state.status==='connected' && createSession 通道在场 ? (cwd)=>{backToConversation(); newSessionCollapsingRightbar(frameDispatch, cwd)} : undefined}`——**cwd 透传，未连接/无通道 = 钮不渲染（红线⑩）**。
3. `app-shared.tsx:35-38` `newSessionCollapsingRightbar(dispatch, cwd?)`：`dispatch(rightbar/collapse); void controller.newSession(cwd)`——**cwd 第三环透传**。
4. `app-controller.ts:412-416` `newSession(cwd?)`：`cwd!==undefined && cwd.length>0 ? api.createSession(cwd) : api.createSession()`——**第四环，空串视同缺省**。
5. `preload/preload.ts:41` `createSession:(cwd?)=>invoke({cmd:'createSession', cwd})`；`bridge.ts:449-457`：`body.cwd = typeof args.cwd==='string' && length>0 ? args.cwd : deps.root`——**末环消费 cwd，缺省回落 --root**。
   测试钉死：`ui-shared/test/controller-new-session-cwd.test.ts`（带 cwd/缺省/空串三例）、`desktop/test/sidebar-project-actions.test.tsx:108`（装配端到端 createSession 收到项目 cwd 且新会话被选中）。**链核结论：五环全通，零丢 cwd。**

**顶部「+」保持空白新会话不被项目态污染**：`shell-seat-contents.tsx:234-237` `onNewSession={() => {backToConversation(); newSessionCollapsingRightbar(frameDispatch)}}`（无 cwd 实参）→ `controller.newSession()` 无参 → `api.createSession()` 无 cwd → 主进程 `deps.root`。`DesktopTopOverlay` 的 `onNewTask`（`App.tsx:474-477`）与 Ctrl+N（`App.tsx:230-235`）同样不带 cwd。测试 `sidebar-project-actions.test.tsx:125`「顶部『+』仍是不带 cwd 的空白新会话（两入口区分）」反向钉。**OK**。

**会话行「删除」只走 controller.deleteSession**：

- 入口：`session-row-menu.tsx:94-153` `delete` 恒末位 + 前置分隔（`:122-123`），`canDelete` 仅当壳给 `onDeleteSession`（`:89`），确认框由 `SessionBrowser.tsx:598-609` 截胡 `onDeleteSession` 为「打开 `ConfirmDialog`」（`:912-936`），确认后 `onDeleteSession(target.id)` → `shell-seat-contents.tsx:218` `onDeleteSession={(id)=>controller.deleteSession(id)}` → `app-controller.ts:682-701`（`store.updateMetadata(id,{deleted:true})` + `api.metadataSet(id,{deleted:true})` + `removeSessionFromView`）。
- 绕道核：全仓 `deleted: true` 写入仅 `app-controller.ts:687,695` 两处（均在 deleteSession 内）；渲染端无旁路 `metadataSet(...deleted)` 直写——**无绕道，不判 P1**。软删语义（覆层标记 + 视图移除、事件日志保留）与注释/红线一致。
- running 禁用**实时性**：`session-row-menu.tsx:93` `deleteDisabled = item.running === true`。`item.running` 来源 `buildSessionItems flagsOf`（`shell-seat-contents.tsx:122-128`）每帧读 `store.peekStream(id).running`（live，非挂载快照）；`SidebarSeatContent` 用 `useAppState`（`app-shell.tsx:28` `useSyncExternalStore(store.subscribe, store.getState)`）订阅，store 每次 running 变更 `notify()` bump rev 产生新引用（`store.ts:257-260`）触发重渲 → 禁用判据**随实时状态更新**，不是快照。**OK。**
- **注释/实现不符（P2）**：`SessionBrowser.tsx:911` 注释称「running 行菜单已禁用；**此处再兜一层**（防对话框开着时该会话转为运行）」，但 `ConfirmDialog` 的 `onConfirm`（`:921-934`）**未复查 `deleteTarget.running`**——对话框打开后该会话若转为运行，确认仍会删除运行中会话（`deleteSession` 不停 turn，视图移除后后台 turn 继续）。主门禁（行菜单禁用）实时有效，此为次要兜底承诺落空 + 注释撒谎，P2。修法：`onConfirm` 前 `if (deleteTarget.running) return;`（或按 live `store.peekStream(deleteTarget.id)?.running` 复查），或删去注释里不存在的「再兜一层」。

**ConfirmDialog 复用既有 dialog 原语（不自造 = 不判 P2）**：`components/ConfirmDialog.tsx` 由 `components/ui/dialog.js`（Radix Dialog）+ `button.js` 组合，`variant="destructive"` 确认钮（`:59-68`）、busy 双钮禁用；既有原语目录 `components/ui/{dialog,button}.tsx` 存在——组合件，非第三套弹窗。**OK。**

**「移出项目」条件确认（组内 running 才弹）**：`SessionBrowser.tsx:654-664` `ctx.onRemoveProject` 包装：`findGroupByCwd(sections,cwd)` 命中且 `group.items.some(it=>it.running)` → `setRemoveProjectTarget`（弹 `ConfirmDialog` `:938-951`，Z-49 文案族 `labels.removeProjectRunning*`）；否则直接 `onRemoveProject(cwd)`。组找不到 = `undefined` → 直接移除（防御性回落，注释 `:652-653` 如实）。文案对齐 `refs-zcode-layout.md:356-392` 语义。`removeProject`（`shell-seat-contents.tsx:106-115`）→ `api.projectsRemove(cwd)`，只写 projects.json、不动会话数据（红线①②）。测试 `sidebar-z48-z49.test.tsx:176,196,209`（running 弹/无 running 直移/空组直移三例）。**OK。**

**文案族**：`labels.ts:193-202` 逐条对齐 Z-48/Z-49（「在此项目新建会话」「删除这个会话？」「移除运行中的项目？」「会话正在运行，先停止再删除」等）。

### 3. Z-96 发送可见化 —— OK（1 项已知遗留，非新缺陷）

**数据源（submitAcks unknown/rejected）**：

- `chat-error-model.ts:38-47` `latestSubmitAckError`：遍历 `Object.values(acks)` 取**最后一条**（键序=插入序，store 每次 `{...prev,[id]:ack}` 重建 `store.ts:837-845`），`state∈{unknown,rejected}` → 横幅候选、`accepted` → null（重发成功旧失败自然消失，无需手动关）。
- 生产者：channel 失败 → `app-controller.ts:475-483` 立即 `applyFrame submit-ack unknown`（reason `提交未送达: msg`）；5s 超时 → `store.ts:915-926` `expirePendingSubmits` 标 unknown；serve 拒绝 → `rejected` 帧经 `resolveSubmitAck`（`store.ts:836-853`）。**unknown/rejected 双源覆盖，事实源唯一。**
- seat 装配 `seat.tsx:452,458-460`：每帧现算（不 memo，注释 `:454-457` 说明 stream 引用恒定 memo 会拿旧 ack），`banner = ackError && !dismissed.has(fp) ? mergeErrorDetail(ackError,lastFailure) : null`。

**指纹去重（关掉同错不顶回）**：`chat-error-model.ts:28-30` `errorFingerprint = state:reason`（不含 clientMessageId → 同因重试视作同错，去重成立）；`:72-80` `withDismissedFingerprint`（有界 50，LRU 删最旧）。X 关闭 `seat.tsx:568` `setDismissed(withDismissedFingerprint(...))`；**每次新提交重新布防**（`seat.tsx:393-395` submit 包装清 `dismissed`/`lastFailure` → 主动重试再失败会重新可见）。测试 `chat-error-banner.test.tsx:59`「点 X 关闭后同错误不再弹；重新提交同一失败 → 横幅重新出现」。**OK。**

**详情 Dialog / 复制 / X 结构**：`ChatErrorBanner.tsx` 完整——`CircleAlertIcon` + 单行截断 message（`truncate`+title 兜全文 `:46-48`）+（有 detail）「查看详情」`:50-60`→ `ChatErrorDetailDialog`（`<pre>` 承载可滚动原文 `:115-123`）+「复制完整报错」`:61-71`（`navigator.clipboard`，缺通道如实禁用不假报 `:30-33`）+ 右上 X `:72-81`。刻意用原生 title 不包 Radix Tooltip（`:8` 注释：防 update-depth 循环，对齐 Z-96）。`mergeErrorDetail`（`chat-error-model.ts:61-67`）按 message 同源配对 detail（防旧 error 串到新横幅）。**OK。**

**草稿保留回归断言**：`Composer.tsx:390-415` 失败分支 `settleFailedSubmission` 还原草稿（`restore-draft` `:404`）+ 附件（`restoreAttachments` `:407`）+ 不静默文案（`:409-414`）+ 上抛 `props.io.onSubmitError?.(...)`（`:415`）。测试 `chat-error-banner.test.tsx:46`「mock submit 失败 → 横幅出现 + **草稿文本仍在编辑器（保留回归）**」——回归断言存在。**OK。**

**onSubmitError desktop+web 两壳接线**：grep 调用点 = `Composer.tsx:415`（**唯一触发点，非零 → 不判 P1**）；handler = `seat.tsx:383-388`（`ioWithErrors` 包 `port.io`）。横幅与 handler 都在**共享 `ConversationSeat`** 内（`seat.tsx:563-570` banner / `:380-399` io），desktop（`assembly.tsx:15,167-169` 渲染 `SharedConversationSeat`）与 web（`web-seat-contents.tsx:17,248` `<ConversationSeat>`）两壳均经此路径 → **两壳自动接线**，计划 §66「onSubmitError 走共享 seat 零 web 改动」的自主决策属实。`chat-error-banner.test.tsx:37-46` 用 `createController+apiWithFailingSubmit` 经真实 seat 装配验证。**OK。**

**禁用 tooltip 三类原因**：`Composer.tsx:343-352` `sendDisabledReason`——`props.locked===true`（connecting/中断，seat `:577` `locked={state.status!=='connected'}`）→「未连接…」；`props.sessionId===undefined` →「未选择会话…」；`uploadsPending`（`:325`）→「附件仍在上传…」。渲染：tooltip 触发点包 `<span className="inline-flex">`（`:718-719`，规避禁用钮 `pointer-events-none` 使 hover 拿不到——正是 Z-96 记录的 ZCode 缺陷，此处改进可达），`TooltipContent`（`:747`）+ `aria-label` 并入原因（`:728-730`）+ `data-disabled-reason`（`:731`）。测试 `chat-error-banner.test.tsx:123,137,147`（未连接/未选择会话/附件三例）。**三因齐备，OK。**

**已知遗留（非新缺陷，计划 §66 已如实登记）**：Z-96 优先级链 `draftModelReadinessError ?? sendSubmissionError ?? projectedComposerError` 只实现 `sendSubmissionError`（submitAcks）一支；`draftModelReadinessError`（模型未就绪本地预判）无数据面未实现——属交付时显式登记的实现范围，不计缺陷。次要观察：channel 失败时 composer 内联 `setSubmitStatus`（`Composer.tsx:409`）与常驻横幅并存，双通道提示；ZCode 亦有落点提示+横幅并存，非破版。

---

### P0/P1/P2 清单（本审查只登记不修复；给修法）

**P0 = 0**
**P1 = 0**（cwd 链五环核全无丢参；删除仅经 `controller.deleteSession`、全仓无旁路 `deleted` 直写；`onSubmitError` 两壳经共享 seat 接线非零调用点；窗控单实例且 `ConversationHeader`/`seat.tsx` 零残留）

**P2 = 2**（1 新发现 + 1 第一轮遗留未修）

| ID                               | 位置                                                                   | 描述                                                                                                                                                                                                       | 修法（不修，登记）                                                                                                                                                | 影响                                                          |
| -------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P2-1（新）                       | `packages/ui-shared/src/renderer/sidebar/SessionBrowser.tsx:911-935`   | 注释声称确认框「running 再兜一层」，但 `ConfirmDialog.onConfirm` 未复查 `deleteTarget.running`：对话框打开后会话转为运行（他格提交/队列放行等）时，确认仍删除运行中会话（软删不停 turn，后台 turn 继续跑） | `onConfirm` 内先 `if (store.peekStream(target.id)?.running === true) { 关框/提示 }`（SessionBrowser 无 store 引用时改由回调方判），或如实删掉注释中不存在的兜底层 | 破坏性窗口窄（主门禁实时有效），但注释与实现不符误导维护者    |
| P2-2（第一轮 P2-3 带过，仍未修） | `desktop-window.css:57-82` + `SettingsShell.tsx:99`（z-100）/ 命令面板 | 覆层打开时右上 136×48 透明 drag 带（z-130）盖过覆层角：该区文案选不中、拖拽会动窗口；无交互控件故不吞按钮                                                                                                  | 覆层态给 drag 带加 `pointer-events:none` 开关，或两覆层头 `padding-right:140px`（同 `.pane-header` 手法）                                                         | 视觉/交互毛刺；Z-46「全场景常驻」达成，仅让位规则未覆盖覆层态 |

**次要观察（不立案）**：① channel 失败时 composer 内联 `setSubmitStatus`（`Composer.tsx:409-414`）与常驻横幅并存，双通道提示同一错误（ZCode 亦有落点提示+横幅并存，非破版）；② `latestSubmitAckError` 的「最后一条」依赖 `Object.values` 插入序（`chat-error-model.ts:33-40`）——`cm:` 前缀非数字键成立，注释已声明，可接受；③ `draftModelReadinessError` 数据源支未实现为交付时如实登记的遗留（计划 §66），不计新缺陷。

### 测试留证（2026-10-14 本机实跑）

```
$ cd packages/ui-shared && ./node_modules/.bin/vitest run --maxWorkers=4
 ✓ test/controller-new-session-cwd.test.ts (3 tests) 5ms
 Test Files  67 passed (67)
      Tests  723 passed (723)
   Duration  20.67s
```

全部通过（含 `chat-error-banner.test.tsx`、`chat-error-model.test.ts`、`sidebar-z48-z49.test.tsx`、`controller-new-session-cwd.test.ts` 等本片相关用例）。注：第一轮登记 680 → 本轮 723，增量来自后续并行提交（T4 系列），无失败项。desktop 侧窗控/装配用例（`window-controls-overlay.test.tsx`、`sidebar-project-actions.test.tsx`）本轮按任务书未重跑（工作树只读约束下仅跑 ui-shared）。
