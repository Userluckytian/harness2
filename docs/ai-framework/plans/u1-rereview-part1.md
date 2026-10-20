# U1 二轮独立审查 · 片1 主进程

- 审查对象：`packages/desktop/src/main/`（bridge / main / workspace-root / tray / window-lifecycle / close-window-handler / preferences* / serve-manager 判据侧）
- 基线：分支 `feat/phase-u1-desktop-parity-fixes`，HEAD `63607ae`；工作树干净（仅未跟踪 `.zcodeignore`）
- 规格依据：`docs/refs/refs-zcode-layout.md` Z-47（:118-129）；计划 `2026-10-14-phase-U1-desktop-parity-fixes.md`；`docs/issue-log/2026-10-11.md` §81
- 方法：全程只读源码 + 跑一次测试留证；未做变异测试（并行代理约束）；未抄第一轮报告

## 片1 主进程

### 1 `bridge.ts` — handleInvoke 穷举 case 表（66 case）

判据：发 HTTP 者必须分支内取 `serveBase()`（漏=P0）；不发 HTTP 者不得触 `deps.serve.baseUrl`/`wsUrl` getter（触=P1）。
`serveBase()` 定义 :430（`= deps.serve.baseUrl`，未就绪同步抛错，getter 见 serve-manager.ts:194-202）。switch 之前无任何 serve getter 读取（R0-3 惰性化保持完好）。

| #   | case                          | 行号 |            发 HTTP             |                         经 serveBase()                         |
| --- | ----------------------------- | ---: | :----------------------------: | :------------------------------------------------------------: |
| 1   | listSessions                  |  439 |               是               |                        是（:440 首行）                         |
| 2   | createSession                 |  449 |               是               |                           是（:450）                           |
| 3   | events                        |  459 |               是               |                           是（:460）                           |
| 4   | undo                          |  463 |               是               |                           是（:464）                           |
| 5   | redo                          |  474 |               是               |                           是（:475）                           |
| 6   | subscribe                     |  482 |            否（WS）            |                               —                                |
| 7   | unsubscribe                   |  485 |            否（WS）            |                               —                                |
| 8   | sendMessage                   |  488 |            否（WS）            |                               —                                |
| 9   | abort                         |  495 |            否（WS）            |                               —                                |
| 10  | respondApproval               |  498 |            否（WS）            |                               —                                |
| 11  | runConfig                     |  517 |               是               |                           是（:518）                           |
| 12  | planState                     |  522 |               是               |            是（:523，经 httpJsonOptional 404→null）            |
| 13  | executionViews                |  528 |               是               |                           是（:529）                           |
| 14  | changeReview                  |  536 |               是               |                           是（:537）                           |
| 15  | fork                          |  542 |            否（WS）            |                               —                                |
| 16  | submit                        |  552 |            否（WS）            |                               —                                |
| 17  | cancel                        |  573 |            否（WS）            |                               —                                |
| 18  | resumeSubscription            |  594 |            否（WS）            |                               —                                |
| 19  | capabilities                  |  601 | 条件（仅 connected∧sessionId） |                     分支内受护读取（见下）                     |
| 20  | runtime:setBusy               |  603 |               否               |                               —                                |
| 21  | loadLayout                    |  610 |               否               |                               —                                |
| 22  | saveLayout                    |  612 |               否               |                               —                                |
| 23  | getStatus                     |  614 |               否               | —（调 `serve.getStatus()` 普通方法 :190-192，不触抛错 getter） |
| 24  | platform:setTitleBarTheme     |  617 |               否               |                               —                                |
| 25  | window:minimize               |  623 |               否               |                               —                                |
| 26  | window:toggleMaximize         |  627 |               否               |                               —                                |
| 27  | window:close                  |  635 |               否               |                               —                                |
| 28  | window:getState               |  640 |               否               |                               —                                |
| 29  | terminal:open                 |  645 |               否               |                               —                                |
| 30  | terminal:write                |  660 |               否               |                               —                                |
| 31  | terminal:resize               |  668 |               否               |                               —                                |
| 32  | terminal:close                |  676 |               否               |                               —                                |
| 33  | tray:status                   |  681 |               否               |           —（isTrayCreated?.() ?? false，缺省安全）            |
| 34  | tray:setCloseToTray           |  689 |               否               |                               —                                |
| 35  | settings:getConfig            |  699 |               否               |                               —                                |
| 36  | settings:updateConfig         |  701 |               否               |                               —                                |
| 37  | settings:getAuthMasked        |  703 |               否               |                               —                                |
| 38  | settings:updateAuth           |  705 |               否               |                               —                                |
| 39  | settings:getModels            |  708 |               否               |                               —                                |
| 40  | settings:updateModels         |  710 |               否               |                               —                                |
| 41  | settings:deleteProvider       |  727 |               否               |                               —                                |
| 42  | settings:writeChannelKey      |  739 |               否               |                               —                                |
| 43  | settings:getCredentialStatus  |  749 |               否               |                               —                                |
| 44  | settings:ackModelsDeclaration |  754 |               否               |                               —                                |
| 45  | settings:discoverModels       |  756 |    否（不触 serve；见补注）    |                               —                                |
| 46  | settings:getPreferences       |  762 |               否               |                               —                                |
| 47  | settings:setPreferences       |  764 |               否               |                               —                                |
| 48  | metadata:get                  |  766 |               否               |                               —                                |
| 49  | metadata:set                  |  768 |               否               |                               —                                |
| 50  | drafts:get                    |  788 |               否               |                               —                                |
| 51  | drafts:set                    |  790 |               否               |                               —                                |
| 52  | projects:list                 |  793 |               否               |                               —                                |
| 53  | projects:add                  |  795 |               否               |                               —                                |
| 54  | projects:remove               |  800 |               否               |                               —                                |
| 55  | projects:pickFolder           |  805 |               否               |                               —                                |
| 56  | settings:getDoctorReport      |  816 |               否               |                               —                                |
| 57  | settings:getCrashReports      |  818 |               否               |                               —                                |
| 58  | settings:getSkills            |  821 |               否               |                               —                                |
| 59  | cron:list                     |  824 |               否               |                               —                                |
| 60  | cron:add                      |  827 |               否               |                               —                                |
| 61  | gitBranch                     |  834 |               否               |                               —                                |
| 62  | getContextUsage               |  838 |               否               |                               —                                |
| 63  | getSnapshotForCall            |  843 |               否               |                               —                                |
| 64  | listDir                       |  855 |               否               |                               —                                |
| 65  | readFileForRef                |  861 |               否               |                               —                                |
| 66  | notify                        |  866 |               否               |                               —                                |

