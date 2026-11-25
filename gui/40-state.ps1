# --------------------------------------------------------------- update logic

$script:lastTweak = $null
# The tweak catalog (lib/catalog.mjs) arrives with every state refresh; the Fixes tab uses
# it for the risk tag, the stock value and the tooltip, so its words match the TUI and web.
$script:catalog = $null
# Which adapter the rows below change; set from every state refresh, so a tooltip always names
# the device an apply would write to.
$script:targetAlias = $null
# The picker's own state: the served choices, the items currently shown (index-aligned, so the
# selection handler never has to parse a display string), the note under it, the virtual toggle,
# and a guard so filling the list cannot look like a user choosing from it.
$script:adapterChoices = @()
$script:adapterItems = @()
$script:adapterNote = ''
$script:showVirtual = $false
$script:fillingAdapter = $false
$script:soakRunning = $false
$script:lastProgressLog = -1
# The DNS tab's current result, shared by its two buttons so a click cannot run a second
# measurement; the bridge fills it from lib/dns.mjs and the verdict from lib/report.mjs.
$script:dnsWinner = $null
$script:dnsDone = $false

function New-AdapterItemText($c) {
    $tags = @()
    if ($c.defaultRoute) { $tags += 'default route' }
    if ($c.virtual) { $tags += 'virtual / VPN' }
    if ($c.status -and $c.status -ne 'Up') { $tags += [string]$c.status }
    $text = [string]$c.alias
    if ($c.description) { $text += ' - ' + [string]$c.description }
    if ($tags.Count -gt 0) { $text += ' (' + ($tags -join ', ') + ')' }
    return $text
}

# Physical adapters are always offered; a virtual or VPN one only once the box is ticked, or
# when it is already the target (so a saved choice is never hidden from its own picker).
function Set-AdapterPickerItems {
    $script:fillingAdapter = $true
    try {
        $cmbAdapter.BeginUpdate()
        try {
            $cmbAdapter.Items.Clear()
            $script:adapterItems = @()
            foreach ($c in @($script:adapterChoices)) {
                if ($null -eq $c) { continue }
                $isTarget = ([string]$c.alias -eq [string]$script:targetAlias)
                if ($c.virtual -and -not $script:showVirtual -and -not $isTarget) { continue }
                [void]$cmbAdapter.Items.Add((New-AdapterItemText $c))
                $script:adapterItems += [pscustomobject]@{ alias = [string]$c.alias }
            }
            $index = -1
            for ($i = 0; $i -lt $script:adapterItems.Count; $i++) {
                if ($script:adapterItems[$i].alias -eq [string]$script:targetAlias) { $index = $i; break }
            }
            if ($index -lt 0 -and $cmbAdapter.Items.Count -gt 0) { $index = 0 }
            if ($index -ge 0) { $cmbAdapter.SelectedIndex = $index }
        } finally {
            $cmbAdapter.EndUpdate()
        }
    } finally {
        $script:fillingAdapter = $false
    }
}

function Update-RestorePoints($pending) {
    $lvRestore.BeginUpdate()
    try {
        $lvRestore.Items.Clear()
        if ($null -ne $pending -and $null -ne $pending.problem) {
            $bad = New-Object System.Windows.Forms.ListViewItem('restore points unreadable')
            [void]$bad.SubItems.Add('')
            [void]$bad.SubItems.Add([string]$pending.problem.message)
            [void]$bad.SubItems.Add('')
            [void]$lvRestore.Items.Add($bad)
            return
        }
        foreach ($it in @($pending.items)) {
            if ($null -eq $it) { continue }
            $row = New-Object System.Windows.Forms.ListViewItem([string]$it.label)
            [void]$row.SubItems.Add([string]$it.alias)
            [void]$row.SubItems.Add([string]$it.restoreWillSet)
            $when = ''
            try { $when = ([datetime]$it.at).ToLocalTime().ToString('HH:mm') } catch { $when = [string]$it.at }
            [void]$row.SubItems.Add($when)
            [void]$lvRestore.Items.Add($row)
        }
    } finally {
        $lvRestore.EndUpdate()
    }
}

