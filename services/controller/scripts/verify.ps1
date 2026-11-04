#Requires -Version 5.1
<#
.SYNOPSIS
  End-to-end checks against the running controller container.

.DESCRIPTION
  Run from anywhere:
    powershell -ExecutionPolicy Bypass -File services\controller\scripts\verify.ps1

  - Reads tokens from secrets\controller.env into memory; never prints them.
  - Creates tasks whose instruction starts with "[verify]". They stay in the
    task history as completed/canceled records.
  - Claim tests are skipped if real tasks are queued or a worker is polling,
    so the script never takes work meant for a real worker and never makes a
    worker run a test task. Test tasks have no projectId, which workers reject
    without starting an agent CLI.
  - Recreates the controller container (not Hermes or the workers) to prove
    persistence; use -SkipRestart to avoid that.
#>
param(
  [string]$BaseUrl = 'http://127.0.0.1:8700',
  [switch]$SkipRestart
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$composeArgs = @('compose', '--project-directory', $repoRoot,
  '-f', (Join-Path $repoRoot 'compose.yaml'),
  '-f', (Join-Path $repoRoot 'compose.workers.yaml'),
  '-f', (Join-Path $repoRoot 'compose.controller.yaml'))
$existingContainers = @('personal_ai-hermes-1', 'personal_ai-claude-worker-1', 'personal_ai-codex-worker-1')

# ---- tokens (kept in memory only) -------------------------------------------
$tokens = @{}
foreach ($line in Get-Content (Join-Path $repoRoot 'secrets\controller.env')) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $tokens[$Matches[1]] = $Matches[2] }
}
$adminToken = $tokens['CONTROLLER_ADMIN_TOKEN']
$claudeToken = $tokens['CONTROLLER_CLAUDE_WORKER_TOKEN']
$codexToken = $tokens['CONTROLLER_CODEX_WORKER_TOKEN']
if (-not ($adminToken -and $claudeToken -and $codexToken)) { throw 'secrets\controller.env is missing tokens' }

# ---- helpers ----------------------------------------------------------------
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(10)

function New-ApiRequest([string]$Method, [string]$Path, [string]$Token, $Body) {
  $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::new($Method)), "$BaseUrl$Path"
  if ($Token) {
    $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue 'Bearer', $Token
  }
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Compress
    $request.Content = New-Object System.Net.Http.StringContent $json, ([Text.Encoding]::UTF8), 'application/json'
  }
  return $request
}

function Read-ApiResponse($response) {
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $parsed = $null
  if ($text) { $parsed = $text | ConvertFrom-Json }
  return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $parsed }
}