**计数**：HTTP 9（全部 :440/:450/:460/:464/:475/:518/:523/:529/:537 分支首行取 base）；WS op 9（全部走 `wsSendOrThrow` :415-420，只查 `ws.readyState`，零 serve getter）；capabilities 1（条件 HTTP，受护）；其余 47 零 serve 触碰。**结论：无 P0（漏取 base）、无 P1（非 HTTP case 连坐触 getter）。**

特别检查：

- **probeCapabilities（:257-280）**：connected 前提**真成立**。:258 读 `deps.serve.status`（公开普通字段，不抛），仅 `connected ∧ sessionId 非空` 才进 :261 读 baseUrl。ServeManager 只在端口确定后才 `setStatus('connected')`（采纳路径 :242-244 先赋 `this.port` 再置位；自建路径 :297 先赋 port、健康检查通过后 :303 置位），不存在 connected 而 port=null 使 baseUrl 抛错的窗口；stop() 置 offline 且 offline 后 connectWs 重连链自断（:381 `status !== 'offline'` 门）。未就绪时返回 `serveReady:false` 报告而非抛错，符合「不发 HTTP 者不得触 getter」。轻微不一致：:261 直读 `deps.serve.baseUrl` 而非走 `serveBase()`（:430 注释约定「只在真正发 HTTP 的 case 内调用本函数」）——语义等价，仅风格，P2。
- **submit（:552-571）**：不发 HTTP、不触 serve ✓。幂等键 `clientMessageId` 空即抛（:555 fail-closed）✓；`intent` 白名单 steer/queue（:557）✓；references 仅 Array.isArray 透传、expectedTurnId 条件携带 ✓。
- **ws token 路径（:346-397）**：HTTP 经 `httpJson` 注 `x-harness2-token` 头（:231-237，token null 时不加头保持旧行为 ✓）；WS 因全局 WebSocket 无自定义头，改 `?token=` 查询参数 + `encodeURIComponent`（:360），`authToken` 普通 getter 不抛（serve-manager :209-211）✓。`wsUrl` getter 的两处读取都在 `connectWs` 的 try 内（:356-361），抛错走 :394-396 发 error 帧，不崩 ✓。connectWs 由 main 在 serve ready 后调用（时序见 §2）。
- **respondApproval（:498-515）**：五态白名单，未知值落 deny，fail-closed ✓。
- **readFileForRef（:126-154）**：`isInside` 用 `relative(cwd,target)` 判逃逸 + `isAbsolutePath` 兜住跨盘绝对路径，64KB 截断，错误转对象不抛 ✓。

