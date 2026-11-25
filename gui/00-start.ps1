# PingLab - desktop GUI (WinForms, no dependencies, no browser).
# It talks to `node pinglab.mjs --bridge` over stdin/stdout with one JSON object per line.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# The same rule as lib\paths.mjs: an installed copy keeps its data in a per-user folder,
# never inside the program folder, so an uninstall can remove the latter and an upgrade
# replaces none of the former.
$script:dataDir = if ($env:PINGLAB_DATA_DIR) { $env:PINGLAB_DATA_DIR }
    elseif (Test-Path (Join-Path $root '.git')) { Join-Path $root 'data' }
    elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'PingLab' }
    else { Join-Path $root 'data' }
try { New-Item -ItemType Directory -Force -Path $script:dataDir | Out-Null } catch { }

$script:logFile = Join-Path $script:dataDir 'gui.log'
function Log([string]$m) {
    try { Add-Content -Path $script:logFile -Value ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}
Log 'script start'

trap {
    Log ('TRAP: ' + ($_ | Out-String))
    [void][System.Windows.Forms.MessageBox]::Show(($_ | Out-String), 'PingLab failed to start', 'OK', 'Error')
    break
}

$ErrorActionPreference = 'Stop'

$script:inv = [System.Globalization.CultureInfo]::InvariantCulture

function N($v, [int]$d = 1) {
    if ($null -eq $v) { return '-' }
    $fmt = '{0:0' + ('.' + ('0' * $d)) + '}'
    return [string]::Format($script:inv, $fmt, [double]$v)
}

# ------------------------------------------------------------------ process

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
# Each launch owns its response file, so a second bridge (a scripted client, say) can
# never truncate the file this window is polling.
$script:outFile = Join-Path $script:dataDir ('bridge-out.' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '.jsonl')
$psi.Arguments = '"' + (Join-Path $root 'pinglab.mjs') + '" --bridge --out "' + $script:outFile + '"'
$psi.WorkingDirectory = $root
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$script:proc = New-Object System.Diagnostics.Process
$script:proc.StartInfo = $psi

