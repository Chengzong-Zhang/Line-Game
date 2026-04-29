$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$candidatePorts = @(8000, 8001, 8002, 8003, 8004)

$backendDir = Join-Path $projectRoot "web后端"

if (-not (Test-Path (Join-Path $backendDir "server.py"))) {
  throw "Could not locate the backend directory containing server.py."
}

function Get-ServerUrl([int] $port) {
  return "http://127.0.0.1:$port/"
}

function Test-BackendReady([int] $port) {
  try {
    $response = Invoke-WebRequest -Uri "$(Get-ServerUrl $port)api/health" -UseBasicParsing -TimeoutSec 2
    $health = $response.Content | ConvertFrom-Json
    return ($health.status -eq "ok" -and $health.sensitiveFilterVersion -eq "v2")
  } catch {
    return $false
  }
}

function Test-PortListening([int] $port) {
  return [bool](netstat -ano | Select-String ":$port\s+.*LISTENING")
}

$port = $null

foreach ($candidatePort in $candidatePorts) {
  if (Test-BackendReady $candidatePort) {
    $serverUrl = Get-ServerUrl $candidatePort
    Start-Process $serverUrl | Out-Null
    Write-Host "Online server is already running at $serverUrl"
    exit 0
  }

  if (-not (Test-PortListening $candidatePort)) {
    $port = $candidatePort
    break
  }
}

if ($null -eq $port) {
  throw "Ports 8000 through 8004 are all occupied by non-backend services."
}

$serverUrl = Get-ServerUrl $port
$runtimeDataDir = Join-Path ([System.IO.Path]::GetTempPath()) "line-game"
$env:LINE_GAME_DB_PATH = Join-Path $runtimeDataDir "game.db"

$pythonw = Get-Command pythonw -ErrorAction SilentlyContinue
$python = Get-Command python -ErrorAction SilentlyContinue
$py = Get-Command py -ErrorAction SilentlyContinue

if ($pythonw) {
  $filePath = $pythonw.Source
  $arguments = @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "$port")
} elseif ($python) {
  $filePath = $python.Source
  $arguments = @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "$port")
} elseif ($py) {
  $filePath = $py.Source
  $arguments = @("-3", "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "$port")
} else {
  throw "Python was not found in PATH."
}

$process = Start-Process -FilePath $filePath -ArgumentList $arguments -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru

$ready = $false
for ($i = 0; $i -lt 20; $i += 1) {
  Start-Sleep -Milliseconds 500
  if (Test-BackendReady $port) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  throw "The online server did not start successfully. Check the backend server.py and port $port."
}

Start-Process $serverUrl | Out-Null
Write-Host "Online server started in the background. PID: $($process.Id)"