结论：**OK**（仅 1 条 P2 风格项）。

### 2 `main.ts` + `workspace-root.ts` — 工作区根两态与三调用点

产物布局证据：`tsconfig.electron.json`（rootDir=src, outDir=dist-electron）+ `package.json:7 main=dist-electron/main/main.js` → dev 态 `__dirname = packages/desktop/dist-electron/main`。

- **dev = 仓库根，上跳 4 级核**：`workspace-root.ts:26 DEV_REPO_ROOT_HOPS=4`，`join(dirname,'..','..','..','..')` 折叠 = `main→dist-electron→desktop→packages→harness2/` ✓ 恰为仓库根（旧 3 级落 `packages/` 的偏差已修）。打包分支 `isPackaged → homeDir`（:30）完全不碰 dirname ✓。
- **打包 = home，§81 安装目录缺陷不回归**：§81 取证二根因（旧 `resolveRepoRoot` 上跳 3 级 = `<install>/resources/`，会话 cwd 落在 `D:\Program Files\harness2\resources`，`docs/issue-log/2026-10-11.md:1286` 起）。现打包态恒 `os.homedir()`，安装目录不参与路径运算 ✓ 不可回归。`.tmp-cmp/inst-x` 时代缺陷同被此门挡住。
- **三调用点一致**：`main.ts:63 const workspaceRoot = defaultWorkspaceRoot()` **单次求值**；①serve `--root`：:107-110 `root: workspaceRoot`（→ serve-manager buildServeArgs :261）；②bridge `deps.root`：:123；③terminal root：:139 `startTerminal({ root: workspaceRoot })`。三处同一常量 ✓ 无二次求值分叉。
- 相邻核对：`resolveCliEntry`（:30-33）dev 上跳 3 级到 `packages/` 再进 `cli/dist/index.js` ✓（该处目标是 packages/cli，3 级恰好，勿与 root 的 4 级混判）；打包 `resourcesPath/cli/harness2-cli.cjs` ✓。
- **connectWs 时序**：onStatus('connected') 内 `bridge.connectWs()`（:114）——ServeManager 两条置 connected 路径都先赋 `this.port`（serve-manager :242-244 采纳 / :297+:303 自建），wsUrl getter 此刻不抛 ✓；`bridge` const 晚绑定安全（回调首次触发在 :255 serve.start() 之后）✓。
- 观察（P2）：normal 模式 `startDesktop` 返回值含 `ready`（:72），但 :368 调用点丢弃 → serve 启动失败时 `.catch` 里 `rejectReady(e)`（:263）产生**无消费者 rejected promise**（unhandledRejection 警告；Electron 主进程不崩，且 serve 内部退避链 :341-359 仍自动重试、sendStatus('offline') 已发）——仅噪声，不判功能缺陷。

结论：**OK**（P2×1）。

### 3 托盘 / 关窗裁决 / 偏好 vs Z-47

逐条对规格（`refs-zcode-layout.md:118-129`）：

