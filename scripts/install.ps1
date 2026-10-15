# Installs the madarch Windows x64 release binary without a build.
#
#   irm https://raw.githubusercontent.com/shady2k/madarch/main/scripts/install.ps1 | iex
#   & .\scripts\install.ps1 [vX.Y.Z]

[CmdletBinding()]
param([string]$Version = '')
$ErrorActionPreference = 'Stop'
$Repo = 'shady2k/madarch'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'madarch does not support Windows arm64: LadybugDB 0.20.4 has no Windows arm64 package.'
  }
  throw "madarch publishes Windows x64 binaries; this machine is $env:PROCESSOR_ARCHITECTURE."
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
}
if ([string]::IsNullOrWhiteSpace($Version)) { throw 'The latest madarch release could not be read; pass a version such as v1.2.3.' }
$Artifact = 'madarch-windows-x64.exe'
$Base = if ($env:MADARCH_RELEASE_BASE) { $env:MADARCH_RELEASE_BASE.TrimEnd('/') } else { "https://github.com/$Repo/releases/download/$Version" }
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$TargetDir = if ($env:MADARCH_INSTALL_PREFIX) { $env:MADARCH_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA 'madarch\bin' }
$Target = Join-Path $TargetDir 'madarch.exe'
try {
  New-Item -ItemType Directory -Path $Temp -Force | Out-Null
  $binaryPath = Join-Path $Temp $Artifact
  $sumFile = Join-Path $Temp 'SHA256SUMS.txt'
  if ($Base.StartsWith('file://')) {
    $sourceDir = ([Uri]$Base).LocalPath
    Copy-Item (Join-Path $sourceDir $Artifact) $binaryPath
    Copy-Item (Join-Path $sourceDir 'SHA256SUMS.txt') $sumFile
  } else {
    Invoke-WebRequest "$Base/$Artifact" -OutFile $binaryPath
    Invoke-WebRequest "$Base/SHA256SUMS.txt" -OutFile $sumFile
  }
  $line = Get-Content $sumFile | Where-Object { $_ -match "\s+$([regex]::Escape($Artifact))$" } | Select-Object -First 1
  if (-not $line) { throw "The release SHA256SUMS.txt has no entry for $Artifact." }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "The downloaded $Artifact failed SHA256 verification (expected $expected, got $actual)." }
  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
  Copy-Item $binaryPath $Target -Force
  Write-Output "Installed madarch $Version at $Target"
  & $Target version
  if ($env:PATH -notlike "*$TargetDir*") { Write-Warning "Add $TargetDir to PATH to run madarch from a new terminal." }
} finally {
  Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
