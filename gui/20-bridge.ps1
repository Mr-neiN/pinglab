# ------------------------------------------------------------------ bridge

$script:pending = @{}
$script:inflight = 0

function Send-Cmd([string]$cmd, $cmdArgs, [scriptblock]$onResult) {
    if ($script:proc.HasExited) {
        Set-Status 'The engine process stopped. Restart PingLab.' 'bad'
        return
    }
    # The answer is routed by its id, not by arrival order: a response can only ever reach the
    # callback that asked for it, even if a busy engine answers out of order or a line is
    # delayed. A queue of callbacks silently mis-attributed a soak answer to the state read on
    # the CI runner and left the picker empty.
    $id = [guid]::NewGuid().ToString('N')
    $script:pending[$id] = $onResult
    $script:inflight = $script:pending.Count
    $msg = @{ id = $id; cmd = $cmd; args = $cmdArgs } | ConvertTo-Json -Compress -Depth 10
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
        $obj = $null
        try { $obj = $line | ConvertFrom-Json } catch { Log ('response not JSON: ' + $line.Substring(0, [math]::Min(120, $line.Length))); continue }
        $id = [string]$obj.id
        $cb = $script:pending[$id]
        if ($null -eq $cb) {
            Log ('response for no pending request: ' + $id)
            continue
        }
        $script:pending.Remove($id)
        $script:inflight = $script:pending.Count
        & $cb $obj
    }
}

