# PingLab - desktop GUI (WinForms, no dependencies, no browser).
# It talks to `node pinglab.mjs --bridge` over stdin/stdout with one JSON object per line.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# The same rule as lib\paths.mjs: an installed copy keeps its data in a per-user folder,
# never inside the program folder, so an uninstall can remove the latter and an upgrade
# replaces none of the former.
$root = $PSScriptRoot
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

# ---------------------------------------------------------------------- ui

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PingLab - network doctor'
$form.Size = New-Object System.Drawing.Size(960, 680)
$form.MinimumSize = New-Object System.Drawing.Size(820, 560)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.BackColor = [System.Drawing.Color]::FromArgb(250, 250, 250)

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'

$status = New-Object System.Windows.Forms.StatusStrip
$lblStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$lblStatus.Text = 'Starting...'
[void]$status.Items.Add($lblStatus)

$form.Controls.Add($tabs)
$form.Controls.Add($status)

function New-Tab([string]$text) {
    $t = New-Object System.Windows.Forms.TabPage
    $t.Text = $text
    $t.Padding = New-Object System.Windows.Forms.Padding(10)
    $t.BackColor = [System.Drawing.Color]::FromArgb(250, 250, 250)
    return $t
}

function New-Grid([string[]]$headers, [int[]]$widths) {
    $lv = New-Object System.Windows.Forms.ListView
    $lv.View = 'Details'
    $lv.FullRowSelect = $true
    $lv.Dock = 'Fill'
    $lv.BorderStyle = 'FixedSingle'
    $lv.HeaderStyle = 'Nonclickable'
    for ($i = 0; $i -lt $headers.Count; $i++) {
        [void]$lv.Columns.Add($headers[$i], $widths[$i])
    }
    return $lv
}

function New-Button([string]$text, [int]$w = 150) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.AutoSize = $false
    $b.Width = $w
    $b.Height = 28
    $b.FlatStyle = 'System'
    return $b
}

function Set-Status([string]$text, [string]$kind = 'info') {
    $lblStatus.Text = $text
    switch ($kind) {
        'good' { $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60) }
        'bad' { $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(180, 30, 30) }
        'warn' { $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0) }
        default { $lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(60, 60, 60) }
    }
}

# ------------------------------------------------------------------ bridge

$script:queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'
$script:inflight = 0

function Send-Cmd([string]$cmd, $cmdArgs, [scriptblock]$onResult) {
    if ($script:proc.HasExited) {
        Set-Status 'The engine process stopped. Restart PingLab.' 'bad'
        return
    }
    $script:queue.Enqueue($onResult)
    $script:inflight++
    $msg = @{ id = [guid]::NewGuid().ToString('N'); cmd = $cmd; args = $cmdArgs } | ConvertTo-Json -Compress -Depth 10
    try {
        $script:proc.StandardInput.WriteLine($msg)
        $script:proc.StandardInput.Flush()
    } catch {
        Set-Status ('Could not reach the engine: ' + $_.Exception.Message) 'bad'
    }
}

# Responses arrive in a file the engine appends to; a UI timer polls it. This avoids
# pipe callbacks, which PowerShell 5.1 cannot deliver into a WinForms message loop.
$script:outPos = 0
$script:buf = ''

function Poll-Bridge {
    if (-not (Test-Path $script:outFile)) { return }
    $text = ''
    try {
        $fs = [System.IO.File]::Open($script:outFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($fs.Length -lt $script:outPos) { $script:outPos = 0; $script:buf = '' }
            [void]$fs.Seek($script:outPos, [System.IO.SeekOrigin]::Begin)
            $sr = New-Object System.IO.StreamReader($fs)
            $text = $sr.ReadToEnd()
            $script:outPos = $fs.Position
        } finally {
            $fs.Close()
        }
    } catch {
        return
    }
    if ([string]::IsNullOrEmpty($text)) { return }
    $all = $script:buf + $text
    $parts = $all -split "`n"
    $script:buf = $parts[$parts.Count - 1]
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        $line = $parts[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $cb = $null
        if (-not $script:queue.TryDequeue([ref]$cb)) { continue }
        $obj = $null
        try { $obj = $line | ConvertFrom-Json } catch { continue }
        try { $script:inflight-- } catch { }
        if ($null -ne $cb) { & $cb $obj }
    }
}

# ---------------------------------------------------------------- tab: overview

$tabOverview = New-Tab 'Overview'
$tlpOverview = New-Object System.Windows.Forms.TableLayoutPanel
$tlpOverview.Dock = 'Fill'
$tlpOverview.ColumnCount = 1
$tlpOverview.RowCount = 2
[void]$tlpOverview.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 40)))
[void]$tlpOverview.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))

