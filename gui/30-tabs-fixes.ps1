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
$tlpFixes.RowCount = 10
[void]$tlpFixes.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 300)))
[void]$tlpFixes.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tlpFixes.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 160)))
for ($i = 0; $i -lt 6; $i++) {
    [void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 74)))
}
# Which adapter the rows below read and write, above them because it scopes all of them.
[void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 58)))
# Then the drift sentence: a setting PingLab wrote that Windows has since put back is the one
# thing the rows themselves cannot show.
[void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34)))
# The preset/restore buttons, then the restore points they would put back and on which adapter.
[void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 46)))
# The restore-point list, kept reachable by scrolling on a screen too short to show it.
[void]$tlpFixes.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 165)))
$tlpFixes.AutoScroll = $true

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
$rowNagle = New-FixRow 2 "TCP buffering / ACK timing" 'TCPNoDelay (Nagle) and TcpAckFrequency (delayed ACK), TCP only'
$rowWifi = New-FixRow 3 'Wi-Fi radio power save (desktop)' 'MIMO power save + roaming aggressiveness, from the driver itself.'
$rowOrder = New-FixRow 4 'Wi-Fi auto-connect order' 'netsh wlan show profiles order - the network Windows rejoins after an adapter reset.'
$rowDns = New-FixRow 5 'DNS servers' 'Benchmark the resolvers PingLab knows, or hand the adapter back to your router.' 'Automatic'
$rowDns.Button.Text = 'Benchmark'

