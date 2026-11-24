<#
  Writes dist\SHA256SUMS.txt for a release folder: one "<sha256>  <name>" line per .zip/.exe,
  sorted by name, LF line endings, no BOM.

  It is a script because two places write this file and they must not disagree: build.ps1 after
  it has built the artifacts, and the release workflow again after Authenticode signing, because
  signing changes the installer's bytes and the hashes written at build time would then describe
  a file nobody downloads. verify-release.ps1 reads the result back and refuses a release whose
  hashes do not match the bytes on disk.

  The format is the one `sha256sum -c` reads, so a hash published here can be checked anywhere.
  A trailing CR would become part of the filename there and report every published file missing,
  hence the explicit LF/no-BOM write.

  Usage:
    installer\write-checksums.ps1                 writes into dist\ beside this script's parent
    installer\write-checksums.ps1 -Dist <folder>  writes into another folder
#>
param([string]$Dist = "")

$ErrorActionPreference = "Stop"

if (-not $Dist) { $Dist = Join-Path (Split-Path -Parent $PSScriptRoot) "dist" }
if (-not (Test-Path -LiteralPath $Dist -PathType Container)) {
    throw "no folder at $Dist - build the artifacts before writing checksums"
}
$folder = (Resolve-Path -LiteralPath $Dist).Path

$files = @(Get-ChildItem -LiteralPath $folder -File -ErrorAction Stop |
    Where-Object { $_.Extension -in ".zip", ".exe" } |
    Sort-Object Name)
if ($files.Count -eq 0) { throw "no .zip or .exe artifacts in $folder" }

$lines = foreach ($file in $files) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($file.Name)"
}

$path = Join-Path $folder "SHA256SUMS.txt"
[System.IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
Write-Host "checksums:    $path"
$files | ForEach-Object { Write-Host ("              {0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name) }
