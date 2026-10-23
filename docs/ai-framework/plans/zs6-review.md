# ZS6 独立审查报告（cat-jam · 只读 · 2026-10-23）

## 范围

审查面 = scratch 仓 `D:/AI_Projects/harness2-zs1-build/ZCode` 提交区间 `3c5b2276..247b4c0e`（P1–P11 patch 全集）+ harness2 仓 adapter 提交 `e804ffd`（ZS5 P2 尾巴清偿）+ 台账四件（ZS6 计划约束 / ZS1 patch 表 / brand-checklist / HANDOFF）+ `docs/patches/zs-shell-patches.patch` + `zs6-pack-report.md` + `scripts/zs6/zs6-pack.ps1`。

diff --stat 两行原文：

```
 18 files changed, 351 insertions(+), 124 deletions(-)     # git diff --stat 3c5b2276 247b4c0e（scratch ZCode）
 7 files changed, 92 insertions(+), 12 deletions(-)        # git show e804ffd --stat（harness2，含 2 docs/截图）
```

## 逐项审查

### 1. packages/ui 逐 hunk 分类 —— 判定：合规（P0=0）

`git diff 3c5b2276 247b4c0e -- packages/ui` 共 5 文件 6 hunk，逐一比对允许集合：

| 文件:位置                                         | hunk 内容                                                                            | 分类                                   | 判定 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- | ---- |
| `lib/settingsNavigation.ts:49-53`                 | `HIDDEN_SETTINGS_SECTIONS` 追加 `"usage"` `"remoteDevices"`（P3）                    | 隐藏渲染·集合追加                      | ✅   |
| `model-provider-section/constants.ts`             | `PRESET_PROVIDER_SPECS`/`CODING_PLAN_PROVIDER_SPECS` 两表置空 + 删 import 2 枚（P4） | 隐藏渲染·表置空                        | ✅   |
| `model-provider-section/Navigation.tsx:389`       | filter 改「一切空组不渲染标题」（P5）                                                | Navigation 空组标题                    | ✅   |
| `WorkspaceHelpMenuButton.tsx`                     | `VENDOR_HELP_LINKS_HIDDEN=true` 常量门，5 外链 + 检查更新整块不渲染（P6）            | 隐藏渲染·条件（不改任何 handler 逻辑） | ✅   |
| `i18n/locales/{zh-CN,en-US}.ts`                   | `titleBar.menu.help.about` 值改「关于/About Harness2 Desktop」（P10）                | i18n 字串值                            | ✅   |
| `model-provider-section/ProviderCardSections.tsx` | 获取模型按钮+Dialog（fetch 状态/discoverModels/addDiscoveredModels/勾选）（P2）      | P2 获取模型面板（已批准交互）          | ✅   |

逐项核验点：P6 的 5 个 `DropdownMenuItem` 原 onSelect（`openProductDocs`/`handleOpenCommunity`/`openIssueReport`/`openExternal(vulnerabilityReportUrl)`/`openFeatureRequest`）与 `updateMenu.checkForUpdates` 全部**原样搬进** `!VENDOR_HELP_LINKS_HIDDEN` 分支，零改写、零删除逻辑；导出日志/资源管理器/关于保留。P2 面板内部状态（`fetchSeqRef`/`providerIdRef` 竞态守卫）为新增自包含代码，未触碰既有 `openAddDialog`/编辑/删除路径；`{ intl, locale }` 解构与按钮 flex 包裹均系 P2 面板配套。无任何集合/表/条件/字串/P2 之外的交互逻辑、状态机或 event 处理变更。**未发现 P0 级越界。**

### 2. 品牌替换只改值不改键 —— 判定：合规（P0=0）；但 en-US 有 2 值未替换（见 P1-1）

`packages/shared/src/desktopMenu.ts`：`DesktopMenuMessageId` 映射表**零 hunk**（`git diff` 该文件 4 个变更 hunk 全部为值行 ±）；键 `trayOpenZCode: "tray.menu.openZCode"` 现值原样（实测 :52），`"tray.menu.openZCode"` 键名原样（:113 zh / :165 en）。过滤 diff 全部 ± 行中的非品牌语义行：`grep` 零命中（EXIT=1）=无结构行改动。ui i18n 两文件同法：仅 `"titleBar.menu.help.about"` 一行值变，键不变。about.ts/desktop-product-identity.mjs/electron-builder.config.js/index.html 为常量值/构建元数据替换，无键语义。**键未被改动=查找不破坏。** 例外面：en-US 段 `tray.tooltip: "ZCode"`、`tray.menu.openZCode: "Open ZCode"` 两**值**未替换（登记口径问题，非键问题）→ 降 P1。

### 3. packages/zcode-adapter（e804ffd） —— 判定：三项全接通，合规