function Invoke-Api([string]$Method, [string]$Path, [string]$Token = $null, $Body = $null) {
  $response = $client.SendAsync((New-ApiRequest $Method $Path $Token $Body)).GetAwaiter().GetResult()
  return Read-ApiResponse $response
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $results.Add([pscustomobject]@{ Result = $(if ($Ok) { 'PASS' } else { 'FAIL' }); Check = $Name; Detail = $Detail })
  $color = $(if ($Ok) { 'Green' } else { 'Red' })
  Write-Host ("[{0}] {1} {2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $Detail) -ForegroundColor $color
}

function New-VerifyTask([string]$Agent, [string]$Label) {
  # No projectId: if a live worker grabs it anyway, the worker rejects it without starting the CLI.
  return Invoke-Api 'POST' '/tasks' $adminToken @{ agent = $Agent; instruction = "[verify] $Label"; projectId = $null }
}

function Wait-Healthy([int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try { if ((Invoke-Api 'GET' '/health').Status -eq 200) { return $true } } catch { }
    Start-Sleep -Milliseconds 1000
  }
  return $false
}

function Get-ContainerState([string]$Name) {
  return (docker inspect --format '{{.Id}} {{.State.Status}} {{.State.StartedAt}}' $Name)
}

$before = @{}
foreach ($name in $existingContainers) { $before[$name] = Get-ContainerState $name }

# ---- 1. health ----------------------------------------------------------------
$health = Invoke-Api 'GET' '/health'
Add-Check 'GET /health without token' ($health.Status -eq 200 -and $health.Body.status -eq 'ok') "HTTP $($health.Status)"

# ---- 2. authentication ----------------------------------------------------------
$anon = Invoke-Api 'POST' '/tasks' $null @{ agent = 'claude'; instruction = '[verify] anonymous' }
Add-Check 'POST /tasks without token is rejected' ($anon.Status -eq 401) "HTTP $($anon.Status)"
$wrong = Invoke-Api 'POST' '/tasks' 'not-a-real-token-not-a-real-token' @{ agent = 'claude'; instruction = '[verify] wrong' }
Add-Check 'POST /tasks with wrong token is rejected' ($wrong.Status -eq 401) "HTTP $($wrong.Status)"
$asWorker = Invoke-Api 'POST' '/tasks' $claudeToken @{ agent = 'claude'; instruction = '[verify] as worker' }
Add-Check 'POST /tasks with worker token is forbidden' ($asWorker.Status -eq 403) "HTTP $($asWorker.Status)"
$adminOnWorkerApi = Invoke-Api 'POST' '/internal/workers/claim' $adminToken
Add-Check 'Worker API with admin token is forbidden' ($adminOnWorkerApi.Status -eq 403) "HTTP $($adminOnWorkerApi.Status)"
$invalid = Invoke-Api 'POST' '/tasks' $adminToken @{ agent = 'claude'; instruction = 'x'; projectId = '../../etc' }
Add-Check 'Path-like projectId is rejected' ($invalid.Status -eq 400) "HTTP $($invalid.Status)"

# ---- 3. create + read -------------------------------------------------------------
$created = New-VerifyTask 'claude' 'create and read'
Add-Check 'POST /tasks with admin token' ($created.Status -eq 201 -and $created.Body.status -eq 'queued') "HTTP $($created.Status) id=$($created.Body.id)"
$fetched = Invoke-Api 'GET' "/tasks/$($created.Body.id)" $adminToken
Add-Check 'GET /tasks/:id returns the task' ($fetched.Status -eq 200 -and $fetched.Body.id -eq $created.Body.id) "status=$($fetched.Body.status)"
$list = Invoke-Api 'GET' '/tasks?limit=5' $adminToken
Add-Check 'GET /tasks lists tasks' ($list.Status -eq 200 -and $list.Body.total -ge 1) "total=$($list.Body.total)"
# Not needed beyond this point; cancel so it is never claimed.
$null = Invoke-Api 'POST' "/tasks/$($created.Body.id)/cancel" $adminToken

# ---- 4. worker claims ---------------------------------------------------------------
$queuedClaude = (Invoke-Api 'GET' '/tasks?agent=claude&status=queued&limit=1' $adminToken).Body.total
$queuedCodex = (Invoke-Api 'GET' '/tasks?agent=codex&status=queued&limit=1' $adminToken).Body.total
# A polling worker would race these tests for the tasks they create.
$liveWorkers = @((Invoke-Api 'GET' '/system/status' $adminToken).Body.workers |
  Where-Object { $_.lastSeenAt -and ((Get-Date) - [datetime]$_.lastSeenAt).TotalSeconds -lt 90 } |
  ForEach-Object { $_.workerId })
if ($queuedClaude -gt 0 -or $queuedCodex -gt 0) {
  Write-Host "Skipping claim/cancel tests: real tasks are queued (claude=$queuedClaude, codex=$queuedCodex)." -ForegroundColor Yellow
} elseif ($liveWorkers.Count -gt 0) {
  Write-Host "Skipping claim/cancel tests: live worker(s) polling: $($liveWorkers -join ', '). Use services\worker\scripts\verify-worker.ps1 instead." -ForegroundColor Yellow
} else {
  # Agent separation
  $claudeTask = New-VerifyTask 'claude' 'agent separation'
  $codexClaim = Invoke-Api 'POST' '/internal/workers/claim' $codexToken
  Add-Check 'Codex worker cannot claim a Claude task' ($codexClaim.Status -eq 200 -and $null -eq $codexClaim.Body.task) "task=$($codexClaim.Body.task)"
  $claudeClaim = Invoke-Api 'POST' '/internal/workers/claim' $claudeToken
  Add-Check 'Claude worker claims its task' ($claudeClaim.Body.task.id -eq $claudeTask.Body.id -and $claudeClaim.Body.task.status -eq 'running') "claimedBy=$($claudeClaim.Body.task.claimedBy)"
  $done = Invoke-Api 'POST' "/internal/tasks/$($claudeTask.Body.id)/complete" $claudeToken @{ result = 'verified' }
  Add-Check 'Worker completes the task with a result' ($done.Status -eq 200 -and $done.Body.task.status -eq 'completed' -and $done.Body.task.result -eq 'verified') "HTTP $($done.Status)"

  # Concurrent duplicate claims
  $single = New-VerifyTask 'claude' 'concurrent claim'
  $pending = @()
  for ($i = 0; $i -lt 10; $i++) { $pending += $client.SendAsync((New-ApiRequest 'POST' '/internal/workers/claim' $claudeToken $null)) }
  [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$pending)
  $claims = @($pending | ForEach-Object { Read-ApiResponse $_.Result } | Where-Object { $null -ne $_.Body.task })
  Add-Check '10 concurrent claims for 1 task -> exactly 1 winner' ($claims.Count -eq 1 -and $claims[0].Body.task.id -eq $single.Body.id) "winners=$($claims.Count)"
  $null = Invoke-Api 'POST' "/internal/tasks/$($single.Body.id)/complete" $claudeToken @{ result = 'verified' }
  $again = Invoke-Api 'POST' "/internal/tasks/$($single.Body.id)/complete" $claudeToken @{ result = 'twice' }
  Add-Check 'Completing a finished task is rejected' ($again.Status -eq 409) "HTTP $($again.Status)"

  # ---- 5. cancellation ----------------------------------------------------------------
  $queuedTask = New-VerifyTask 'codex' 'cancel queued'
  $cancelQueued = Invoke-Api 'POST' "/tasks/$($queuedTask.Body.id)/cancel" $adminToken
  Add-Check 'Cancel queued task -> canceled' ($cancelQueued.Body.outcome -eq 'canceled' -and $cancelQueued.Body.task.status -eq 'canceled') "outcome=$($cancelQueued.Body.outcome)"
  $afterCancel = Invoke-Api 'POST' '/internal/workers/claim' $codexToken
  Add-Check 'Canceled task is never claimed' ($null -eq $afterCancel.Body.task) ''

  $runningTask = New-VerifyTask 'codex' 'cancel running'
  $null = Invoke-Api 'POST' '/internal/workers/claim' $codexToken
  $cancelRunning = Invoke-Api 'POST' "/tasks/$($runningTask.Body.id)/cancel" $adminToken
  Add-Check 'Cancel running task -> cancel_requested (not canceled)' ($cancelRunning.Body.outcome -eq 'cancel_requested' -and $cancelRunning.Body.task.status -eq 'cancel_requested') "message=$($cancelRunning.Body.message)"
  $beat = Invoke-Api 'POST' "/internal/tasks/$($runningTask.Body.id)/heartbeat" $codexToken
  Add-Check 'Heartbeat tells the worker cancel was requested' ($beat.Body.cancelRequested -eq $true) ''
  $ack = Invoke-Api 'POST' "/internal/tasks/$($runningTask.Body.id)/cancel-ack" $codexToken
  Add-Check 'Worker cancel-ack -> canceled' ($ack.Body.task.status -eq 'canceled') ''
  $cancelDone = Invoke-Api 'POST' "/tasks/$($runningTask.Body.id)/cancel" $adminToken
  Add-Check 'Cancel of a finished task is rejected' ($cancelDone.Status -eq 409) "HTTP $($cancelDone.Status)"
}

# ---- 6. persistence across container re-creation -------------------------------------
if (-not $SkipRestart) {
  $marker = New-VerifyTask 'claude' 'persistence marker'
  $null = Invoke-Api 'POST' "/tasks/$($marker.Body.id)/cancel" $adminToken
  Write-Host 'Recreating the controller container...' -ForegroundColor Cyan
  & docker @composeArgs up -d --force-recreate --no-deps controller | Out-Null
  $healthy = Wait-Healthy
  $persisted = Invoke-Api 'GET' "/tasks/$($marker.Body.id)" $adminToken
  Add-Check 'Task survives controller re-creation' ($healthy -and $persisted.Status -eq 200 -and $persisted.Body.id -eq $marker.Body.id) "HTTP $($persisted.Status) status=$($persisted.Body.status)"
}

# ---- 7. status + network reachability ------------------------------------------------------
$status = Invoke-Api 'GET' '/system/status' $adminToken
$hermesProbe = $status.Body.services | Where-Object { $_.name -eq 'hermes' }
Add-Check 'GET /system/status (admin)' ($status.Status -eq 200 -and $status.Body.database.status -eq 'ok') "tasks=$($status.Body.tasks.total) hermes=$($hermesProbe.status)"

$fromHermes = docker exec personal_ai-hermes-1 curl -s --max-time 5 http://controller:3000/health
Add-Check 'Hermes reaches http://controller:3000' ($fromHermes -match '"ok"') "$fromHermes"
$probe = "fetch(process.argv[1]).then(r=>console.log(r.status),e=>console.log('unreachable'))"
$fromClaude = docker exec personal_ai-claude-worker-1 node -e $probe http://controller:3000/health
Add-Check 'claude-worker reaches http://controller:3000' ($fromClaude -eq '200') "$fromClaude"
$fromCodex = docker exec personal_ai-codex-worker-1 node -e $probe http://controller:3000/health
Add-Check 'codex-worker reaches http://controller:3000' ($fromCodex -eq '200') "$fromCodex"
$workerToHermes = docker exec personal_ai-claude-worker-1 node -e $probe http://hermes:9119/
Add-Check 'Workers still cannot reach Hermes directly' ($workerToHermes -eq 'unreachable') "$workerToHermes"

# ---- 8. existing services untouched -----------------------------------------------------------
foreach ($name in $existingContainers) {
  $after = Get-ContainerState $name
  Add-Check "$name unchanged and running" ($after -eq $before[$name] -and $after -match ' running ') ($after -split ' ')[1]
}

$client.Dispose()
Write-Host ''
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host ("{0} checks, {1} failed" -f $results.Count, $failed) -ForegroundColor $(if ($failed) { 'Red' } else { 'Green' })
exit $failed
