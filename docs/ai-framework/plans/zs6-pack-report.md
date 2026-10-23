# ZS6-T3 win 安装包报告（2026-10-23，正常通道跑通）

## 产物（不进 git：`release/` 已 gitignore 实证）

| 文件                                                            | 大小    | SHA256                                                             |
| --------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `Harness2 Desktop-3.16.2-win32-x64.exe`（NSIS，oneClick=false） | 170.5MB | `8C15C7A20B901C68536D1253263409A30463FCAD6721248C6E447552658C7FE8` |
| `Harness2 Desktop-3.16.2-win32-x64-portable.exe`                | 170.2MB | `A85E6B831714F7FACC865DE93B7F146ACB1DF86A2D3982250E753CAA9FFD0A80` |

附产物：`.blockmap`、`latest.yml`（updater 元数据，本程序不接自动更新链，仅 builder 副产物）。
构建身份：`ZCODE_ENV=production` + production identity → productName「Harness2 Desktop」/ appId `dev.harness2.desktop`；version=3.16.2（上游对齐）；Electron 41.0.3。

## 通道与实证障碍（全部记录，非「应该能过」）

编排者脚本 `scripts/zs6/zs6-pack.ps1`（幂等；只写 release\ 与 scratch out\）。直调 `electron-builder/out/cli/cli.js`，**必须 `-c electron-builder.config.js`**（非标准探测名；缺它=无 npmRebuild:false → node-pty 本地重建撞 VS BuildTools 缺 Spectre 库 MSB8040）。跑通序列内已解决四障碍：

1. **MSB8040**（node-gyp 重建 node-pty）：`-c` 加载配置带 `npmRebuild:false`（ZCode 既有口径）即消。
2. **`version=null`**：desktop package.json 故意留 null（workspace 成员），builder 校验早于 extraMetadata → pack 脚本临时戳 build-meta 版本（3.16.2），pack 完 `git checkout` 还原（scratch 树保持零漂移实证 SCRATCH-CLEAN）。
3. **winCodeSign-2.6.0 解包永败**：归档含 macOS 符号链接（darwin/*.dylib），本机 7za 无特权（「客户端没有所需的特权」）；builder 默认对 `.dll/.node` 签名（signExts）必拉此包 → **`--config.win.signAndEditExecutable=false`** 跳过（ZCode config ~L832 自家口径「本地不被签名配置绑死」）。代价=EXE 文件元数据（图标/版本资源）不落、SmartScreen 本地装包有警告——**正式签名/图标=CI/人类运营面，登记待办**。
4. **打包态无 CDP**：main 仅 `!app.isPackaged` 开 9229 → smoke 直传 `--remote-debugging-port=9229` 命令行开关（fuses 只关 node --inspect 不关此开关，实证可用）。

## 内心装配（关键设计，零新 patch）

安装包的 host = **harness2 真内心**：pack 脚本把 adapter bundle 暂存为 `out/host/harness2-host.cjs` + ESM 桥 `out/host/index.js`（上游 `utilityProcess.fork` 路径契约不变；正式包无 `ZS1_HOST_MODULE_PATH`，P1 回落到此路径）。asar 内实证：`out/host/index.js`=桥注释、`harness2-host.cjs` 含 `zs1 stub host started`/`@harness2/core`/`HARNESS2_HOME` 标记（1.68MB）。

## Smoke（win-unpacked 直跑，全 fake-home 隔离含 HARNESS2_HOME）

`t2-brand-verify.cjs` 改语言无关匹配（打包态首启英文/dev 壳中文，同判品牌词）后 **GATE=PASS 6/6**：

- `SMOKE-CDP-OK UA=…Harness2Desktop/3.16.2 …Electron/41.0.3`（UA 品牌+真实版本号 3.16.2=EXE 内壳在跑）
- `PASS P11_page_title`（document.title="Harness2 Desktop"）
- `PASS P10_help_about_label / P10_no_old_label / menu_no_zcode`（HELP_ITEMS 英文态 "About Harness2 Desktop"）
- `PASS P8_about_window_brand / P8_about_window_no_old`（关于窗打开+品牌断言）

e2e 基础轮（dev 壳）此前已 exit=0（真实 provider 流式回复），安装包级真对话=V9 人类装机项（红线：发版动作与验收归人类）。

## 回退轨（manual-pack）状态如实登记

`packages/desktop/scripts/manual-pack.mjs`（旧壳 U1 T8 通道）在旧壳仓存在；scratch 侧移植**未做**——回退前提是正常通道失败，正常通道已跑通（含上述四障碍的真实排除过程）。移植步骤备忘（若未来环境劣化）：robocopy 组 stage/文件级 unpack/resedit 元数据/elevate + `--prepackaged`，对照 U1 计划 §T8 行。

## 待人类面（入 V9 清单）

1. NSIS 装机试跑一轮真对话（真 `~/.harness2` key）；SmartScreen 提示预期内（无签名）。
2. 正式 logo 供给 → 替换 `build/icon.ico` + `icon_installer.ico` 重打（一键）。
3. 正式签名证书/CI 签名链 = 运营面立项（跨平台另立，ZS6 约束 7 不做）。