$panelOverviewTop = New-Object System.Windows.Forms.Panel
$panelOverviewTop.Dock = 'Fill'
$btnRefresh = New-Button 'Refresh' 110
$btnRefresh.Location = New-Object System.Drawing.Point(0, 4)
$panelOverviewTop.Controls.Add($btnRefresh)
$tlpOverview.Controls.Add($panelOverviewTop, 0, 0)

$lvOverview = New-Grid @('Property', 'Value') @(200, 700)
$tlpOverview.Controls.Add($lvOverview, 0, 1)
$tabOverview.Controls.Add($tlpOverview)
[void]$tabs.TabPages.Add($tabOverview)

# ------------------------------------------------------------------- tab: fixes

$tabFixes = New-Tab 'Fixes'
$tlpFixes = New-Object System.Windows.Forms.TableLayoutPanel
$tlpFixes.Dock = 'Fill'
$tlpFixes.ColumnCount = 3
$tlpFixes.RowCount = 8
[void]$tlpFixes.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 300)))
[void]$tlpFixes.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tlpFixes.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 160)))
for ($i = 0; $i -lt 6; $i++) {
    [void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 74)))
}
# One row above the settings for the drift sentence: a setting PingLab wrote that Windows has
# since put back is the one thing the rows themselves cannot show.
[void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34)))
[void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))

$fixTip = New-Object System.Windows.Forms.ToolTip
$fixTip.AutoPopDelay = 30000
$fixTip.InitialDelay = 400
$fixTip.ReshowDelay = 100

function New-FixRow([int]$row, [string]$title, [string]$hint, [string]$altText = '') {
    $lblTitle = New-Object System.Windows.Forms.Label
    $lblTitle.Text = $title
    $lblTitle.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
    $lblTitle.AutoSize = $true
    $lblTitle.Margin = New-Object System.Windows.Forms.Padding(0, 8, 6, 0)

    $lblHint = New-Object System.Windows.Forms.Label
    $lblHint.Text = $hint
    $lblHint.AutoSize = $true
    $lblHint.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
    $lblHint.Margin = New-Object System.Windows.Forms.Padding(0, 2, 6, 0)

    $cell = New-Object System.Windows.Forms.TableLayoutPanel
    $cell.ColumnCount = 1
    $cell.RowCount = 2
    $cell.Dock = 'Fill'
    [void]$cell.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 26)))
    [void]$cell.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    $cell.Controls.Add($lblTitle, 0, 0)
    $cell.Controls.Add($lblHint, 0, 1)

    $lblState = New-Object System.Windows.Forms.Label
    $lblState.AutoSize = $false
    $lblState.Dock = 'Fill'
    $lblState.TextAlign = 'MiddleLeft'
    $lblState.Margin = New-Object System.Windows.Forms.Padding(0, 8, 8, 8)

    # A row may carry a second button (DNS: use the benchmarked winner, or go back to the
    # router), so the actions live in a stack that fits the 74 px row either way.
    $btnCell = New-Object System.Windows.Forms.FlowLayoutPanel
    $btnCell.FlowDirection = 'TopDown'
    $btnCell.WrapContents = $false
    $btnCell.Dock = 'Fill'
    $btnCell.Margin = New-Object System.Windows.Forms.Padding(0)

    $btn = New-Button 'Apply' 140
    $btn.Margin = New-Object System.Windows.Forms.Padding(0, $(if ($altText) { 6 } else { 20 }), 0, 0)
    $btnCell.Controls.Add($btn)

    $btnAlt = $null
    if ($altText) {
        $btnAlt = New-Button $altText 140
        $btnAlt.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 0)
        $btnCell.Controls.Add($btnAlt)
    }

    $tlpFixes.Controls.Add($cell, 0, $row)
    $tlpFixes.Controls.Add($lblState, 1, $row)
    $tlpFixes.Controls.Add($btnCell, 2, $row)

    return @{ Label = $lblState; Button = $btn; Button2 = $btnAlt; Hint = $lblHint; Title = $lblTitle }
}

$rowPlan = New-FixRow 0 'Wireless power saving' 'Power Options -> Wireless Adapter Settings -> Power Saving Mode'
$rowNic = New-FixRow 1 'NIC power management' 'Device Manager -> adapter -> Power Management'
$rowNagle = New-FixRow 2 "Nagle's algorithm" 'TcpAckFrequency / TCPNoDelay on this interface'
$rowWifi = New-FixRow 3 'Wi-Fi radio power save (desktop)' 'MIMO power save + roaming aggressiveness, from the driver itself.'
$rowOrder = New-FixRow 4 'Wi-Fi auto-connect order' 'netsh wlan show profiles order - the network Windows rejoins after an adapter reset.'
$rowDns = New-FixRow 5 'DNS servers' 'Benchmark the resolvers PingLab knows, or hand the adapter back to your router.' 'Automatic'
$rowDns.Button.Text = 'Benchmark'