1. **平台门**：`window-lifecycle.ts:17-19 isTrayPlatform = win32|linux`；`tray.ts:116 !isTrayPlatform → return null`（mac 不建 ✓）。`main.ts:188 opts.tray ∧ createTray null` 双门。
2. **左键/双击 = show（非 toggle）**：`tray.ts:140-141` click/double-click → `showMainWindow`；`main.ts:199-203` restore（若最小化）+ show + focus ✓ 与 Z-47 `desktopTray.ts:114-115→showCurrentWindow` 语义一致。
3. **右键菜单序**：Z-47 要求「打开 ┃ 新建任务/打开工作区 ┃（仅 production）检查更新/**关于**/导出日志 ┃ 退出」；计划设计摘要（`2026-10-14-phase-U1-desktop-parity-fixes.md:50`）同样含「**关于**/导出日志」。实现 `tray.ts:96-108`：打开 harness2 / 新建会话 / 添加项目 / ─ / 导出日志(disabled) / ─ / 退出——**缺「关于」项，计划承诺项未落地且 T2 验收行（:65）未登记该跳过** → **P1**。导出日志灰显 + TODO 注记（:102-104）与计划 :65「如实置灰」一致，不另计。
4. **hide 三重门**：`window-lifecycle.ts:43-49 decideWindowClose`：平台门 → `explicitQuit→proceed` → `!closeToTrayEnabled→proceed` → `!trayCreated→proceed`，全过才 `hide-to-tray`。接线 `main.ts:238-253`：action==='hide-to-tray' 时 `preventDefault()+win.hide()`；`forceClosing`（D4 request-stop 二次 close）跳过裁决防「永远退不出」（:216-217,227-230,239）✓。closeToTray 有效值 = `resolveCloseToTray(readPreferences(home).closeToTray, platform)`（:215，**每次 close 现读**，设置页改偏好即时生效 ✓）。
5. **能力双条件门（linux）**：Z-47 之二的 DBus `StatusNotifierWatcher` 探测，`window-lifecycle.ts:7-8` 注释称「折叠进 trayCreated」——但 `tray.ts:129-135` 仅 `new Tray` 不抛即算成功，**无探测**。Linux（GNOME 无 AppIndicator 扩展）上 Tray 构造通常不抛但图标不可见 → hide 门全过 → **关窗后窗口消失且无托盘可唤回**（任务栏按钮随 hide 消失）。默认安全（linux 缺省 closeToTray=false，`window-lifecycle.ts:22-24`；Z-47 linux 首次强制归位为关），**仅 linux 用户手动开启时踩中** → **P1**。修法：照 ZCode `desktopTraySupport.ts:182-203` gdbus→busctl→qdbus 探测链折入 `isTrayCreated`，或裁决内 linux 恒 proceed（设置页对 linux 隐藏开关）。
6. **退出写法 + 回滚**：托盘「退出」= `quitIntent.mark('tray-quit')` 后 `app.quit()`（`main.ts:207-210`；Z-47「先 markExplicitQuit 再 quit」✓）。回滚：D4 三出口全 rollback（`close-window-handler.ts:59-61,63-67,76-78` → `main.ts:232-236 onQuitAborted → quitIntent.rollback()`）——取消/保持后台/弹窗失败均不残留陈旧标志，后续关窗恢复 hide 裁决 ✓（Z-47「before-quit 兜底确认、取消则回滚」等价达成）。`quitIntent` 纯状态件 `window-lifecycle.ts:65-77`，isExplicit=marked!==null ✓。
7. **竞态推演**：
   - **hide 后如何退出**：窗口 hide 不销毁 → 不触发 window-all-closed；退出唯一路径 = 托盘「退出」（mark→app.quit→close 事件→裁决 explicitQuit=真→proceed→busy 时 D4 框；!busy 直放）或设置关窗后再关（正常裁决）。✓ 闭环。
   - **双 close**：连续两次关窗均 hide，幂等；busy+弹框未决时再来 close 事件：`stoppingForClose` 仅在 request-stop 后为真（`close-window-handler.ts:45,70`），**第一次弹框挂起期间第二次 close 会再进 showDialog**——Electron `showMessageBox(win,…)` 对同父窗模态，实际表现=排队/阻塞而非双杀，窄缝隙且属 D4 既有面 → P2 注记。
   - **busy + hide 门全过**：hide 优先于 D4（不进框、任务继续=驻留本意，`main.ts:220-221` 注释明示）；关 hide 门则回 D4 框 ✓。
   - **「保持后台运行」×hide 门**：keep-running→minimize+rollback（`close-window-handler.ts:63-67`）——退出中止、标志回滚、窗口在（最小化），无「hide 了还弹框」错位 ✓。
   - **trayHandle 销毁**：`tray.ts:151-159` handle.destroy 存在，但 main.ts **无任何调用点**（before-quit 不 destroy；进程退出 OS 回收，win 实践无害）→ P2 卫生项。
