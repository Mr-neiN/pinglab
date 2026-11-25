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

# The one benchmark path: the DNS row's button and the DNS tab's button both call this.
function Update-Dns($d) {
    $result = $null
    if ($null -ne $d -and $null -ne $d.dns) { $result = $d.dns.result }
    $lvDns.BeginUpdate()
    try {
        $lvDns.Items.Clear()
        if ($null -ne $result) {
            foreach ($row in @($result.resolvers)) {
                if ($null -eq $row) { continue }
                $it = New-Object System.Windows.Forms.ListViewItem([string]$row.label)
                [void]$it.SubItems.Add((N $row.median))
                [void]$it.SubItems.Add((N $row.worst))
                [void]$it.SubItems.Add(("{0}/{1}" -f $row.answered, $result.domains))
                $note = if ($null -ne $d.winner -and ([string]$d.winner.id -eq [string]$row.id)) { 'winner' } else { '' }
                [void]$it.SubItems.Add($note)
                [void]$lvDns.Items.Add($it)
            }
        }
    } finally {
        $lvDns.EndUpdate()
    }
    $lblDnsVerdict.Text = if ($null -ne $d -and $d.verdict) { [string]$d.verdict } else { 'Run the benchmark to compare the resolvers PingLab knows; it changes nothing on its own.' }
    $servers = @()
    if ($null -ne $d -and $null -ne $d.dns -and $null -ne $d.dns.current) { $servers = @($d.dns.current.servers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    $lblDnsCurrent.Text = if ($servers.Count -gt 0) { 'Current: ' + ($servers -join ', ') } else { 'Current: automatic' }
    $script:dnsWinner = if ($null -ne $d) { $d.winner } else { $null }
    $btnDnsUse.Enabled = ($null -ne $script:dnsWinner)
    $script:dnsDone = $true
}

function Invoke-DnsBenchmark {
    Set-Status 'Benchmarking DNS resolvers - this takes about 20 seconds...' 'info'
    $btnDnsBench.Enabled = $false
    $btnDnsRun.Enabled = $false
    Send-Cmd 'dns' @{} {
        param($r)
        $btnDnsBench.Enabled = $true
        $btnDnsRun.Enabled = $true
        if (-not $r.ok) { Set-Status ('DNS benchmark failed: ' + $r.error) 'bad'; return }
        Update-Dns $r.data
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
                elseif ($null -ne $res.leader) { $detail = 'the resolvers are level' }
            }
            Set-Status "No clear winner ($detail), so DNS was left alone - it affects joins, not in-game ping." 'warn'
            return
        }
        # The headless self-test reads the table; it must never wait on a dialog.
        if ($env:PINGLAB_GUI_DNSTEST) {
            Set-Status ("$($winner.label) answered fastest - the self-test leaves DNS alone.") 'info'
            return
        }
        $servers = @($winner.servers)
        $question = "$($winner.label) answered fastest.`n`nPoint this adapter's DNS at $($servers -join ', ')?"
        $answer = [System.Windows.Forms.MessageBox]::Show($question, 'Use this resolver?', 'YesNo', 'Question')
        if ($answer -ne 'Yes') { Set-Status 'DNS left unchanged.' 'info'; return }
        Send-Tweak 'dns-best'
    }
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
                $script:startupProblem = $true
                $lblStatus.ToolTipText = [string]$dbState.problem.message
                $copyLeaf = if ($null -ne $dbState.problem.copy) { [System.IO.Path]::GetFileName([string]$dbState.problem.copy) } else { $null }
                if ($copyLeaf) {
                    Set-Status ("History database was damaged - set aside as $copyLeaf, so this run starts with an empty history.") 'warn'
                } else {
                    Set-Status ([string]$dbState.problem.message) 'warn'
                }
            } elseif ($null -ne $r.data.config -and $null -ne $r.data.config.problem) {
                Log ('settings problem: ' + $r.data.config.problem.message)
                $script:startupProblem = $true
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
        # A newer release is worth one line in the status row the first time it is known. The
        # check runs in the engine's background, so it can arrive after the first state read; it
        # is reported once, and it never displaces a start-up problem, which is about this machine
        # rather than about a newer build.
        $upd = $r.data.update
        if (-not $script:updateSeen -and -not $script:startupProblem -and $null -ne $upd -and -not [string]::IsNullOrWhiteSpace([string]$upd.sentence)) {
            $script:updateSeen = $true
            Log ('update: ' + [string]$upd.sentence)
            $lblStatus.ToolTipText = [string]$upd.sentence
            Set-Status ([string]$upd.sentence) 'warn'
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
        # The picker first: every row below is read from the adapter it selects.
        Update-AdapterPicker $r.data
        Update-Overview $r.data
        Update-Fixes $r.data.tweak $r.data.pending
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
        if ($null -ne $r.data.tweak) { Update-Fixes $r.data.tweak $r.data.pending }
        $msg = if ($r.data.message) { $r.data.message } else { 'Done.' }
        $kind = if ($r.data.kind -eq 'bad') { 'bad' } elseif ($r.data.kind -eq 'warn') { 'warn' } else { 'good' }
        Set-Status $msg $kind
        Refresh-State
    }
}

