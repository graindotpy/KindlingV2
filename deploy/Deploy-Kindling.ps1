[CmdletBinding()]
param(
  [string]$Target = "admin@192.168.4.148",
  [string]$RemoteAppDir = "/DATA/AppData/kindling",
  [string]$Service = "kindling",
  [string]$ImageRepository = "kindling",
  [ValidateRange(30, 600)]
  [int]$HealthTimeoutSeconds = 150,
  [switch]$SkipChecks,
  [switch]$AllowUnhealthyCurrent,
  [switch]$KeepRemoteArtifacts,
  [switch]$KeepLocalArtifacts,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "`n[kindling] $Message" -ForegroundColor Cyan
}

function Assert-SafeArguments {
  if ($Target -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$') {
    throw "Target must look like user@hostname and contain no shell metacharacters."
  }
  if ($RemoteAppDir -notmatch '^/DATA/AppData/[A-Za-z0-9._/-]+$' -or
      $RemoteAppDir -match '(^|/)\.\.?(/|$)' -or
      $RemoteAppDir.Contains('//')) {
    throw "RemoteAppDir must be a safe absolute path below /DATA/AppData."
  }
  if ($Service -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
    throw "Service contains unsupported characters."
  }
  if ($ImageRepository -notmatch '^[a-z0-9][a-z0-9._/-]*$' -or
      $ImageRepository.Contains('//') -or
      $ImageRepository -match '(^|/)\.\.?(/|$)') {
    throw "ImageRepository contains unsupported characters."
  }
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

function Get-ArchiveEntries {
  param([string]$ArchivePath)

  $rawEntries = @(& tar -tzf $ArchivePath)
  if ($LASTEXITCODE -ne 0) {
    throw "The deployment archive could not be read."
  }

  $entries = @()
  foreach ($rawEntry in $rawEntries) {
    $entry = ([string]$rawEntry).Trim().Replace('\', '/')
    while ($entry.StartsWith('./')) {
      $entry = $entry.Substring(2)
    }
    if ($entry) {
      $entries += $entry
    }
  }
  return $entries
}

function Assert-SafeArchive {
  param(
    [string]$ArchivePath,
    [string[]]$Entries
  )

  $requiredEntries = @(
    ".dockerignore",
    ".env.example",
    "Dockerfile",
    "package.json",
    "package-lock.json",
    "app/api/health/live/route.ts",
    "deploy/deploy-zimaos.sh",
    "lib/readarr/service.ts",
    "scripts/healthcheck.mjs"
  )

  foreach ($requiredEntry in $requiredEntries) {
    if ($Entries -notcontains $requiredEntry) {
      throw "The deployment archive is missing required file '$requiredEntry'."
    }
  }

  foreach ($entry in $Entries) {
    if ($entry.StartsWith('/') -or $entry -match '^[A-Za-z]:' -or
        $entry -match '(^|/)\.\.(/|$)') {
      throw "Unsafe archive path detected: $entry"
    }
    if ($entry -match '(^|/)\.env($|\.)' -and $entry -ne '.env.example') {
      throw "Private environment file detected in deployment archive: $entry"
    }
    if ($entry -match '(?i)(^|/)(\.git|node_modules|\.next|dist|data|test-results|playwright-report)(/|$)') {
      throw "Local or generated directory detected in deployment archive: $entry"
    }
    if ($entry -match '(?i)(\.db(?:-(?:wal|shm))?|\.sqlite(?:-(?:wal|shm))?|\.(?:pem|key|crt|cer|p12|pfx|jks|keystore))$') {
      throw "Private data or key file detected in deployment archive: $entry"
    }
    if ($entry -match '(?i)\.(?:tar|tar\.gz|tgz|zip)$') {
      throw "Nested archive detected in deployment archive: $entry"
    }
  }

  $verboseEntries = @(& tar -tvzf $ArchivePath)
  if ($LASTEXITCODE -ne 0) {
    throw "The deployment archive metadata could not be read."
  }
  foreach ($verboseEntry in $verboseEntries) {
    if ([string]$verboseEntry -match '^[lhbcps]') {
      throw "Links or special files are not allowed in the deployment archive."
    }
  }
}

function Remove-SafeLocalTempDirectory {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
    return
  }

  $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  $parentPath = [System.IO.Path]::GetDirectoryName($resolvedPath).TrimEnd('\')
  $leaf = [System.IO.Path]::GetFileName($resolvedPath)

  if ($parentPath -ne $tempRoot -or -not $leaf.StartsWith('kindling-deploy-')) {
    throw "Refusing to remove unexpected temporary path '$resolvedPath'."
  }

  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

Assert-SafeArguments

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$remoteHelper = Join-Path $PSScriptRoot "deploy-zimaos.sh"
if (-not (Test-Path -LiteralPath $remoteHelper -PathType Leaf)) {
  throw "Remote deployment helper not found: $remoteHelper"
}
$remoteHelperBytes = [System.IO.File]::ReadAllBytes($remoteHelper)
if ($remoteHelperBytes -contains 13) {
  throw "Remote deployment helper must use Linux LF line endings."
}

Require-Command "tar"
if (-not $SkipChecks) {
  Require-Command "npm"
}
if (-not $DryRun) {
  Require-Command "scp"
  Require-Command "ssh"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$nonce = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$localTempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "kindling-deploy-$timestamp-$nonce"
$archivePath = Join-Path $localTempDirectory "kindling-source.tar.gz"
$localRemoteHelper = $null

$packageEntries = @(
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "Dockerfile",
  "README.md",
  "app",
  "components",
  "deploy",
  "docs",
  "lib",
  "public",
  "scripts",
  "tests",
  "docker-compose.yml",
  "eslint.config.mjs",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "playwright.config.ts",
  "tsconfig.json",
  "vitest.config.ts"
)

New-Item -ItemType Directory -Path $localTempDirectory | Out-Null

try {
  Push-Location $repositoryRoot
  try {
    if (-not $SkipChecks) {
      Write-Step "Running lint, type checking, and unit tests"
      Invoke-NativeCommand "npm" @("run", "lint") "Lint failed"
      Invoke-NativeCommand "npm" @("run", "typecheck") "Type checking failed"
      Invoke-NativeCommand "npm" @("test") "Unit tests failed"
    }

    foreach ($entry in $packageEntries) {
      if (-not (Test-Path -LiteralPath $entry)) {
        throw "Required package entry '$entry' does not exist."
      }
    }

    Write-Step "Packaging the current working tree"
    $tarArguments = @("-czf", $archivePath) + $packageEntries
    Invoke-NativeCommand "tar" $tarArguments "Packaging failed"
  } finally {
    Pop-Location
  }

  $archiveEntries = Get-ArchiveEntries $archivePath
  Assert-SafeArchive $archivePath $archiveEntries
  $sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $releaseId = "$timestamp-$($sha256.Substring(0, 12))"
  $releaseArchivePath = Join-Path $localTempDirectory "kindling-deploy-$releaseId.tar.gz"
  Move-Item -LiteralPath $archivePath -Destination $releaseArchivePath
  $archivePath = $releaseArchivePath
  $remoteArchive = "/tmp/kindling-deploy-$releaseId.tar.gz"
  $remoteScript = "/tmp/kindling-deploy-$releaseId.sh"
  $localRemoteHelper = Join-Path $localTempDirectory "kindling-deploy-$releaseId.sh"
  Copy-Item -LiteralPath $remoteHelper -Destination $localRemoteHelper

  Write-Host "[kindling] Archive privacy check passed." -ForegroundColor Green
  Write-Host "[kindling] Release: $releaseId"
  Write-Host "[kindling] SHA-256: $sha256"

  if ($DryRun) {
    Write-Host "[kindling] Dry run complete; nothing was uploaded or changed." -ForegroundColor Green
    Write-Output "DEPLOY_ARCHIVE=$archivePath"
    Write-Output "DEPLOY_SHA256=$sha256"
    return
  }

  Write-Step "Uploading the source and deployment helper to $Target"
  Invoke-NativeCommand "scp" @(
    $archivePath,
    $localRemoteHelper,
    "${Target}:/tmp/"
  ) "Upload failed"

  $remoteCommand = "sudo /bin/bash $remoteScript --archive $remoteArchive --sha256 $sha256 --release $releaseId --app-dir $RemoteAppDir --service $Service --image-repository $ImageRepository --health-timeout $HealthTimeoutSeconds"
  if ($AllowUnhealthyCurrent) {
    $remoteCommand += " --allow-unhealthy-current"
  }
  if ($KeepRemoteArtifacts) {
    $remoteCommand += " --keep-upload"
  }

  Write-Step "Deploying release $releaseId on ZimaOS"
  Invoke-NativeCommand "ssh" @("-tt", $Target, $remoteCommand) "Remote deployment failed"
  Write-Host "`n[kindling] Deployment completed successfully." -ForegroundColor Green
} finally {
  if ($KeepLocalArtifacts) {
    Write-Host "[kindling] Local deployment files retained at $localTempDirectory"
  } else {
    Remove-SafeLocalTempDirectory $localTempDirectory
  }
}