- **三段链路**：`createHarness2Services.ts` 定义 `disposers[]`+`registerDispose` 并传入 `createAgentService({..., registerDispose })`（diff +246/+254）→ `real/agent-service.ts:355-365` `disposeSessionsIndex`（clearInterval + `sessionsIndexSubs.clear()`）经 `opts.registerDispose?.()` 注册 → `host-entry.ts:162-167` `port.once('close')` 内 `rawServer.dispose(); protocol.disconnect(); dispose();`。链路源头契约有单测钉死（`test/sessions-index.test.ts` 新增「dispose 回收轮询定时器并停帧」，断言 disposer 构造期即注册 + 停帧）。✅
- **TEST_CRASH 双信号门**：`host-entry.ts` 条件 `ZS5_TEST_CRASH==='1' && ZS2_PROBE==='1'`。设置面实测：`scripts/zs2/run-e2e.ps1:86` 无条件设 `ZS2_PROBE='1'`，:90 仅 `-Crash` 开关设 `ZS5_TEST_CRASH='1'`（run-e2e.ps1 为全仓唯一设置点；run-soak.ps1:77 注释明示不设 ZS2_PROBE）→ 两枚仅 runbook 能齐设，单 env 误带入不再可能触发。✅
- **plugin-management 读写形状**：`plugin-management-stub.ts` 4 读方法 `async` 返回空态形状（listPlugins/getPluginsOverview/getPluginReferenceCatalog/resolveSuggestedPluginReference，对照 zcode-protocol schema 注释）；13 写方法显式列 `throws`，`stub-factory.ts:77-81` 对 `throws` 名单返回 `async (): Promise<never> => { throw ... }`=async 形状 reject；其余未列方法 B 类默认同样 async throw（:86-89）。✅

### 4. patch 一致 —— 判定：合规

`git diff --name-only 3c5b2276 247b4c0e | wc -l` = **18**；`grep -c "^diff --git" docs/patches/zs-shell-patches.patch` = **18**；`wc -l` = **830**。加强核验：`diff <(git diff 3c5b2276 247b4c0e) zs-shell-patches.patch` → **PATCH-IDENTICAL**（内容逐字一致，非仅计数巧合）。✅

### 5. 「基线 11 处」四处口径互洽 —— 判定：互洽

| 口径源                         | 表述                                                                              | 一致性 |
| ------------------------------ | --------------------------------------------------------------------------------- | ------ |
| ZS6 计划约束 1（:33-35）       | 基线 2 → T1 偏离登记 P3–P6（2→6）→ T2 追加 P7–P11（6→11）                         | ✅     |
| ZS1 计划 patch 表（:272-283）  | P1–P11 逐行在列，各一次，无缺无重；变更登记三行 1→2→6→11                          | ✅     |
| `zs6-brand-checklist.md` §P 表 | P7–P11 五处 + 触点 1-10 映射（P7/P8/P9/P10/P11 编号同 ZS1 表）                    | ✅     |
| `docs/HANDOFF.md:6`            | 「UI patch 基线=**11 处**」逐一列 P1–P11 文件名与归组（P3–P6 隐藏 / P7–P11 品牌） | ✅     |

编号 P1–P11 无缺无重；「构建配置不占编号」在 ZS1 登记表与 brand-checklist 两处口径一致。✅

### 6. 打包报告哈希 —— 判定：实测一致

`Get-FileHash release/zs6/*.exe`（本次审查实测）：NSIS `8C15C7A2...58C7FE8`、portable `A85E6B83...FFD0A80`，与 `zs6-pack-report.md:7-8` 两行逐字符相同。大小实测 178,761,559 B = 170.48MB ≈ 报告 170.5MB；178,433,030 B = 170.17MB ≈ 170.2MB。✅ 产物不进 git：`git check-ignore -v` 命中 `.gitignore:18 release/`。✅

### 7. zs6-pack.ps1 危险动作 —— 判定：无危险动作（1 条健壮性观察入 P2）

- **Kill 匹配面**（:30-34）：`Win32_Process` 先按 `Name='Harness2 Desktop.exe' OR Name='electron.exe'`，再 Where 路径必须 `ExecutablePath -like 'D:\AI_Projects\harness2-zs1-build\*'` 或 `'D:\AI_Projects\harness2\release\zs6\*'`。本机正式安装（`D:\Programs\ZCode`，进程名 ZCode.exe）名称不匹配且路径不在两个集合内=**伤不到**；`ExecutablePath` 为 null（权限不足进程）时 `-like` 不成立=不杀。✅
- **写盘范围**（全脚本核）：`release\zs6`（+fake-home 于 zs1-build 内）、scratch `out\host` 两文件（:67-73 暂存=构建编排）、scratch `packages/desktop/package.json` 临时 version 戳（:80-83）且 **:92 `git checkout --` 紧跟还原**；实测 scratch `git status` 中 package.json **无 M 状态**（还原确实发生）。无任何 `Remove-Item`/删除命令，**无仓外删除**。✅
- 构建产物目录经 `ZCODE_DESKTOP_DIST_DIR=$ReleaseDir`（:28）钉死在仓内 release/zs6。✅

