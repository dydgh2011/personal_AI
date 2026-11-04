#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only sync of registered GitHub projects into the repository cache.

.DESCRIPTION
  powershell -ExecutionPolicy Bypass -File services\repo-sync\scripts\sync-project.ps1 -ProjectId hello-world
  powershell -ExecutionPolicy Bypass -File services\repo-sync\scripts\sync-project.ps1 -All

  1. Reads the project(s) from the controller registry (admin token from secrets\controller.env, host side only).
  2. Runs repo-sync (bare mirror, no checkout, no hooks). Projects registered with authMode "token"
     (private repositories) use secrets\github-readonly.token through compose.github.yaml; without that
     file the sync fails - there is no anonymous fallback.
  3. Writes syncStatus / lastFetchedAt / cachedHeadSha, or syncStatus=error with lastSyncError (the last
     good cachedHeadSha is kept; workers refuse a project whose last sync failed).
  4. Runs provision-exports.ps1 so each worker sees exactly the projects it may use.
  Syncing never enables a project. Nothing is pushed anywhere.
#>
param(
  [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,63}$')][string]$ProjectId,
  [switch]$All,
  [string]$BaseUrl = 'http://127.0.0.1:8700'
)

$ErrorActionPreference = 'Stop'
if (-not $ProjectId -and -not $All) { throw 'Pass -ProjectId <id> or -All' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$tokens = @{}
foreach ($line in Get-Content (Join-Path $repoRoot 'secrets\controller.env')) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $tokens[$Matches[1]] = $Matches[2] }
}
$admin = @{ Authorization = "Bearer $($tokens['CONTROLLER_ADMIN_TOKEN'])" }
$hasToken = Test-Path (Join-Path $repoRoot 'secrets\github-readonly.token')

$projects = if ($All) { @((Invoke-RestMethod "$BaseUrl/projects" -Headers $admin).items | Where-Object { $_.source -eq 'github' }) }
            else { @(Invoke-RestMethod "$BaseUrl/projects/$ProjectId" -Headers $admin) }

$exit = 0
Push-Location $repoRoot
try {
  foreach ($project in $projects) {
    if ($project.source -ne 'github') { Write-Host "$($project.id): not a GitHub project, skipped"; continue }
    $compose = @('-f', 'compose.yaml', '-f', 'compose.workers.yaml', '-f', 'compose.controller.yaml')
    $auth = 'none'
    if ($project.authMode -eq 'token') {
      $auth = 'token'
      if ($hasToken) { $compose += @('-f', 'compose.github.yaml') }
      # Without the token file repo-sync reports auth_required; it never retries anonymously.
    } elseif ($project.authMode -ne 'none') {
      Write-Host "$($project.id): authMode $($project.authMode) is not supported yet" -ForegroundColor Yellow
      $exit = 1; continue
    }
    $compose += @('--profile', 'tools')
    $output = docker compose @compose run --rm --no-deps repo-sync sync --id $project.id --url $project.remoteUrl --branch $project.defaultBranch --auth $auth
    $code = $LASTEXITCODE
    $result = ($output | Select-Object -Last 1) | ConvertFrom-Json
    if ($code -eq 0 -and $result.ok) {
      $patch = @{ syncStatus = 'synced'; lastFetchedAt = $result.fetchedAt; cachedHeadSha = $result.headSha; lastSyncError = '' }
    } else {
      $patch = @{ syncStatus = 'error'; lastSyncError = ("{0}: {1}" -f $result.code, $result.error) }
      $exit = 1
    }
    $body = [Text.Encoding]::UTF8.GetBytes(($patch | ConvertTo-Json))
    $updated = Invoke-RestMethod -Method Patch "$BaseUrl/projects/$($project.id)" -Headers $admin -ContentType 'application/json; charset=utf-8' -Body $body
    Write-Host ("{0}: syncStatus={1} head={2} auth={3} {4}" -f $updated.id, $updated.syncStatus, $updated.cachedHeadSha, $auth, $updated.lastSyncError)
  }
} finally {
  Pop-Location
}

& (Join-Path $PSScriptRoot 'provision-exports.ps1') -BaseUrl $BaseUrl
if ($LASTEXITCODE -ne 0) { $exit = 1 }
exit $exit