$lblDrift = New-Object System.Windows.Forms.Label
$lblDrift.Dock = 'Fill'
$lblDrift.AutoSize = $false
$lblDrift.AutoEllipsis = $true
$lblDrift.TextAlign = 'MiddleLeft'
$lblDrift.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
$lblDrift.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$lblDrift.Margin = New-Object System.Windows.Forms.Padding(0, 6, 8, 0)
$tlpFixes.Controls.Add($lblDrift, 0, 6)
$tlpFixes.SetColumnSpan($lblDrift, 3)

$panelRestore = New-Object System.Windows.Forms.Panel
$panelRestore.Dock = 'Fill'
$btnPresetSafe = New-Button 'Apply safe preset' 190
$btnPresetSafe.Location = New-Object System.Drawing.Point(0, 12)
$btnPresetSafe.BackColor = [System.Drawing.Color]::FromArgb(232, 244, 232)
$panelRestore.Controls.Add($btnPresetSafe)

$btnPresetLatency = New-Button 'Apply lowest-latency preset' 210
$btnPresetLatency.Location = New-Object System.Drawing.Point(198, 12)
$panelRestore.Controls.Add($btnPresetLatency)

$btnRestore = New-Button 'Restore everything PingLab changed' 300
$btnRestore.Location = New-Object System.Drawing.Point(416, 12)
$btnRestore.BackColor = [System.Drawing.Color]::FromArgb(252, 236, 236)
$panelRestore.Controls.Add($btnRestore)
$tlpFixes.Controls.Add($panelRestore, 0, 7)
$tlpFixes.SetColumnSpan($panelRestore, 3)
$tabFixes.Controls.Add($tlpFixes)
[void]$tabs.TabPages.Add($tabFixes)

# -------------------------------------------------------------------- tab: wifi

$tabWifi = New-Tab 'Wi-Fi'
$tlpWifi = New-Object System.Windows.Forms.TableLayoutPanel
$tlpWifi.Dock = 'Fill'
$tlpWifi.ColumnCount = 1
$tlpWifi.RowCount = 3
[void]$tlpWifi.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 40)))
[void]$tlpWifi.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 48)))
[void]$tlpWifi.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 52)))

$panelWifiTop = New-Object System.Windows.Forms.Panel
$panelWifiTop.Dock = 'Fill'
$btnScan = New-Button 'Scan channels' 150
$btnScan.Location = New-Object System.Drawing.Point(0, 4)
$panelWifiTop.Controls.Add($btnScan)
$tlpWifi.Controls.Add($panelWifiTop, 0, 0)

$lvWifi = New-Grid @('Network', 'Band', 'Channel', 'Signal') @(340, 110, 90, 90)
$tlpWifi.Controls.Add($lvWifi, 0, 1)

$txtAdvice = New-Object System.Windows.Forms.RichTextBox
$txtAdvice.Dock = 'Fill'
$txtAdvice.ReadOnly = $true
$txtAdvice.BackColor = [System.Drawing.Color]::White
$txtAdvice.BorderStyle = 'FixedSingle'
$txtAdvice.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$tlpWifi.Controls.Add($txtAdvice, 0, 2)
$tabWifi.Controls.Add($tlpWifi)
[void]$tabs.TabPages.Add($tabWifi)

# ----------------------------------------------------------------- tab: latency

$tabLatency = New-Tab 'Latency'
$tlpLatency = New-Object System.Windows.Forms.TableLayoutPanel
$tlpLatency.Dock = 'Fill'
$tlpLatency.ColumnCount = 1
$tlpLatency.RowCount = 4
[void]$tlpLatency.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 40)))
[void]$tlpLatency.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tlpLatency.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 30)))
[void]$tlpLatency.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 30)))

$panelLatencyTop = New-Object System.Windows.Forms.Panel
$panelLatencyTop.Dock = 'Fill'
$btnProbe = New-Button 'Run latency test' 160
$btnProbe.Location = New-Object System.Drawing.Point(0, 4)
$panelLatencyTop.Controls.Add($btnProbe)
$btnBloat = New-Button 'Run bufferbloat test' 180
$btnBloat.Location = New-Object System.Drawing.Point(170, 4)
$panelLatencyTop.Controls.Add($btnBloat)
$tlpLatency.Controls.Add($panelLatencyTop, 0, 0)