function Update-AdapterPicker($d) {
    $script:targetAlias = if ($null -ne $d.target) { [string]$d.target.alias } else { $null }
    $script:adapterChoices = @($d.adapterChoices)
    $note = @()
    if ($null -ne $d.target -and $d.target.note) { $note += [string]$d.target.note }
    if ($d.targetFallback) { $note += [string]$d.targetFallback }
    $script:adapterNote = ($note -join ' ')
    Set-AdapterPickerItems
    $lblAdapterNote.Text = $script:adapterNote
    $fixTip.SetToolTip($lblAdapterNote, $script:adapterNote)
}

# The one write path: the engine validates the name against the machine, saves it the same way
# `node pinglab.mjs --adapter` and POST /api/adapter do, and answers with the re-read state.
function Set-TargetAdapter([string]$alias) {
    if ([string]::IsNullOrWhiteSpace($alias)) { return }
    if ($alias -eq [string]$script:targetAlias) { return }
    Set-Status ("Aiming the settings at $alias...") 'info'
    Send-Cmd 'adapter' @{ alias = $alias } {
        param($r)
        if (-not $r.ok) {
            Set-Status ('Adapter not changed: ' + $r.error) 'bad'
            # The saved choice is untouched, so put the picker back on it rather than showing
            # a device the engine refused.
            Set-AdapterPickerItems
            return
        }
        $script:targetAlias = [string]$r.data.target.alias
        Set-Status ("Settings now apply to $($script:targetAlias).") 'good'
        # Rows, drift, the DNS-in-use line and the restore points all come from one state read,
        # so this redraws every one of them against the new adapter without a restart.
        Refresh-State
    }
}

function Update-Overview($d) {
    $lvOverview.BeginUpdate()
    $lvOverview.Items.Clear()
    $c = $d.connection
    if ($null -ne $c) {
        $a = $c.activeAdapter
        $w = $c.wifi
        $t = $d.tweak
        function Add-Row([string]$k, [string]$v) {
            $it = New-Object System.Windows.Forms.ListViewItem($k)
            [void]$it.SubItems.Add($v)
            [void]$lvOverview.Items.Add($it)
        }
        Add-Row 'Adapter' ("{0} - {1}" -f $a.name, $a.description)
        Add-Row 'Type' $(if ($c.usingWifi) { 'Wi-Fi' } else { 'Ethernet / other' })
        Add-Row 'Link speed' ("{0}" -f $a.linkSpeedText)
        Add-Row 'Default route' ("{0} -> {1}" -f $c.activeRoute.alias, $c.activeRoute.nextHop)
        # Which adapter the settings are read from and written to, and why: the default route
        # unless another adapter was chosen, never a virtual or VPN one by silence. The picker's
        # own update sets $script:targetAlias; this row reports the same value.
        if ($null -ne $d.target) {
            $tgt = $d.target
            $tag = @()
            if ($tgt.defaultRoute) { $tag += 'default route' }
            if ($tgt.virtual) { $tag += 'virtual/VPN' }
            Add-Row 'Settings apply to' ("{0}{1}" -f $tgt.alias, $(if ($tag.Count) { ' (' + ($tag -join ', ') + ')' } else { '' }))
        }
        Add-Row 'DNS' $(if ($c.dnsForActive.servers.Count -gt 0) { $c.dnsForActive.servers -join ', ' } else { 'automatic' })
        if ($w.connected) {
            Add-Row 'Wi-Fi' ("{0} | {1} ch {2} | {3}% | {4}" -f $w.ssid, $w.band, $w.channel, $w.signalPct, $w.radioType)
        } elseif ($c.usingWifi) {
            Add-Row 'Wi-Fi' 'details hidden (Location services off)'
        }
        if ($null -ne $t) {
            Add-Row 'Wireless power saving' $(if ($t.planPower -eq 'off') { 'maximum performance' } else { $t.planDetail })
            Add-Row 'NIC power management' $(if ($t.nicPower -eq 'unsupported') { 'not available on this adapter' } else { $t.nicDetail })
            Add-Row 'Nagle' $(if ($t.nagleDisabled) { 'disabled (TcpAckFrequency=1, TCPNoDelay=1)' } else { 'on' })
        }
        Add-Row 'Active changes' $(if ($null -ne $d.pending.problem) { 'restore points unreadable - see --audit' } else { "{0}" -f $d.pending.count })
        $tuning = if ($null -eq $t.adapterTuning) { 'unreadable' } elseif ($t.adapterTuning.needsFix) { 'stock' } else { 'applied' }
        $orderText = if ($null -eq $t.wifiOrder) { 'n/a' } elseif (-not $t.wifiOrder.readable) { 'unreadable' } elseif ($t.wifiOrder.isFirst) { 'first' } else { '#' + $t.wifiOrder.position }
        Log ("render: adapter={0} wifi={1} {2} ch{3} {4}% plan={5} nic={6} nagle={7} tuning={8} order={9} restorePoints={10}" -f $a.name, $w.ssid, $w.band, $w.channel, $w.signalPct, $t.planPower, $t.nicPower, $t.nagleDisabled, $tuning, $orderText, $d.pending.count)
        $lastProbe = $d.runs | Where-Object { $_.kind -eq 'probe' } | Select-Object -First 1
        if ($null -ne $lastProbe) { Add-Row 'Last latency test' ("{0}  ({1})" -f $lastProbe.summary, ([datetime]$lastProbe.createdAt).ToLocalTime().ToString('HH:mm')) }
        if ($d.soaks.Count -gt 0) {
            $s = $d.soaks[0]
            $dur = if ($s.seconds -lt 60) { "$($s.seconds) s" } else { "$([int][math]::Round($s.seconds / 60)) min" }
            $soakText = "#{0} | {1} | {2} samples | {3}" -f $s.id, $dur, $s.summary.samples, $s.summary.label
            Add-Row 'Last soak' $soakText
            Log ('overview last soak: ' + $soakText)
        }
    }
    $lvOverview.EndUpdate()
}