8. **smoke tray:false 无泄漏**：`main.ts:321 startDesktop({…, tray:false})` → 不建托盘、isTrayCreated=false；退出走 `finish()`（:293-310）：bridge.disconnectWs + stopTerminal + await serve.stop + rmSync(smokeHome) + `app.exit(code)`——app.exit 绕过 close/before-quit，但清理已手动做全 ✓；40s 超时路径同走 finish ✓；`smokeHome` TDZ 预声明（:290-292）✓。测试夹具 `test/desktop-tray*.test.ts` 在位。
9. **closeToTray 加性字段**：`shared/preferences.ts` 字段 `closeToTray?: boolean` 可选（:74-78 注释「加性、缺省=平台默认」）；`normalizePreferences` 仅 `typeof boolean` 才展开（:146-147），缺失保持缺失、非布尔脏值回落缺失 ✓；`defaultPreferences()` 不含该键 ✓；既有旧文件（无字段）读→normalize→仍不含→写回不新增 ✓ 不破坏；`setCloseToTray` 读-改-写不整体覆盖（`preferences-file.ts:30-33`）✓；`resolveCloseToTray` 用 `??` 保显式 false ✓（`stored ?? platform==='win32'` 语义：win 默认开/linux 默认关，与 Z-47 :129 一致）。bridge 侧 `tray:status/setCloseToTray`（bridge.ts:681-698）零 serve 触碰 ✓。
10. mac 语义偏离（关窗 quit 而非 ZCode 的 hide+Dock）：`window-lifecycle.ts:10` 注释自认「本模块不改 mac 关窗语义」，计划 Goal 锁 Windows 交付 → 已登记决策，不计缺陷。

结论：**问题 2 项（P1×2）+ P2×2**，其余对 Z-47 逐项符合。

### 4 测试留证（一次实跑，不改码）

```
$ cd packages/desktop && ./node_modules/.bin/vitest run --maxWorkers=4 2>&1 | tail -3
 Test Files  128 passed (128)
      Tests  1282 passed | 1 skipped (1283)
   Duration  39.81s
```

全绿；相关用例 `test/desktop-tray.test.ts`、`test/desktop-tray-status.test.ts`、`test/desktop-window-lifecycle.test.ts`、`test/desktop-workspace-root.test.ts`、`test/desktop-close-window.test.ts`、`test/desktop-close-handler.test.ts`、`test/desktop-r0-3-budget.test.ts`、`bridge-token.test.ts` 均在跑过的 128 files 内。

---

## P0/P1/P2 清单

**P0 = 0。P1 = 2。P2 = 4。**

### P0（无）

第 1 节判据全部满足：9 个 HTTP case 均分支首行 `serveBase()`；probeCapabilities 条件 HTTP 受 connected 护；其余 56 个非 HTTP case 零触 `deps.serve.baseUrl/wsUrl`。第 2/3 节未发现安装目录回归。

### P1（不修，给修法与复跑命令）

- **P1-1 托盘右键菜单缺「关于」项**（计划承诺未落地，且验收未登记跳过）
  证据：计划 `2026-10-14-phase-U1-desktop-parity-fixes.md:50` 与 Z-47 `refs-zcode-layout.md:125` 均要求「…─ 关于/导出日志 ─ 退出」；实现 `tray.ts:96-108` 只有导出日志(disabled)，**无「关于」项**；`TRAY_LABELS`（:20-26）未定义；T2 验收行 `计划:65` 登记了「导出日志如实置灰」却未登记「关于」跳过。
  修法：`TRAY_LABELS` 补 `about: '关于'`，模板在导出日志前插入 `{ label: about, click: () => actions.showAbout() }`；`TrayActions` 加 `showAbout()`；`main.ts:197-211` 接 `app.showAboutPanel()`（或自定义关于窗），并在计划验收表如实登记。
  复跑：`cd packages/desktop && ./node_modules/.bin/vitest run --maxWorkers=4 2>&1 | tail -3`（`desktop-tray.test.ts` 断言菜单结构，需同步补「关于」条目）。

