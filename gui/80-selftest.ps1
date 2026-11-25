# ------------------------------------------------- headless adapter self-test
# The shipped window built but not shown, driven against the real bridge and fake Windows by
# lib/gui-adapter.test.mjs. Every step goes through the control or handler a click would use,
# so the picker, the rows and the restore-point list are exercised, not a copy of their logic.
function Wait-Gui([scriptblock]$cond, [int]$timeoutMs = 30000) {
    $until = (Get-Date).AddMilliseconds($timeoutMs)
    while ($true) {
        Poll-Bridge
        [System.Windows.Forms.Application]::DoEvents()
        if (& $cond) { return $true }
        if ((Get-Date) -gt $until) { return $false }
        Start-Sleep -Milliseconds 40
    }
}

function Invoke-GuiAdapterSelfTest {
    $checks = [ordered]@{}
    function Note([string]$name, [bool]$ok, [string]$detail) {
        $checks[$name] = [pscustomobject]@{ ok = $ok; detail = $detail }
    }

    if (-not (Wait-Gui { $null -ne $script:adapterChoices -and @($script:adapterChoices).Count -gt 0 })) {
        Note 'state' $false 'the bridge never delivered state'
        return $checks
    }

    $aliases = @($script:adapterItems | ForEach-Object { $_.alias })
    $virtual = @($script:adapterChoices | Where-Object { $_.virtual } | ForEach-Object { $_.alias })
    $note = [string]$lblAdapterNote.Text
    $shown = if ($cmbAdapter.SelectedIndex -ge 0) { $script:adapterItems[$cmbAdapter.SelectedIndex].alias } else { '' }
    Note 'preselected' (([string]$script:targetAlias -eq 'WLAN') -and ($shown -eq 'WLAN')) ("target=$($script:targetAlias) shown=$shown")
    Note 'physical-only' (($aliases -notcontains 'Tailscale') -and $virtual.Count -gt 0) ("shown=$($aliases -join ',') virtual=$($virtual -join ',')")
    Note 'vpn-note' (($note -match 'virtual adapter') -and ($note -match 'WLAN')) $note

    # Ticking the box reveals the VPN adapter without moving the target.
    $chkVirtual.Checked = $true
    $revealed = @($script:adapterItems | ForEach-Object { $_.alias })
    $still = if ($cmbAdapter.SelectedIndex -ge 0) { $script:adapterItems[$cmbAdapter.SelectedIndex].alias } else { '' }
    Note 'revealed' (($revealed -contains 'Tailscale') -and ($still -eq 'WLAN')) ("shown=$($revealed -join ',') shown-selected=$still")

    # Choosing from the picker goes through the same handler a click does.
    $index = -1
    for ($i = 0; $i -lt $script:adapterItems.Count; $i++) {
        if ($script:adapterItems[$i].alias -eq 'Ethernet 2') { $index = $i; break }
    }
    if ($index -lt 0) {
        Note 'switch' $false 'Ethernet 2 is not offered'
        return $checks
    }
    $cmbAdapter.SelectedIndex = $index
    $switched = Wait-Gui { ([string]$script:targetAlias -eq 'Ethernet 2') -and ($null -ne $script:lastTweak) -and ([string]$script:lastTweak.alias -eq 'Ethernet 2') }
    $saved = ''
    try { $saved = [string](Get-Content (Join-Path $script:dataDir 'config.json') -Raw | ConvertFrom-Json).adapter } catch { }
    Note 'switch-persisted' ($switched -and ($saved -eq 'Ethernet 2')) ("target=$($script:targetAlias) saved=$saved")

    # An apply names the chosen adapter, and the restore point it lands says so too. The power
    # plan is the row the fake Windows records a write for, so the read-back can agree.
    Send-Tweak 'plan-power-off'
    $landed = Wait-Gui { @($lvRestore.Items | Where-Object { $_.Text -like 'Wireless*' }).Count -gt 0 }
    $restoreRow = @($lvRestore.Items | Where-Object { $_.Text -like 'Wireless*' } | Select-Object -First 1)
    $restoreAlias = if ($restoreRow.Count -eq 1) { [string]$restoreRow[0].SubItems[1].Text } else { '' }
    $planOff = ($null -ne $script:lastTweak) -and ([string]$script:lastTweak.planPower -eq 'off')
    Note 'apply-chosen-adapter' ($landed -and ($restoreAlias -eq 'Ethernet 2') -and $planOff) ("restore=$restoreAlias plan=$($script:lastTweak.planPower) status=$($lblStatus.Text)")
    Note 'rows-named' ([string]$rowPlan.Hint.Text -match 'Ethernet 2') ([string]$rowPlan.Hint.Text)

    # A name the machine does not have is refused and changes nothing.
    $before = ''
    try { $before = [string](Get-Content (Join-Path $script:dataDir 'config.json') -Raw | ConvertFrom-Json).adapter } catch { }
    Set-TargetAdapter 'Nope 0'
    $refused = Wait-Gui { [string]$lblStatus.Text -like 'Adapter not changed:*' }
    $after = ''
    try { $after = [string](Get-Content (Join-Path $script:dataDir 'config.json') -Raw | ConvertFrom-Json).adapter } catch { }
    $backOnSaved = ($cmbAdapter.SelectedIndex -ge 0) -and ($script:adapterItems[$cmbAdapter.SelectedIndex].alias -eq 'Ethernet 2')
    Note 'refused' ($refused -and ($before -eq $after) -and ($after -eq 'Ethernet 2') -and $backOnSaved -and ([string]$script:targetAlias -eq 'Ethernet 2')) ("status=$($lblStatus.Text) saved=$after")

    return $checks
}

function Invoke-GuiDnsSelfTest {
    $checks = [ordered]@{}
    function Note([string]$name, [bool]$ok, [string]$detail) {
        $checks[$name] = [pscustomobject]@{ ok = $ok; detail = $detail }
    }

    if (-not (Wait-Gui { $null -ne $script:lastTweak })) {
        Note 'state' $false 'the bridge never delivered state'
        return [ordered]@{ ok = $false; checks = $checks }
    }

    $script:dnsDone = $false
    $script:dnsWinner = $null
    # The function the DNS buttons' Click handlers call; a hidden WinForms button does not
    # raise Click (CanSelect is false before the form is shown), so the handler body is run
    # directly here. The test still reads the filled controls, not the answer object.
    Invoke-DnsBenchmark
    $finished = Wait-Gui { $script:dnsDone -eq $true } 60000
    $rows = @($lvDns.Items | ForEach-Object {
        [pscustomobject]@{
            label = [string]$_.Text
            median = [string]$_.SubItems[1].Text
            worst = [string]$_.SubItems[2].Text
            answered = [string]$_.SubItems[3].Text
            note = [string]$_.SubItems[4].Text
        }
    })
    Note 'benchmark' ($finished -and ($rows.Count -gt 0)) ("rows=$($rows.Count) status=$($lblStatus.Text)")
    return [ordered]@{
        ok = ($finished -and ($rows.Count -gt 0))
        rows = $rows
        verdict = [string]$lblDnsVerdict.Text
        current = [string]$lblDnsCurrent.Text
        winnerId = if ($null -ne $script:dnsWinner) { [string]$script:dnsWinner.id } else { $null }
        checks = $checks
    }
}

