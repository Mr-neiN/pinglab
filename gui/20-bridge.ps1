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

