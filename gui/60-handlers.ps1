# ------------------------------------------------------------------- handlers

$btnRefresh.Add_Click({ Refresh-State })

$cmbAdapter.Add_SelectedIndexChanged({
    if ($script:fillingAdapter) { return }
    $i = $cmbAdapter.SelectedIndex
    if ($i -lt 0 -or $i -ge $script:adapterItems.Count) { return }
    Set-TargetAdapter $script:adapterItems[$i].alias
})

# Revealing virtual adapters never changes the target: it only offers them.
$chkVirtual.Add_CheckedChanged({
    $script:showVirtual = [bool]$chkVirtual.Checked
    Set-AdapterPickerItems
})
$btnPlan = $rowPlan.Button
$btnNic = $rowNic.Button
$btnNagle = $rowNagle.Button
$btnWifi = $rowWifi.Button
$btnOrder = $rowOrder.Button

$btnPlan.Add_Click({
    $action = if ($null -ne $script:lastTweak -and $script:lastTweak.planPower -eq 'off') { 'plan-power-on' } else { 'plan-power-off' }
    Send-Tweak $action
})
$btnNic.Add_Click({
    $action = if ($null -ne $script:lastTweak -and $script:lastTweak.nicPower -eq 'off') { 'nic-power-on' } else { 'nic-power-off' }
    Send-Tweak $action
})
$btnNagle.Add_Click({
    $action = if ($null -ne $script:lastTweak -and $script:lastTweak.nagleDisabled) { 'nagle-on' } else { 'nagle-off' }
    Send-Tweak $action
})
$btnWifi.Add_Click({
    $needsFix = $null -ne $script:lastTweak -and $null -ne $script:lastTweak.adapterTuning -and $script:lastTweak.adapterTuning.needsFix
    $action = if ($needsFix) { 'adapter-tuning-off' } else { 'adapter-tuning-on' }
    Send-Tweak $action
})
$btnOrder.Add_Click({
    $wo = $null
    if ($null -ne $script:lastTweak) { $wo = $script:lastTweak.wifiOrder }
    $revert = $null -ne $wo -and $wo.isFirst -and $wo.appliedByUs
    Send-Tweak $(if ($revert) { 'wifi-order-restore' } else { 'wifi-order-first' })
})

$btnDnsBench = $rowDns.Button
$btnDnsAuto = $rowDns.Button2

$btnDnsBench.Add_Click({ Invoke-DnsBenchmark })
$btnDnsAuto.Add_Click({ Send-Tweak 'dns-reset' })
$btnDnsRun.Add_Click({ Invoke-DnsBenchmark })
$btnDnsUse.Add_Click({ Send-Tweak 'dns-best' })
$btnDnsAutomatic.Add_Click({ Send-Tweak 'dns-reset' })

$btnPresetSafe.Add_Click({ Send-Tweak '' 'safe' })
$btnPresetLatency.Add_Click({ Send-Tweak '' 'latency' })

$btnRestore.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show('Restore every setting PingLab changed back to how it was?', 'PingLab', 'YesNo', 'Question')
    if ($answer -eq 'Yes') { Send-Tweak 'restore-all' }
})

$btnScan.Add_Click({
    Set-Status 'Scanning Wi-Fi...' 'info'
    $btnScan.Enabled = $false
    Send-Cmd 'wifi' @{} {
        param($r)
        $btnScan.Enabled = $true
        if (-not $r.ok) { Set-Status ('Scan failed: ' + $r.error) 'bad'; return }
        Update-Wifi $r.data
        $n = if ($null -ne $r.data.scan -and $r.data.scan.ok) { $r.data.scan.networks.Count } else { 0 }
        Set-Status ("Scan done - $n networks visible.") 'good'
        Log ("wifi rendered: {0} networks, {1} advice lines" -f $n, $r.data.advice.Count)
    }
})

$btnProbe.Add_Click({
    Set-Status 'Measuring latency - this takes a few seconds...' 'info'
    $btnProbe.Enabled = $false
    Send-Cmd 'probe' @{} {
        param($r)
        $btnProbe.Enabled = $true
        if (-not $r.ok) { Set-Status ('Latency test failed: ' + $r.error) 'bad'; return }
        Update-Probe $r.data.probe
        Set-Status ("Latency test done - game avg {0} ms." -f (N $r.data.probe.summary.gameAvgMs)) 'good'
    }
})

$btnBloat.Add_Click({
    Set-Status 'Loading the line with downloads, then uploads - about 15 seconds...' 'info'
    $btnBloat.Enabled = $false
    Send-Cmd 'bloat' @{ seconds = 6 } {
        param($r)
        $btnBloat.Enabled = $true
        if (-not $r.ok) { Set-Status ('Bufferbloat test failed: ' + $r.error) 'bad'; return }
        Update-Bloat $r.data.bloat
        if ($r.data.bloat.overallGrade -eq 'n/a') { Set-Status ('Bufferbloat not measurable: ' + $r.data.verdict) 'warn' }
        else { Set-Status ("Bufferbloat done - worst direction grade {0}." -f $r.data.bloat.overallGrade) 'good' }
        Refresh-State
    }
})

$btnSoakStart.Add_Click({
    $minutes = [int]$numMinutes.Value
    Set-Status "Starting a $minutes minute soak..." 'info'
    Send-Cmd 'soakStart' @{ minutes = $minutes } {
        param($r)
        if (-not $r.ok) { Set-Status ('Could not start the soak: ' + $r.error) 'bad'; return }
        Update-SoakProgress $r.data.soak
        Set-Status "Soak running - $minutes min. Samples are written to the database as they arrive." 'good'
    }
})

$btnSoakStop.Add_Click({
    Send-Cmd 'soakStop' @{} {
        param($r)
        if (-not $r.ok) { Set-Status ('Error: ' + $r.error) 'bad'; return }
        Set-Status 'Stopping the soak - the summary is being written.' 'warn'
    }
})

