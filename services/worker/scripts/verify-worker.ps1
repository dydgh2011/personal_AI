#Requires -Version 5.1
<#
.SYNOPSIS
  Checks a running worker (claude-worker or codex-worker) against the real controller.

.DESCRIPTION
  powershell -ExecutionPolicy Bypass -File services\worker\scripts\verify-worker.ps1 [-Agent claude|codex] [-RealTask]

  Without -RealTask no model is called: test tasks have no projectId, which the
  worker rejects before starting the CLI. For codex the sandbox is checked with
  `codex sandbox` (no model). -RealTask additionally runs one small real task
  (creates an HTML file in the sandbox) on your subscription.
#>
param(
  [ValidateSet('claude', 'codex')]
  [string]$Agent = 'claude',
  [switch]$RealTask,
  [string]$BaseUrl = 'http://127.0.0.1:8700'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$tokens = @{}
foreach ($line in Get-Content (Join-Path $repoRoot 'secrets\controller.env')) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $tokens[$Matches[1]] = $Matches[2] }
}
$admin = @{ Authorization = "Bearer $($tokens['CONTROLLER_ADMIN_TOKEN'])" }
$otherAgent = $(if ($Agent -eq 'claude') { 'codex' } else { 'claude' })
$other = @{ Authorization = "Bearer $($tokens["CONTROLLER_$($otherAgent.ToUpper())_WORKER_TOKEN"])" }
$container = "personal_ai-$Agent-worker-1"
$workerId = "$Agent-worker"

$results = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $label = $(if ($Ok) { 'PASS' } else { 'FAIL' })
  $results.Add([pscustomobject]@{ Result = $label; Check = $Name; Detail = $Detail })
  Write-Host ("[{0}] {1} {2}" -f $label, $Name, $Detail) -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
}
function New-Task($body) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json))
  return Invoke-RestMethod -Method Post "$BaseUrl/tasks" -Headers $admin -ContentType 'application/json; charset=utf-8' -Body $bytes
}
function Wait-Task([string]$Id, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    Start-Sleep -Seconds 2
    $t = Invoke-RestMethod "$BaseUrl/tasks/$Id" -Headers $admin
  } while ($t.status -in @('queued', 'running', 'cancel_requested') -and (Get-Date) -lt $deadline)
  return $t
}

# ---- container ----------------------------------------------------------------------
$state = docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $container
Add-Check "$container running and healthy" ($state -eq 'running healthy') $state
$cmd = docker inspect --format '{{json .Config.Cmd}}' $container
Add-Check 'Container runs the polling client' ($cmd -eq '["node","/opt/agent-worker/main.js"]') $cmd
$mounts = docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' $container
Add-Check 'No Docker socket mounted' ($mounts -notmatch 'docker.sock') $mounts.Trim()
$privileged = docker inspect --format '{{.HostConfig.Privileged}} {{json .HostConfig.CapAdd}}' $container
Add-Check 'Not privileged, no added capabilities' ($privileged -eq 'false null') $privileged
$user = docker exec $container id -u
$caps = docker exec $container sh -c "grep CapEff /proc/1/status"
Add-Check 'Runs as non-root without capabilities' ($user -eq '1000' -and $caps -match '0000000000000000') "uid=$user"
$keyPattern = $(if ($Agent -eq 'claude') { '^ANTHROPIC_API_KEY=' } else { '^(OPENAI_API_KEY|CODEX_API_KEY)=' })
$apiKey = docker exec $container sh -c "env | grep -cE '$keyPattern' || true"
Add-Check 'No API key in the worker (subscription login only)' ($apiKey -eq '0') "count=$apiKey"

