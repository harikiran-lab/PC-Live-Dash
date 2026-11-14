<#
  End-to-end test of the Windows installer, used by the Build workflow.

    pwsh scripts\test-installer.ps1 -Setup release\PC-Live-Dash-Setup-v2.2.0.exe

  Installs silently, starts the app through its launcher, checks that the
  dashboard works, quits it, and uninstalls. Fails on the first problem.
  It installs and removes PC Live Dash for the current user, so do not run it
  on a PC where you use the installed app.
#>
param([Parameter(Mandatory = $true)][string]$Setup)

$ErrorActionPreference = 'Stop'
$appDir = Join-Path $env:LOCALAPPDATA 'Programs\PC Live Dash'
$launcher = Join-Path $appDir 'PC Live Dash.exe'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$trayLog = Join-Path $env:TEMP 'pc-live-dash-tray.log'

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw "FAILED: $Message" }
    Write-Host "ok  $Message"
}

function Wait-Until([scriptblock]$Test, [int]$Seconds) {
    for ($i = 0; $i -lt $Seconds * 2; $i++) {
        if (& $Test) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-TrayProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.CommandLine -notlike '*-Quit*' }
}

Remove-Item $trayLog -ErrorAction SilentlyContinue

# --- Install ------------------------------------------------------------------
$install = Start-Process -FilePath $Setup -Wait -PassThru -ArgumentList `
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=startup', "/LOG=$PWD\install.log"
Assert ($install.ExitCode -eq 0) "installer exits with code 0 (got $($install.ExitCode))"

foreach ($file in 'PC Live Dash.exe', 'pc-live-dash-server.exe', 'tray.ps1', 'unins000.exe') {
    Assert (Test-Path (Join-Path $appDir $file)) "$file is installed in $appDir"
}
Assert (Test-Path (Join-Path $startMenu 'PC Live Dash.lnk')) 'Start menu shortcut exists'
Assert (Test-Path (Join-Path $startMenu 'PC Live Dash Settings.lnk')) 'Start menu settings shortcut exists'
$runValue = (Get-ItemProperty -Path $runKey -Name 'PCLiveDash' -ErrorAction SilentlyContinue).PCLiveDash
Assert ($runValue -like '*PC Live Dash.exe*') "start-at-sign-in entry points at the launcher ($runValue)"

try {
    # --- Run --------------------------------------------------------------------
    Start-Process -FilePath $launcher
    node scripts/smoke-test.js 3000
    Assert ($LASTEXITCODE -eq 0) 'dashboard works when started through the launcher'

    Assert ([bool](Get-TrayProcess)) 'tray app process is running'
    Assert ([bool](Get-Process 'pc-live-dash-server' -ErrorAction SilentlyContinue)) 'server process is running'
    $visible = Get-Process 'pc-live-dash-server', 'powershell' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }
    Assert (-not $visible) 'no console window is shown'

    # A second start must hand over to the running copy, not start another.
    Start-Process -FilePath $launcher -Wait
    Start-Sleep -Seconds 3
    Assert (@(Get-TrayProcess).Count -eq 1) 'a second launch does not start a second tray app'

    # Opening settings in the running copy must not crash it.
    Start-Process -FilePath $launcher -ArgumentList '--settings' -Wait
    Start-Sleep -Seconds 3
    Assert ([bool](Get-TrayProcess)) 'tray app survives opening the settings window'

    # --- Quit -------------------------------------------------------------------
    Start-Process -FilePath $launcher -ArgumentList '--quit' -Wait
    $stopped = Wait-Until { -not (Get-Process 'pc-live-dash-server' -ErrorAction SilentlyContinue) -and -not (Get-TrayProcess) } 30
    Assert $stopped 'quit stops the tray app and the server'
} finally {
    if (Test-Path $trayLog) {
        Write-Host '--- tray error log ---'
        Get-Content $trayLog
    }
}
Assert (-not (Test-Path $trayLog)) 'tray app logged no errors'

# --- Uninstall while running ----------------------------------------------------
Start-Process -FilePath $launcher
Assert (Wait-Until { [bool](Get-Process 'pc-live-dash-server' -ErrorAction SilentlyContinue) } 60) 'app starts again before uninstall'

Start-Process -FilePath (Join-Path $appDir 'unins000.exe') -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'
Assert (Wait-Until { -not (Test-Path $appDir) } 60) 'uninstall removes the install folder'
Assert (-not (Get-Process 'pc-live-dash-server' -ErrorAction SilentlyContinue)) 'uninstall stops the server'
Assert (-not (Test-Path (Join-Path $startMenu 'PC Live Dash.lnk'))) 'uninstall removes the Start menu shortcut'
$left = Get-ItemProperty -Path $runKey -Name 'PCLiveDash' -ErrorAction SilentlyContinue
Assert (-not $left) 'uninstall removes the start-at-sign-in entry'

Write-Host "`nInstaller test passed."
