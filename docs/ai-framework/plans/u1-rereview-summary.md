# U1 二轮独立复审 · 总结

> 四片明细：`u1-rereview-part1.md`（主进程）/ `part2.md`（渲染端）/ `part3.md`（性能终态 Z-97）/ `part4.md`（红线卫生）。
> 执行者说明（如实）：用户选定严格口径（jam-only）后，cat-jam 路由持续被上游 OpenCode 免费额度拒绝（FreeTierError，直探与派发双红、3h 窗口未命中、resume 实例真任务亦中途死）→ 按用户「派子智能体审查」指令，四片由等职能 general-purpose 子代理从零执行（片1/2）+ 编排者直跑（片3 补全与片4 全片，属验收复跑证据本分）。第一轮报告未作预设、未抄结论。

## 总判定

| 片         | P0  | P1    | P2  | 结果                                                                                                                                                  |
| ---------- | --- | ----- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 主进程   | 0   | **2** | 4   | P1 双项已修（`4de407c` 关于项 / `aa6b8ba` linux DBus 能力门），P2 登记不阻塞                                                                          |
| 2 渲染端   | 0   | 0     | 2   | cwd 五环链、删除唯一路径、Z-96 接线全核 OK；P2 两项登记                                                                                               |
| 3 性能终态 | 0   | 0     | 1   | Z-97 竞态闭合、tick 纪律、生成器钉死全 OK（执行者一条 P2 经复核**改判误报**：armHungTurnWatch 同步收敛分支在 noteActivity 路径不可达）                |
| 4 红线卫生 | 0   | 0     | 1   | 冻结区逐行=仅版本字段、api-surface 0、凭据扫描 0、68 文件 eslint 0 error/prettier 全绿、commit 42/42 合规、manual-pack 无危险动作（注释术语 P2 一条） |

**第二轮合计：P0=0；P1=2 全修；P2=8 登记（含 1 条改判误报撤销）。第一轮报告经独立复核基本成立，且本轮新增抓到第一轮漏报的托盘域两缺陷——「子代理自报不可全信、复审必须从零跑」的纪律被实证。**

## 关键修复（P1×2）

- **P1-1 托盘右键缺「关于」**（Z-47 承诺项漏落地）：`tray.ts` 菜单补项 → `app.showAboutPanel()`（版本走 `app.getVersion()`）；测试同步（`4de407c`，desktop-tray 12 例绿）。
- **P1-2 Linux 能力双条件门缺失**（`window-lifecycle.ts` 注释谎称折叠、实际 `new Tray` 不抛即放行 → GNOME 无 AppIndicator 时关窗=窗口消失无托盘可回）：新建 `tray-support.ts` 注入式 gdbus→busctl→qdbus 三级探测（零 electron import，fake 可测五例），`main.ts` **两处门**（isTrayCreated + close 站点 trayCreated）同步收紧、探测未回绝不 hide（`aa6b8ba`，desktop 129 files/1287 passed，tsc 0）。

### P2 处置实况（2026-10-15 09:0x 终版）

- **已修 5 条**：①删除确认框 live running 复查（`ac0df60` + 补链 `1c7c71d`，ui-shared 725/desktop 1287 全绿+变异自证）；②probeCapabilities 改走 serveBase()；③normal 模式 ready 挂静默 catch（防 unhandledRejection 噪声）；④before-quit 托盘判空销毁；⑤manual-pack 注释「镜像」→「递归拷贝（非 /MIR，幂等）」（②③④⑤合 commit `b09e4ca`）。
- **维持登记 3 条**：part1-P2-4（busy 弹框挂起期二次 close 重入——Electron 模态窗实测阻塞/排队非双弹，窄缝隙属 D4 既有面）、part2-P2-②（设置页/命令面板右上 136×48 透明 drag 带未让窗控安全区——纯观感）、part3 口径项（WORK_TICK_MS 与 ZCode 同值，登记即可）。
- **过程教训（如实）**：P2 批先后三次整批派发遭通道截断（零落盘）；拆成 **20 分钟内可完成 + 锚点内嵌 + 单文件粒度** 的极小派后 100% 成功（3/3 批全绿落码）。执行者 `b09e4ca` 批次曾把 tsc 红项误报为「预存缺陷」，实为 `ac0df60` 断链（SidebarRoot 未透传 prop）——编排者独立复跑识破并补链，再次实证「子代理自报不可信，闸门必须亲跑」。

## 修复后交付物（终版 08:56 重建并端到端复验）

`tsc -p tsconfig.electron.json` + `vite build` 重发 → `manual-pack.mjs` → `electron-builder --prepackaged` → **`release/harness2-1.0.2-win-x64.exe` 124.8MB / portable 124.6MB（2026-10-15 08:56）**。编排者端到端：NSIS 全量解出 `harness2.exe --smoke` `{"ok":true}` exit 0；包内核验 = main.js 含 `trayHandle?.destroy`+`ready.catch`、渲染 bundle `index-BIxYG0X6.js` 含 `isSessionRunning` 接线（2 处命中）。闸门：ui-shared/desktop tsc×3 全 0、vitest 双包绿、1.0.0 崩溃回归标记零命中。

## 结论

B 路径（严格口径缺口）已按可达手段补齐：二轮全量复审完成、其 P0/P1 全修、P2 修 5 登记 3、交付物重建（08:56）并端到端复验。**发版（push→合 main→tag v1.0.2→CI 三平台）与 M1-M12 真机点验仍待用户授权/执行。** 剩余登记项与既有 core 挂账（工具无硬超时、R0-3②③、roles.main 定格）留 OPEN.md/计划文档，不带病、不静默。
