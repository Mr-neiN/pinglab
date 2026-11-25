# PingLab - desktop GUI entry point.
#
# The window is built by the modules below, loaded in this order. Each file owns one theme,
# so the DNS tab, the restore-point list or one handler has a single place to change; this
# entry point is the only code that runs after all of them are loaded.
$root = $PSScriptRoot
. (Join-Path $root 'gui\00-start.ps1')
. (Join-Path $root 'gui\10-widgets.ps1')
. (Join-Path $root 'gui\20-bridge.ps1')
. (Join-Path $root 'gui\30-tabs-fixes.ps1')
. (Join-Path $root 'gui\31-tabs-adapter.ps1')
. (Join-Path $root 'gui\32-tabs-tools.ps1')
. (Join-Path $root 'gui\40-state.ps1')
. (Join-Path $root 'gui\41-diagnostics.ps1')
. (Join-Path $root 'gui\50-commands.ps1')
. (Join-Path $root 'gui\60-handlers.ps1')
. (Join-Path $root 'gui\70-timer.ps1')
. (Join-Path $root 'gui\80-selftest.ps1')

# --- entry point
# ------------------------------------------------------------------- startup

$started = $false
try {
    $script:proc.Start() | Out-Null
    $started = $true
    Log ('engine started, pid ' + $script:proc.Id)
} catch {
    Log ('ENGINE START FAILED: ' + $_.Exception.Message)
    Set-Status ('Could not start the engine: ' + $_.Exception.Message) 'bad'
}

if ($started) {
    $timer.Start()
    Set-Status 'Reading system state...' 'info'
    $script:startupPending = $true
    $script:startupProblem = $false
    $script:benchSeen = $false
    $script:updateSeen = $false
    Refresh-State
    Send-Cmd 'soakStatus' @{} {
        param($r)
        if (-not $r.ok) { return }
        Update-SoakProgress $r.data.soak
        if (-not $r.data.soak.running -and $null -ne $r.data.summary) { Update-SoakSummary $r.data.summary }
    }
}

if ($env:PINGLAB_GUI_DNSTEST) {
    if (-not $started) {
        Write-Output 'GUIDNSTEST {"ok":false,"detail":"the engine did not start"}'
        exit 1
    }
    $dnsCheck = Invoke-GuiDnsSelfTest
    $outPath = Join-Path $script:dataDir 'gui-dns-selftest.json'
    $json = $dnsCheck | ConvertTo-Json -Compress -Depth 6
    [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ('GUIDNSTEST ' + $outPath)
    $failed = @($dnsCheck.checks.Values | Where-Object { -not $_.ok })
    Stop-Engine
    exit $(if ($failed.Count -gt 0) { 1 } else { 0 })
}

if ($env:PINGLAB_GUI_SELFTEST) {
    if (-not $started) {
        Write-Output 'GUISELFTEST {"state":{"ok":false,"detail":"the engine did not start"}}'
        exit 1
    }
    $checks = Invoke-GuiAdapterSelfTest
    # Written as UTF-8 to a file: the console code page would turn the curly quotes in a note
    # into something a JSON parser refuses, and the note is part of what is verified.
    $outPath = Join-Path $script:dataDir 'gui-adapter-selftest.json'
    $json = $checks | ConvertTo-Json -Compress -Depth 5
    [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ('GUISELFTEST ' + $outPath)
    $failed = @($checks.Values | Where-Object { -not $_.ok })
    Stop-Engine
    exit $(if ($failed.Count -gt 0) { 1 } else { 0 })
}

[void]$form.Show()
[void]$form.Refresh()

while ($form.Visible) {
    [System.Windows.Forms.Application]::DoEvents()
    Poll-Bridge
    Start-Sleep -Milliseconds 40
}

Stop-Engine
Log 'script end'
