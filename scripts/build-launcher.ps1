<#
  Builds dist\PC Live Dash.exe, the windowless launcher for the tray app,
  using the C# compiler that ships with Windows. Run from the project root:

    powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$out = Join-Path $dist 'PC Live Dash.exe'

& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    "/win32icon:$(Join-Path $root 'assets\icon.ico')" `
    "/out:$out" `
    /reference:System.Windows.Forms.dll `
    (Join-Path $root 'launcher\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed with exit code $LASTEXITCODE" }

Write-Host "Built $out"