function Update-Fixes($t, $pending) {
    Update-RestorePoints $pending
    if ($null -eq $t) {
        foreach ($row in @($rowPlan, $rowNic, $rowNagle, $rowWifi, $rowOrder, $rowDns)) {
            $row.Label.Text = 'No active adapter - connect one and press Refresh'
            $row.Label.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
            $row.Button.Enabled = $false
            if ($null -ne $row.Button2) { $row.Button2.Enabled = $false }
        }
        $script:lastTweak = $null
        return
    }
    $script:lastTweak = $t

    if ($t.planPower -eq 'off') {
        $rowPlan.Label.Text = "Maximum performance - $($t.planDetail)"
        $rowPlan.Label.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60)
        $rowPlan.Button.Text = 'Revert'
        $rowPlan.Button.Enabled = $true
    } else {
        $rowPlan.Label.Text = "On - $($t.planDetail)"
        $rowPlan.Label.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
        $rowPlan.Button.Text = 'Maximum performance'
        $rowPlan.Button.Enabled = $true
    }

    if ($t.nicPower -eq 'unsupported') {
        $rowNic.Label.Text = 'Not available - the driver exposes no device power setting'
        $rowNic.Label.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
        $rowNic.Button.Text = 'Not available'
        $rowNic.Button.Enabled = $false
    } elseif ($t.nicPower -eq 'off') {
        $rowNic.Label.Text = "Disabled - $($t.nicDetail)"
        $rowNic.Label.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60)
        $rowNic.Button.Text = 'Revert'
        $rowNic.Button.Enabled = $true
    } else {
        $rowNic.Label.Text = "On - $($t.nicDetail)"
        $rowNic.Label.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
        $rowNic.Button.Text = 'Disable'
        $rowNic.Button.Enabled = $true
    }

    if ($t.nagleDisabled) {
        $rowNagle.Label.Text = "Disabled - TcpAckFrequency=$($t.nagleValues.tcpAckFrequency), TCPNoDelay=$($t.nagleValues.tcpNoDelay)"
        $rowNagle.Label.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60)
        $rowNagle.Button.Text = 'Restore'
    } else {
        $rowNagle.Label.Text = 'On - Windows batches small packets'
        $rowNagle.Label.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
        $rowNagle.Button.Text = 'Disable'
    }
    $rowNagle.Button.Enabled = $true

    $at = $t.adapterTuning
    if ($null -eq $at) {
        $rowWifi.Label.Text = 'Not readable - this driver exposes no matching property'
        $rowWifi.Label.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
        $rowWifi.Button.Text = 'Not available'
        $rowWifi.Button.Enabled = $false
    } elseif ($at.needsFix) {
        $stock = ($at.items | ForEach-Object { $_.display }) -join ', '
        $reason = if ($at.reason) { $at.reason } else { 'vendor default' }
        $rowWifi.Label.Text = "Not tuned for a fixed desktop - now $stock. $reason"
        $rowWifi.Label.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
        $rowWifi.Button.Text = 'Apply anyway'
        $rowWifi.Button.Enabled = $true
    } else {
        $applied = ($at.items | ForEach-Object { $_.display }) -join ', '
        $rowWifi.Label.Text = "Tuned - $applied"
        $rowWifi.Label.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60)
        $rowWifi.Button.Text = 'Revert'
        $rowWifi.Button.Enabled = $true
    }

    $wo = $t.wifiOrder
    if ($null -eq $wo) {
        $rowOrder.Label.Text = 'Not available - this adapter is not wireless'
        $rowOrder.Label.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
        $rowOrder.Button.Text = 'Not available'
        $rowOrder.Button.Enabled = $false
    } elseif (-not $wo.readable) {
        $rowOrder.Label.Text = 'Unreadable - netsh returned no profile list'
        $rowOrder.Label.ForeColor = [System.Drawing.Color]::FromArgb(180, 30, 30)
        $rowOrder.Button.Text = 'Not available'
        $rowOrder.Button.Enabled = $false
    } elseif ($wo.isFirst) {
        $rowOrder.Label.Text = "First - $($wo.target) is picked before every other saved network"
        $rowOrder.Label.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60)
        if ($wo.appliedByUs) {
            $rowOrder.Button.Text = 'Revert'
            $rowOrder.Button.Enabled = $true
        } else {
            $rowOrder.Button.Text = 'Already first'
            $rowOrder.Button.Enabled = $false
        }
    } else {
        $rowOrder.Label.Text = "$($wo.target) is #$($wo.position) of $($wo.profiles.Count) - an adapter reset can land on another network"
        $rowOrder.Label.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
        $rowOrder.Button.Text = 'Move first'
        $rowOrder.Button.Enabled = $true
    }

    $dnsServers = @($t.currentDns | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($dnsServers.Count -gt 0) {
        $rowDns.Label.Text = "Fixed - $($dnsServers -join ', ')"
        $rowDns.Label.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
        $rowDns.Button2.Enabled = $true
    } else {
        $rowDns.Label.Text = 'Automatic - the router hands out the servers'
        $rowDns.Label.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
        $rowDns.Button2.Enabled = $false
    }
    $rowDns.Button.Enabled = $true

    # The catalog decides the risk tag, preset membership and the tooltip text; the code
    # above only decides the live state sentence and which button follows from it.
    if ($null -ne $script:catalog) {
        $riskMap = @{}
        foreach ($k in $script:catalog.risk.PSObject.Properties) { $riskMap[$k.Name] = $k.Value.label }
        $presetMap = @{}
        foreach ($p in $script:catalog.presets) {
            foreach ($id in $p.tweaks) {
                if ($null -eq $presetMap[$id]) { $presetMap[$id] = @() }
                $presetMap[$id] = @($presetMap[$id]) + $p.id
            }
        }
        $rows = @{ 'plan-power' = $rowPlan; 'nic-power' = $rowNic; 'nagle' = $rowNagle; 'radio-tuning' = $rowWifi; 'wifi-order' = $rowOrder; 'dns' = $rowDns }
        foreach ($t in $script:catalog.tweaks) {
            $row = $rows[$t.id]
            if ($null -eq $row) { continue }
            $in = $presetMap[$t.id]
            # Short on purpose: the row is 300 px wide, and the long explanations live in the
            # tooltip instead of running into the state column.
            $onAdapter = if ($script:targetAlias) { ' - on ' + [string]$script:targetAlias } else { '' }
            $row.Hint.Text = '[{0}] {1}{2}' -f $riskMap[$t.risk], $(if ($in) { 'in ' + ($in -join ', ') } else { 'no preset' }), $onAdapter
            $fixTip.SetToolTip($row.Hint, ("What it changes:`n{0}`n`nTrade-off:`n{1}`n`nUndo:`n{2}" -f $t.what, $t.tradeoff, $t.undo))
            $onAdapter = if ($script:targetAlias) { "`nChanges on adapter: $($script:targetAlias)" } else { '' }
            $fixTip.SetToolTip($row.Title, ("{0} - {1}{2}" -f $t.label, $t.stock, $onAdapter))
        }
    }
}

