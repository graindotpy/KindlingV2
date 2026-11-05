[CmdletBinding()]
param(
  [string]$Target = "admin@192.168.4.148",
  [string]$RemoteAppDir = "/DATA/AppData/kindling-bookshelf-hardcover-pilot",
  [string]$UpstreamRepository = "https://github.com/blampe/rreading-glasses.git",
  [string]$UpstreamCommit = "a2939b625d91389d3f0a3e58cbc3bfa7ebb8390a",
  [ValidateRange(60, 600)]
  [int]$HealthTimeoutSeconds = 240,
  [switch]$SkipLiveSearch,
  [switch]$KeepRemoteArtifacts,
  [switch]$KeepLocalArtifacts,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "`n[hardcover-pilot] $Message" -ForegroundColor Cyan
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found."
  }
}

function Invoke-NativeCommand {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)."
  }
}

function Remove-SafeTemporaryDirectory {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
    return
  }

  $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  $parentPath = [System.IO.Path]::GetDirectoryName($resolvedPath).TrimEnd('\')
  $leaf = [System.IO.Path]::GetFileName($resolvedPath)

  if ($parentPath -ne $tempRoot -or -not $leaf.StartsWith('kindling-hardcover-pilot-')) {
    throw "Refusing to remove unexpected temporary path '$resolvedPath'."
  }

  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

if ($Target -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$') {
  throw "Target must look like user@hostname and contain no shell metacharacters."
}
if ($RemoteAppDir -notmatch '^/DATA/AppData/[A-Za-z0-9._/-]+$' -or
    $RemoteAppDir -match '(^|/)\.\.?(/|$)' -or $RemoteAppDir.Contains('//')) {
  throw "RemoteAppDir must be a safe absolute path below /DATA/AppData."
}
if ($UpstreamRepository -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$') {
  throw "UpstreamRepository must be a GitHub HTTPS clone URL."
}
if ($UpstreamCommit -notmatch '^[0-9a-f]{40}$') {
  throw "UpstreamCommit must be a full lowercase Git commit SHA."
}

$scriptDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
$patchPath = Join-Path $scriptDirectory "patches/0001-limit-hardcover-graphql-batches.patch"
$composePath = Join-Path $scriptDirectory "compose.yaml"
$envExamplePath = Join-Path $scriptDirectory "pilot.env.example"
$remoteHelperPath = Join-Path $scriptDirectory "deploy-zimaos.sh"

foreach ($file in @($patchPath, $composePath, $envExamplePath, $remoteHelperPath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Required pilot file was not found: $file"
  }
}

$remoteHelperBytes = [System.IO.File]::ReadAllBytes($remoteHelperPath)
if ($remoteHelperBytes -contains 13) {
  throw "The ZimaOS helper must use Linux LF line endings."
}

foreach ($command in @("git", "tar")) {
  Require-Command $command
}
if (-not $DryRun) {
  Require-Command "scp"
  Require-Command "ssh"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$nonce = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "kindling-hardcover-pilot-$timestamp-$nonce"
$bundleDirectory = Join-Path $temporaryDirectory "bundle"
$sourceDirectory = Join-Path $bundleDirectory "rreading-glasses"
$archivePath = Join-Path $temporaryDirectory "hardcover-pilot.tar.gz"

New-Item -ItemType Directory -Path $bundleDirectory | Out-Null

try {
  Write-Step "Fetching pinned rreading-glasses source $UpstreamCommit"
  Invoke-NativeCommand "git" @(
    "clone", "--filter=blob:none", "--no-checkout", "--quiet",
    $UpstreamRepository, $sourceDirectory
  ) "Could not clone rreading-glasses"
  Invoke-NativeCommand "git" @(
    "-C", $sourceDirectory, "checkout", "--detach", "--quiet", $UpstreamCommit
  ) "Could not check out the pinned rreading-glasses commit"

  $resolvedCommit = (& git -C $sourceDirectory rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $UpstreamCommit) {
    throw "The checked-out rreading-glasses source did not match the pinned commit."
  }

  Write-Step "Applying the locally owned Hardcover reliability patch"
  Invoke-NativeCommand "git" @(
    "-C", $sourceDirectory, "apply", "--check", $patchPath
  ) "The local Hardcover patch no longer applies cleanly"
  Invoke-NativeCommand "git" @(
    "-C", $sourceDirectory, "apply", $patchPath
  ) "Could not apply the local Hardcover patch"
  Invoke-NativeCommand "git" @(
    "-C", $sourceDirectory, "diff", "--check"
  ) "The patched source contains whitespace errors"

  $patchedMain = Get-Content -Raw (Join-Path $sourceDirectory "cmd/rghc/main.go")
  if ($patchedMain -notmatch 'HARDCOVER_BATCH_SIZE' -or
      $patchedMain -notmatch 'HardcoverBatchSize\s*<\s*1\s*\|\|' -or
      $patchedMain -notmatch 'HardcoverBatchSize\s*>\s*5') {
    throw "The patched source does not enforce the expected Hardcover batch limit."
  }

  Copy-Item -LiteralPath $composePath -Destination (Join-Path $bundleDirectory "compose.yaml")
  Copy-Item -LiteralPath $envExamplePath -Destination (Join-Path $bundleDirectory "pilot.env.example")
  Copy-Item -LiteralPath $remoteHelperPath -Destination (Join-Path $bundleDirectory "deploy-zimaos.sh")

  $patchSha256 = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceManifest = @(
    "upstream_repository=$UpstreamRepository"
    "upstream_commit=$UpstreamCommit"
    "patch_sha256=$patchSha256"
  ) -join "`n"
  [System.IO.File]::WriteAllText(
    (Join-Path $bundleDirectory "SOURCE_MANIFEST.txt"),
    "$sourceManifest`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Step "Packaging the reproducible pilot source"
  Push-Location $bundleDirectory
  try {
    Invoke-NativeCommand "tar" @(
      "--exclude=rreading-glasses/.git",
      "-czf", $archivePath,
      "SOURCE_MANIFEST.txt", "compose.yaml", "pilot.env.example",
      "deploy-zimaos.sh", "rreading-glasses"
    ) "Could not package the Hardcover pilot"
  } finally {
    Pop-Location
  }

  $entries = @(& tar -tzf $archivePath)
  if ($LASTEXITCODE -ne 0) {
    throw "The pilot archive could not be read."
  }
  if ($entries -notcontains "rreading-glasses/cmd/rghc/main.go" -or
      $entries -notcontains "rreading-glasses/Dockerfile" -or
      $entries -notcontains "compose.yaml" -or
      $entries -notcontains "deploy-zimaos.sh") {
    throw "The pilot archive is missing required files."
  }
  if ($entries | Where-Object { $_ -match '(^|/)\.git(/|$)|(^|/)\.env($|\.)|(^|/)secrets?(/|$)' }) {
    throw "The pilot archive contains private or local-only files."
  }

  $archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $releaseId = "$timestamp-$($archiveSha256.Substring(0, 12))"
  $releaseArchivePath = Join-Path $temporaryDirectory "hardcover-pilot-$releaseId.tar.gz"
  Move-Item -LiteralPath $archivePath -Destination $releaseArchivePath
  $archivePath = $releaseArchivePath
  $remoteArchive = "/tmp/hardcover-pilot-$releaseId.tar.gz"
  $remoteScript = "/tmp/hardcover-pilot-$releaseId.sh"
  $localRemoteScript = Join-Path $temporaryDirectory "hardcover-pilot-$releaseId.sh"
  Copy-Item -LiteralPath $remoteHelperPath -Destination $localRemoteScript

  Write-Host "[hardcover-pilot] Archive privacy check passed." -ForegroundColor Green
  Write-Host "[hardcover-pilot] Release: $releaseId"
  Write-Host "[hardcover-pilot] SHA-256: $archiveSha256"
  Write-Host "[hardcover-pilot] Upstream source: $UpstreamCommit"
  Write-Host "[hardcover-pilot] Local patch: $patchSha256"

  if ($DryRun) {
    Write-Host "[hardcover-pilot] Dry run complete; nothing was uploaded or changed." -ForegroundColor Green
    Write-Output "PILOT_DEPLOY_ARCHIVE=$archivePath"
    Write-Output "PILOT_DEPLOY_SHA256=$archiveSha256"
    return
  }

  Write-Step "Uploading the pilot release to $Target"
  Invoke-NativeCommand "scp" @(
    $archivePath,
    $localRemoteScript,
    "${Target}:/tmp/"
  ) "Pilot upload failed"

  $remoteCommand = "sudo /bin/bash $remoteScript --archive $remoteArchive --sha256 $archiveSha256 --release $releaseId --app-dir $RemoteAppDir --health-timeout $HealthTimeoutSeconds"
  if ($SkipLiveSearch) {
    $remoteCommand += " --skip-live-search"
  }
  if ($KeepRemoteArtifacts) {
    $remoteCommand += " --keep-upload"
  }

  Write-Step "Building and starting the isolated pilot on ZimaOS"
  Invoke-NativeCommand "ssh" @("-tt", $Target, $remoteCommand) "Remote pilot deployment failed"
  Write-Host "`n[hardcover-pilot] Pilot deployment completed successfully." -ForegroundColor Green
} finally {
  if ($KeepLocalArtifacts) {
    Write-Host "[hardcover-pilot] Local deployment files retained at $temporaryDirectory"
  } else {
    Remove-SafeTemporaryDirectory $temporaryDirectory
  }
}
