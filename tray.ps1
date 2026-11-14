<#
  PC Live Dash - system tray app (Windows)

  Shows a tray icon with a menu and a settings window. If the dashboard
  server is not already running (for example as the Windows service), this
  script starts it and stops it again on Quit.

  LAN access and the port are changed through the server's local settings
  API. The server saves them to config.json, so they survive restarts.
  "Start with Windows" is stored in the current user's Run registry key.

  Only one tray app runs at a time. Starting it again passes the request on
  to the running one:

    -OpenDashboard   open the dashboard in the browser
    -Settings        open the settings window
    -Quit            stop the running tray app (and the server it started)
#>
param(
    [switch]$OpenDashboard,
    [switch]$Settings,
    [switch]$Quit
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Headers = @{ 'X-PC-Live-Dash' = 'tray' }
$script:ServerProcess = $null
$script:SettingsForm = $null
$script:RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunName = 'PCLiveDash'

# --- Server access ------------------------------------------------------------

function Get-ConfiguredPort {
    if ($env:PORT -match '^\d+$') { return [int]$env:PORT }
    $configPath = Join-Path $PSScriptRoot 'config.json'
    if (Test-Path $configPath) {
        try {
            $config = Get-Content $configPath -Raw | ConvertFrom-Json
            if ($config.port -is [int] -or $config.port -is [long]) { return [int]$config.port }
        } catch { }
    }
    return 3000
}

$script:Port = Get-ConfiguredPort

function Get-DashSettings([int]$Port = $script:Port) {
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/settings" -Headers $script:Headers -TimeoutSec 3
    } catch {
        return $null
    }
}

function Set-DashSettings([hashtable]$Change) {
    $body = $Change | ConvertTo-Json
    return Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/api/settings" -Method Put `
        -Headers $script:Headers -ContentType 'application/json' -Body $body -TimeoutSec 5
}

function Get-ErrorText($ErrorRecord) {
    try {
        $detail = $ErrorRecord.ErrorDetails.Message | ConvertFrom-Json
        if ($detail.error) { return $detail.error }
    } catch { }
    return $ErrorRecord.Exception.Message
}

function Start-DashServer {
    if (Get-DashSettings) { return $true }   # already running, e.g. as the service

    # An installed or downloaded copy has the server .exe next to this script.
    # A source checkout runs server.js with Node.js.
    $exe = Join-Path $PSScriptRoot 'pc-live-dash-server.exe'
    if (Test-Path $exe) {
        $script:ServerProcess = Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot `
            -WindowStyle Hidden -PassThru
    } else {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { return $false }
        $script:ServerProcess = Start-Process -FilePath $node.Source -ArgumentList 'server.js' `
            -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    }

    # The server gathers hardware details before it starts listening.
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if ($script:ServerProcess.HasExited) { return $false }
        if (Get-DashSettings) { return $true }
    }
    return $false
}

# Applies a change and waits for the server to come back on its (possibly new)
# port. Returns the settings in effect afterwards; throws with a readable message.
function Update-DashSettings([hashtable]$Change) {
    $oldPort = $script:Port
    try {
        $expected = Set-DashSettings $Change
    } catch {
        throw (Get-ErrorText $_)
    }
    $newPort = [int]$expected.port

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        $actual = Get-DashSettings -Port $newPort
        if ($actual) {
            $script:Port = $newPort
            return $actual
        }
        if ($newPort -ne $oldPort -and $i -ge 4) {
            # The server goes back to the old port when the new one is unavailable.
            $reverted = Get-DashSettings -Port $oldPort
            if ($reverted) { throw "Port $newPort could not be used. It may be taken by another program." }
        }
    }
    throw 'The server did not respond after the change.'
}

# --- Start with Windows -------------------------------------------------------

function Get-StartWithWindows {
    $value = Get-ItemProperty -Path $script:RunKey -Name $script:RunName -ErrorAction SilentlyContinue
    return [bool]$value
}

