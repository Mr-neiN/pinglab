<#
  Check a release folder against its own SHA256SUMS.txt before it is published.

  build.ps1 writes dist/SHA256SUMS.txt from the zip and exe it has just produced. Publishing
  that file without reading it back trusts the build to have hashed exactly what it shipped: a
  truncated installer, a stale artifact left over from an earlier build, or a checksum file
  written from the wrong folder would all go out as a download whose published hash nobody can
  match. This recomputes every hash from the bytes on disk.

  It also refuses the other direction: an artifact in dist that SHA256SUMS.txt does not cover
  (a second build leaving an older setup behind) makes the release ambiguous, because the
  release job uploads every dist/PingLab-* file.

  Nothing is written or moved. A mismatch stops the release instead of being published.

  Usage:
    installer\verify-release.ps1                 checks dist\ beside this script's parent
    installer\verify-release.ps1 -Dist <folder>  checks another folder
  Exit: 0 every artifact matches, 1 otherwise.
#>
param([string]$Dist = "")

$ErrorActionPreference = "Stop"

if (-not $Dist) { $Dist = Join-Path (Split-Path -Parent $PSScriptRoot) "dist" }
$sumsPath = Join-Path $Dist "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) {
    throw "no $sumsPath - build.ps1 writes it beside the artifacts"
}

$listed = @{}
$lines = @([System.IO.File]::ReadAllLines($sumsPath) | Where-Object { $_.Trim() -ne "" })
if ($lines.Count -eq 0) { throw "$sumsPath is empty" }

foreach ($line in $lines) {
    # The format build.ps1 writes is "<sha256>  <name>", the same one sha256sum -c reads; the
    # optional "*" is the binary-mode marker other tools add, so both are accepted.
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
        throw "unreadable checksum line: $line"
    }
    $want = $Matches[1].ToLowerInvariant()
    $name = $Matches[2]
    if ($listed.ContainsKey($name)) { throw "$name is listed twice in $sumsPath" }
    $path = Join-Path $Dist $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "$name is listed in $sumsPath but is not in $Dist"
    }
    $got = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $want) {
        throw "$name does not match its checksum (listed $want, found $got)"
    }
    $listed[$name] = $true
    Write-Host "ok   $name  $want"
}

$artifacts = @(Get-ChildItem -LiteralPath $Dist -File | Where-Object { $_.Extension -in ".zip", ".exe" })
if ($artifacts.Count -eq 0) { throw "no .zip or .exe artifacts in $Dist" }
foreach ($file in $artifacts) {
    if (-not $listed.ContainsKey($file.Name)) {
        throw "$($file.Name) is in $Dist but not in $sumsPath"
    }
}

Write-Host "verified $($artifacts.Count) artifact(s) against $sumsPath"
