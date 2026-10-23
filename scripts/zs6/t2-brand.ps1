# ZS6-T2 品牌验证启动器（复用 run-e2e 的 fake-home 装配面，只起壳+验证+清场）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zs6/t2-brand.ps1 [-Capture]
# -Capture：跑 t2-capture.cjs 取 V3 证据截图；默认跑 t2-brand-verify.cjs 判定门
param([switch]$Capture)
$ErrorActionPreference = 'Stop'

$HarnessRoot  = 'D:\AI_Projects\harness2'
$Zs1Build     = 'D:\AI_Projects\harness2-zs1-build'
$ZCodeRoot    = Join-Path $Zs1Build 'ZCode'
$FakeHome     = Join-Path $Zs1Build 'fake-home'
$DataDir      = Join-Path $Zs1Build 'zs1-data'
$Electron     = Join-Path $ZCodeRoot 'node_modules\electron\dist\electron.exe'
$AdapterHost  = Join-Path $HarnessRoot 'packages\zcode-adapter\dist\host-entry.cjs'

function Kill-Scratch {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -like ($Zs1Build + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Kill-Scratch
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort 9229 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host 'ABORT: port 9229 still busy'; exit 2
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
$env:ZS1_HOST_MODULE_PATH = $AdapterHost
$env:ZCODE_DATA_BASE_DIR = $DataDir
# ZS6-T2 运行时品牌注入（零 patch 通道：装配壳既有 env 覆盖应用身份）
$env:ZCODE_DESKTOP_APPLICATION_NAME = 'Harness2 Desktop'

if (-not (Test-Path $AdapterHost)) {
  Push-Location (Join-Path $HarnessRoot 'packages\zcode-adapter')
  node scripts/zs1-guard.mjs buildAll
  Pop-Location
}

Start-Process -FilePath $Electron -ArgumentList '.' -WorkingDirectory (Join-Path $ZCodeRoot 'packages\desktop') | Out-Null

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9229/json/list' -UseBasicParsing -TimeoutSec 2
    if ($r.Content -match 'harness2-zs1-build') { $ready = $true; break }
  } catch {}
}
if (-not $ready) { Write-Host 'ABORT: page not up within 60s'; Kill-Scratch; exit 2 }
Start-Sleep -Seconds 4

# 路由：ZS6_T2_SCRIPT=t1-verify.cjs 可复用同一套起壳装配跑其它 zs6 验证门；
# -Capture 或 ZS6_T2_CAPTURE=1 走截图采集。5.1 下 -File 传 switch 不生效（实证 2026-10-23），env 兜底。
$script = 't2-brand-verify.cjs'
if ($Capture -or $env:ZS6_T2_CAPTURE -eq '1') { $script = 't2-capture.cjs' }
if ($env:ZS6_T2_SCRIPT) { $script = $env:ZS6_T2_SCRIPT }
Push-Location $HarnessRoot
node ("scripts/zs6/" + $script)
$code = $LASTEXITCODE
Pop-Location

Kill-Scratch
Write-Host ("T2 BRAND exit=" + $code)
exit $code
