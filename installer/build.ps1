<#
  Builds the release artifacts into <repo>\dist:

    PingLab-<version>-portable.zip     the app, no install step
    PingLab-Setup-<version>.exe        per-user installer (Inno Setup)
    SHA256SUMS.txt                     hashes of both

  Usage:
    installer\build.ps1                       version from package.json
    installer\build.ps1 -Version 1.0.1        an explicit version
    installer\build.ps1 -RequireInstaller     fail if Inno Setup is missing (CI)

  ISCC is looked up on PATH, then in the usual Inno Setup 6 locations. Without
  it the portable zip is still produced and the installer is skipped with a warning.
#>
param(
    [string]$Version = "",
    [switch]$RequireInstaller,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

if (-not $Version) {
    $Version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
}
$Version = $Version.Trim().TrimStart("v", "V")
if ($Version -notmatch '^\d+\.\d+\.\d+') {
    throw "Version must start with major.minor.patch (got '$Version')"
}
$packageVersion = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
if ($packageVersion -ne $Version) {
    Write-Warning "package.json says $packageVersion, building $Version"
}

$stage = Join-Path $dist "PingLab-$Version"
$zip = Join-Path $dist "PingLab-$Version-portable.zip"
$setup = Join-Path $dist "PingLab-Setup-$Version.exe"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $setup) { Remove-Item $setup -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Everything the app needs to run, and nothing it writes (data/, .freebuff/, dist/).
$items = @(
    "pinglab.mjs",
    "server.mjs",
    "PingLab.ps1",
    "PingLab.cmd",
    "PingLab-TUI.cmd",
    "package.json",
    "README.md",
    "lib",
    "public"
)
foreach ($item in $items) {
    Copy-Item (Join-Path $root $item) (Join-Path $stage $item) -Recurse -Force
}

Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Write-Host "portable zip: $zip"

function Find-Iscc {
    $onPath = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

if (-not $SkipInstaller) {
    $iscc = Find-Iscc
    if ($iscc) {
        # Inno Setup 6 wants /DAppVersion=..., Inno Setup 7 wants --define=...; a generated
        # include avoids depending on either.
        Set-Content -Path (Join-Path $PSScriptRoot "version.iss") -Value "#define AppVersion `"$Version`"" -Encoding ascii
        & $iscc (Join-Path $PSScriptRoot "pinglab.iss")
        if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
        if (-not (Test-Path $setup)) { throw "ISCC reported success but $setup does not exist" }
        Write-Host "installer:    $setup"
    } elseif ($RequireInstaller) {
        throw "Inno Setup (ISCC.exe) was not found; install it with: choco install innosetup -y"
    } else {
        Write-Warning "Inno Setup (ISCC.exe) not found - portable zip only. CI installs it with choco."
    }
}

# One writer for the format, shared with the release workflow's post-signing step: two
# copies of this rule is how a signed installer ends up with a hash of its unsigned bytes.
& (Join-Path $PSScriptRoot "write-checksums.ps1") -Dist $dist
$artifacts = Get-ChildItem $dist -File | Where-Object { $_.Extension -in ".zip", ".exe" } | Sort-Object Name
$artifacts | ForEach-Object { "{0,-38} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB) }
