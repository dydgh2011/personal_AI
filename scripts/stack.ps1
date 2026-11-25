<#
Personal AI OS stack helper, shared by every agent (Claude Code, Codex) and the owner.

  powershell -ExecutionPolicy Bypass -File scripts\stack.ps1 <command> [args]

Read-only commands work from anywhere. Commands that change the running stack only run from the
checkout the stack was started from (D:\personal_ai), never from a worktree: compose from another
folder would start a second stack with empty volumes, clashing ports and a second Discord bot.
Never prints secret values.
#>
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'
$Project = 'personal_ai'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Files = @(
  'compose.yaml', 'compose.workers.yaml', 'compose.controller.yaml', 'compose.github.yaml',
  'compose.dashboard.yaml', 'compose.publisher.yaml', 'compose.test-runner.yaml', 'compose.learning.yaml',
  'compose.notifier.yaml', 'compose.planner.yaml', 'compose.knowledge.yaml', 'compose.llm.yaml', 'compose.school.yaml'
)
$Operator = 'compose.knowledge-operator.yaml'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Fail([string]$msg) { Write-Host "stack: $msg" -ForegroundColor Red; exit 1 }
function Info([string]$msg) { Write-Host "stack: $msg" }

function FileArgs([string[]]$extra = @()) {
  $out = @()
  foreach ($f in ($Files + $extra)) { $out += '-f'; $out += (Join-Path $Root $f) }
  return $out
}

function Compose([string[]]$cmd, [string[]]$extra = @()) {
  $fa = FileArgs $extra
  & docker compose -p $Project --project-directory $Root @fa @cmd
  if ($LASTEXITCODE -ne 0) { Fail "docker compose $($cmd -join ' ') failed (exit $LASTEXITCODE)" }
}

# The folder the running stack was started from (from Docker, not from this script's location).
function StackRoot {
  $json = docker compose ls --all --format json 2>$null
  if (-not $json) { return $null }
  $entry = ($json | ConvertFrom-Json) | Where-Object { $_.Name -eq $Project } | Select-Object -First 1
  if (-not $entry) { return $null }
  return Split-Path -Parent (($entry.ConfigFiles -split ',')[0])
}

function RequireStackRoot {
  $live = StackRoot
  if ($live -and ((Resolve-Path $live).Path -ne $Root)) {
    Fail "refusing: the stack runs from '$live' but this script is in '$Root' (a worktree or copy). Run it from '$live'."
  }
}

function Container([string]$svc) { return "$Project-$svc-1" }

function KnownService([string]$svc) {
  $names = Compose @('config', '--services')
  if (-not ($names -contains $svc)) { Fail "unknown service '$svc'. Services: $($names -join ', ')" }
}

function WaitHealthy([string]$svc, [int]$seconds = 180) {
  $c = Container $svc
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $h = docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $c 2>$null
    if ($h -eq 'healthy' -or ($h -eq 'running' -and -not (docker inspect -f '{{.State.Health}}' $c 2>$null | Select-String 'Status'))) { Info "$svc is $h"; return }
    Start-Sleep -Seconds 3
  }
  Fail "$svc did not become healthy within $seconds s (last: $h). Check: scripts\stack.ps1 logs $svc"
}

# Runs JavaScript inside a container through stdin (no quoting problems, nothing printed but its output).
function NodeIn([string]$svc, [string]$js) {
  $out = $js | docker exec -i (Container $svc) node -
  if ($LASTEXITCODE -ne 0) { Fail "node in $svc failed" }
  return $out
}

function Backup([string]$what) {
  RequireStackRoot
  $dir = Join-Path $Root "data\backups\$what"
  New-Item -ItemType Directory -Force $dir | Out-Null
  switch ($what) {
    'learning' {
      & node (Join-Path $Root 'services\learning\scripts\backup.mjs')
      if ($LASTEXITCODE -ne 0) { Fail 'learning backup failed' }
    }
    'knowledge' {
      $tmp = "/var/lib/knowledge/stack-backup-$Stamp.db"
      NodeIn 'knowledge' @"
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/var/lib/knowledge/knowledge.db');db.exec("VACUUM INTO '$tmp'");
const b=new DatabaseSync('$tmp',{readOnly:true});
console.log('integrity',b.prepare('PRAGMA integrity_check').get().integrity_check,'facts',b.prepare('SELECT count(*) n FROM facts').get().n);
"@ | Write-Host
      docker cp "$(Container 'knowledge'):$tmp" (Join-Path $dir "knowledge.db.$Stamp") | Out-Null
      docker exec (Container 'knowledge') rm -f $tmp
      Info "saved data\backups\knowledge\knowledge.db.$Stamp"
    }
    'controller' {
      $tmp = "/var/lib/controller/stack-backup-$Stamp.db"
      NodeIn 'controller' @"
const D=require('better-sqlite3');const db=new D('/var/lib/controller/controller.db');db.exec("VACUUM INTO '$tmp'");
const b=new D('$tmp',{readonly:true});
console.log('integrity',b.pragma('integrity_check',{simple:true}),'version',b.pragma('user_version',{simple:true}),'tasks',b.prepare('SELECT count(*) n FROM tasks').get().n);
"@ | Write-Host
      docker cp "$(Container 'controller'):$tmp" (Join-Path $dir "controller.db.$Stamp") | Out-Null
      docker exec (Container 'controller') rm -f $tmp
      Info "saved data\backups\controller\controller.db.$Stamp"
    }
    default { Fail "backup what? knowledge | controller | learning" }
  }
}