function Set-StartWithWindows([bool]$Enabled) {
    if ($Enabled) {
        $launcher = Join-Path $PSScriptRoot 'PC Live Dash.exe'
        if (Test-Path $launcher) {
            $command = "`"$launcher`""
        } else {
            $scriptPath = Join-Path $PSScriptRoot 'tray.ps1'
            $command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
        }
        Set-ItemProperty -Path $script:RunKey -Name $script:RunName -Value $command
    } else {
        Remove-ItemProperty -Path $script:RunKey -Name $script:RunName -ErrorAction SilentlyContinue
    }
}

# --- Single instance ----------------------------------------------------------

# Named objects shared by every copy of this script in the user's session.
$script:Mutex = New-Object System.Threading.Mutex($false, 'Local\PCLiveDashTray')
$script:QuitEvent = New-Object System.Threading.EventWaitHandle(
    $false, [System.Threading.EventResetMode]::ManualReset, 'Local\PCLiveDashTrayQuit')
$script:SettingsEvent = New-Object System.Threading.EventWaitHandle(
    $false, [System.Threading.EventResetMode]::AutoReset, 'Local\PCLiveDashTraySettings')

# Takes the mutex if no other tray app holds it. Waits up to $TimeoutMs.
function Enter-TrayInstance([int]$TimeoutMs = 0) {
    try {
        return $script:Mutex.WaitOne($TimeoutMs)
    } catch [System.Threading.AbandonedMutexException] {
        return $true   # the previous owner was killed; the mutex is ours now
    }
}

if ($Quit) {
    if (-not (Enter-TrayInstance)) {
        [void]$script:QuitEvent.Set()
        # Wait for the running tray app to exit. If it has not, leave the
        # request set so it still quits once it gets to it.
        if (Enter-TrayInstance 20000) { [void]$script:QuitEvent.Reset() }
    }
    exit 0
}

if (-not (Enter-TrayInstance)) {
    # Already running: hand the request to that copy and leave.
    if ($Settings) {
        [void]$script:SettingsEvent.Set()
    } elseif ($OpenDashboard) {
        Start-Process "http://localhost:$(Get-ConfiguredPort)"
    }
    exit 0
}
[void]$script:QuitEvent.Reset()

# --- Tray icon ----------------------------------------------------------------

function New-TrayIcon {
    $bitmap = New-Object System.Drawing.Bitmap 32, 32
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(10, 14, 26))
    $graphics.FillEllipse($background, 1, 1, 30, 30)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(0, 229, 255)), 3
    $graphics.DrawEllipse($pen, 3, 3, 26, 26)
    # A small activity line across the middle
    $points = @(
        (New-Object System.Drawing.Point 7, 17),
        (New-Object System.Drawing.Point 12, 17),
        (New-Object System.Drawing.Point 15, 10),
        (New-Object System.Drawing.Point 18, 22),
        (New-Object System.Drawing.Point 21, 15),
        (New-Object System.Drawing.Point 25, 15)
    )
    $graphics.DrawLines($pen, [System.Drawing.Point[]]$points)
    $graphics.Dispose()
    return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}

$script:Icon = New-TrayIcon

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $script:Icon
$notifyIcon.Text = 'PC Live Dash'
$notifyIcon.Visible = $true

function Show-Tip([string]$Text, [string]$Kind = 'Info') {
    $notifyIcon.ShowBalloonTip(5000, 'PC Live Dash', $Text, [System.Windows.Forms.ToolTipIcon]::$Kind)
}

function Open-Dashboard {
    Start-Process "http://localhost:$($script:Port)"
}

function Show-LanResult($Settings) {
    if ($Settings.lanAccess) {
        $urls = @($Settings.lanUrls)
        $address = if ($urls.Count -gt 0) { $urls[0] } else { "port $($Settings.port)" }
        Show-Tip "LAN access is on. Other devices can open $address"
    } else {
        Show-Tip 'LAN access is off. Only this PC can open the dashboard.'
    }
}

# --- Settings window ----------------------------------------------------------

function Show-SettingsWindow {
    if ($script:SettingsForm -and -not $script:SettingsForm.IsDisposed) {
        $script:SettingsForm.Activate()
        return
    }

    $settings = Get-DashSettings

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'PC Live Dash Settings'
    $form.Icon = $script:Icon
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.ClientSize = New-Object System.Drawing.Size 400, 330
    $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $form.TopMost = $true

    $networkGroup = New-Object System.Windows.Forms.GroupBox
    $networkGroup.Text = 'Network'
    $networkGroup.Location = New-Object System.Drawing.Point 12, 10
    $networkGroup.Size = New-Object System.Drawing.Size 376, 190

    $lanCheck = New-Object System.Windows.Forms.CheckBox
    $lanCheck.Text = 'Allow other devices on my network (LAN access)'
    $lanCheck.Location = New-Object System.Drawing.Point 14, 26
    $lanCheck.AutoSize = $true

    $lanNote = New-Object System.Windows.Forms.Label
    $lanNote.Location = New-Object System.Drawing.Point 32, 50
    $lanNote.Size = New-Object System.Drawing.Size 332, 52
    $lanNote.ForeColor = [System.Drawing.SystemColors]::GrayText

    $copyButton = New-Object System.Windows.Forms.Button
    $copyButton.Text = 'Copy address'
    $copyButton.Location = New-Object System.Drawing.Point 32, 104
    $copyButton.Size = New-Object System.Drawing.Size 110, 26
    $copyButton.Visible = $false

    $portLabel = New-Object System.Windows.Forms.Label
    $portLabel.Text = 'Port:'
    $portLabel.Location = New-Object System.Drawing.Point 14, 150
    $portLabel.AutoSize = $true

    $portBox = New-Object System.Windows.Forms.NumericUpDown
    $portBox.Minimum = 1024
    $portBox.Maximum = 65535
    $portBox.Location = New-Object System.Drawing.Point 56, 147
    $portBox.Size = New-Object System.Drawing.Size 80, 24

    $portNote = New-Object System.Windows.Forms.Label
    $portNote.Location = New-Object System.Drawing.Point 146, 150
    $portNote.Size = New-Object System.Drawing.Size 220, 32
    $portNote.ForeColor = [System.Drawing.SystemColors]::GrayText

    $networkGroup.Controls.AddRange(@($lanCheck, $lanNote, $copyButton, $portLabel, $portBox, $portNote))

    $startupGroup = New-Object System.Windows.Forms.GroupBox
    $startupGroup.Text = 'Startup'
    $startupGroup.Location = New-Object System.Drawing.Point 12, 208
    $startupGroup.Size = New-Object System.Drawing.Size 376, 60

    $startupCheck = New-Object System.Windows.Forms.CheckBox
    $startupCheck.Text = 'Start PC Live Dash when I sign in to Windows'
    $startupCheck.Location = New-Object System.Drawing.Point 14, 26
    $startupCheck.AutoSize = $true
    $startupCheck.Checked = Get-StartWithWindows
    $startupGroup.Controls.Add($startupCheck)

    $saveButton = New-Object System.Windows.Forms.Button
    $saveButton.Text = 'Save'
    $saveButton.Location = New-Object System.Drawing.Point 222, 288
    $saveButton.Size = New-Object System.Drawing.Size 80, 28

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = 'Cancel'
    $cancelButton.Location = New-Object System.Drawing.Point 308, 288
    $cancelButton.Size = New-Object System.Drawing.Size 80, 28

    $form.AcceptButton = $saveButton
    $form.CancelButton = $cancelButton
    $form.Controls.AddRange(@($networkGroup, $startupGroup, $saveButton, $cancelButton))

    # Fill in the current values
    if ($settings) {
        $lanCheck.Checked = [bool]$settings.lanAccess
        $lanCheck.Enabled = -not $settings.hostLocked
        $portBox.Value = [Math]::Min([Math]::Max([int]$settings.port, 1024), 65535)
        $portBox.Enabled = -not $settings.portLocked
        $portNote.Text = if ($settings.portLocked) { 'Fixed by the PORT environment variable.' } else { 'Default is 3000.' }

        $urls = @($settings.lanUrls)
        if ($settings.hostLocked) {
            $lanNote.Text = 'Fixed by the HOST environment variable.'
        } elseif ($settings.lanAccess -and $urls.Count -gt 0) {
            $lanNote.Text = "Other devices can open:`n$($urls -join "`n")"
            $copyButton.Tag = $urls[0]
            $copyButton.Visible = $true
        } else {
            $lanNote.Text = 'There is no password. Anyone on your network can see your processes and hardware details. Use a trusted network only.'
        }
    } else {
        $lanCheck.Enabled = $false
        $portBox.Enabled = $false
        $portBox.Value = [Math]::Min([Math]::Max($script:Port, 1024), 65535)
        $lanNote.Text = 'The dashboard server is not running, so network settings cannot be changed.'
    }

    # Event handlers run after this function returns, so they reach the
    # controls through a script-level table instead of local variables.
    $script:Ui = @{
        form = $form; lanCheck = $lanCheck; copyButton = $copyButton
        portBox = $portBox; startupCheck = $startupCheck; settings = $settings
    }

    $copyButton.add_Click({
        if ($script:Ui.copyButton.Tag) { [System.Windows.Forms.Clipboard]::SetText([string]$script:Ui.copyButton.Tag) }
    })

    $cancelButton.add_Click({ $script:Ui.form.Close() })

    $saveButton.add_Click({
        try {
            Set-StartWithWindows $script:Ui.startupCheck.Checked

            if ($script:Ui.settings) {
                $change = @{}
                if ($script:Ui.lanCheck.Enabled -and $script:Ui.lanCheck.Checked -ne [bool]$script:Ui.settings.lanAccess) {
                    $change.lanAccess = [bool]$script:Ui.lanCheck.Checked
                }
                if ($script:Ui.portBox.Enabled -and [int]$script:Ui.portBox.Value -ne [int]$script:Ui.settings.port) {
                    $change.port = [int]$script:Ui.portBox.Value
                }
                if ($change.Count -gt 0) {
                    $script:Ui.form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
                    $result = Update-DashSettings $change
                    if ($change.ContainsKey('lanAccess')) { Show-LanResult $result }
                    elseif ($change.ContainsKey('port')) { Show-Tip "The dashboard is now on port $($result.port)." }
                }
            }
            $script:Ui.form.Close()
        } catch {
            $script:Ui.form.Cursor = [System.Windows.Forms.Cursors]::Default
            [void][System.Windows.Forms.MessageBox]::Show($script:Ui.form, [string]$_.Exception.Message, 'PC Live Dash',
                [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
        }
    })

    $script:SettingsForm = $form
    $form.Show()
    $form.Activate()
}

# --- Tray menu ----------------------------------------------------------------

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Open Dashboard'
$openItem.Font = New-Object System.Drawing.Font ($openItem.Font, [System.Drawing.FontStyle]::Bold)
$settingsItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Settings...'
$lanItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Allow LAN access'
$lanUrlItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Copy LAN address'
$lanUrlItem.Visible = $false
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Quit'

[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($settingsItem)
[void]$menu.Items.Add($lanItem)
[void]$menu.Items.Add($lanUrlItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($quitItem)
$notifyIcon.ContextMenuStrip = $menu

function Update-Menu {
    $settings = Get-DashSettings
    if (-not $settings) {
        $lanItem.Text = 'Allow LAN access (server not running)'
        $lanItem.Enabled = $false
        $lanItem.Checked = $false
        $lanUrlItem.Visible = $false
        return
    }

    $lanItem.Checked = [bool]$settings.lanAccess
    if ($settings.hostLocked) {
        $lanItem.Text = 'Allow LAN access (fixed by HOST variable)'
        $lanItem.Enabled = $false
    } else {
        $lanItem.Text = 'Allow LAN access'
        $lanItem.Enabled = $true
    }

    $urls = @($settings.lanUrls)
    if ($settings.lanAccess -and $urls.Count -gt 0) {
        $lanUrlItem.Text = "Copy LAN address: $($urls[0])"
        $lanUrlItem.Tag = $urls[0]
        $lanUrlItem.Visible = $true
    } else {
        $lanUrlItem.Visible = $false
    }
}

$openItem.add_Click({ Open-Dashboard })
$notifyIcon.add_MouseDoubleClick({ Open-Dashboard })
$settingsItem.add_Click({ Show-SettingsWindow })
$menu.add_Opening({ Update-Menu })

$lanItem.add_Click({
    try {
        $result = Update-DashSettings @{ lanAccess = (-not $lanItem.Checked) }
        Show-LanResult $result
    } catch {
        Show-Tip "Could not change LAN access: $($_.Exception.Message)" 'Error'
    }
})

$lanUrlItem.add_Click({
    if ($lanUrlItem.Tag) {
        [System.Windows.Forms.Clipboard]::SetText([string]$lanUrlItem.Tag)
        Show-Tip 'LAN address copied.'
    }
})

$quitItem.add_Click({
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# Requests from other copies of this script (see "Single instance").
$signalTimer = New-Object System.Windows.Forms.Timer
$signalTimer.Interval = 500
$signalTimer.add_Tick({
    if ($script:QuitEvent.WaitOne(0)) {
        $signalTimer.Stop()
        $notifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
        return
    }
    if ($script:SettingsEvent.WaitOne(0)) { Show-SettingsWindow }
})

# --- Start --------------------------------------------------------------------

$script:LogPath = Join-Path $env:TEMP 'pc-live-dash-tray.log'

try {
    if (Start-DashServer) {
        $running = Get-DashSettings
        if ($running -and $running.version) { $notifyIcon.Text = "PC Live Dash v$($running.version)" }
        if ($OpenDashboard) { Open-Dashboard }
    } else {
        Show-Tip 'The dashboard server did not start. From a source checkout, check that Node.js is installed and npm install has been run.' 'Error'
    }
    if ($Settings) { Show-SettingsWindow }

    $signalTimer.Start()
    [System.Windows.Forms.Application]::Run()
} catch {
    "$(Get-Date -Format s) $($_ | Out-String)`n$($_.ScriptStackTrace)" | Add-Content -Path $script:LogPath
    throw
} finally {
    $signalTimer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    if ($script:ServerProcess -and -not $script:ServerProcess.HasExited) {
        Stop-Process -Id $script:ServerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    try { $script:Mutex.ReleaseMutex() } catch { }
}
