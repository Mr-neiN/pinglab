# ------------------------------------------------- adapter the settings target
# Which adapter the rows are read from and written to, chosen once and saved by the engine
# (bridge command `adapter`, the same path /api/adapter uses), so every Fixes row, the drift
# sentence, the DNS-in-use line and the restore points below describe that adapter.

$tlpAdapterRow = New-Object System.Windows.Forms.TableLayoutPanel
$tlpAdapterRow.Dock = 'Fill'
$tlpAdapterRow.ColumnCount = 3
$tlpAdapterRow.RowCount = 2
[void]$tlpAdapterRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 112)))
[void]$tlpAdapterRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 330)))
[void]$tlpAdapterRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tlpAdapterRow.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 28)))
[void]$tlpAdapterRow.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 28)))

$lblAdapterTitle = New-Object System.Windows.Forms.Label
$lblAdapterTitle.Text = 'Settings apply to'
$lblAdapterTitle.AutoSize = $true
$lblAdapterTitle.TextAlign = 'MiddleLeft'
$lblAdapterTitle.Margin = New-Object System.Windows.Forms.Padding(0, 8, 6, 0)

$cmbAdapter = New-Object System.Windows.Forms.ComboBox
$cmbAdapter.DropDownStyle = 'DropDownList'
$cmbAdapter.Dock = 'Fill'
$cmbAdapter.Margin = New-Object System.Windows.Forms.Padding(0, 4, 8, 4)

$chkVirtual = New-Object System.Windows.Forms.CheckBox
$chkVirtual.Text = 'show virtual / VPN adapters'
$chkVirtual.AutoSize = $true
$chkVirtual.Margin = New-Object System.Windows.Forms.Padding(0, 7, 6, 0)

# The same sentences the page and the terminal print for a VPN on the default route and for a
# remembered adapter that has left the machine.
$lblAdapterNote = New-Object System.Windows.Forms.Label
$lblAdapterNote.AutoSize = $false
$lblAdapterNote.AutoEllipsis = $true
$lblAdapterNote.Dock = 'Fill'
$lblAdapterNote.TextAlign = 'MiddleLeft'
$lblAdapterNote.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$lblAdapterNote.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$lblAdapterNote.Margin = New-Object System.Windows.Forms.Padding(0)

$tlpAdapterRow.Controls.Add($lblAdapterTitle, 0, 0)
$tlpAdapterRow.Controls.Add($cmbAdapter, 1, 0)
$tlpAdapterRow.Controls.Add($chkVirtual, 2, 0)
$tlpAdapterRow.Controls.Add($lblAdapterNote, 0, 1)
$tlpAdapterRow.SetColumnSpan($lblAdapterNote, 3)
$tlpFixes.Controls.Add($tlpAdapterRow, 0, 6)
$tlpFixes.SetColumnSpan($tlpAdapterRow, 3)

$lblDrift = New-Object System.Windows.Forms.Label
$lblDrift.Dock = 'Fill'
$lblDrift.AutoSize = $false
$lblDrift.AutoEllipsis = $true
$lblDrift.TextAlign = 'MiddleLeft'
$lblDrift.ForeColor = [System.Drawing.Color]::FromArgb(165, 105, 0)
$lblDrift.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$lblDrift.Margin = New-Object System.Windows.Forms.Padding(0, 6, 8, 0)
$tlpFixes.Controls.Add($lblDrift, 0, 7)
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
$tlpFixes.Controls.Add($panelRestore, 0, 8)
$tlpFixes.SetColumnSpan($panelRestore, 3)

# The restore points, each with the adapter it belongs to: undoing a change is never a guess
# about which device it was written to.
$tlpRestorePoints = New-Object System.Windows.Forms.TableLayoutPanel
$tlpRestorePoints.Dock = 'Fill'
$tlpRestorePoints.ColumnCount = 1
$tlpRestorePoints.RowCount = 2
[void]$tlpRestorePoints.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 22)))
[void]$tlpRestorePoints.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))

$lblRestorePoints = New-Object System.Windows.Forms.Label
$lblRestorePoints.Text = 'Restore points - what each active change can put back, and which adapter it was written to.'
$lblRestorePoints.AutoSize = $true
$lblRestorePoints.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$lblRestorePoints.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 0)

$lvRestore = New-Grid @('Setting', 'Adapter', 'Restored to', 'When') @(240, 150, 300, 90)
$tlpRestorePoints.Controls.Add($lblRestorePoints, 0, 0)
$tlpRestorePoints.Controls.Add($lvRestore, 0, 1)
$tlpFixes.Controls.Add($tlpRestorePoints, 0, 9)
$tlpFixes.SetColumnSpan($tlpRestorePoints, 3)
$tabFixes.Controls.Add($tlpFixes)
[void]$tabs.TabPages.Add($tabFixes)