## P0

无。

## P1

1. **en-US 托盘两值未品牌化 + P9 登记虚记「6 串」**：`desktopMenu.ts` en-US 段 `tray.tooltip: "ZCode"`、`tray.menu.openZCode: "Open ZCode"`（实测 :164-165）未替换；`zs6-brand-checklist.md` 触点 #4 与 ZS1 表 P9 行均写「zh+en 共 6 处 / ×6 串」→ 实际 diff 仅改 4 值（zh 3 + en `help.about` 1）。切英文 locale 的用户托盘仍显示旧品牌。属「登记与 diff 实证不符 + 品牌残留」，不破坏键查找与交互，且运行态门（zh 环境）不可见。修复=补 2 值或改登记口径为 4 串并显式声明 en 托盘保留。

## P2

1. **P7 使 dev 态与 packaged 态应用名同值**：`desktopRuntimeEnv.ts` dev 回退 `"ZCode Dev"` 与 packaged 回退 `"ZCode"` 现同为 `"Harness2 Desktop"`——同机并行「开发起壳 + 装包实例」将共用 userData/单实例锁（原 ZCode/ZCode Dev 分离语义被并一）。checklist #1 有授权语境，登记观察；如需并行开发可在 launcher 显式设 `ZCODE_DESKTOP_APPLICATION_NAME`。
2. **pack 脚本 version 戳还原非异常安全**：`:92` 还原是 builder 调用后的顺序语句，若 `node $BuilderCli` 进程外因终止（PowerShell 会话被杀）而 `$ErrorActionPreference='Stop'` 抛断在 :90-92 之间，package.json 戳会残留 scratch 工作树（git 可手工还原，非丢失风险）。建议 try/finally。

## 结论

⚠️ **有条件通过：P0=0 / P1=1 / P2=2**

代码面红线全部守住：UI 六 hunk 均在允许四类内、键零扰动、adapter 三链路实证接通、patch 台账 18/18/830 逐字互证、哈希实测一致、打包脚本无危险动作。唯一需带入收口/下阶段闭环的是 P1-1（en 托盘 2 值 + P9 登记口径 6→4 或补齐）；两条 P2 为登记观察项。V6「P1 闭环」= 处理 P1-1 后即可转 ✅。

## 自证

```
$ git -C D:/AI_Projects/harness2 status --short docs/ai-framework/plans/
?? docs/ai-framework/plans/zs6-review.md
```

（仅本报告 1 个未跟踪文件，其余计划目录文件零改动。）

```
$ wc -l docs/ai-framework/plans/zs6-review.md
101 docs/ai-framework/plans/zs6-review.md
```

---

审查方法备注：全部判定基于只读命令实测（git diff/show/status、grep、diff、Get-FileHash、check-ignore）；「未核实」项=无（7/7 项均落证据）；运行态复跑类证据（t1/t2-verify、e2e、smoke）按 §14 采信执行记录 + 本审查静态面独立复核，未重跑起壳。

---

## 闭环处置（编排者，2026-10-23 审查后追加）

| 发现         | 处置                                                                                                                       | 证据                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **P1-1**     | en-US `tray.tooltip`/`tray.menu.openZCode` 两值补品牌=「Harness2 Desktop」/「Open Harness2 Desktop」；登记口径「×6」转真实 | scratch `48915dd1`；desktopTray/about/runtimeEnv 单测 39 绿；`t2-brand-verify` 复跑 GATE=PASS 6/6 |
| **P2-1**     | dev 回退改「Harness2 Desktop Dev」恢复 dev/packaged 单实例分离语义                                                         | 同上 `48915dd1`；main bundle 重建含新值；e2e `-Fresh` 复跑（本轮）                                |
| **P2-2**     | pack 脚本 version 戳还原改 try/finally 异常安全                                                                            | `scripts/zs6/zs6-pack.ps1`（harness2 收口提交内）                                                 |
| 产物哈希失效 | 修复后终版重打包=NSIS `77325B1C…C62238` / portable `F723A616…411F9C2`（171.8/171.4MB），打包体 smoke 同轮 GATE=PASS 6/6    | `zs6-pack-report.md` 终版表+重打包史；`zs6-release-draft.md` 已同步                               |

patch 基线仍=11 处（修复在既有 P7/P9 文件内，未新增编号）；`zs-shell-patches.patch` 重生成=18 文件 842 行（含 `48915dd1`）。**V6 判定：P1 已闭环 → ✅ 通过（P0=0 / P1=0 残留 / P2=0 残留，2 观察项均处置）。**
