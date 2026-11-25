# Ask Kelly (Hermes) one question from a file and save only the answer, e.g. a draft to compare with a
# high-end model's draft. Read-only for the stack: it runs one `hermes chat` turn inside the running
# container. The CLI's "session_id: ..." line is dropped so the saved file is just the answer.
#
#   powershell -ExecutionPolicy Bypass -File scripts\kelly-draft.ps1 -Request request.txt -Out data\plans\x\plan-kelly.md
#
# The request should say that nothing may be changed (calendar, todos, knowledge) when only a draft is wanted.
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Container = 'personal_ai-hermes-1'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Request)) { throw "request file not found: $Request" }
$text = Get-Content -LiteralPath $Request -Raw -Encoding utf8
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'docker'
$psi.Arguments = "exec -i $Container hermes chat --query-file - -Q"
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$p = [System.Diagnostics.Process]::Start($psi)
$writer = New-Object System.IO.StreamWriter($p.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
$writer.Write($text)
$writer.Close()
$answer = $p.StandardOutput.ReadToEnd()
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw "hermes chat failed (exit $($p.ExitCode))" }
$lines = $answer -split "`r?`n" | Where-Object { $_ -notmatch '^\s*session_id:\s' }
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
[System.IO.File]::WriteAllText($Out, (($lines -join "`n").Trim() + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "saved $Out ($((Get-Item -LiteralPath $Out).Length) bytes)"
