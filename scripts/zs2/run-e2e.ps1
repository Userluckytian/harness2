param([switch]$Fresh)

$ErrorActionPreference = 'Stop'

$HarnessRoot = 'D:/AI_Projects/harness2'
$Zs1Build   = 'D:/AI_Projects/harness2-zs1-build'
$ZCodeRoot  = Join-Path $Zs1Build 'ZCode'
$FakeHome   = Join-Path $Zs1Build 'fake-home'
$AdapterDist = Join-Path $HarnessRoot 'packages/zcode-adapter/dist/host-entry.cjs'

function Kill-Targets {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ForEach-Object {
    $cl = $_.CommandLine
    if ($cl -like '*harness2*' -or $cl -like '*dev-desktop*' -or $cl -like '*ZCode*' -or $cl -like '*harness2-zs1-build*') {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $cl = $_.CommandLine
    if ($cl -like '*dev-desktop-env*') {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

Kill-Targets
Start-Sleep -Seconds 3

try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9229/json/list' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
  Write-Host 'PORT 9229 still in use, aborting'
  exit 2
} catch {
  Write-Host 'PORT 9229 free'
}

if (-not (Test-Path $AdapterDist)) {
  Write-Host 'building zcode-adapter...'
  Push-Location (Join-Path $HarnessRoot 'packages/zcode-adapter')
  node scripts/zs1-guard.mjs buildAll
  Pop-Location
}

if ($Fresh) {
  foreach ($sub in @('.zcode','.harness2')) {
    $p = Join-Path $FakeHome $sub
    if (Test-Path $p) {
      try { Remove-Item -Recurse -Force $p -ErrorAction Stop } catch { }
    }
  }
  if (-not (Test-Path $FakeHome)) { New-Item -ItemType Directory -Force -Path $FakeHome | Out-Null }
  if (-not (Test-Path (Join-Path $FakeHome 'AppData/Roaming'))) { New-Item -ItemType Directory -Force -Path (Join-Path $FakeHome 'AppData/Roaming') | Out-Null }
  if (-not (Test-Path (Join-Path $FakeHome 'AppData/Local'))) { New-Item -ItemType Directory -Force -Path (Join-Path $FakeHome 'AppData/Local') | Out-Null }
}

$env:ZCODE_DESKTOP_HOME_DIR = $FakeHome
$env:HOME = $FakeHome
$env:USERPROFILE = $FakeHome
$env:APPDATA = Join-Path $FakeHome 'AppData/Roaming'
$env:LOCALAPPDATA = Join-Path $FakeHome 'AppData/Local'
$env:HARNESS2_HOME = 'C:/Users/ASUS'
$env:ZS1_HOST_MODULE_PATH = $AdapterDist
$env:ZCODE_DATA_BASE_DIR = Join-Path $Zs1Build 'zs1-data'
$env:ZS2_PROBE = '1'
$env:PNPM_HOME = 'D:/Programs/nodejs'
$env:PATH = 'D:/Programs/nodejs;' + $env:PATH

$log = Join-Path $Zs1Build 'zs2-runbook.log'
$err = Join-Path $Zs1Build 'zs2-runbook.err'
$proc = Start-Process -FilePath 'node' -ArgumentList 'scripts/dev-desktop-env.mjs','test' -WorkingDirectory $ZCodeRoot -RedirectStandardOutput $log -RedirectStandardError $err -PassThru

Start-Sleep -Seconds 90

Push-Location $HarnessRoot
node scripts/zs2/e2e-round.cjs
$exitCode = $LASTEXITCODE
Pop-Location

Kill-Targets

exit $exitCode
