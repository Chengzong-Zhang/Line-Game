param(
    [Parameter(Mandatory = $true)][string]$JobPath,
    [switch]$InstallLoginRecovery,
    [switch]$CheckOnly,
    [string]$NodePath = ''
)

# Explicit launcher for a prepared frozen job. The worker supervisor owns its
# exclusive lease, original deadline and bounded retries after this exits.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$nodeExecutable = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$resolvedJob = (Resolve-Path -LiteralPath $JobPath -ErrorAction Stop).Path
$job = Get-Content -LiteralPath $resolvedJob -Raw -Encoding UTF8 | ConvertFrom-Json
if ($job.schema -ne 'lifeline-supervised-job-v1' -or -not [IO.Path]::IsPathRooted($job.run_root) -or -not [IO.Path]::IsPathRooted($job.cwd)) {
    throw 'Expected a prepared absolute-path lifeline-supervised-job-v1 job.'
}
$supervisorPath = Join-Path $PSScriptRoot 'supervise-three-player-job.mjs'
$recoveryPath = Join-Path $PSScriptRoot 'recover-defensive-warmstart-at-login-v2.ps1'
$jobHashBytes = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($resolvedJob.ToLowerInvariant()))
$jobKey = ([BitConverter]::ToString($jobHashBytes)).Replace('-', '').Substring(0, 16).ToLowerInvariant()
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) ('Lifeline-Defensive-Warmstart-{0}.lnk' -f $jobKey)
$decision = [ordered]@{ schema = 'lifeline-defensive-warmstart-launch-v2'; jobPath = $resolvedJob;
    runRoot = $job.run_root; started = $false; loginRecoveryInstalled = $false; loginRecoveryPath = $startupPath }
if ($CheckOnly) {
    $decision | ConvertTo-Json -Compress
    exit 0
}
if ($InstallLoginRecovery) {
    # A user startup shortcut is reversible and never elevates privileges. The
    # recovery script retains PAUSE/STOP, rejects drift and never extends time.
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startupPath)
    $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $shortcut.TargetPath)) {
        $shortcut.TargetPath = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    $shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -JobPath "{1}" -NodePath "{2}"' -f $recoveryPath, $resolvedJob, $nodeExecutable
    $shortcut.WorkingDirectory = $job.cwd
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Recover this existing Lifeline training job only within its frozen deadline; respect PAUSE and STOP.'
    $shortcut.Save()
    $decision.loginRecoveryInstalled = $true
}
$launchStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$arguments = @(('"{0}"' -f $supervisorPath), '--job', ('"{0}"' -f $resolvedJob))
$process = Start-Process -FilePath $nodeExecutable -ArgumentList $arguments -WorkingDirectory $job.cwd -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $job.run_root ('supervisor-{0}.stdout.log' -f $launchStamp)) `
    -RedirectStandardError (Join-Path $job.run_root ('supervisor-{0}.stderr.log' -f $launchStamp))
$decision.started = $true
$decision.supervisorPid = $process.Id
$decision.launchMeaning = 'Supervisor spawned; inspect durable progress and exit receipts for actual training status.'
$decisionText = $decision | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText((Join-Path $job.run_root ('launch-{0}.json' -f $launchStamp)), $decisionText, (New-Object Text.UTF8Encoding($false)))
Write-Output $decisionText
