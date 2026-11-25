# ---------------------------------------------------------------------- timer

$script:tick = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    Poll-Bridge
    $script:tick++
    if ($script:soakRunning) {
        Send-Cmd 'soakStatus' @{} {
            param($r)
            if (-not $r.ok) { return }
            Update-SoakProgress $r.data.soak
            if (-not $r.data.soak.running -and $null -ne $r.data.summary) {
                Update-SoakSummary $r.data.summary
                Set-Status ("Soak finished - {0} samples." -f $r.data.summary.samples) 'good'
                Refresh-State
            }
        }
    } elseif (($script:tick % 20) -eq 0 -and $script:inflight -eq 0) {
        Refresh-State
    }
})

$form.Add_FormClosing({
    $timer.Stop()
})

function Stop-Engine {
    $timer.Stop()
    try {
        if (-not $script:proc.HasExited) {
            $script:proc.Kill()
            # Wait for the engine to let go of the response file, or the delete below fails
            # with a sharing violation on Windows.
            [void]$script:proc.WaitForExit(3000)
        }
    } catch { }
    for ($i = 0; $i -lt 5; $i++) {
        if (-not (Test-Path $script:outFile)) { break }
        try { Remove-Item -LiteralPath $script:outFile -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 200 }
    }
}

