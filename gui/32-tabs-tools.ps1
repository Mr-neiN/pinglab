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

# --------------------------------------------------------------------- tab: dns
# The same benchmark the terminal and the page run: the button sends the bridge's `dns`
# command, and the table, verdict and winner come back from lib/dns.mjs and lib/report.mjs.
# This tab only draws them, so the three surfaces cannot disagree about what was measured.

$tabDns = New-Tab 'DNS'
$tlpDns = New-Object System.Windows.Forms.TableLayoutPanel
$tlpDns.Dock = 'Fill'
$tlpDns.ColumnCount = 1
$tlpDns.RowCount = 4
[void]$tlpDns.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 40)))
[void]$tlpDns.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tlpDns.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 46)))
[void]$tlpDns.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 26)))

$panelDnsTop = New-Object System.Windows.Forms.Panel
$panelDnsTop.Dock = 'Fill'
$btnDnsRun = New-Button 'Benchmark resolvers' 180
$btnDnsRun.Location = New-Object System.Drawing.Point(0, 4)
$panelDnsTop.Controls.Add($btnDnsRun)
$btnDnsUse = New-Button 'Use winner' 130
$btnDnsUse.Location = New-Object System.Drawing.Point(190, 4)
$btnDnsUse.Enabled = $false
$panelDnsTop.Controls.Add($btnDnsUse)
$btnDnsAutomatic = New-Button 'Automatic (router)' 160
$btnDnsAutomatic.Location = New-Object System.Drawing.Point(330, 4)
$panelDnsTop.Controls.Add($btnDnsAutomatic)
$tlpDns.Controls.Add($panelDnsTop, 0, 0)

$lvDns = New-Grid @('Resolver', 'median ms', 'worst ms', 'answered', 'note') @(220, 100, 100, 100, 260)
$tlpDns.Controls.Add($lvDns, 0, 1)

$lblDnsVerdict = New-Object System.Windows.Forms.Label
$lblDnsVerdict.Dock = 'Fill'
$lblDnsVerdict.AutoSize = $false
$lblDnsVerdict.TextAlign = 'MiddleLeft'
$lblDnsVerdict.Text = 'Run the benchmark to compare the resolvers PingLab knows; it changes nothing on its own.'
$tlpDns.Controls.Add($lblDnsVerdict, 0, 2)

$lblDnsCurrent = New-Object System.Windows.Forms.Label
$lblDnsCurrent.Dock = 'Fill'
$lblDnsCurrent.TextAlign = 'MiddleLeft'
$lblDnsCurrent.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$lblDnsCurrent.Text = 'Current: automatic'
$tlpDns.Controls.Add($lblDnsCurrent, 0, 3)
$tabDns.Controls.Add($tlpDns)
[void]$tabs.TabPages.Add($tabDns)

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

