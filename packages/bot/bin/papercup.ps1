<#
.SYNOPSIS
  Papercup bot daemon control (Windows mirror of bin/papercup).

.DESCRIPTION
  Subcommands: start | stop | restart | status | logs | tail [N]
  PID stored in logs/bot.pid, output in logs/bot.log.
#>
[CmdletBinding()]
param(
  [Parameter(Position=0)]
  [ValidateSet("start","stop","restart","status","logs","tail")]
  [string]$Command = "status",
  [Parameter(Position=1)]
  [int]$TailLines = 50
)

$ErrorActionPreference = "Stop"
$BinDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $BinDir
Set-Location $Root

$LogsDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogsDir "bot.pid"
$LogFile = Join-Path $LogsDir "bot.log"
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $false }
  $procPid = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $procPid) { return $false }
  $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
  return $null -ne $proc
}

function Start-Bot {
  if (Test-Running) {
    $procPid = Get-Content $PidFile
    Write-Host "already running (pid $procPid)"
    return
  }
  if (-not (Test-Path $LogFile)) { New-Item -ItemType File -Path $LogFile | Out-Null }

  # Detach npm run start; capture stdout/stderr to bot.log via Start-Process redirection.
  $proc = Start-Process -FilePath "npm" `
    -ArgumentList "run","--silent","start" `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError "$LogFile.err" `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -Path $PidFile -Value $proc.Id

  Start-Sleep -Seconds 2
  if (Test-Running) {
    Write-Host "started pid $($proc.Id), logging to $LogFile"
  } else {
    Write-Host "failed to start — see $LogFile"
    exit 1
  }
}

function Stop-Bot {
  if (-not (Test-Running)) {
    Write-Host "not running"
    if (Test-Path $PidFile) { Remove-Item $PidFile }
    return
  }
  $procPid = Get-Content $PidFile
  # Kill the npm wrapper + its tsx child.
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$procPid" | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $procPid -Force -ErrorAction SilentlyContinue
  # Belt-and-suspenders: any leftover tsx for this project.
  Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    try { $_.CommandLine -like "*tsx*src/index.ts*" } catch { $false }
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "stopped"
}

function Show-Status {
  if (Test-Running) {
    $procPid = Get-Content $PidFile
    $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
    if ($proc) {
      $uptime = (Get-Date) - $proc.StartTime
      Write-Host "running (pid $procPid, uptime $($uptime.ToString('hh\:mm\:ss')))"
    } else {
      Write-Host "running (pid $procPid)"
    }
  } else {
    Write-Host "stopped"
  }
}

switch ($Command) {
  "start"   { Start-Bot }
  "stop"    { Stop-Bot }
  "restart" { Stop-Bot; Start-Sleep -Seconds 1; Start-Bot }
  "status"  { Show-Status }
  "logs"    {
    if (-not (Test-Path $LogFile)) { New-Item -ItemType File -Path $LogFile | Out-Null }
    Get-Content $LogFile -Wait
  }
  "tail" {
    if (Test-Path $LogFile) {
      Get-Content $LogFile -Tail $TailLines
    } else {
      Write-Host "(no log yet)"
    }
  }
}