- **P1-2 Linux「能力双条件门」的 DBus 探测缺失/折叠不实**
  证据：Z-47 `refs-zcode-layout.md:128` 要求 `resolveCloseToTraySupported = 托盘创建成功 ∧ linux DBus StatusNotifierWatcher 探测（gdbus→busctl→qdbus）`；`window-lifecycle.ts:7-8` 注释称「已折叠进 trayCreated」，但 `tray.ts:129-135` 的「成功」仅 = `new Tray` 不抛 + 图标非空，**无任何 DBus 探测**。GNOME 无 AppIndicator 扩展时 `new Tray` 通常不抛但托盘不可见 → `isTrayCreated()=true`（`main.ts:135`）→ hide 三重门全过 → 关窗后窗口消失且无托盘唤回（仅 linux 用户显式开启 closeToTray 时踩中；默认安全因 `window-lifecycle.ts:22-24` linux 缺省 false）。
  修法：`isTrayCreated` 语义收紧为「创建成功 ∧（linux）DBus 探测通过」——新增 `traySupport.ts` 注入式探测（execFile gdbus/busctl/qdbus 三级回退，非 linux 恒 true），`main.ts:135` 改 `() => trayHandle !== null && dbusProbe.ok`；探测不过即 `trayCreated=false`，裁决自然回落确认退出路径。或在 linux 设置页隐藏该开关（与 defaultCloseToTray=false 形成双保险）。
  复跑：`cd packages/desktop && ./node_modules/.bin/vitest run --maxWorkers=4 2>&1 | tail -3`（新增 `desktop-tray-support` 注入 fake execFile 覆盖探测三态）。

### P2（卫生/一致性，可择机）

- **P2-1 probeCapabilities 直读 baseUrl 而非 serveBase()**：`bridge.ts:261` 用 `deps.serve.baseUrl`，与 :430 注释「只在真正发 HTTP 的 case 内调用本函数」自相矛盾（功能等价，:258 已护 connected，语义无误）。统一改 `serveBase()` 即可。
- **P2-2 normal 模式 ready promise 无消费者**：`main.ts:72` 定义 `ready`，`.catch` 里 `rejectReady(e)`（:263），但 `:368` 调用点丢弃返回值（仅 smoke :325 消费）→ serve 启动失败时产生 unhandledRejection 警告（Electron 主进程不崩、sendStatus/退避链已覆盖，纯噪声）。修法：丢弃处挂 `.catch(()=>{})` 或 normal 不 reject。
- **P2-3 trayHandle 无 destroy 调用点**：`tray.ts:151-159` 句柄可销毁，`main.ts:68/188` 持有但 `before-quit`（:266-270）不调 → 退出依赖 OS 回收（win 实践无害）。建议 before-quit 里 `trayHandle?.destroy()`。
- **P2-4 busy 弹框挂起期二次 close 重入 showDialog**：`close-window-handler.ts:45` 的 `stoppingForClose` 仅在 request-stop 后为真；首次 `showDialog` 未决时第二次 close 事件会再进（:47）。Electron `showMessageBox(win,…)` 对同父窗模态实为阻塞/排队，非双弹，缝隙窄（且属 D4 既有面，非 Z-47 引入）。修法：加 `dialogOpen` 门，挂起期直接 `return`（保持 preventDefault 不关）。

**审查约束遵守**：全程只读 `packages/**`（未做任何 checkout/stash/变异）；唯一写入 = 本文件。计数：`handleInvoke` 66 case = HTTP 9（全 serveBase）+ WS op 9（全 wsSendOrThrow，零 serve getter）+ capabilities 1（条件受护）+ 其余 47 零 serve 触碰。
