#Requires -Version 5.1
<#
.SYNOPSIS
  Registers a task with the controller and (optionally) waits for the worker's result.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File services\worker\scripts\submit-task.ps1 -Instruction "Create index.html with a hello page" -Wait

.EXAMPLE
  # Look up an existing task
  powershell -ExecutionPolicy Bypass -File services\worker\scripts\submit-task.ps1 -TaskId <id>

.NOTES
  Reads the admin token from secrets\controller.env into memory; never prints it.
  A real task runs Claude Code with your subscription.
#>
param(
  [string]$Instruction,
  [string]$Project = 'sandbox',
  [ValidateSet('claude', 'codex')][string]$Agent = 'claude',
  [string]$TaskId,
  [switch]$Wait,
  [int]$TimeoutMinutes = 35,
  [string]$BaseUrl = 'http://127.0.0.1:8700'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$adminToken = $null
foreach ($line in Get-Content (Join-Path $repoRoot 'secrets\controller.env')) {
  if ($line -match '^\s*CONTROLLER_ADMIN_TOKEN\s*=\s*(.+?)\s*$') { $adminToken = $Matches[1] }
}
if (-not $adminToken) { throw 'CONTROLLER_ADMIN_TOKEN not found in secrets\controller.env' }
$headers = @{ Authorization = "Bearer $adminToken" }

function Show-Task($task) {
  Write-Host ''
  Write-Host ("Task     {0}" -f $task.id)
  Write-Host ("Status   {0}  (agent={1}, project={2}, claimedBy={3})" -f $task.status, $task.agent, $task.projectId, $task.claimedBy)
  Write-Host ("Times    created={0} started={1} completed={2}" -f $task.createdAt, $task.startedAt, $task.completedAt)
  $raw = $task.result
  if (-not $raw) { $raw = $task.error }
  if (-not $raw) { return }
  try { $report = $raw | ConvertFrom-Json } catch { Write-Host "Report   $raw"; return }
  if ($report.format -ne 'agent-worker/v1') { Write-Host "Report   $raw"; return }
  Write-Host ("Outcome  {0}  exitCode={1} durationMs={2} timedOut={3}" -f $report.outcome, $report.exitCode, $report.durationMs, $report.timedOut)
  if ($report.workspace) {
    $ws = $report.workspace
    Write-Host ("Branch   {0}  commit={1}" -f $ws.branch, $ws.commit)
    if ($ws.path -like '/workspace/*') {
      Write-Host ("Files    {0}" -f (Join-Path $repoRoot ("workspaces\$($report.agent)\" + $ws.path.Substring(11).Replace('/', '\'))))
    }
    foreach ($f in $ws.changedFiles) { Write-Host ("         {0} {1}" -f $f.status, $f.path) }
  }
  if ($report.agentDetails.permissionDenials.Count -gt 0) {
    Write-Host ("Denied   {0}" -f (($report.agentDetails.permissionDenials | ForEach-Object { "$($_.tool) $($_.path)" }) -join '; ')) -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host $report.message
}

if ($TaskId) {
  Show-Task (Invoke-RestMethod "$BaseUrl/tasks/$TaskId" -Headers $headers)
  return
}
if (-not $Instruction) { throw 'Pass -Instruction "..." to create a task, or -TaskId <id> to look one up.' }

$body = @{ agent = $Agent; projectId = $Project; instruction = $Instruction } | ConvertTo-Json
$bytes = [Text.Encoding]::UTF8.GetBytes($body)
$task = Invoke-RestMethod -Method Post "$BaseUrl/tasks" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
Write-Host "Created task $($task.id) ($($task.status))"
if (-not $Wait) { return }

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$last = ''
do {
  Start-Sleep -Seconds 3
  $task = Invoke-RestMethod "$BaseUrl/tasks/$($task.id)" -Headers $headers
  if ($task.status -ne $last) { Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $task.status); $last = $task.status }
} while ($task.status -in @('queued', 'running', 'cancel_requested') -and (Get-Date) -lt $deadline)
Show-Task $task
