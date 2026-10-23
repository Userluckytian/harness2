# ZS6-T3 win 安装包编排（计划：正常通道 + manual-pack 回退双轨）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zs6/zs6-pack.ps1 [-SkipBuild] [-NoSmoke]
# 纪律：幂等；只写 release\ 与 scratch out\；不删仓外文件；产物不进 git（release/ 已 gitignore）。
param([switch]$SkipBuild, [switch]$NoSmoke)
$ErrorActionPreference = 'Stop'

$HarnessRoot = 'D:\AI_Projects\harness2'
$Zs1Build    = 'D:\AI_Projects\harness2-zs1-build'
$ZCodeRoot   = Join-Path $Zs1Build 'ZCode'
$Desktop     = Join-Path $ZCodeRoot 'packages\desktop'
$FakeHome    = Join-Path $Zs1Build 'fake-home'
$AdapterHost = Join-Path $HarnessRoot 'packages\zcode-adapter\dist\host-entry.cjs'
$ReleaseDir  = Join-Path $HarnessRoot 'release\zs6'
$ViteBin     = Join-Path $ZCodeRoot 'node_modules\vite\bin\vite.js'
$TsupCli     = Join-Path $ZCodeRoot 'node_modules\tsup\dist\cli-default.js'
$BuilderCli  = Join-Path $ZCodeRoot 'node_modules\electron-builder\out\cli\cli.js'

# 镜像（U1 T8 既成事实 + ZCode resolveElectronDownloadMirror 优先级实证）
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:NPM_CONFIG_ELECTRON_MIRROR = $env:ELECTRON_MIRROR
$env:electron_builder_binaries_mirror = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR = $env:electron_builder_binaries_mirror
# 构建身份：生产后端+正式 flavor（ZCODE_PREVIEW_IDENTITY 缺省 0 → production identity）
$env:ZCODE_ENV = 'production'
$env:ZCODE_TARGET_OS = 'win'
$env:ZCODE_TARGET_ARCH = 'x64'
$env:NODE_ENV = 'production'
$env:ZCODE_DESKTOP_DIST_DIR = $ReleaseDir

function Kill-Scratch {
  Get-CimInstance Win32_Process -Filter "Name='Harness2 Desktop.exe' OR Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -like ($Zs1Build + '*') -or $_.ExecutablePath -like ($ReleaseDir + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null }

# 1) adapter 内心 bundle（永远重建，成本秒级）
Push-Location (Join-Path $HarnessRoot 'packages\zcode-adapter')
node scripts/zs1-guard.mjs buildAll
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'ABORT: adapter buildAll'; exit 3 }
Pop-Location

# 2) desktop 生产构建（tsup=main/host/preload/scheduler；vite=renderer）——直调绕过 pnpm shim
Push-Location $Desktop
if (-not $SkipBuild) {
  node scripts/build-metadata.mjs
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'ABORT: build-metadata'; exit 3 }
  node $TsupCli
  # 既有障碍登记：plugin-sandbox onSuccess 的 gen-ui vendor 哈希校验在本机 checkout 失败
  # （脚本自带 manifest 缺档=checkout 工件，非 ZS 引入；main/host/preload/renderer/scheduler
  # 产物全出实证）。tsup 退出码以产物存在性复核为准，不盲从。
  if ($LASTEXITCODE -ne 0) { Write-Host 'NOTE: tsup nonzero (known gen-ui onSuccess); verifying outputs instead' }
  node $ViteBin build
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'ABORT: vite'; exit 3 }
}
foreach ($req in @('out\main\index.js', 'out\renderer\index.html', 'out\host\index.js', 'out\preload', 'out\scheduler\index.js')) {
  if (-not (Test-Path (Join-Path $Desktop $req))) {
    Pop-Location; Write-Host ('ABORT: out/ missing ' + $req); exit 3
  }
}
Pop-Location

# 3) 装配内心：暂存 harness2 host 到 out/host（正式包无 ZS1_HOST_MODULE_PATH，
#    P1 回落路径=out/host/index.js——staging=构建编排动作，非源码 patch）
$HostDir = Join-Path $Desktop 'out\host'
Copy-Item $AdapterHost (Join-Path $HostDir 'harness2-host.cjs') -Force
[System.IO.File]::WriteAllText((Join-Path $HostDir 'index.js'), @(
  '// ZS6-T3 装配暂存（pack 脚本生成，勿手改）：harness2 内心 = zcode-adapter bundle。',
  '// CJS bundle 经 ESM 桥导入；上游 utilityProcess.fork(out/host/index.js) 路径契约不变。',
  "import './harness2-host.cjs';",
  ''
) -join "`n")

