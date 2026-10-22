# ZS5 soak runbook
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zs5\run-soak.ps1
# Exit code: passthrough soak.cjs (0 pass / 1 fail)
param([switch]$Fresh)
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

function Kill-Scratch {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -like ($Zs1Build + '*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Kill-Scratch
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort 9229 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host 'ABORT: port 9229 still busy after cleanup'; exit 2
}

if (-not (Test-Path $OutRenderer)) {
  Write-Host 'renderer missing -> vite build...'
  Push-Location (Join-Path $ZCodeRoot 'packages\desktop')
  $env:NODE_ENV = 'production'
  node $ViteBin build | Out-Null
  Pop-Location
  if (-not (Test-Path $OutRenderer)) { Write-Host 'ABORT: renderer build failed'; exit 2 }
}
if (-not (Test-Path $AdapterHost)) {
  Push-Location (Join-Path $HarnessRoot 'packages\zcode-adapter')
  node scripts/zs1-guard.mjs buildAll
  Pop-Location
}

# clean fake-home (fresh style)
$cleanPaths = @()
$cleanPaths += (Join-Path $FakeHome '.zcode')
$cleanPaths += (Join-Path $FakeHome '.harness2')
$cleanPaths += (Join-Path $DataDir '.zcode')
$cleanPaths += (Join-Path $FakeHome 'AppData\Roaming')
$cleanPaths += (Join-Path $FakeHome 'AppData\Local')
foreach ($p in $cleanPaths) {
  if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
$dirs = @()
$dirs += (Join-Path $FakeHome 'AppData\Roaming')
$dirs += (Join-Path $FakeHome 'AppData\Local')
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# seed MockProvider channel (BOM-free)
$h2 = Join-Path $FakeHome '.harness2'
if (-not (Test-Path $h2)) { New-Item -ItemType Directory -Force -Path $h2 | Out-Null }
$mockCfg = @{
  providers = @{ mock = @{ protocol = 'openai'; baseUrl = 'http://127.0.0.1:19099/v1'; models = @{ 'mock-model' = @{} } } }
  roles = @{ main = @{ channel = 'mock'; model = 'mock-model' } }
} | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $h2 'config.json'), $mockCfg, (New-Object System.Text.UTF8Encoding($false)))

$env:ZCODE_DESKTOP_HOME_DIR = $FakeHome
$env:HOME = $FakeHome
$env:USERPROFILE = $FakeHome
$env:APPDATA = Join-Path $FakeHome 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $FakeHome 'AppData\Local'
$env:HARNESS2_HOME = $FakeHome
$env:ZS1_HOST_MODULE_PATH = $AdapterHost
$env:ZCODE_DATA_BASE_DIR = $DataDir
# do not set ZS2_PROBE

Start-Process -FilePath $Electron -ArgumentList '.' -WorkingDirectory (Join-Path $ZCodeRoot 'packages\desktop') | Out-Null

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
node scripts/zs5/soak.cjs
$code = $LASTEXITCODE
Pop-Location

Kill-Scratch
Write-Host ("RUNBOOK soak exit=" + $code)
exit $code