switch ($Command) {
  'help' {
    @'
scripts\stack.ps1 <command>

Read-only
  ps                       containers and health
  unhealthy                only containers that are not healthy/running
  logs <svc> [lines]       last lines of one service (default 100)
  tasks                    coding tasks queued/running (check before rebuilding workers)
  map                      run the service map collector now (data\service-map\service-map.json)
  verify-networks          prove the network layout (no unreachable link, no open internal network)
  config-check             render the merged compose config (errors only, values not shown)

Changes the stack (only from the stack's own checkout, one agent at a time)
  rebuild <svc> [svc...]   build and recreate the given services one by one, wait until healthy
  restart <svc>            restart one container (e.g. hermes to reload plugins)
  backup <knowledge|controller|learning>   consistent DB copy into data\backups\<name>\
  operator open|close      knowledge operator access (127.0.0.1:8793); always close after use
'@ | Write-Host
  }
  'ps' { Compose @('ps', '--format', 'table {{.Name}}\t{{.Status}}') }
  'unhealthy' {
    $rows = docker ps -a --filter "label=com.docker.compose.project=$Project" --format '{{.Names}}|{{.Status}}'
    $bad = $rows | Where-Object { $_ -notmatch '\(healthy\)' -and $_ -notmatch '^\S+\|Up [^()]*$' }
    if ($bad) { $bad | ForEach-Object { Write-Host $_ } } else { Info 'all containers healthy or running' }
  }
  'logs' {
    if (-not $Rest) { Fail 'logs <service> [lines]' }
    $n = if ($Rest.Count -gt 1) { $Rest[1] } else { '100' }
    Compose @('logs', '--no-color', '--tail', $n, $Rest[0])
  }
  'tasks' {
    NodeIn 'controller' @"
const D=require('better-sqlite3');const db=new D('/var/lib/controller/controller.db',{readonly:true});
const rows=db.prepare("SELECT status,count(*) n FROM tasks WHERE status IN ('queued','running','cancel_requested') GROUP BY status").all();
console.log(rows.length?'active tasks: '+rows.map(r=>r.status+'='+r.n).join(', '):'active tasks: none');
"@ | Write-Host
  }
  'map' { & node (Join-Path $Root 'services\service-map\collect.mjs'); if ($LASTEXITCODE -ne 0) { Fail 'collector failed' } }
  'verify-networks' {
    Push-Location $Root
    try { & node 'services\service-map\verify-networks.mjs'; if ($LASTEXITCODE -ne 0) { Fail 'network proof failed' } } finally { Pop-Location }
  }
  'config-check' {
    $fa = FileArgs
    docker compose -p $Project --project-directory $Root @fa config --quiet
    if ($LASTEXITCODE -ne 0) { Fail 'compose config has errors' } else { Info 'compose config renders' }
  }
  'rebuild' {
    RequireStackRoot
    if (-not $Rest) { Fail 'rebuild <service> [service...]  (one or more names; there is no "all")' }
    foreach ($svc in $Rest) { KnownService $svc }
    if ($Rest | Where-Object { $_ -match 'worker' }) {
      Info 'workers are being rebuilt; check "tasks" first if a coding task may be running'
    }
    foreach ($svc in $Rest) {
      Info "rebuilding $svc"
      Compose @('up', '-d', '--build', '--no-deps', $svc)
      WaitHealthy $svc
    }
  }
  'restart' {
    RequireStackRoot
    if (-not $Rest) { Fail 'restart <service>' }
    KnownService $Rest[0]
    docker restart (Container $Rest[0]) | Out-Null
    WaitHealthy $Rest[0]
  }
  'backup' { if (-not $Rest) { Fail 'backup <knowledge|controller|learning>' }; Backup $Rest[0] }
  'operator' {
    RequireStackRoot
    switch ($Rest[0]) {
      'open' {
        Compose @('up', '-d', '--no-deps', 'knowledge') @($Operator)
        WaitHealthy 'knowledge'
        Info "operator access open on $(docker port (Container 'knowledge')). Close it when done: scripts\stack.ps1 operator close"
      }
      'close' {
        Compose @('up', '-d', '--no-deps', 'knowledge')
        WaitHealthy 'knowledge'
        $p = docker port (Container 'knowledge')
        if ($p) { Fail "knowledge still publishes a port: $p" } else { Info 'operator access closed (no host port)' }
      }
      default { Fail 'operator open|close' }
    }
  }
  default { Fail "unknown command '$Command' (see: scripts\stack.ps1 help)" }
}
