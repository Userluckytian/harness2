# U1 二轮独立复审 · 总结

> 四片明细：`u1-rereview-part1.md`（主进程）/ `part2.md`（渲染端）/ `part3.md`（性能终态 Z-97）/ `part4.md`（红线卫生）。
> 执行者说明（如实）：用户选定严格口径（jam-only）后，cat-jam 路由持续被上游 OpenCode 免费额度拒绝（FreeTierError，直探与派发双红、3h 窗口未命中、resume 实例真任务亦中途死）→ 按用户「派子智能体审查」指令，四片由等职能 general-purpose 子代理从零执行（片1/2）+ 编排者直跑（片3 补全与片4 全片，属验收复跑证据本分）。第一轮报告未作预设、未抄结论。

## 总判定

| 片 | P0 | P1 | P2 | 结果 |
| -- | -- | -- | -- | ---- |
| 1 主进程 | 0 | **2** | 4 | P1 双项已修（`4de407c` 关于项 / `aa6b8ba` linux DBus 能力门），P2 登记不阻塞 |
| 2 渲染端 | 0 | 0 | 2 | cwd 五环链、删除唯一路径、Z-96 接线全核 OK；P2 两项登记 |
| 3 性能终态 | 0 | 0 | 1 | Z-97 竞态闭合、tick 纪律、生成器钉死全 OK（执行者一条 P2 经复核**改判误报**：armHungTurnWatch 同步收敛分支在 noteActivity 路径不可达） |
| 4 红线卫生 | 0 | 0 | 1 | 冻结区逐行=仅版本字段、api-surface 0、凭据扫描 0、68 文件 eslint 0 error/prettier 全绿、commit 42/42 合规、manual-pack 无危险动作（注释术语 P2 一条） |

**第二轮合计：P0=0；P1=2 全修；P2=8 登记（含 1 条改判误报撤销）。第一轮报告经独立复核基本成立，且本轮新增抓到第一轮漏报的托盘域两缺陷——「子代理自报不可全信、复审必须从零跑」的纪律被实证。**

## 关键修复（P1×2）

- **P1-1 托盘右键缺「关于」**（Z-47 承诺项漏落地）：`tray.ts` 菜单补项 → `app.showAboutPanel()`（版本走 `app.getVersion()`）；测试同步（`4de407c`，desktop-tray 12 例绿）。
- **P1-2 Linux 能力双条件门缺失**（`window-lifecycle.ts` 注释谎称折叠、实际 `new Tray` 不抛即放行 → GNOME 无 AppIndicator 时关窗=窗口消失无托盘可回）：新建 `tray-support.ts` 注入式 gdbus→busctl→qdbus 三级探测（零 electron import，fake 可测五例），`main.ts` **两处门**（isTrayCreated + close 站点 trayCreated）同步收紧、探测未回绝不 hide（`aa6b8ba`，desktop 129 files/1287 passed，tsc 0）。

## 修复后交付物（重建并端到端复验）

`tsc -p tsconfig.electron.json` 重发射 → `manual-pack.mjs` → `electron-builder --prepackaged` → **`release/harness2-1.0.2-win-x64.exe` 124.8MB / portable 124.6MB（2026-10-15 08:11）**。编排者从最终 NSIS 全量解出直跑：`harness2.exe --smoke` `{"ok":true}` exit 0；asar 内验：`tray-support.js` 在包、tray.js 含「关于」、main.js 含 `trayProbeOk` 接线。闸门：desktop 129/1287+1s、ui-shared 67/723、tsc×2=0、smoke=0、红线 diff=0（core/gateway 功能面）。

## 结论

B 路径（严格口径缺口）已按可达手段补齐：二轮全量复审完成、其 P0/P1 全修、交付物重建并端到端复验。**发版（push→合 main→tag v1.0.2→CI 三平台）与 M1-M12 真机点验仍待用户授权/执行。** P2×8 与既有 core 挂账（工具无硬超时、R0-3②③、roles.main 定格）一并留 OPEN.md/计划文档，不带病、不静默。