$lvProbe = New-Grid @('Endpoint', 'avg ms', 'p95 ms', 'jitter ms', 'loss %') @(300, 100, 100, 100, 90)
$tlpLatency.Controls.Add($lvProbe, 0, 1)

$lblProbeSummary = New-Object System.Windows.Forms.Label
$lblProbeSummary.Dock = 'Fill'
$lblProbeSummary.TextAlign = 'MiddleLeft'
$lblProbeSummary.Text = ''
$tlpLatency.Controls.Add($lblProbeSummary, 0, 2)

$lblBloat = New-Object System.Windows.Forms.Label
$lblBloat.Dock = 'Fill'
$lblBloat.TextAlign = 'MiddleLeft'
$lblBloat.Text = ''
$tlpLatency.Controls.Add($lblBloat, 0, 3)
$tabLatency.Controls.Add($tlpLatency)
[void]$tabs.TabPages.Add($tabLatency)

# -------------------------------------------------------------------- tab: soak

$tabSoak = New-Tab 'Soak test'
$tlpSoak = New-Object System.Windows.Forms.TableLayoutPanel
$tlpSoak.Dock = 'Fill'
$tlpSoak.ColumnCount = 1
$tlpSoak.RowCount = 3
[void]$tlpSoak.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 72)))
[void]$tlpSoak.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tlpSoak.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 30)))

$panelSoakTop = New-Object System.Windows.Forms.Panel
$panelSoakTop.Dock = 'Fill'

$lblMinutes = New-Object System.Windows.Forms.Label
$lblMinutes.Text = 'Minutes'
$lblMinutes.AutoSize = $true
$lblMinutes.Location = New-Object System.Drawing.Point(0, 10)
$panelSoakTop.Controls.Add($lblMinutes)

$numMinutes = New-Object System.Windows.Forms.NumericUpDown
$numMinutes.Minimum = 1
$numMinutes.Maximum = 60
$numMinutes.Value = 10
$numMinutes.Width = 60
$numMinutes.Location = New-Object System.Drawing.Point(58, 8)
$panelSoakTop.Controls.Add($numMinutes)

$btnSoakStart = New-Button 'Start soak' 110
$btnSoakStart.Location = New-Object System.Drawing.Point(132, 6)
$panelSoakTop.Controls.Add($btnSoakStart)

$btnSoakStop = New-Button 'Stop' 80
$btnSoakStop.Location = New-Object System.Drawing.Point(250, 6)
$btnSoakStop.Enabled = $false
$panelSoakTop.Controls.Add($btnSoakStop)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(0, 42)
$progress.Width = 560
$progress.Height = 18
$progress.Anchor = 'Left,Top,Right'
$panelSoakTop.Controls.Add($progress)

$tlpSoak.Controls.Add($panelSoakTop, 0, 0)

$lvSoak = New-Grid @('Target', 'avg', 'p95', 'p99', 'jitter', 'loss %', 'spikes') @(280, 80, 80, 80, 80, 80, 80)
$tlpSoak.Controls.Add($lvSoak, 0, 1)

$lblSoakSummary = New-Object System.Windows.Forms.Label
$lblSoakSummary.Dock = 'Fill'
$lblSoakSummary.TextAlign = 'MiddleLeft'
$tlpSoak.Controls.Add($lblSoakSummary, 0, 2)
$tabSoak.Controls.Add($tlpSoak)
[void]$tabs.TabPages.Add($tabSoak)

# --------------------------------------------------------------- update logic

$script:lastTweak = $null
# The tweak catalog (lib/catalog.mjs) arrives with every state refresh; the Fixes tab uses
# it for the risk tag, the stock value and the tooltip, so its words match the TUI and web.
$script:catalog = $null
$script:soakRunning = $false
$script:lastProgressLog = -1

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

function Update-Fixes($t) {
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
            $row.Hint.Text = '[{0}] {1}' -f $riskMap[$t.risk], $(if ($in) { 'in ' + ($in -join ', ') } else { 'no preset' })
            $fixTip.SetToolTip($row.Hint, ("What it changes:`n{0}`n`nTrade-off:`n{1}`n`nUndo:`n{2}" -f $t.what, $t.tradeoff, $t.undo))
            $fixTip.SetToolTip($row.Title, ("{0} - {1}" -f $t.label, $t.stock))
        }
    }
}

