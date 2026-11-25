# ---------------------------------------------------------------------- ui

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PingLab - network doctor'
# Tall enough for the Fixes tab to show its own restore points below the buttons; anything
# shorter scrolls that tab rather than clipping them.
$form.Size = New-Object System.Drawing.Size(960, 820)
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

