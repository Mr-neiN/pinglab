; PingLab installer - per-user, no administrator rights needed to install.
; Build with: installer\build.ps1 [-Version 1.0.0]
;
; The version comes from version.iss, which build.ps1 generates, because Inno Setup 6
; and 7 disagree on how to pass defines on the command line.
;
; The app itself asks Windows for administrator approval when it changes a setting;
; installing it never does.

#define AppName "PingLab"
#define AppPublisher "Mr-neiN"
#define AppUrl "https://github.com/Mr-neiN/pinglab"
#include "version.iss"

[Setup]
AppId={{4C0E9E1A-2C63-4B7B-9E49-0E7B2F6C51D8}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} installer
DefaultDirName={localappdata}\Programs\PingLab
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
OutputDir=..\dist
OutputBaseFilename=PingLab-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=pinglab.ico
UninstallDisplayIcon={app}\pinglab.ico
UninstallDisplayName={#AppName} {#AppVersion}
CloseApplications=no
RestartApplications=no
UsePreviousAppDir=yes
AllowNoIcons=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "..\pinglab.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\server.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PingLab.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\gui\*.ps1"; DestDir: "{app}\gui"; Flags: ignoreversion
Source: "..\PingLab.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PingLab-TUI.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\lib\*.mjs"; DestDir: "{app}\lib"; Flags: ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs
Source: "pinglab.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\PingLab.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\pinglab.ico"; Comment: "Network doctor: measure, then change one setting at a time"
Name: "{userprograms}\{#AppName} terminal"; Filename: "{cmd}"; Parameters: "/c ""{app}\PingLab-TUI.cmd"""; WorkingDir: "{app}"; IconFilename: "{app}\pinglab.ico"; Comment: "The same app in a terminal window"
Name: "{userdesktop}\{#AppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\PingLab.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\pinglab.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\PingLab.cmd"; Description: "Start {#AppName} now"; Flags: postinstall nowait skipifsilent unchecked

[Code]
{ PingLab runs on Node.js 22 or newer. Refuse to install onto a machine that cannot run it,
  and say where to get Node instead of letting the shortcuts fail later. }
function GetNodeVersion(): String;
var
  ResultCode: Integer;
  TempFile: String;
  Lines: TArrayOfString;
begin
  Result := '';
  TempFile := ExpandConstant('{tmp}\pinglab-node-version.txt');
  if Exec(ExpandConstant('{cmd}'), '/c node --version > "' + TempFile + '" 2>nul', '',
          SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if (ResultCode = 0) and FileExists(TempFile) then
    begin
      if LoadStringsFromFile(TempFile, Lines) and (GetArrayLength(Lines) > 0) then
        Result := Trim(Lines[0]);
    end;
  end;
  DeleteFile(TempFile);
end;

function NodeMajor(const Version: String): Integer;
var
  Text: String;
  Dot: Integer;
begin
  Text := Version;
  if (Length(Text) > 0) and ((Text[1] = 'v') or (Text[1] = 'V')) then
    Delete(Text, 1, 1);
  Dot := Pos('.', Text);
  if Dot > 0 then
    Text := Copy(Text, 1, Dot - 1);
  Result := StrToIntDef(Text, 0);
end;

function InitializeSetup(): Boolean;
var
  Version: String;
  ErrorCode: Integer;
begin
  Result := True;
  Version := GetNodeVersion();
  if Version = '' then
  begin
    if MsgBox('PingLab needs Node.js 22 or newer, and "node" was not found on PATH.' + #13#10 + #13#10 +
              'Install Node.js 22 LTS (or newer), then run this installer again.' + #13#10 + #13#10 +
              'Open the Node.js download page now?',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://nodejs.org/en/download', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    Result := False;
    Exit;
  end;
  if NodeMajor(Version) < 22 then
  begin
    MsgBox('PingLab needs Node.js 22 or newer; this machine has ' + Version + '.' + #13#10 + #13#10 +
           'Update Node.js, then run this installer again.', mbCriticalError, MB_OK);
    Result := False;
  end;
end;