function Update-Wifi($d) {
    $lvWifi.BeginUpdate()
    $lvWifi.Items.Clear()
    if ($null -ne $d.scan -and $d.scan.ok) {
        foreach ($n in $d.scan.networks) {
            $band = if ([string]::IsNullOrWhiteSpace([string]$n.band)) { 'unknown' } else { [string]$n.band }
            $it = New-Object System.Windows.Forms.ListViewItem($(if ([string]::IsNullOrEmpty($n.ssid)) { '(hidden)' } else { $n.ssid }))
            [void]$it.SubItems.Add($band)
            [void]$it.SubItems.Add("$($n.channel)")
            [void]$it.SubItems.Add("$($n.signalPct)%")
            [void]$lvWifi.Items.Add($it)
        }
    }
    $lvWifi.EndUpdate()

    $txtAdvice.Clear()
    if ($null -eq $d.scan) { return }
    if (-not $d.scan.ok) {
        $txtAdvice.SelectionColor = [System.Drawing.Color]::FromArgb(180, 30, 30)
        $txtAdvice.AppendText(($d.scan.reason + "`n"))
        return
    }
    # A scan Windows confirmed finished is dated here, from the same sentence the terminal and
    # the page print; without a confirmation it says so and claims nothing about freshness.
    # Either way every count below stays scoped to what this scan returned.
    if (-not [string]::IsNullOrWhiteSpace([string]$d.freshnessText)) {
        $txtAdvice.SelectionColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
        $txtAdvice.AppendText(($d.freshnessText + "`n`n"))
    }
    foreach ($line in $d.advice) {
        $kind = $line[0]
        $text = $line[1]
        $col = switch ($kind) {
            'good' { [System.Drawing.Color]::FromArgb(0, 120, 60) }
            'warn' { [System.Drawing.Color]::FromArgb(165, 105, 0) }
            'bad' { [System.Drawing.Color]::FromArgb(180, 30, 30) }
            'dim' { [System.Drawing.Color]::FromArgb(130, 130, 130) }
            default { [System.Drawing.Color]::FromArgb(40, 60, 120) }
        }
        $txtAdvice.SelectionColor = $col
        $txtAdvice.AppendText("* $text`n`n")
    }
}

