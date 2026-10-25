param(
    [Parameter(Mandatory = $true)][string]$JobPath,
    [switch]$CheckOnly,
    [string]$NodePath = ''
)

# Explicit opt-in entry point only: this script never installs a login item.
# No --resume: the original supervisor must retain its saved absolute deadline.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    $nodeExecutable = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
    $resolvedJob = [IO.Path]::GetFullPath($JobPath)
    $supervisorPath = Join-Path $PSScriptRoot 'supervise-three-player-job.mjs'
    $preflight = @'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jobPath = process.argv[1], supervisorPath = process.argv[2];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const output = { schema: 'lifeline-login-recovery-decision-v1', recoverable: false,
  launched: false, jobPath, supervisorPath, checkedEpochMs: Date.now() };
try {
  if (!fs.existsSync(jobPath)) throw new Error('MISSING_JOB');
  const raw = fs.readFileSync(jobPath), job = JSON.parse(raw);
  if (job.schema !== 'lifeline-supervised-job-v1' || !path.isAbsolute(job.run_root || '')
    || !path.isAbsolute(job.cwd || '') || !Array.isArray(job.identity_files)
    || !Array.isArray(job.command) || job.command.length < 2) throw new Error('INVALID_JOB');
  output.runRoot = job.run_root; output.cwd = job.cwd;
  const statePath = path.join(job.run_root, 'supervisor-state.json');
  if (!fs.existsSync(statePath)) throw new Error('MISSING_STATE_NO_FIRST_LAUNCH');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const { integrity, ...body } = state;
  if (state.schema !== 'lifeline-supervisor-state-v1' || sha(JSON.stringify(body)) !== integrity)
    throw new Error('CORRUPT_STATE_SEAL');
  output.priorStatus = state.status; output.identity = state.identity;
  output.originalDeadlineEpochMs = state.deadline_epoch_ms;
  if (fs.existsSync(path.join(job.run_root, 'PAUSE'))) throw new Error('PAUSE_MARKER');
  if (fs.existsSync(path.join(job.run_root, 'STOP'))) throw new Error('STOP_MARKER');
  if (!['PREPARED', 'RUNNING'].includes(state.status)) throw new Error('STATUS_NOT_RECOVERABLE');
  if (!Number.isSafeInteger(state.deadline_epoch_ms) || state.deadline_epoch_ms <= Date.now())
    throw new Error('ABSOLUTE_DEADLINE_EXPIRED');
  const identityFiles = {};
  for (const file of [supervisorPath, ...job.identity_files.map(p => path.resolve(job.cwd, p))])
    identityFiles[file] = sha(fs.readFileSync(file));
  if (sha(JSON.stringify({ raw_job_sha256: sha(raw), identity_files: identityFiles })) !== state.identity)
    throw new Error('JOB_IDENTITY_MISMATCH');
  output.remainingMilliseconds = state.deadline_epoch_ms - Date.now();
  if (output.remainingMilliseconds <= 0) throw new Error('ABSOLUTE_DEADLINE_EXPIRED');
  output.recoverable = true; output.reason = 'EXISTING_JOB_WITHIN_ORIGINAL_DEADLINE';
} catch (error) { output.reason = error.message; }
process.stdout.write(JSON.stringify(output));
'@
    $decisionText = (& $nodeExecutable '-e' $preflight $resolvedJob $supervisorPath) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Read-only recovery preflight failed.' }
    $decision = $decisionText | ConvertFrom-Json
    if ($CheckOnly -or -not $decision.recoverable) {
        Write-Output $decisionText
        exit 0
    }
    # Start-Process joins its arguments on Windows; quote each observed file path.
    # Both paths end in a filename, so there is no trailing-backslash quote case.
    $supervisorArguments = @(('"{0}"' -f $supervisorPath), '--job', ('"{0}"' -f $resolvedJob))
    $process = Start-Process -FilePath $nodeExecutable -ArgumentList $supervisorArguments `
        -WorkingDirectory $decision.cwd -WindowStyle Hidden -PassThru
    $decision.launched = $true
    $decision | Add-Member -NotePropertyName supervisorPid -NotePropertyValue $process.Id
    $decision | Add-Member -NotePropertyName launchMeaning -NotePropertyValue 'Supervisor spawned; its existing lease and identity checks decide recovery.'
    $decision | ConvertTo-Json -Depth 6 -Compress
} catch {
    [ordered]@{ schema = 'lifeline-login-recovery-decision-v1'; recoverable = $false;
        launched = $false; reason = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
