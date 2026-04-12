$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $projectRoot "web后端"
$serverUrl = "http://127.0.0.1:8000/"

function Test-ServerReady {
  try {
    $null = Invoke-WebRequest -Uri $serverUrl -UseBasicParsing -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

if (Test-ServerReady) {
  Start-Process $serverUrl | Out-Null
  Write-Host "Online server is already running at $serverUrl"
  exit 0
}

$pythonw = Get-Command pythonw -ErrorAction SilentlyContinue
$python = Get-Command python -ErrorAction SilentlyContinue
$py = Get-Command py -ErrorAction SilentlyContinue

if ($pythonw) {
  $filePath = $pythonw.Source
  $arguments = @("server.py")
} elseif ($python) {
  $filePath = $python.Source
  $arguments = @("server.py")
} elseif ($py) {
  $filePath = $py.Source
  $arguments = @("-3", "server.py")
} else {
  throw "Python was not found in PATH."
}

$process = Start-Process -FilePath $filePath -ArgumentList $arguments -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru

$ready = $false
for ($i = 0; $i -lt 20; $i += 1) {
  Start-Sleep -Milliseconds 500
  if (Test-ServerReady) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  throw "The online server did not start successfully. Check web后端/server.py and port 8000."
}

Start-Process $serverUrl | Out-Null
Write-Host "Online server started in the background. PID: $($process.Id)"