function Update-Probe($p) {
    $lvProbe.BeginUpdate()
    $lvProbe.Items.Clear()
    if ($null -eq $p) { $lvProbe.EndUpdate(); return }
    foreach ($r in $p.results) {
        $it = New-Object System.Windows.Forms.ListViewItem($r.label)
        [void]$it.SubItems.Add((N $r.avg))
        [void]$it.SubItems.Add((N $r.p95))
        [void]$it.SubItems.Add((N $r.jitter))
        [void]$it.SubItems.Add((N $r.loss))
        if ($null -ne $r.avg -and $r.avg -gt 110) { $it.ForeColor = [System.Drawing.Color]::FromArgb(180, 30, 30) }
        elseif ($null -ne $r.avg -and $r.avg -gt 60) { $it.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0) }
        else { $it.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60) }
        [void]$lvProbe.Items.Add($it)
    }
    # UDP rows: games send UDP, so the same grid carries them. Only an answered endpoint has
    # latency or loss; a closed port shows its path figure in the row title and silence shows
    # a dash in every number column, so no row can be read as a service figure it is not.
    foreach ($u in @($p.udp)) {
        if ($null -eq $u) { continue }
        $answered = $u.state -eq 'answered'
        $title = 'UDP: ' + $u.label
        if (-not $answered) {
            if ($u.state -eq 'closed') {
                $title += ' (port closed'
                if ($null -ne $u.pathMs) { $title += ', path ' + (N $u.pathMs) + ' ms' }
                $title += ')'
            }
            else { $title += ' (no reply)' }
        }
        $it = New-Object System.Windows.Forms.ListViewItem($title)
        if ($answered) {
            [void]$it.SubItems.Add((N $u.avg))
            [void]$it.SubItems.Add((N $u.p95))
            [void]$it.SubItems.Add((N $u.jitter))
            [void]$it.SubItems.Add(((N $u.loss) + '%'))
        }
        else {
            # Silence and a closed port have no service latency and no loss to show.
            [void]$it.SubItems.Add((N $null))
            [void]$it.SubItems.Add((N $null))
            [void]$it.SubItems.Add((N $null))
            [void]$it.SubItems.Add((N $null))
        }
        if (-not $answered) { $it.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130) }
        elseif ($u.avg -gt 110) { $it.ForeColor = [System.Drawing.Color]::FromArgb(180, 30, 30) }
        elseif ($u.avg -gt 60) { $it.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0) }
        else { $it.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 60) }
        [void]$lvProbe.Items.Add($it)
    }
    $lvProbe.EndUpdate()
    $udpRows = @($p.udp | Where-Object { $null -ne $_ } | ForEach-Object {
        if ($_.state -eq 'answered') { 'UDP {0}: avg {1} p95 {2} jitter {3} loss {4}%' -f $_.label, (N $_.avg), (N $_.p95), (N $_.jitter), (N $_.loss) }
        elseif ($_.state -eq 'closed') { 'UDP {0}: port closed, path {1} ms (not service latency)' -f $_.label, (N $_.pathMs) }
        else { 'UDP {0}: no reply (not loss)' -f $_.label }
    })
    $rowsText = @(@($p.results | ForEach-Object { '{0}: avg {1} p95 {2} jitter {3} loss {4}%' -f $_.label, (N $_.avg), (N $_.p95), (N $_.jitter), (N $_.loss) }) + $udpRows) -join ' || '
    Log ("probe grid: {0} rows | {1}" -f $lvProbe.Items.Count, $rowsText)
    $udpNote = ''
    if ($null -ne $p.summary.udp) {
        $uSum = $p.summary.udp
        if ($uSum.answered -gt 0) { $udpNote = ' | UDP {0}/{1} answered, {2} ms' -f $uSum.answered, $uSum.targets, (N $uSum.serviceMs) }
        elseif ($uSum.closed -gt 0) { $udpNote = ' | UDP no service reply ({0}/{1} port closed)' -f $uSum.closed, $uSum.targets }
        else { $udpNote = ' | UDP unanswered, not loss' }
    }
    $lblProbeSummary.Text = (("game avg {0} ms | jitter {1} ms | loss {2}% | {3}/{4} reachable" -f (N $p.summary.gameAvgMs), (N $p.summary.gameJitter), (N $p.summary.gameLoss), $p.summary.reachable, $p.summary.endpoints) + $udpNote)
    if ($null -ne $p.summary.transport) {
        $t = $p.summary.transport
        if ($t.icmpAnswered -eq 0) { Log 'ICMP echo blocked; TCP figures stand alone' }
        elseif ($null -ne $t.gapMs -and [math]::Abs($t.gapMs) -ge 15) { Log ("TCP {0} ms vs ICMP {1} ms" -f $t.tcpMs, $t.icmpMs) }
    }
    # UDP figures exist only where a game service answered. A closed port is path evidence
    # and silence is not loss, so neither is logged as a latency or loss number.
    if ($null -ne $p.summary.udp) {
        $u = $p.summary.udp
        if ($u.answered -gt 0) { Log ("UDP {0}/{1} answered, avg {2} ms, worst loss {3}%" -f $u.answered, $u.targets, (N $u.serviceMs), (N $u.loss)) }
        elseif ($u.closed -gt 0) { Log ("UDP no service reply; {0}/{1} port(s) closed, path {2} ms" -f $u.closed, $u.targets, (N $u.pathMs)) }
        else { Log ("UDP unanswered on {0} endpoint(s); not counted as packet loss" -f $u.targets) }
    }
}

function Update-Bloat($b) {
    if ($null -eq $b) { $lblBloat.Text = ''; return }
    $parts = @()
    foreach ($pair in @(@('download', $b.download), @('upload', $b.upload))) {
        $name = $pair[0]
        $p = $pair[1]
        if ($null -eq $p) { continue }
        if ($p.grade -eq 'n/a') { $parts += ("{0} not measured" -f $name) }
        else { $parts += ("{0} grade {1} ({2} ms added, {3} Mbps)" -f $name, $p.grade, (N $p.deltaMs), (N $p.mbps)) }
    }
    $lblBloat.Text = ('Bufferbloat: ' + ($parts -join ' | '))
    Log ('bufferbloat: ' + $lblBloat.Text)
}

function Update-SoakSummary($sum) {
    $lvSoak.BeginUpdate()
    $lvSoak.Items.Clear()
    if ($null -eq $sum -or $null -eq $sum.targets) { $lvSoak.EndUpdate(); return }
    foreach ($t in $sum.targets) {
        $it = New-Object System.Windows.Forms.ListViewItem($t.label)
        [void]$it.SubItems.Add((N $t.avg))
        [void]$it.SubItems.Add((N $t.p95))
        [void]$it.SubItems.Add((N $t.p99))
        [void]$it.SubItems.Add((N $t.jitter))
        [void]$it.SubItems.Add((N $t.loss))
        [void]$it.SubItems.Add("$($t.spikes)")
        [void]$lvSoak.Items.Add($it)
    }
    $lvSoak.EndUpdate()
    $rowsText = @($sum.targets | ForEach-Object { '{0}: avg {1} p95 {2} loss {3}% spikes {4}' -f $_.label, (N $_.avg), (N $_.p95), (N $_.loss), $_.spikes }) -join ' || '
    Log ("soak grid: {0} rows | {1}" -f $lvSoak.Items.Count, $rowsText)
    if ($null -ne $sum.overall) {
        $lblSoakSummary.Text = ("run #{0} | {1} samples | avg {2} ms | p95 {3} ms | jitter {4} ms | {5}" -f $sum.runId, $sum.samples, (N $sum.overall.avg), (N $sum.overall.p95), (N $sum.overall.jitter), $sum.label)
    }
}