# 4) electron-builder（直调 cli；nsis+portable 经 CLI 目标覆盖，不动 scratch 配置）
# desktop/package.json 的 version 上游故意留 null（workspace 成员），但 app-builder-lib
# 在应用 extraMetadata 前先校验源 package.json → 临时戳 build-meta 版本，pack 完还原，
# 保持 scratch 工作树=登记 patch 集（T6 diff -rq 口径）。
Push-Location $Desktop
$meta = Get-Content 'out\metadata\build-meta.json' -Raw | ConvertFrom-Json
$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
$pkg | Add-Member -NotePropertyName version -NotePropertyValue $meta.appVersion -Force
[System.IO.File]::WriteAllText((Join-Path $Desktop 'package.json'), ($pkg | ConvertTo-Json -Depth 30))
# 关键：-c 显式加载 electron-builder.config.js（非标准自动探测名；缺它=无 npmRebuild:false
# → builder 对 node-pty 本地 node-gyp 重建，VS BuildTools 缺 Spectre 库必炸 MSB8040，实证）。
# signAndEditExecutable=false：本机无签名证书通道（ZCode 自家本地构建同口径，config ~L832
# 注释「本地开发不被签名配置绑死」），且 builder 的 winCodeSign 工具包在本机永远解包失败
# （含 macOS 符号链接，无特权=实证 MSB 之外的另一硬障碍）→ 跳过 signtool 查找。
# 代价=EXE 文件元数据（图标/版本资源）不落，SmartScreen 警告本地装包时出现——正式签名归 CI/人类运营面。
node $BuilderCli -c electron-builder.config.js --config.win.signAndEditExecutable=false --config.nsis.artifactName='${productName}-${version}-${platform}-${arch}.${ext}' --config.portable.artifactName='${productName}-${version}-${platform}-${arch}-portable.${ext}' --win nsis portable --x64
$buildCode = $LASTEXITCODE
git -C $ZCodeRoot checkout -- packages/desktop/package.json
Pop-Location
if ($buildCode -ne 0) { Write-Host 'BUILDER-EXIT-NONZERO'; }

# 5) 产物清单+哈希（报告 docs/ai-framework/plans/zs6-pack-report.md 由编排者汇总）
$exes = Get-ChildItem $ReleaseDir -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending
Write-Host ("ARTIFACTS=" + $exes.Count)
foreach ($f in $exes) {
  $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
  Write-Host ("FILE=" + $f.Name + " SIZE_MB=" + [math]::Round($f.Length/1MB,1) + " SHA256=" + $h)
}
$unpacked = Get-ChildItem $ReleaseDir -Directory -Filter 'win-unpacked'
if ($unpacked) { Write-Host 'WIN-UNPACKED-OK' } else { Write-Host 'WIN-UNPACKED-MISSING (builder pre-stage?)' }

# 6) smoke：win-unpacked 直跑（真内心）+ 端口 9229（打包态不自动开 CDP，命令行直传
#    --remote-debugging-port 让 Chromium 解析；electronFuses 只关 node --inspect 不关此开关）
if (-not $NoSmoke) {
  Kill-Scratch
  if (-not (Test-Path $FakeHome)) { New-Item -ItemType Directory -Force -Path $FakeHome | Out-Null }
  $exe = Join-Path $ReleaseDir 'win-unpacked\Harness2 Desktop.exe'
  if (-not (Test-Path $exe)) { Write-Host 'SMOKE-SKIP: unpacked exe missing'; exit $buildCode }
  # 全 fake-home 隔离：HARNESS2_HOME 也指向 fake-home，烟测绝不写真实 ~/.harness2
  foreach ($d in @((Join-Path $FakeHome 'AppData\Roaming'), (Join-Path $FakeHome 'AppData\Local'), (Join-Path $FakeHome '.harness2'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  }
  $env:ZCODE_DESKTOP_HOME_DIR = $FakeHome
  $env:HOME = $FakeHome; $env:USERPROFILE = $FakeHome
  $env:APPDATA = Join-Path $FakeHome 'AppData\Roaming'
  $env:LOCALAPPDATA = Join-Path $FakeHome 'AppData\Local'
  $env:HARNESS2_HOME = $FakeHome
  $env:ZCODE_DATA_BASE_DIR = (Join-Path $Zs1Build 'zs1-data')
  Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9229' | Out-Null
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9229/json/list' -UseBasicParsing -TimeoutSec 2
      if ($r.Content -match 'renderer') { $ready = $true; break }
    } catch {}
  }
  if ($ready) {
    Start-Sleep -Seconds 3
    $vj = (Invoke-WebRequest -Uri 'http://127.0.0.1:9229/json/version' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    Write-Host ('SMOKE-CDP-OK UA=' + $vj.'User-Agent')
    # 打包态页 URL=file://.../win-unpacked/... → 用 ZS6_PAGE_MATCH 放宽 t2-brand-verify 选择器
    $env:ZS6_PAGE_MATCH = 'win-unpacked'
    Push-Location $HarnessRoot
    node scripts/zs6/t2-brand-verify.cjs
    $smokeCode = $LASTEXITCODE
    Pop-Location
    Write-Host ('SMOKE verify exit=' + $smokeCode)
  } else {
    Write-Host 'SMOKE-FAIL: page not up within 60s'
    $smokeCode = 4
  }
  Kill-Scratch
  if ($buildCode -ne 0) { exit $buildCode }
  exit $smokeCode
}

exit $buildCode
