#Requires -Version 5.1
<#
.SYNOPSIS
  Makes each worker's repository volume match the project registry.

.DESCRIPTION
  powershell -ExecutionPolicy Bypass -File services\repo-sync\scripts\provision-exports.ps1

  For each agent (claude, codex) and for the GitHub Publisher the export volume (mounted read-only at /repo-cache in that
  agent's worker) is set to exactly the GitHub projects that are enabled, synced and allow
  the agent in the registry. Everything else is removed from that volume, so disabling a
  project or removing an agent from allowedAgents takes the repository away from the worker.

  Run it after changing a project (PATCH /projects/:id) and after syncing; sync-project.ps1
  runs it automatically. The workers' own clones under workspaces\<agent>\repos are kept
  (they hold task branches), but the worker refuses new tasks for a project it is not allowed.
#>
param([string]$BaseUrl = 'http://127.0.0.1:8700')

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$tokens = @{}
foreach ($line in Get-Content (Join-Path $repoRoot 'secrets\controller.env')) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $tokens[$Matches[1]] = $Matches[2] }
}
$admin = @{ Authorization = "Bearer $($tokens['CONTROLLER_ADMIN_TOKEN'])" }
$projects = (Invoke-RestMethod "$BaseUrl/projects" -Headers $admin).items

$compose = @('-f', 'compose.yaml', '-f', 'compose.workers.yaml', '-f', 'compose.controller.yaml', '--profile', 'tools')
$failed = 0
Push-Location $repoRoot
try {
  foreach ($agent in @('claude', 'codex', 'publisher')) {
    # The publisher gets the projects whose commits could ever be published (code changes allowed).
    $ids = @($projects | Where-Object {
        $_.source -eq 'github' -and $_.enabled -and $_.syncStatus -eq 'synced' -and
        ($(if ($agent -eq 'publisher') { $_.allowCodeChanges } else { $_.allowedAgents -contains $agent }))
      } | ForEach-Object { $_.id })
    $list = ($ids -join ',')
    # --projects=<list> keeps an empty list as one argument (PowerShell drops empty "" arguments),
    # so revoking the last project really empties the volume.
    $output = docker compose @compose run --rm --no-deps repo-sync export --agent $agent "--projects=$list"
    if ($LASTEXITCODE -ne 0) { $failed++ }
    $result = ($output | Select-Object -Last 1) | ConvertFrom-Json
    if (-not $result.ok -and $result.code) {
      Write-Host "${agent}: export FAILED ($($result.code)): $($result.error)" -ForegroundColor Red
      continue
    }
    Write-Host ("{0}: exported=[{1}] removed=[{2}] errors={3}" -f $agent, (($result.exported | ForEach-Object { $_.id }) -join ','), ($result.removed -join ','), (@($result.errors).Count))
    foreach ($e in @($result.errors)) { if ($e) { Write-Host "  error $($e.id): $($e.error)" -ForegroundColor Yellow } }
  }
} finally {
  Pop-Location
}
exit $failed