function Update-SoakProgress($st) {
    if ($null -eq $st) { return }
    $script:soakRunning = [bool]$st.running
    if ($st.running) {
        $pct = [int][math]::Min(100, [math]::Round(($st.elapsed / [math]::Max(1, $st.seconds)) * 100))
        $progress.Value = [math]::Max(0, [math]::Min(100, $pct))
        $lblSoakSummary.Text = ("running | {0}s of {1}s | {2} samples stored | ~{3} min left" -f $st.elapsed, $st.seconds, $st.samples, [math]::Ceiling(($st.seconds - $st.elapsed) / 60))
        $btnSoakStart.Enabled = $false
        $btnSoakStop.Enabled = $true
        if ($st.elapsed -ne $script:lastProgressLog) {
            $script:lastProgressLog = $st.elapsed
            if (($st.elapsed % 5) -eq 0) {
                Log ("soak progress: {0}s of {1}s | {2} samples | {3}%" -f $st.elapsed, $st.seconds, $st.samples, $pct)
            }
        }
    } else {
        $btnSoakStart.Enabled = $true
        $btnSoakStop.Enabled = $false
    }
}

# ------------------------------------------------------------------ commands

function Update-Drift($drift) {
    if ($null -eq $drift -or -not $drift.count) {
        $lblDrift.Text = ''
        $fixTip.SetToolTip($lblDrift, '')
        return
    }
    $lblDrift.Text = [string]$drift.text
    $details = @($drift.drifted | ForEach-Object { '- ' + $_.setting + ': ' + $_.observation })
    $fixTip.SetToolTip($lblDrift, ((@([string]$drift.text) + $details) -join "`r`n"))
    Log ('drift: ' + $drift.text)
}

function Refresh-State {
    Send-Cmd 'state' @{} {
        param($r)
        if (-not $r.ok) { Log ('state error: ' + $r.error); Set-Status ('Error: ' + $r.error) 'bad'; return }
        Log 'state received'
        # The first successful read replaces the startup placeholder, so the status bar does
        # not keep saying "Reading system state..." while the window is already populated.
        # A database that had to be set aside when the engine started is not a silent reset:
        # it takes the place of "Ready." in the status row, and the full sentence (the copy's
        # path included) rides along as the label's tooltip. Only on start-up, so a later
        # action's own result is never overwritten by it.
        if ($script:startupPending) {
            $script:startupPending = $false
            $dbState = $r.data.history
            if ($null -ne $dbState -and $null -ne $dbState.problem) {
                Log ('history problem: ' + $dbState.problem.message)
                $lblStatus.ToolTipText = [string]$dbState.problem.message
                $copyLeaf = if ($null -ne $dbState.problem.copy) { [System.IO.Path]::GetFileName([string]$dbState.problem.copy) } else { $null }
                if ($copyLeaf) {
                    Set-Status ("History database was damaged - set aside as $copyLeaf, so this run starts with an empty history.") 'warn'
                } else {
                    Set-Status ([string]$dbState.problem.message) 'warn'
                }
            } elseif ($null -ne $r.data.config -and $null -ne $r.data.config.problem) {
                Log ('settings problem: ' + $r.data.config.problem.message)
                $lblStatus.ToolTipText = [string]$r.data.config.problem.message
                $copyLeaf = if ($null -ne $r.data.config.problem.copy) { [System.IO.Path]::GetFileName([string]$r.data.config.problem.copy) } else { $null }
                if ($copyLeaf) {
                    Set-Status ("Settings file could not be used - the endpoint list is back to the built-in defaults, and the old file was kept as $copyLeaf.") 'warn'
                } else {
                    Set-Status ([string]$r.data.config.problem.message) 'warn'
                }
            } else {
                Set-Status 'Ready.' 'good'
            }
        }
        # The last before/after comparison and the last rollback are reported with the sentence the
        # page and the terminal use, so "rolled back" means the same thing in all three. What was
        # already in history when the window opened is not news: the first read only marks it seen.
        $bench = $r.data.benchmark
        if ($null -ne $bench) {
            $revertId = if ($null -ne $bench.lastRevert) { [string]$bench.lastRevert.id } else { '' }
            $compId = if ($null -ne $bench.latest) { [string]$bench.latest.id } else { '' }
            if (-not $script:benchSeen) {
                $script:benchSeen = $true
                $script:reportedRevert = $revertId
                $script:reportedComparison = $compId
            } else {
                if ($revertId -and $revertId -ne $script:reportedRevert) {
                    $script:reportedRevert = $revertId
                    Log ('rollback: ' + [string]$bench.lastRevert.summary)
                    if (-not $bench.lastRevert.data.restored) {
                        Set-Status ([string]$bench.lastRevert.summary) 'warn'
                    }
                }
                if ($compId -and $compId -ne $script:reportedComparison) {
                    $script:reportedComparison = $compId
                    Log ('before/after: ' + [string]$bench.latest.summary)
                }
            }
        }
        $script:catalog = $r.data.catalog
        Update-Overview $r.data
        Update-Fixes $r.data.tweak
        Update-Drift $r.data.drift
        if (-not $script:soakRunning) { Update-SoakProgress $r.data.soak }
    }
}

