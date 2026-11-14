; PC Live Dash - Windows installer (Inno Setup 6)
;
; Build from the project root, after dist\ holds the server and launcher:
;   ISCC /DAppVersion=2.2.0 installer\pc-live-dash.iss
;
; Installs for the current user only, so no administrator prompt is needed
; and the app can save its settings (config.json) in its own folder.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "PC Live Dash"
#define LauncherExe "PC Live Dash.exe"
#define ServerExe "pc-live-dash-server.exe"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"
#define RunValue "PCLiveDash"

[Setup]
AppId={{3A3A5E7F-367D-48D4-B5B6-6F30E37F254A}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=harikiran-lab
AppPublisherURL=https://github.com/harikiran-lab/PC-Live-Dash
AppSupportURL=https://github.com/harikiran-lab/PC-Live-Dash/issues
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\release
OutputBaseFilename=PC-Live-Dash-Setup-v{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#LauncherExe}
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startup"; Description: "Start {#AppName} in the background when I sign in to Windows"; GroupDescription: "Startup:"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\{#LauncherExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\{#ServerExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#LauncherExe}"; Parameters: "--open"; Comment: "Start {#AppName} and open the dashboard"
Name: "{autoprograms}\{#AppName} Settings"; Filename: "{app}\{#LauncherExe}"; Parameters: "--settings"; Comment: "Open {#AppName} settings"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#LauncherExe}"; Parameters: "--open"; Tasks: desktopicon

[Registry]
; The same value the tray app's "Start with Windows" setting uses.
Root: HKCU; Subkey: "{#RunKey}"; ValueType: string; ValueName: "{#RunValue}"; ValueData: """{app}\{#LauncherExe}"""; Tasks: startup

[Run]
Filename: "{app}\{#LauncherExe}"; Parameters: "--open"; Description: "Start {#AppName} and open the dashboard"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\config.json.tmp"

[Code]
// Stops a running tray app and server so their files can be replaced or removed.
procedure StopRunningApp();
var
  ResultCode: Integer;
  TrayScript: String;
begin
  TrayScript := ExpandConstant('{app}\tray.ps1');
  if FileExists(TrayScript) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' + TrayScript + '" -Quit',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#ServerExe}',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningApp();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningApp();
    // Remove the sign-in entry whether the installer or the tray app set it.
    RegDeleteValue(HKEY_CURRENT_USER, '{#RunKey}', '{#RunValue}');
  end;
end;
