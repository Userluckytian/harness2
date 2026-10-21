# ZS2 e2e 一键 runbook（编排者安全重写，2026-10-21；旧版三处不可放行：`*ZCode*` 过宽误杀面 / 未验证的 dev-desktop-env 启动 / 180s 死等）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zs2\run-e2e.ps1 [-Fresh]
# 退出码: 透传 e2e-round.cjs（0 通过 / 3 实例锁定失败 / 4 输入未落 / 5 用户行未现 / 6 无 composer / 1 其他）
param([switch]$Fresh, [switch]$Approval, [switch]$SidebarDelete, [switch]$SettingsProvider)
$ErrorActionPreference = 'Stop'

$HarnessRoot  = 'D:\AI_Projects\harness2'
$Zs1Build     = 'D:\AI_Projects\harness2-zs1-build'
$ZCodeRoot    = Join-Path $Zs1Build 'ZCode'
$FakeHome     = Join-Path $Zs1Build 'fake-home'
$DataDir      = Join-Path $Zs1Build 'zs1-data'
$Electron     = Join-Path $ZCodeRoot 'node_modules\electron\dist\electron.exe'
$AdapterHost  = Join-Path $HarnessRoot 'packages\zcode-adapter\dist\host-entry.cjs'
$ViteBin      = Join-Path $ZCodeRoot 'node_modules\vite\bin\vite.js'
$OutRenderer  = Join-Path $ZCodeRoot 'packages\desktop\out\renderer\index.html'

# 安全杀进程：只按 ExecutablePath 精确匹配 scratch 树（用户 ZCode.exe 在 D:\Programs\ZCode\，天然不中；
# 绝不按 CommandLine 的 '*ZCode*' 之类宽匹配——会误杀宿主 IDE）。
function Kill-Scratch {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -like ($Zs1Build + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Kill-Scratch
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort 9229 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host 'ABORT: port 9229 still busy after cleanup (残留旧壳 dev 实例?)'; exit 2
}

# renderer 产物自愈（host-bundle/测试重建会清 out/，实证过多次）
if (-not (Test-Path $OutRenderer)) {
  Write-Host 'renderer missing -> vite build...'
  Push-Location (Join-Path $ZCodeRoot 'packages\desktop')
  $env:NODE_ENV = 'production'
  node $ViteBin build | Out-Null
  Pop-Location
  if (-not (Test-Path $OutRenderer)) { Write-Host 'ABORT: renderer build failed'; exit 2 }
}
# adapter bundle 缺失则构建
if (-not (Test-Path $AdapterHost)) {
  Push-Location (Join-Path $HarnessRoot 'packages\zcode-adapter')
  node scripts/zs1-guard.mjs buildAll
  Pop-Location
}

# -Fresh：清壳配置 + 会话工作区/草稿数据（草稿持久化在 zs1-data 与 HARNESS2_HOME 的 zs 目录，
# 2026-10-21 实证跨重启残留会污染 composer 初值）
if ($Fresh -or $SidebarDelete -or $SettingsProvider) {
  foreach ($p in @((Join-Path $FakeHome '.zcode'), (Join-Path $FakeHome '.harness2'), (Join-Path $DataDir '.zcode'))) {
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
  }
}
foreach ($d in @((Join-Path $FakeHome 'AppData\Roaming'), (Join-Path $FakeHome 'AppData\Local'))) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

$env:ZCODE_DESKTOP_HOME_DIR = $FakeHome
$env:HOME = $FakeHome
$env:USERPROFILE = $FakeHome
$env:APPDATA = Join-Path $FakeHome 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $FakeHome 'AppData\Local'
$env:HARNESS2_HOME = 'C:\Users\ASUS'
if ($SidebarDelete -or $SettingsProvider) { $env:HARNESS2_HOME = $FakeHome }
$env:ZS1_HOST_MODULE_PATH = $AdapterHost
$env:ZCODE_DATA_BASE_DIR = $DataDir
$env:ZS2_PROBE = '1'
if ($Approval) { $env:ZS3_E2E_APPROVAL = '1' }
if ($SidebarDelete) { $env:ZS4_SIDEBAR_DELETE = '1' }
if ($SettingsProvider) { $env:ZS4_SETTINGS_PROVIDER = '1' }

Start-Process -FilePath $Electron -ArgumentList '.' -WorkingDirectory (Join-Path $ZCodeRoot 'packages\desktop') | Out-Null

# 轮询 CDP 直至 page 出现（上限 60s），再留 4s 稳定——替代旧版 180s 死等
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9229/json/list' -UseBasicParsing -TimeoutSec 2
    if ($r.Content -match 'harness2-zs1-build') { $ready = $true; break }
  } catch {}
}
if (-not $ready) { Write-Host 'ABORT: new-shell page not up within 60s'; Kill-Scratch; exit 2 }
Start-Sleep -Seconds 4

Push-Location $HarnessRoot
if ($Approval) {
  node scripts/zs3/approval-round.cjs
} elseif ($SidebarDelete) {
  node scripts/zs4/sidebar-delete-round.cjs
} elseif ($SettingsProvider) {
  node scripts/zs4/settings-provider-round.cjs
} else {
  node scripts/zs2/e2e-round.cjs
}
$code = $LASTEXITCODE
Pop-Location

Kill-Scratch
Write-Host ("RUNBOOK e2e exit=" + $code)
exit $code