function Send-Tweak([string]$action, [string]$presetId) {
    Set-Status 'Waiting for the Windows administrator prompt - click Yes; nothing changes until you do.' 'warn'
    $tweakArgs = if ($presetId) { @{ preset = $presetId } } else { @{ action = $action } }
    Send-Cmd 'apply' $tweakArgs {
        param($r)
        if (-not $r.ok) { Set-Status ('Error: ' + $r.error) 'bad'; return }
        if ($null -ne $r.data.tweak) { Update-Fixes $r.data.tweak }
        $msg = if ($r.data.message) { $r.data.message } else { 'Done.' }
        $kind = if ($r.data.kind -eq 'bad') { 'bad' } elseif ($r.data.kind -eq 'warn') { 'warn' } else { 'good' }
        Set-Status $msg $kind
        Refresh-State
    }
}

# ------------------------------------------------------------------- handlers

$btnRefresh.Add_Click({ Refresh-State })
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

$btnDnsBench.Add_Click({
    Set-Status 'Benchmarking DNS resolvers - this takes about 20 seconds...' 'info'
    $btnDnsBench.Enabled = $false
    Send-Cmd 'dns' @{} {
        param($r)
        $btnDnsBench.Enabled = $true
        if (-not $r.ok) { Set-Status ('DNS benchmark failed: ' + $r.error) 'bad'; return }
        $res = $null
        if ($null -ne $r.data -and $null -ne $r.data.dns) { $res = $r.data.dns.result }
        $winner = $null
        if ($null -ne $res -and $res.best) {
            $winner = $res.resolvers | Where-Object { $_.id -eq $res.best } | Select-Object -First 1
        }
        if ($null -eq $winner) {
            $detail = 'no resolver answered'
            if ($null -ne $res) {
                if ($null -ne $res.gapPct -and $res.gapPct -gt 0) { $detail = "$($res.leader) led by only $($res.gapPct)%" }
                else { $detail = 'the resolvers are level' }
            }
            Set-Status "No clear winner ($detail), so DNS was left alone - it affects joins, not in-game ping." 'warn'
            return
        }
        $servers = @($winner.servers)
        $question = "$($winner.label) answered fastest.`n`nPoint this adapter's DNS at $($servers -join ', ')?"
        $answer = [System.Windows.Forms.MessageBox]::Show($question, 'Use this resolver?', 'YesNo', 'Question')
        if ($answer -ne 'Yes') { Set-Status 'DNS left unchanged.' 'info'; return }
        Send-Tweak 'dns-best'
    }
})

$btnDnsAuto.Add_Click({ Send-Tweak 'dns-reset' })

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

# ------------------------------------------------------------------- startup

[void]$form.Show()
[void]$form.Refresh()

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
    $script:benchSeen = $false
    Refresh-State
    Send-Cmd 'soakStatus' @{} {
        param($r)
        if (-not $r.ok) { return }
        Update-SoakProgress $r.data.soak
        if (-not $r.data.soak.running -and $null -ne $r.data.summary) { Update-SoakSummary $r.data.summary }
    }
}

while ($form.Visible) {
    [System.Windows.Forms.Application]::DoEvents()
    Poll-Bridge
    Start-Sleep -Milliseconds 40
}

$timer.Stop()
try {
    if ($started -and -not $script:proc.HasExited) {
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
Log 'script end'
