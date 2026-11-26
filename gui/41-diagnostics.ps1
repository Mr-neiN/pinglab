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
            elseif ($u.state -eq 'challenge') {
                $title += ' (challenge answered'
                if ($null -ne $u.challengeAvgMs) { $title += ' in ' + (N $u.challengeAvgMs) + ' ms' }
                $title += '; follow-up never completed - not a reply)'
            }
            elseif ($u.state -eq 'unexpected') { $title += ' (replied with something else, untimed)' }
            elseif ($u.state -eq 'mismatched') { $title += ' (datagrams from a different address/port, untimed)' }
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
        elseif ($_.state -eq 'challenge') { 'UDP {0}: challenge answered in {1} ms, follow-up never completed (not a reply)' -f $_.label, (N $_.challengeAvgMs) }
        elseif ($_.state -eq 'closed') { 'UDP {0}: port closed, path {1} ms (not service latency)' -f $_.label, (N $_.pathMs) }
        elseif ($_.state -eq 'unexpected') { 'UDP {0}: replied with something else, untimed (not loss)' -f $_.label }
        elseif ($_.state -eq 'mismatched') { 'UDP {0}: datagrams came from a different address/port, untimed (not loss)' -f $_.label }
        else { 'UDP {0}: no reply (not loss)' -f $_.label }
    })
    $rowsText = @(@($p.results | ForEach-Object { '{0}: avg {1} p95 {2} jitter {3} loss {4}%' -f $_.label, (N $_.avg), (N $_.p95), (N $_.jitter), (N $_.loss) }) + $udpRows) -join ' || '
    Log ("probe grid: {0} rows | {1}" -f $lvProbe.Items.Count, $rowsText)
    $udpNote = ''
    if ($null -ne $p.summary.udp) {
        $uSum = $p.summary.udp
        if ($uSum.answered -gt 0) {
            $udpNote = ' | UDP {0}/{1} answered, {2} ms' -f $uSum.answered, $uSum.targets, (N $uSum.serviceMs)
            if ($uSum.challenge -gt 0) { $udpNote += ' | {0} challenge-only' -f $uSum.challenge }
        }
        elseif ($uSum.challenge -gt 0) { $udpNote = ' | UDP no completed reply ({0}/{1} challenge only)' -f $uSum.challenge, $uSum.targets }
        elseif ($uSum.closed -gt 0) { $udpNote = ' | UDP no service reply ({0}/{1} port closed)' -f $uSum.closed, $uSum.targets }
        else { $udpNote = ' | UDP unanswered, not loss' }
        if ($uSum.mismatched -gt 0) { $udpNote += ' | {0} wrong source, untimed' -f $uSum.mismatched }
        if ($uSum.unexpected -gt 0) { $udpNote += ' | {0} wrong reply, untimed' -f $uSum.unexpected }
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
        if ($u.answered -gt 0) { Log ("UDP {0}/{1} answered, avg {2} ms, worst loss {3}%; {4} challenge-only" -f $u.answered, $u.targets, (N $u.serviceMs), (N $u.loss), $u.challenge) }
        elseif ($u.challenge -gt 0) { Log ("UDP no completed reply; {0}/{1} challenge only, {2} ms challenge RTT" -f $u.challenge, $u.targets, (N $u.challengeMs)) }
        elseif ($u.closed -gt 0) { Log ("UDP no service reply; {0}/{1} port(s) closed, path {2} ms" -f $u.closed, $u.targets, (N $u.pathMs)) }
        else { Log ("UDP unanswered on {0} endpoint(s); not counted as packet loss" -f $u.targets) }
        if ($u.mismatched -gt 0) { Log ("UDP {0} endpoint(s) sent datagrams from a different address/port; untimed" -f $u.mismatched) }
        if ($u.unexpected -gt 0) { Log ("UDP {0} endpoint(s) sent a datagram that did not match the query; untimed" -f $u.unexpected) }
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