if ($Agent -eq 'codex') {
  $login = (docker exec $container sh -c 'codex login status 2>&1' | Select-String 'Logged in' | Select-Object -First 1) -as [string]
  Add-Check 'Codex uses the ChatGPT login' ($login -match 'ChatGPT') $login
  $securityOpt = docker inspect --format '{{json .HostConfig.SecurityOpt}}' $container
  Add-Check 'Custom seccomp profile applied (bubblewrap namespaces only)' ($securityOpt -match 'seccomp=' -and $securityOpt -match 'codex-worker: bubblewrap') 'seccomp=codex-worker.json'
  $probe = Get-Content -Raw (Join-Path $PSScriptRoot 'codex-sandbox-probe.mjs') | docker exec -i $container node -
  $probeFailed = @($probe | Select-String '^FAIL').Count
  $probe | Select-String '^FAIL' | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Add-Check 'Codex sandbox blocks escapes (codex-sandbox-probe.mjs)' ($LASTEXITCODE -eq 0 -and $probeFailed -eq 0 -and ($probe -match 'ALL CHECKS PASSED')) "$(@($probe | Select-String '^PASS').Count) passed, $probeFailed failed"
}

# ---- controller connection ------------------------------------------------------------
$status = Invoke-RestMethod "$BaseUrl/system/status" -Headers $admin
$me = $status.workers | Where-Object { $_.workerId -eq $workerId }
$age = $(if ($me.lastSeenAt) { [int]((Get-Date) - [datetime]$me.lastSeenAt).TotalSeconds } else { -1 })
Add-Check 'Worker is polling the controller' ($age -ge 0 -and $age -lt 30) "lastSeen=${age}s ago"

# ---- rejection without a model call -----------------------------------------------------
$noProject = New-Task @{ agent = $Agent; projectId = $null; instruction = '[verify-worker] no project; must be rejected without running the CLI' }
$otherClaim = Invoke-RestMethod -Method Post "$BaseUrl/internal/workers/claim" -Headers $other
Add-Check "$otherAgent token cannot claim $Agent tasks" ($null -eq $otherClaim.task -or $otherClaim.task.agent -eq $otherAgent) "task=$($otherClaim.task.id)"
if ($otherClaim.task) { Write-Host "  note: claimed $otherAgent task $($otherClaim.task.id); its lease will expire and fail it" -ForegroundColor Yellow }
$t = Wait-Task $noProject.id 30
$msg = $(if ($t.error) { ($t.error | ConvertFrom-Json).message } else { '' })
Add-Check 'Worker claims and rejects a task without a project' ($t.status -eq 'failed' -and $t.claimedBy -eq $workerId -and $msg -match 'no projectId') "$($t.status): $msg"
$started = @(docker logs $container 2>&1 | Select-String $noProject.id | Select-String 'Agent started').Count
Add-Check "The $Agent CLI was not started for it" ($started -eq 0) "Agent started lines=$started"

# ---- optional real task -------------------------------------------------------------------
if ($RealTask) {
  $real = New-Task @{ agent = $Agent; projectId = 'sandbox'; instruction = 'Create verify.html in the current directory: a minimal valid HTML5 page titled "Worker check" with an h1 "Worker check passed". Do not create other files.' }
  $t = Wait-Task $real.id 300
  $report = $(if ($t.result) { $t.result | ConvertFrom-Json } else { $t.error | ConvertFrom-Json })
  Add-Check 'Real task completed' ($t.status -eq 'completed' -and $report.exitCode -eq 0) "status=$($t.status) exit=$($report.exitCode)"
  $file = Join-Path $repoRoot "workspaces\$Agent\.worktrees\$($real.id)\verify.html"
  Add-Check 'verify.html created in the task worktree' (Test-Path $file) $file
  Add-Check 'Change committed on the task branch' ([bool]$report.workspace.commit -and $report.workspace.branch -eq "$Agent/task-$($real.id)") "$($report.workspace.branch) $($report.workspace.commit)"
  Add-Check 'Main checkout untouched' (-not (Test-Path (Join-Path $repoRoot "workspaces\$Agent\sandbox\verify.html"))) ''
}

Write-Host ''
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host ("{0} checks, {1} failed" -f $results.Count, $failed) -ForegroundColor $(if ($failed) { 'Red' } else { 'Green' })
exit $failed
