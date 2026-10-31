[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Serial,
    [string] $EvidenceRoot = (Join-Path $env:LOCALAPPDATA 'Lifeline\verification\l33f-real-play-process-recovery'),
    [int] $BuildTimeoutSeconds = 240,
    [int] $InstrumentationTimeoutSeconds = 90,
    [int] $AdbTimeoutSeconds = 25,
    [int] $OverallTimeoutSeconds = 900,
    [switch] $NoRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$mobileRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $mobileRoot '..')).Path
$androidRoot = Join-Path $mobileRoot 'android'
$gradle = Join-Path $androidRoot 'gradlew.bat'
$appId = 'cn.lifelinegame.mobile'
$testId = "$appId.test"
$testClass = 'cn.lifelinegame.mobile.LifelineRealPlayProcessRecoveryTest'
$instrumentation = "$testId/androidx.test.runner.AndroidJUnitRunner"
$phaseMethods = [ordered]@{ prepare = 'prepareSavedSession'; verify = 'verifyColdStartVisibleMatchUi'; cleanup = 'cleanupSessionAndVerifyTombstone' }
$appApk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $androidRoot 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
$javaSource = Join-Path $androidRoot 'app\src\androidTest\java\cn\lifelinegame\mobile\LifelineRealPlayProcessRecoveryTest.java'
$verificationSourcePaths = [ordered]@{
    java = $javaSource
    runner = $PSCommandPath
    webGameController = Join-Path $repoRoot 'web\web前端\GameController.js'
    webOnlineApp = Join-Path $repoRoot 'web\web前端\OnlineApp.js'
    webOnlineAppState = Join-Path $repoRoot 'web\web前端\OnlineAppState.js'
    webLocalGameSession = Join-Path $repoRoot 'web\web前端\LocalGameSession.js'
    distOnlineApp = Join-Path $repoRoot 'mobile\dist\OnlineApp.js'
    distOnlineAppState = Join-Path $repoRoot 'mobile\dist\OnlineAppState.js'
    distLocalGameSession = Join-Path $repoRoot 'mobile\dist\LocalGameSession.js'
    distGameController = Join-Path $repoRoot 'mobile\dist\GameController.js'
    androidOnlineApp = Join-Path $repoRoot 'mobile\android\app\src\main\assets\public\OnlineApp.js'
    androidOnlineAppState = Join-Path $repoRoot 'mobile\android\app\src\main\assets\public\OnlineAppState.js'
    androidLocalGameSession = Join-Path $repoRoot 'mobile\android\app\src\main\assets\public\LocalGameSession.js'
    androidGameController = Join-Path $repoRoot 'mobile\android\app\src\main\assets\public\GameController.js'
    appEntry = Join-Path $repoRoot 'web\web前端\main.js'
    mobileEntryGenerator = Join-Path $mobileRoot 'tools\build-web.mjs'
    distMobileEntry = Join-Path $mobileRoot 'dist\mobile-entry.js'
    androidMobileEntry = Join-Path $androidRoot 'app\src\main\assets\public\mobile-entry.js'
    webMain = Join-Path $repoRoot 'web\web前端\main.js'
    distMain = Join-Path $mobileRoot 'dist\main.js'
    androidMain = Join-Path $androidRoot 'app\src\main\assets\public\main.js'
    mobileBridge = Join-Path $mobileRoot 'src\mobile-bridge.js'
    sessionAuthority = Join-Path $mobileRoot 'src\session-authority.js'
    sessionEnvelope = Join-Path $mobileRoot 'src\session-envelope.js'
    storagePlugin = Join-Path $androidRoot 'app\src\main\java\cn\lifelinegame\mobile\LifelineStoragePlugin.java'
    distMobileBridge = Join-Path $mobileRoot 'dist\platform\mobile-bridge.js'
    distSessionAuthority = Join-Path $mobileRoot 'dist\platform\session-authority.js'
    distSessionEnvelope = Join-Path $mobileRoot 'dist\platform\session-envelope.js'
    androidMobileBridge = Join-Path $androidRoot 'app\src\main\assets\public\platform\mobile-bridge.js'
    androidSessionAuthority = Join-Path $androidRoot 'app\src\main\assets\public\platform\session-authority.js'
    androidSessionEnvelope = Join-Path $androidRoot 'app\src\main\assets\public\platform\session-envelope.js'
}
$safeSerial = $Serial -replace '[^A-Za-z0-9_.-]', '_'
$runId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + $safeSerial
$prepareRunToken = [Guid]::NewGuid().ToString('N')
$runDir = Join-Path $EvidenceRoot $runId
$startedAt = [DateTimeOffset]::UtcNow
$steps = [System.Collections.Generic.List[object]]::new()
$primaryFailure = $null
$cleanupFailure = $null
$adb = $null
$apkEvidence = [ordered]@{ app = $null; instrumentation = $null }
$initialPid = $null
$emulatorShutdownConfirmed = $false
$adbEmptyAfterShutdown = $false
$dedicatedEmulatorValidated = $false
$uiObservation = $null
$phaseObservations = [ordered]@{}
$verifyObservationReceived = $false
$broadUiPassed = $false
$nativeAuthorityPassed = $false
$verifyJUnitPassed = $false
$expectedNativeSha256 = $null
$expectedNativeRevision = $null
$apkEvidenceAfterRun = [ordered]@{ app = $null; instrumentation = $null }
$apkUnchangedDuringRun = $null
$sourceHashesAfterRun = $null
$sourceFilesUnchangedDuringRun = $null
$syncCopiesAlignedBeforeRun = $null
$syncCopiesAlignedAfterRun = $null
$pidBeforeForceStop = $null
$pidGoneAfterForceStop = $false
$prepareReadyReceived = $false
$prepareStatusCode2Received = $false
$prepareHostAliveAtReady = $false
$preparePidValidated = $false
$prepareForceStopIssued = $false
$prepareOldPidGone = $false
$prepareExitAfterForceStop = $false
$prepareNormalCompletionObserved = $false
$prepareHostAdbKilled = $false
$prepareOutputFullyDrained = $false
$prepareFinalizeFailure = $null
$prepareReadyUtc = $null
$prepareForceStopUtc = $null
$prepareExitUtc = $null
$prepareExitCode = $null
$prepareStartedUtc = $null
$prepareRawStdoutTail = @()
$prepareRawStderrTail = @()
$prepareTutorialSkipDiagnostics = $null
$prepareTutorialSkipDiagnosticsParseFailure = $null
$prepareProcess = $null
$prepareHostStarted = $false
$prepareReadyObservation = $null
$prepareReadyObservationCount = 0
$prepareStatusCode2Count = 0
$preparePairedStatusCode2Count = 0
$prepareStdoutLineCount = 0
$prepareReadyLineIndex = -1
$prepareStatusCode2LineIndex = -1
$prepareReadyAwaitingStatus2 = $false
$prepareReadyStatusPairValid = $false
$prepareReadyPairFailure = $null
$prepareVerifyPhasePassed = $false
$cleanupPhasePassed = $false
$finalJointGatePassed = $false
$prepareStdoutReader = $null
$prepareStderrReader = $null
$prepareStdoutLines = [System.Collections.Generic.List[string]]::new()
$prepareStderrLines = [System.Collections.Generic.List[string]]::new()
$pidBeforeVerify = $null
$pidAfterVerify = $null
$postCleanupPid = $null
$packagesWereAbsent = $false
$installAttempted = $false
$installCompleted = $false
$uninstallConfirmed = $false
$javaEvidence = [ordered]@{ home = $env:JAVA_HOME; javaPath = $null; jlinkPath = $null; jlinkPresent = $false; version = $null }
$sourceHashesBeforeRun = $null
$script:cleanupMode = $false
$script:timer = $null
$script:cleanupReserveSeconds = 0
$script:cleanupTimer = $null

function Resolve-Adb {
    $sdk = $env:ANDROID_SDK_ROOT
    if ([string]::IsNullOrWhiteSpace($sdk)) { $sdk = $env:ANDROID_HOME }
    if (-not [string]::IsNullOrWhiteSpace($sdk)) {
        $candidate = Join-Path $sdk 'platform-tools\adb.exe'
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    $command = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'adb.exe not found; set ANDROID_SDK_ROOT or ANDROID_HOME.'
}

function Format-ProcessArgument([string] $Value) {
    if ($Value -match '[\s"]') { return '"' + $Value.Replace('"', '\"') + '"' }
    return $Value
}

function Invoke-Captured([string] $Name, [string] $Executable, [string[]] $Arguments, [int] $TimeoutSeconds, [switch] $AllowFailure, [string] $RawCommandLine = $null) {
    if ($script:cleanupMode) {
        $left = [int][Math]::Floor($script:cleanupReserveSeconds - $script:cleanupTimer.Elapsed.TotalSeconds)
        if ($left -le 0) { throw "Reserved cleanup timeout elapsed before $Name." }
        $TimeoutSeconds = [Math]::Min($TimeoutSeconds, $left)
    } elseif ($script:timer) {
        $left = [int][Math]::Floor($OverallTimeoutSeconds - $script:cleanupReserveSeconds - $script:timer.Elapsed.TotalSeconds)
        if ($left -le 0) { throw "Main-run timeout elapsed before $Name." }
        $TimeoutSeconds = [Math]::Min($TimeoutSeconds, $left)
    }
    $stdoutPath = Join-Path $runDir "$Name.stdout.txt"
    $stderrPath = Join-Path $runDir "$Name.stderr.txt"
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.WorkingDirectory = $androidRoot
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if (-not [string]::IsNullOrEmpty($RawCommandLine)) { $info.Arguments = $RawCommandLine }
    else { $info.Arguments = (($Arguments | ForEach-Object { Format-ProcessArgument $_ }) -join ' ') }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    $stdoutText = ''
    $stderrText = ''
    $began = [DateTimeOffset]::UtcNow
    $exitCode = $null
    $timedOut = $false
    $captureFailure = $null
    try {
        if (-not $process.Start()) { throw "Could not start $Executable" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            try { $process.Kill($true) } catch { }
            [void] $process.WaitForExit(5000)
            try { $process.WaitForExit() } catch { }
        } else { $process.WaitForExit(); $exitCode = $process.ExitCode }
        try { $stdoutText = $stdoutTask.GetAwaiter().GetResult() }
        catch { $captureFailure = "stdout read failed: $($_.Exception.Message)" }
        try { $stderrText = $stderrTask.GetAwaiter().GetResult() }
        catch {
            $stderrFailure = "stderr read failed: $($_.Exception.Message)"
            $captureFailure = if ($captureFailure) { "$captureFailure | $stderrFailure" } else { $stderrFailure }
        }
    } finally {
        [IO.File]::WriteAllText($stdoutPath, $stdoutText, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($stderrPath, $stderrText, [Text.UTF8Encoding]::new($false))
        $process.Dispose()
    }
    $record = [pscustomobject]@{
        name = $Name; executable = $Executable; arguments = $Arguments; rawCommandLine = $RawCommandLine
        startedUtc = $began.ToString('o'); finishedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        timeoutSeconds = $TimeoutSeconds; timedOut = $timedOut; exitCode = $exitCode; captureFailure = $captureFailure
        stdout = [IO.Path]::GetFileName($stdoutPath); stderr = [IO.Path]::GetFileName($stderrPath)
    }
    $steps.Add($record)
    if ($captureFailure) { throw "$Name output capture failed after evidence was written: $captureFailure" }
    if ($timedOut) { throw "$Name exceeded its $TimeoutSeconds second timeout." }
    if ($exitCode -ne 0 -and -not $AllowFailure) { throw "$Name failed with exit code $exitCode." }
    return $stdoutText
}

function Invoke-Adb([string] $Name, [string[]] $Arguments, [int] $Timeout = $AdbTimeoutSeconds, [switch] $AllowFailure) {
    return Invoke-Captured $Name $adb (@('-s', $Serial) + $Arguments) $Timeout -AllowFailure:$AllowFailure
}

function Get-AppPid([string] $Name) {
    $stdout = (Invoke-Adb $Name @('shell', 'pidof', $appId) 12 -AllowFailure).Trim()
    $step = $steps[$steps.Count - 1]
    $stderrPath = Join-Path $runDir $step.stderr
    $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath).Trim() } else { '' }
    if ($step.exitCode -eq 0) {
        if ($stderr -or $stdout -notmatch '^\d+$') { throw "pidof returned malformed output (exit=$($step.exitCode), stdout='$stdout', stderr='$stderr')." }
        return $stdout
    }
    if ($step.exitCode -eq 1 -and -not $stdout -and -not $stderr) { return '' }
    throw "pidof failed instead of reporting a process state (exit=$($step.exitCode), stdout='$stdout', stderr='$stderr')."
}

function Get-PackagePath([string] $Name, [string] $Package) {
    $stdout = (Invoke-Adb $Name @('shell', 'pm', 'path', $Package) 15 -AllowFailure).Trim()
    $step = $steps[$steps.Count - 1]
    $stderrPath = Join-Path $runDir $step.stderr
    $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath).Trim() } else { '' }
    if ($step.exitCode -eq 0) {
        $lines = @($stdout -split '\r?\n' | Where-Object { $_.Trim() })
        if ($stderr -or $lines.Count -eq 0 -or @($lines | Where-Object { $_ -notmatch '^package:\S+$' }).Count -gt 0) {
            throw "pm path returned malformed output (exit=$($step.exitCode), stdout='$stdout', stderr='$stderr')."
        }
        return $stdout
    }
    if ($step.exitCode -eq 1 -and -not $stdout -and -not $stderr) { return '' }
    throw "pm path failed instead of reporting package state (exit=$($step.exitCode), stdout='$stdout', stderr='$stderr')."
}

function Get-UniquePairedStatusObservation([string] $Output, [string] $Key) {
    $lines = @($Output -split "`r?`n")
    $pattern = '^INSTRUMENTATION_STATUS:\s*' + [regex]::Escape($Key) + '=(.*)$'
    $indices = [System.Collections.Generic.List[int]]::new()
    $status2Indices = [System.Collections.Generic.List[int]]::new()
    $jsonText = $null
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $lineMatch = [regex]::Match($lines[$index], $pattern)
        if ($lineMatch.Success) { $indices.Add($index); $jsonText = $lineMatch.Groups[1].Value }
        if ($lines[$index] -match '^INSTRUMENTATION_STATUS_CODE:\s*2\s*$') { $status2Indices.Add($index) }
    }
    if ($indices.Count -ne 1) {
        return [pscustomobject]@{ valid = $false; json = $null; count = $indices.Count; statusCode2Count = $status2Indices.Count; paired = $false; failure = "expected one observation line, received $($indices.Count)" }
    }
    if ($status2Indices.Count -ne 1) { return [pscustomobject]@{ valid = $false; json = $jsonText; count = 1; statusCode2Count = $status2Indices.Count; paired = $false; failure = "expected exactly one STATUS_CODE 2 line, received $($status2Indices.Count)" } }
    $observationIndex = $indices[0]
    $paired = ($status2Indices[0] -eq ($observationIndex + 1))
    if (-not $paired) { return [pscustomobject]@{ valid = $false; json = $jsonText; count = 1; statusCode2Count = 1; paired = $false; failure = 'the unique STATUS_CODE 2 line was not immediately after the observation' } }
    try {
        $decoded = $jsonText | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $decoded) { throw 'Observation JSON decoded to null.' }
    } catch { return [pscustomobject]@{ valid = $false; json = $jsonText; count = 1; statusCode2Count = 1; paired = $true; failure = "observation JSON was malformed: $($_.Exception.Message)" } }
    return [pscustomobject]@{ valid = $true; json = $jsonText; count = 1; statusCode2Count = 1; paired = $true; failure = $null }
}

function Get-PrepareTutorialSkipDiagnosticsFromOutput {
    $failurePrefix = 'L33-F prepare failed:'
    $diagnosticsMarker = '__L33F_TUTORIAL_SKIP_DIAGNOSTICS__'
    foreach ($line in $script:prepareStdoutLines) {
        $failureIndex = $line.IndexOf($failurePrefix, [StringComparison]::Ordinal)
        if ($failureIndex -lt 0) { continue }
        $jsonStart = $line.IndexOf('{', $failureIndex)
        if ($jsonStart -lt 0) { continue }
        $outerJson = $line.Substring($jsonStart)
        try {
            $failureResult = $outerJson | ConvertFrom-Json -ErrorAction Stop
        } catch {
            $script:prepareTutorialSkipDiagnosticsParseFailure = "Could not parse prepare failure JSON: $($_.Exception.Message)"
            continue
        }
        $failureText = [string](Get-ObservationProperty $failureResult 'error' '')
        $markerIndex = $failureText.IndexOf($diagnosticsMarker, [StringComparison]::Ordinal)
        if ($markerIndex -lt 0) { continue }
        $diagnosticsJson = $failureText.Substring($markerIndex + $diagnosticsMarker.Length)
        try {
            $diagnostics = $diagnosticsJson | ConvertFrom-Json -ErrorAction Stop
            if ($null -eq $diagnostics) { throw 'Tutorial skip diagnostics JSON decoded to null.' }
            $diagnostics | Add-Member -NotePropertyName receiptSource -NotePropertyValue 'prepare-failure-error' -Force
            return $diagnostics
        } catch {
            $script:prepareTutorialSkipDiagnosticsParseFailure = "Could not parse tutorial skip diagnostics JSON: $($_.Exception.Message)"
            return [pscustomobject]@{
                receiptSource = 'prepare-failure-error-parse-failure'
                parseFailure = $script:prepareTutorialSkipDiagnosticsParseFailure
                rawDiagnosticText = $diagnosticsJson
            }
        }
    }
    return $null
}

function Invoke-Phase([string] $Phase) {
    $method = $phaseMethods[$Phase]
    $args = @('-s', $Serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', "$testClass#$method",
        '-e', 'phase', $Phase, $instrumentation)
    if ($Phase -eq 'verify') {
        $args = @('-s', $Serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', "$testClass#$method",
            '-e', 'phase', $Phase, '-e', 'runToken', $prepareRunToken,
            '-e', 'expectedNativeSha256', $expectedNativeSha256,
            '-e', 'expectedNativeRevision', [string]$expectedNativeRevision, $instrumentation)
    }
    $output = Invoke-Captured "instrumentation-$Phase" $adb $args $InstrumentationTimeoutSeconds
    $step = $steps[$steps.Count - 1]
    $codeOk = $output -match '(?m)^INSTRUMENTATION_CODE:\s*-1\s*$'
    $testOk = $output -match '(?m)^INSTRUMENTATION_STATUS_CODE:\s*0\s*$'
    $oneTestOk = $output -match '(?m)^OK \(1 test\)\s*$'
    $step | Add-Member -NotePropertyName instrumentationStatusCode0 -NotePropertyValue $testOk
    $step | Add-Member -NotePropertyName instrumentationCodeMinus1 -NotePropertyValue $codeOk
    $key = "l33f_${Phase}_observation"
    $captured = Get-UniquePairedStatusObservation $output $key
    if ($captured.valid) {
        try {
            $parsedObservation = $captured.json | ConvertFrom-Json -ErrorAction Stop
            if ($null -eq $parsedObservation) { throw 'Verify Bundle JSON decoded to null.' }
            $script:phaseObservations[$Phase] = $parsedObservation
        }
        catch {
            if ($Phase -eq 'verify') {
                $script:phaseObservations.verifyCaptureFailure = "Malformed verify Bundle JSON: $($_.Exception.Message)"
                $step | Add-Member -NotePropertyName observationCaptureFailure -NotePropertyValue $script:phaseObservations.verifyCaptureFailure
            } else { throw }
        }
        if ($script:phaseObservations.Contains($Phase)) {
        $step | Add-Member -NotePropertyName observation -NotePropertyValue $script:phaseObservations[$Phase]
        if ($Phase -eq 'verify') {
            $script:verifyObservationReceived = $true
            $script:uiObservation = $script:phaseObservations.verify
            $script:broadUiPassed = Test-BroadUiObservation $script:uiObservation
            $script:nativeAuthorityPassed = Test-NativeAuthorityObservation $script:uiObservation
            $observedPid = [int](Get-ObservationProperty $script:uiObservation 'inProcessPid' 0)
            if ($observedPid -le 0 -or $observedPid -eq [int]$pidBeforeForceStop) {
                $step | Add-Member -NotePropertyName observationPidFailure -NotePropertyValue "Invalid or reused PID $observedPid (previous=$pidBeforeForceStop)."
            }
        }
        }
    } elseif ($Phase -eq 'verify') {
        $script:phaseObservations.verifyCaptureFailure = "Verify Bundle evidence was invalid: $($captured.failure); status markers: oneTest=$oneTestOk status0=$testOk codeMinus1=$codeOk."
        $step | Add-Member -NotePropertyName observationCaptureFailure -NotePropertyValue $script:phaseObservations.verifyCaptureFailure
    }
    if (-not ($codeOk -and $testOk -and $oneTestOk)) {
        if ($Phase -eq 'verify') {
            $reasons = [System.Collections.Generic.List[string]]::new()
            if (-not $script:verifyObservationReceived) { $reasons.Add("verify Bundle observation was not received exactly once with paired STATUS_CODE 2 ($($captured.failure))") }
            elseif (-not $script:broadUiPassed) { $reasons.Add('restored canvas / BLACK turn banner / two saved UI moves / third RED UI move checks failed') }
            if ($script:verifyObservationReceived -and -not $script:nativeAuthorityPassed) { $reasons.Add('prepared dynamic-revision native restore and continued-save checks failed') }
            $observationErrors = @(Get-ObservationProperty $script:uiObservation 'errors' @())
            if ($observationErrors.Count) { $reasons.Add(($observationErrors -join '; ')) }
            $reasonText = if ($reasons.Count) { $reasons -join ' | ' } else { 'JUnit assertion failure despite collected observation' }
            throw "Instrumentation verify JUnit failed (oneTest=$oneTestOk status0=$testOk codeMinus1=$codeOk); $reasonText; observation=$($script:uiObservation | ConvertTo-Json -Compress -Depth 8)"
        }
        throw "Instrumentation $Phase lacked one-test OK, INSTRUMENTATION_STATUS_CODE 0, and INSTRUMENTATION_CODE -1 evidence."
    }
    if (-not $captured.valid -or ($Phase -eq 'verify' -and -not $script:verifyObservationReceived)) { throw "Instrumentation $Phase did not emit exactly one structured status Bundle paired with STATUS_CODE 2: $($captured.failure)" }
    if ($Phase -eq 'verify') {
        $script:verifyJUnitPassed = $true
        $script:prepareVerifyPhasePassed = $true
    }
}

function New-ProcessLineReader([System.Diagnostics.Process] $Process, [string] $Name, [string] $Path, [System.Collections.Generic.List[string]] $Lines) {
    return [pscustomobject]@{
        name = $Name; stream = if ($Name -eq 'stdout') { $Process.StandardOutput } else { $Process.StandardError }
        writer = [IO.StreamWriter]::new($Path, $false, [Text.UTF8Encoding]::new($false))
        task = $null; eof = $false; lines = $Lines; path = $Path
    }
}

function Receive-ProcessLine($Reader) {
    if ($Reader.eof -or -not $Reader.task.IsCompleted) { return $null }
    $line = $Reader.task.GetAwaiter().GetResult()
    if ($null -eq $line) { $Reader.eof = $true; return $null }
    $Reader.lines.Add($line)
    $Reader.writer.WriteLine($line)
    $Reader.writer.Flush()
    if ($line -match '^(?:OK \(1 test\)|INSTRUMENTATION_CODE:\s*-1|INSTRUMENTATION_STATUS_CODE:\s*0)\s*$') {
        $script:prepareNormalCompletionObserved = $true
    }
    if ($Reader.name -eq 'stdout') {
        $script:prepareStdoutLineCount++
        if ($line -match '^INSTRUMENTATION_STATUS_CODE:\s*2\s*$') {
            $script:prepareStatusCode2Count++
            $script:prepareStatusCode2LineIndex = $script:prepareStdoutLineCount
        }
        if ($script:prepareReadyAwaitingStatus2) {
            if ($line -match '^INSTRUMENTATION_STATUS_CODE:\s*2\s*$') {
                $script:preparePairedStatusCode2Count++
                $script:prepareStatusCode2Received = $true
                $script:prepareReadyStatusPairValid = ($script:prepareStatusCode2Count -eq 1 -and
                    $script:prepareStatusCode2LineIndex -eq ($script:prepareReadyLineIndex + 1))
            } else {
                $script:prepareReadyPairFailure = "Prepare-ready Bundle was not immediately followed by STATUS_CODE 2; next line='$line'."
            }
            $script:prepareReadyAwaitingStatus2 = $false
        }
        $readyMatch = [regex]::Match($line, '^INSTRUMENTATION_STATUS:\s*l33f_prepare_ready=(.*)$')
        if ($readyMatch.Success) {
            $script:prepareReadyObservationCount++
            if ($script:prepareReadyObservationCount -eq 1) {
                $script:prepareReadyLineIndex = $script:prepareStdoutLineCount
                $script:prepareReadyAwaitingStatus2 = $true
                try {
                    $parsedReady = $readyMatch.Groups[1].Value | ConvertFrom-Json -ErrorAction Stop
                    if ($null -eq $parsedReady) { throw 'Prepare-ready Bundle JSON decoded to null.' }
                    $script:prepareReadyObservation = $parsedReady
                    $script:prepareReadyReceived = $true
                    $script:prepareReadyUtc = [DateTimeOffset]::UtcNow.ToString('o')
                } catch { $script:prepareReadyPairFailure = "Malformed prepare-ready structured observation: $($_.Exception.Message)" }
            } else {
                $script:prepareReadyPairFailure = 'Duplicate prepare-ready structured observations were received.'
            }
        }
    }
    $Reader.task = $Reader.stream.ReadLineAsync()
    return $line
}

function Pump-PrepareOutput {
    foreach ($reader in @($script:prepareStdoutReader, $script:prepareStderrReader)) {
        if (-not $reader) { continue }
        while ($null -ne (Receive-ProcessLine $reader)) { }
    }
}

function Complete-PrepareOutput([int] $TimeoutSeconds = 10) {
    $script:prepareOutputFullyDrained = $false
    if (-not $script:prepareProcess -or -not $script:prepareStdoutReader -or -not $script:prepareStderrReader) {
        throw 'Cannot confirm prepare output drain without the process and both redirected stream readers.'
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Pump-PrepareOutput
        if ($script:prepareStdoutReader.eof -and $script:prepareStderrReader.eof) {
            $script:prepareOutputFullyDrained = $true
            return $true
        }
        Start-Sleep -Milliseconds 20
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Prepare stdout/stderr were not both fully drained to EOF within $TimeoutSeconds seconds."
}

function Finalize-PrepareProcess([System.Diagnostics.Process] $Process, [string[]] $Arguments, [string] $StartedUtc, [switch] $ThrowOnError) {
    $errors = [System.Collections.Generic.List[string]]::new()
    try { [void](Complete-PrepareOutput 10) } catch { $errors.Add($_.Exception.Message) }
    if ($script:prepareOutputFullyDrained -and -not (Test-PrepareObservationUniqueAndPaired)) {
        $errors.Add("Prepare observation uniqueness/pairing failed after full output drain: $script:prepareReadyPairFailure (observations=$script:prepareReadyObservationCount status2=$script:prepareStatusCode2Count pairedStatus2=$script:preparePairedStatusCode2Count).")
    }
    foreach ($reader in @($script:prepareStdoutReader, $script:prepareStderrReader)) {
        if ($reader) { try { $reader.writer.Dispose() } catch { $errors.Add($_.Exception.Message) } }
    }
    try { $script:prepareExitCode = $Process.ExitCode } catch { $errors.Add($_.Exception.Message) }
    if (-not $script:prepareExitUtc) { $script:prepareExitUtc = [DateTimeOffset]::UtcNow.ToString('o') }
    $script:prepareRawStdoutTail = @($script:prepareStdoutLines | Select-Object -Last 80)
    $script:prepareRawStderrTail = @($script:prepareStderrLines | Select-Object -Last 80)
    if (-not $script:prepareReadyReceived) {
        $script:prepareTutorialSkipDiagnostics = Get-PrepareTutorialSkipDiagnosticsFromOutput
    }
    if (@($steps | Where-Object name -eq 'instrumentation-prepare-held').Count -eq 0) {
        $steps.Add([pscustomobject]@{
            name = 'instrumentation-prepare-held'; executable = $adb; arguments = $Arguments
            startedUtc = $StartedUtc; finishedUtc = $script:prepareExitUtc
            timeoutSeconds = $InstrumentationTimeoutSeconds; timedOut = $false; exitCode = $script:prepareExitCode
            stdout = 'instrumentation-prepare.stdout.txt'; stderr = 'instrumentation-prepare.stderr.txt'
            runToken = $prepareRunToken; readyReceived = $script:prepareReadyReceived
            statusCode2Received = $script:prepareStatusCode2Received; hostAliveAtReady = $script:prepareHostAliveAtReady
            observation = $script:prepareReadyObservation; normalCompletionObserved = $script:prepareNormalCompletionObserved
            outputFullyDrained = $script:prepareOutputFullyDrained
            forceStopIssuedUtc = $script:prepareForceStopUtc; exitedAfterForceStop = $script:prepareExitAfterForceStop
            rawStdoutTail = $script:prepareRawStdoutTail; rawStderrTail = $script:prepareRawStderrTail
        })
    }
    try { $Process.Dispose() } catch { $errors.Add($_.Exception.Message) }
    $script:prepareProcess = $null
    if ($errors.Count -gt 0) {
        $script:prepareFinalizeFailure = $errors -join ' | '
        if ($ThrowOnError) { throw "Prepare output/process finalization failed: $script:prepareFinalizeFailure" }
    }
}

function Invoke-PrepareHeldInstrumentation {
    $arguments = @('-s', $Serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', "$testClass#$($phaseMethods.prepare)",
        '-e', 'phase', 'prepare', '-e', 'runToken', $prepareRunToken, $instrumentation)
    $stdoutPath = Join-Path $runDir 'instrumentation-prepare.stdout.txt'
    $stderrPath = Join-Path $runDir 'instrumentation-prepare.stderr.txt'
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $adb
    $info.WorkingDirectory = $androidRoot
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = ($arguments | ForEach-Object { Format-ProcessArgument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    $script:prepareProcess = $process
    $began = [DateTimeOffset]::UtcNow
    $failure = $null
    $script:prepareReadyObservation = $null
    $script:prepareReadyObservationCount = 0
    $script:prepareStatusCode2Count = 0
    $script:preparePairedStatusCode2Count = 0
    $script:prepareStdoutLineCount = 0
    $script:prepareReadyLineIndex = -1
    $script:prepareStatusCode2LineIndex = -1
    $script:prepareReadyAwaitingStatus2 = $false
    $script:prepareReadyStatusPairValid = $false
    $script:prepareReadyPairFailure = $null
    $script:prepareReadyReceived = $false
    $script:prepareStatusCode2Received = $false
    $script:prepareHostAliveAtReady = $false
    $script:preparePidValidated = $false
    $script:prepareForceStopIssued = $false
    $script:prepareOldPidGone = $false
    $script:prepareExitAfterForceStop = $false
    $script:prepareNormalCompletionObserved = $false
    $script:prepareHostAdbKilled = $false
    $script:prepareReadyUtc = $null
    $script:prepareForceStopUtc = $null
    $script:prepareExitUtc = $null
    $script:prepareExitCode = $null
    $script:prepareStartedUtc = $began.ToString('o')
    $script:prepareStdoutLines.Clear()
    $script:prepareStderrLines.Clear()
    try {
        if (-not $process.Start()) { throw "Could not start $adb for prepare instrumentation." }
        $script:prepareHostStarted = $true
        $script:prepareStdoutReader = New-ProcessLineReader $process 'stdout' $stdoutPath $script:prepareStdoutLines
        $script:prepareStderrReader = New-ProcessLineReader $process 'stderr' $stderrPath $script:prepareStderrLines
        $script:prepareStdoutReader.task = $script:prepareStdoutReader.stream.ReadLineAsync()
        $script:prepareStderrReader.task = $script:prepareStderrReader.stream.ReadLineAsync()

        $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds($InstrumentationTimeoutSeconds)
        while (-not ($script:prepareReadyReceived -and $script:prepareStatusCode2Received) -and -not $script:prepareReadyPairFailure) {
            Pump-PrepareOutput
            if ($process.HasExited) { Complete-PrepareOutput 3; throw 'Prepare instrumentation exited before the ready Bundle and following status code 2 were both observed.' }
            if ([DateTimeOffset]::UtcNow -ge $readyDeadline) { throw "Timed out waiting for the prepare-ready status Bundle for $InstrumentationTimeoutSeconds seconds." }
            Start-Sleep -Milliseconds 25
        }
        $duplicateCheckDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds(300)
        while ([DateTimeOffset]::UtcNow -lt $duplicateCheckDeadline) { Pump-PrepareOutput; Start-Sleep -Milliseconds 20 }
        if ($script:prepareReadyObservationCount -ne 1 -or $script:prepareStatusCode2Count -ne 1 -or $script:preparePairedStatusCode2Count -ne 1 -or
            -not $script:prepareReadyStatusPairValid -or $script:prepareReadyAwaitingStatus2 -or $script:prepareReadyPairFailure) {
            throw "Prepare-ready observation must occur exactly once and pair with the only STATUS_CODE 2 line: $script:prepareReadyPairFailure (observations=$script:prepareReadyObservationCount status2=$script:prepareStatusCode2Count pairedStatus2=$script:preparePairedStatusCode2Count)."
        }
        if ($process.HasExited) { throw 'Prepare instrumentation host exited before runner validation and external force-stop.' }
        $script:prepareHostAliveAtReady = $true
        $observation = $script:prepareReadyObservation
        if (-not (Test-PrepareReadyObservation $observation)) { throw 'Prepare-ready Bundle failed two-UI-move prefix, converged envelope/revision, hash, or run-token checks.' }
        $script:expectedNativeSha256 = ([string]$observation.nativeSha256).ToLowerInvariant()
        $script:expectedNativeRevision = [int]$observation.nativeRevision
        $script:phaseObservations.prepare = $observation
        if ($script:prepareNormalCompletionObserved) { throw 'Prepare instrumentation emitted normal completion before the external force-stop.' }

        $pidText = Get-AppPid 'pid-before-force-stop'
        $pidTokens = @($pidText -split '\s+' | Where-Object { $_ })
        if ($pidTokens.Count -ne 1 -or $pidTokens[0] -notmatch '^\d+$' -or [int]$pidTokens[0] -le 0) {
            throw "Expected exactly one positive target PID before force-stop; pidof returned '$pidText'."
        }
        $script:pidBeforeForceStop = [int]$pidTokens[0]
        if ($script:pidBeforeForceStop -ne [int]$observation.inProcessPid) { throw "Target PID $script:pidBeforeForceStop does not match ready Bundle PID $($observation.inProcessPid)." }
        $script:preparePidValidated = $true
        if ($process.HasExited) { throw 'Prepare instrumentation host exited after PID validation and before external force-stop.' }
        if ($script:prepareNormalCompletionObserved) { throw 'Prepare instrumentation completed normally before external force-stop.' }

        $script:prepareForceStopUtc = [DateTimeOffset]::UtcNow.ToString('o')
        Invoke-Adb 'force-stop-after-prepare' @('shell', 'am', 'force-stop', $appId) | Out-Null
        $script:prepareForceStopIssued = $true
        $goneDeadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
        do {
            Pump-PrepareOutput
            $remainingText = Get-AppPid 'pid-gone-poll'
            if ([string]::IsNullOrWhiteSpace($remainingText)) {
                $script:pidGoneAfterForceStop = $true
                $script:prepareOldPidGone = $true
                break
            }
            $remainingTokens = @($remainingText -split '\s+' | Where-Object { $_ })
            if ($remainingTokens -notcontains [string]$script:pidBeforeForceStop) {
                throw "Target process changed PID during force-stop polling instead of becoming absent: '$remainingText'."
            }
            Start-Sleep -Milliseconds 300
        } while ([DateTimeOffset]::UtcNow -lt $goneDeadline)
        if (-not $script:prepareOldPidGone) { throw "Target PID $script:pidBeforeForceStop remained after force-stop." }

        $exitDeadline = [DateTimeOffset]::UtcNow.AddSeconds(25)
        while (-not $process.HasExited -and [DateTimeOffset]::UtcNow -lt $exitDeadline) {
            Pump-PrepareOutput
            Start-Sleep -Milliseconds 25
        }
        if (-not $process.HasExited) {
            $script:prepareHostAdbKilled = $true
            try { $process.Kill($true) } catch { }
            try { [void]$process.WaitForExit(5000) } catch { }
            throw 'Target app was force-stopped, but prepare adb host did not exit; runner had to kill the host process.'
        }
        $process.WaitForExit()
        $script:prepareExitCode = $process.ExitCode
        $script:prepareExitUtc = [DateTimeOffset]::UtcNow.ToString('o')
        $script:prepareExitAfterForceStop = $true
        [void](Complete-PrepareOutput 10)
        if (-not $script:prepareOutputFullyDrained) { throw 'Prepare instrumentation output was not fully drained before completion-marker validation.' }
        if ($script:prepareNormalCompletionObserved) { throw 'Prepare instrumentation reported normal test completion; it must be terminated by the external force-stop.' }
    } catch {
        $failure = $_.Exception.Message
        throw
    } finally {
        if ($process -and $script:prepareHostStarted -and $process.HasExited) {
            Finalize-PrepareProcess $process $arguments $script:prepareStartedUtc -ThrowOnError:($null -eq $failure)
        } elseif ($process -and -not $script:prepareHostStarted) {
            $process.Dispose()
            $script:prepareProcess = $null
        }
    }
}

function Get-FileEvidence([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Expected APK missing: $Path" }
    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{ path = $Path; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Get-ObservationProperty($Observation, [string] $Name, $Default = $null) {
    if ($null -eq $Observation) { return $Default }
    $property = $Observation.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Test-HasObservationProperty($Observation, [string] $Name) {
    if ($null -eq $Observation) { return $false }
    return $null -ne $Observation.PSObject.Properties[$Name]
}

function Get-StartWaitSampleDiagnostics($Sample) {
    $controller = Get-ObservationProperty $Sample 'controller'
    $controllerState = Get-ObservationProperty $controller 'controllerState'
    $onlineActionSync = Get-ObservationProperty $controller 'onlineActionSync'
    $canvas = Get-ObservationProperty $Sample 'canvas'
    $startControl = Get-ObservationProperty $Sample 'startControl'
    return [ordered]@{
        elapsedMs = Get-ObservationProperty $Sample 'elapsedMs'
        sampledAtMs = Get-ObservationProperty $Sample 'sampledAtMs'
        exactTextButtonCount = Get-ObservationProperty $Sample 'exactTextButtonCount'
        startControlDisabled = Get-ObservationProperty $startControl 'disabled'
        canvasAriaDisabled = Get-ObservationProperty $canvas 'ariaDisabled'
        controllerLookupPath = Get-ObservationProperty $controller 'controllerLookupPath'
        controllerStateSource = Get-ObservationProperty $controller 'controllerStateSource'
        interactionLockReason = Get-ObservationProperty $controllerState 'interactionLockReason'
        resetLockReason = Get-ObservationProperty $controllerState 'resetLockReason'
        onlineActionSyncAvailable = Get-ObservationProperty $onlineActionSync 'available'
        onlineActionSyncLookupPath = Get-ObservationProperty $onlineActionSync 'lookupPath'
        protocolStatus = Get-ObservationProperty $onlineActionSync 'protocolStatus'
        controllerReadError = Get-ObservationProperty $controller 'controllerReadError'
        onlineActionSyncReadError = Get-ObservationProperty $controller 'onlineActionSyncReadError'
    }
}

function Get-PrepareStartWaitDiagnostics($Observation) {
    $startAction = Get-ObservationProperty $Observation 'startAction'
    $wait = Get-ObservationProperty $startAction 'wait'
    $firstSample = Get-ObservationProperty $wait 'first'
    $lastSample = Get-ObservationProperty $wait 'last'
    return [ordered]@{
        waitLimitMs = Get-ObservationProperty $wait 'waitLimitMs'
        waitedMs = Get-ObservationProperty $wait 'waitedMs'
        observations = Get-ObservationProperty $wait 'observations'
        first = Get-StartWaitSampleDiagnostics $firstSample
        last = Get-StartWaitSampleDiagnostics $lastSample
        firstSample = $firstSample
        lastSample = $lastSample
    }
}

function Test-PrepareStartWaitSamplesPersisted($Diagnostics) {
    $firstSample = if ($Diagnostics -is [System.Collections.IDictionary]) { $Diagnostics['firstSample'] } else { Get-ObservationProperty $Diagnostics 'firstSample' }
    $lastSample = if ($Diagnostics -is [System.Collections.IDictionary]) { $Diagnostics['lastSample'] } else { Get-ObservationProperty $Diagnostics 'lastSample' }
    return ($null -ne $firstSample -and $null -ne $lastSample -and
        (Test-HasObservationProperty $firstSample 'sampledAtMs') -and
        (Test-HasObservationProperty $lastSample 'sampledAtMs'))
}

function Test-PrepareReadyObservation($Observation) {
    if (-not $Observation) { return $false }
    $nativePoint = @(Get-ObservationProperty $Observation 'nativeActionPoint' @())
    $startAction = Get-ObservationProperty $Observation 'startAction'
    $startWait = Get-ObservationProperty $startAction 'wait'
    $firstStartWait = Get-ObservationProperty $startWait 'first'
    $lastStartWait = Get-ObservationProperty $startWait 'last'
    $lastStartWaitButtons = @(Get-ObservationProperty $lastStartWait 'visibleButtons' @())
    $lastStartControl = Get-ObservationProperty $lastStartWait 'startControl'
    $lastCanvas = Get-ObservationProperty $lastStartWait 'canvas'
    $lastController = Get-ObservationProperty $lastStartWait 'controller'
    $lastControllerState = Get-ObservationProperty $lastController 'controllerState'
    $lastOnlineActionSync = Get-ObservationProperty $lastController 'onlineActionSync'
    $canvasInputs = @(Get-ObservationProperty $Observation 'canvasInputs' @())
    $legalityPreflight = @(Get-ObservationProperty $Observation 'legalityPreflight' @())
    $localSha = [string](Get-ObservationProperty $Observation 'localSha256' '')
    $nativeSha = [string](Get-ObservationProperty $Observation 'nativeSha256' '')
    return ((Get-ObservationProperty $Observation 'phase' '') -ceq 'prepare' -and
        (Get-ObservationProperty $Observation 'runToken' '') -ceq $prepareRunToken -and
        (Get-ObservationProperty $Observation 'holdState' '') -ceq 'awaiting-external-force-stop' -and
        [int](Get-ObservationProperty $Observation 'inProcessPid' 0) -gt 0 -and
        (Get-ObservationProperty $Observation 'durable' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'localEvictedBeforeForceStop' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'nativeRetainedAfterLocalEviction' $false) -eq $true -and
        [int](Get-ObservationProperty $Observation 'localRevision' 0) -gt 0 -and
        [int](Get-ObservationProperty $Observation 'nativeRevision' 0) -eq [int](Get-ObservationProperty $Observation 'localRevision' 0) -and
        (Get-ObservationProperty $Observation 'revisionMonotone' $false) -eq $true -and
        [int](Get-ObservationProperty $Observation 'uiClickCount' 0) -eq 2 -and
        [int](Get-ObservationProperty $Observation 'localActions' -1) -eq 2 -and
        [int](Get-ObservationProperty $Observation 'nativeActions' -1) -eq 2 -and
        (Get-ObservationProperty $Observation 'localStartPlayer' '') -ceq 'BLACK' -and
        (Get-ObservationProperty $Observation 'nativeStartPlayer' '') -ceq 'BLACK' -and
        (Get-ObservationProperty $Observation 'rulesVersion' '') -ceq 'territory-v3' -and
        (Get-ObservationProperty $Observation 'blackChoice' '') -ceq 'human' -and (Get-ObservationProperty $Observation 'whiteChoice' '') -ceq 'human' -and
        (Get-ObservationProperty $startAction 'converged' $false) -eq $true -and
        (Get-ObservationProperty $startWait 'resolved' $false) -eq $true -and
        [int](Get-ObservationProperty $startWait 'waitLimitMs' 0) -eq 15000 -and
        [int](Get-ObservationProperty $startWait 'waitedMs' 15001) -le 15000 -and
        [int](Get-ObservationProperty $startWait 'observations' 0) -gt 0 -and
        (Test-HasObservationProperty $firstStartWait 'sampledAtMs') -and
        (Test-HasObservationProperty $lastStartWait 'sampledAtMs') -and
        [int](Get-ObservationProperty $lastStartWait 'exactTextButtonCount' 0) -eq 1 -and
        $lastStartWaitButtons.Count -eq 1 -and (Get-ObservationProperty $lastStartWaitButtons[0] 'disabled' $true) -eq $false -and
        (Test-HasObservationProperty $lastStartControl 'disabled') -and
        (Get-ObservationProperty $lastStartControl 'disabled' $true) -eq $false -and
        (Test-HasObservationProperty $lastCanvas 'ariaDisabled') -and
        (Test-HasObservationProperty $lastController 'controllerState') -and
        (Test-HasObservationProperty $lastControllerState 'resetLockReason') -and
        (Test-HasObservationProperty $lastControllerState 'interactionLockReason') -and
        (Test-HasObservationProperty $lastController 'onlineActionSync') -and
        (Test-HasObservationProperty $lastOnlineActionSync 'protocolStatus') -and
        (Get-ObservationProperty $startAction 'localRulesVersion' '') -ceq 'territory-v3' -and
        (Get-ObservationProperty $startAction 'blackChoice' '') -ceq 'human' -and (Get-ObservationProperty $startAction 'whiteChoice' '') -ceq 'human' -and
        (Get-ObservationProperty $startAction 'isTrusted' $true) -eq $false -and
        [string](Get-ObservationProperty $Observation 'inputType' '') -match 'isTrusted is false' -and
        $canvasInputs.Count -eq 2 -and @($canvasInputs | Where-Object { (Get-ObservationProperty $_ 'isTrusted' $true) -ne $false }).Count -eq 0 -and
        $legalityPreflight.Count -eq 3 -and @($legalityPreflight | Where-Object { (Get-ObservationProperty $_ 'legal' $false) -ne $true }).Count -eq 0 -and
        (@(Get-ObservationProperty $legalityPreflight[2] 'point' @()) -join ',') -ceq '3,0' -and
        (Get-ObservationProperty $Observation 'nativeActionType' '') -ceq 'player_move' -and
        $nativePoint.Count -eq 2 -and [int]$nativePoint[0] -eq 1 -and [int]$nativePoint[1] -eq 0 -and
        $localSha -match '(?i)^[0-9a-f]{64}$' -and $nativeSha -match '(?i)^[0-9a-f]{64}$' -and
        $localSha.Equals($nativeSha, [StringComparison]::OrdinalIgnoreCase) -and
        @(Get-ObservationProperty $Observation 'actionPrefix' @()).Count -eq 2)
}

function Test-PrepareObservationUniqueAndPaired {
    return ($prepareReadyObservationCount -eq 1 -and $prepareStatusCode2Count -eq 1 -and $preparePairedStatusCode2Count -eq 1 -and
        $prepareReadyStatusPairValid -eq $true -and -not $prepareReadyAwaitingStatus2 -and
        $prepareStatusCode2LineIndex -eq ($prepareReadyLineIndex + 1) -and
        [string]::IsNullOrWhiteSpace([string]$prepareReadyPairFailure))
}

function Get-SourceEvidence([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{ path = $Path; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Get-VerificationSourceHashes {
    $hashes = [ordered]@{}
    foreach ($name in $verificationSourcePaths.Keys) {
        $path = $verificationSourcePaths[$name]
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Verification source missing: $path" }
        $hashes[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $hashes
}

function Test-SyncCopiesAligned($Hashes) {
    return ($Hashes.webGameController -eq $Hashes.distGameController -and $Hashes.webGameController -eq $Hashes.androidGameController -and
        $Hashes.webOnlineApp -eq $Hashes.distOnlineApp -and $Hashes.webOnlineApp -eq $Hashes.androidOnlineApp -and
        $Hashes.webLocalGameSession -eq $Hashes.distLocalGameSession -and $Hashes.webLocalGameSession -eq $Hashes.androidLocalGameSession -and
        $Hashes.distMobileBridge -eq $Hashes.androidMobileBridge -and
        $Hashes.distSessionAuthority -eq $Hashes.androidSessionAuthority -and
        $Hashes.distSessionEnvelope -eq $Hashes.androidSessionEnvelope -and
        $Hashes.distMobileEntry -eq $Hashes.androidMobileEntry -and
        $Hashes.distMain -eq $Hashes.androidMain -and $Hashes.webMain -eq $Hashes.distMain)
}

function Test-BroadUiObservation($Observation) {
    if (-not $Observation) { return $false }
    $point = @(Get-ObservationProperty $Observation 'localActionPoint' @())
    return ((Get-ObservationProperty $Observation 'visibleMatchUiObserved' $false) -eq $true -and (Get-ObservationProperty $Observation 'laidOutCanvas' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'blueBanner' $false) -eq $true -and
        [int](Get-ObservationProperty $Observation 'restoredActionCount' -1) -eq 2 -and [string](Get-ObservationProperty $Observation 'localActionType' '') -ceq 'player_move' -and
        $point.Count -eq 2 -and [int]$point[0] -eq 1 -and [int]$point[1] -eq 0)
}

function Test-NativeAuthorityObservation($Observation) {
    if (-not $Observation -or -not $expectedNativeSha256 -or -not $expectedNativeRevision) { return $false }
    $status = Get-ObservationProperty $Observation 'storageStatus'
    $pointLocal = @(Get-ObservationProperty $Observation 'localActionPoint' @())
    $pointNative = @(Get-ObservationProperty $Observation 'nativeActionPoint' @())
    $continuedInput = Get-ObservationProperty $Observation 'continuationInput'
    $continuedPoint = @(Get-ObservationProperty $continuedInput 'point' @())
    $continuedPrefix = @(Get-ObservationProperty $Observation 'continuedPrefix' @())
    $thirdPoint = if ($continuedPrefix.Count -ge 3) { @(Get-ObservationProperty $continuedPrefix[2] 'point' @()) } else { @() }
    return ((Get-ObservationProperty $Observation 'runToken' '') -ceq $prepareRunToken -and
        (Get-ObservationProperty $Observation 'recoveryRoute' '') -ceq 'native-restore' -and
        (Get-ObservationProperty $status 'state' '') -ceq 'restored' -and (Get-ObservationProperty $status 'source' '') -ceq 'native' -and (Get-ObservationProperty $status 'operation' '') -ceq 'restore' -and (Get-ObservationProperty $status 'nativeAvailable' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'localNativeEqual' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'nativeAuthorityReady' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'continuedUiMove' $false) -eq $true -and
        (Get-ObservationProperty $Observation 'continuedRedBanner' $false) -eq $true -and
        [int](Get-ObservationProperty $Observation 'continuedActionCount' -1) -eq 3 -and
        [int](Get-ObservationProperty $Observation 'continuedRevision' 0) -gt [int]$expectedNativeRevision -and
        (Get-ObservationProperty $Observation 'continuedLocalNativeEqual' $false) -eq $true -and
        $continuedPrefix.Count -eq 3 -and
        (Get-ObservationProperty $continuedInput 'eventType' '') -ceq 'instrumentation-injected Canvas MouseEvent' -and
        (Get-ObservationProperty $continuedInput 'isTrusted' $true) -eq $false -and
        $continuedPoint.Count -eq 2 -and [int]$continuedPoint[0] -eq 3 -and [int]$continuedPoint[1] -eq 0 -and
        $thirdPoint.Count -eq 2 -and [int]$thirdPoint[0] -eq 3 -and [int]$thirdPoint[1] -eq 0 -and
        (Get-ObservationProperty $Observation 'resumeNoticeMatches' $false) -eq $true -and
        [int](Get-ObservationProperty $Observation 'localRevision' -1) -eq [int]$expectedNativeRevision -and [int](Get-ObservationProperty $Observation 'nativeRevision' -1) -eq [int]$expectedNativeRevision -and
        (Get-ObservationProperty $Observation 'localSha256' '') -ceq $expectedNativeSha256 -and (Get-ObservationProperty $Observation 'nativeSha256' '') -ceq $expectedNativeSha256 -and
        (Get-ObservationProperty $Observation 'localMatchesExpected' $false) -eq $true -and (Get-ObservationProperty $Observation 'nativeMatchesExpected' $false) -eq $true -and
        [int](Get-ObservationProperty $Observation 'localActions' -1) -eq 2 -and [int](Get-ObservationProperty $Observation 'nativeActions' -1) -eq 2 -and
        [string](Get-ObservationProperty $Observation 'localActionType' '') -ceq 'player_move' -and [string](Get-ObservationProperty $Observation 'nativeActionType' '') -ceq 'player_move' -and
        $pointLocal.Count -eq 2 -and [int]$pointLocal[0] -eq 1 -and [int]$pointLocal[1] -eq 0 -and
        $pointNative.Count -eq 2 -and [int]$pointNative[0] -eq 1 -and [int]$pointNative[1] -eq 0)
}

function Save-Receipt([string] $Status) {
    $startWaitDiagnostics = Get-PrepareStartWaitDiagnostics $prepareReadyObservation
    $startWaitSamplesPersisted = Test-PrepareStartWaitSamplesPersisted $startWaitDiagnostics
    $tutorialSkipDiagnostics = $prepareTutorialSkipDiagnostics
    $tutorialSkipDiagnosticsSource = if ($prepareTutorialSkipDiagnostics) { 'prepare-failure-error' } else { $null }
    if ($prepareReadyObservation) {
        $readySkipDiagnostics = Get-ObservationProperty $prepareReadyObservation 'tutorialSkipDiagnostics'
        if ($readySkipDiagnostics) {
            $tutorialSkipDiagnostics = $readySkipDiagnostics
            $tutorialSkipDiagnosticsSource = 'prepare-ready-bundle'
        }
    }
    $receipt = [ordered]@{
        schemaVersion = 5; task = 'L33-F Android process recovery'; status = $Status
        scope = 'Two instrumentation-injected Canvas MouseEvents produce saved move history and equal durable local/native envelopes; the test then removes only the WebView local session key and confirms the native plugin retains the exact envelope before external force-stop; cold start must restore from native and show the visible match; a third instrumentation-injected Canvas MouseEvent advances history and durable revision. Event isTrusted is false; this does not prove physical touch, screen hit, or real-device behavior.'
        inputEvidence = [ordered]@{ type = 'instrumentation-injected Canvas MouseEvent'; isTrusted = $false; method = 'direct DOM dispatch to canvas after recording elementFromPoint and coordinates'; proves = @('application canvas event handler and saved-session product path on API 36 emulator'); doesNotProve = @('physical touch', 'trusted input', 'screen hit', 'real-device behavior') }
        serial = $Serial; applicationId = $appId; instrumentationPackage = $testId
        instrumentationRunner = $instrumentation; testClass = $testClass; runDirectory = $runDir
        startedUtc = $startedAt.ToString('o'); finishedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        totalTimeoutSeconds = $OverallTimeoutSeconds; buildTimeoutSeconds = $BuildTimeoutSeconds
        instrumentationTimeoutSeconds = $InstrumentationTimeoutSeconds; adbTimeoutSeconds = $AdbTimeoutSeconds
        packagesAbsentBeforeInstall = $packagesWereAbsent; installAttempted = $installAttempted
        installCompleted = $installCompleted; uninstallConfirmed = $uninstallConfirmed; emulatorShutdownConfirmed = $emulatorShutdownConfirmed; adbEmptyAfterShutdown = $adbEmptyAfterShutdown; dedicatedEmulatorValidated = $dedicatedEmulatorValidated
        apk = [ordered]@{ beforeRun = $apkEvidence; afterRun = $apkEvidenceAfterRun; unchangedDuringRun = $apkUnchangedDuringRun }
        java = $javaEvidence
        source = [ordered]@{ files = $verificationSourcePaths; sha256BeforeRun = $sourceHashesBeforeRun; sha256AfterRun = $sourceHashesAfterRun; unchangedDuringRun = $sourceFilesUnchangedDuringRun; mobileSyncCopiesAlignedBeforeRun = $syncCopiesAlignedBeforeRun; mobileSyncCopiesAlignedAfterRun = $syncCopiesAlignedAfterRun }
        phaseObservations = $phaseObservations
        initialPid = $initialPid; pidBeforeForceStop = $pidBeforeForceStop
        pidGoneAfterForceStop = $pidGoneAfterForceStop
        pidBeforeVerify = $pidBeforeVerify; pidAfterVerify = $pidAfterVerify; postCleanupPid = $postCleanupPid; uiObservation = $uiObservation
        pidBeforeVerifyAbsent = [string]::IsNullOrWhiteSpace([string]$pidBeforeVerify)
        verifyObservationReceived = $verifyObservationReceived
        broadUiPassed = $broadUiPassed
        nativeAuthorityPassed = $nativeAuthorityPassed
        verifyJUnitPassed = $verifyJUnitPassed
        cleanupPhasePassed = $cleanupPhasePassed
        prepareBoundary = [ordered]@{
            runToken = $prepareRunToken; readyReceived = $prepareReadyReceived; statusCode2Received = $prepareStatusCode2Received
            startWaitDiagnostics = $startWaitDiagnostics; startWaitSamplesPersisted = $startWaitSamplesPersisted
            localEvictedBeforeForceStop = (Get-ObservationProperty $prepareReadyObservation 'localEvictedBeforeForceStop' $false)
            nativeRetainedAfterLocalEviction = (Get-ObservationProperty $prepareReadyObservation 'nativeRetainedAfterLocalEviction' $false)
            tutorialSkipDiagnostics = $tutorialSkipDiagnostics
            tutorialSkipDiagnosticsSource = $tutorialSkipDiagnosticsSource
            tutorialSkipDiagnosticsParseFailure = $prepareTutorialSkipDiagnosticsParseFailure
            readyUtc = $prepareReadyUtc; hostAliveAtReady = $prepareHostAliveAtReady
            observationCount = $prepareReadyObservationCount; statusCode2Count = $prepareStatusCode2Count
            pairedStatusCode2Count = $preparePairedStatusCode2Count
            statusPairValid = $prepareReadyStatusPairValid; statusPairFailure = $prepareReadyPairFailure
            uniqueAndPairedAfterFullDrain = (Test-PrepareObservationUniqueAndPaired)
            pidValidated = $preparePidValidated; forceStopIssuedUtc = $prepareForceStopUtc
            forceStopIssued = $prepareForceStopIssued; oldPidGone = $prepareOldPidGone
            prepareExitUtc = $prepareExitUtc; prepareExitAfterForceStop = $prepareExitAfterForceStop
            prepareExitCode = $prepareExitCode; prepareRawStdoutTail = $prepareRawStdoutTail
            prepareRawStderrTail = $prepareRawStderrTail; normalCompletionObserved = $prepareNormalCompletionObserved
            outputFullyDrained = $prepareOutputFullyDrained; prepareFinalizeFailure = $prepareFinalizeFailure
            hostAdbKilled = $prepareHostAdbKilled
        }
        jointPassChecks = [ordered]@{
            startWaitSamplesPersisted = $startWaitSamplesPersisted
            localEvictedBeforeForceStop = ($prepareReadyObservation -and (Get-ObservationProperty $prepareReadyObservation 'localEvictedBeforeForceStop' $false) -eq $true)
            nativeRetainedAfterLocalEviction = ($prepareReadyObservation -and (Get-ObservationProperty $prepareReadyObservation 'nativeRetainedAfterLocalEviction' $false) -eq $true)
            prepareReadyAndToken = ($prepareReadyReceived -and $prepareStatusCode2Received -and $prepareReadyObservation -and (Get-ObservationProperty $prepareReadyObservation 'runToken' '') -ceq $prepareRunToken)
            prepareObservationUniqueAndPairedAfterDrain = ((Test-PrepareObservationUniqueAndPaired) -and $prepareOutputFullyDrained)
            prepareHostAliveAndPidMatched = ($prepareHostAliveAtReady -and $preparePidValidated -and $pidBeforeForceStop -and $prepareReadyObservation -and [int]$pidBeforeForceStop -eq [int](Get-ObservationProperty $prepareReadyObservation 'inProcessPid' 0))
            externalForceStopAndExit = ($prepareForceStopIssued -and $prepareOldPidGone -and $pidGoneAfterForceStop -and $prepareExitAfterForceStop -and -not $prepareHostAdbKilled)
            noNormalPrepareCompletion = (-not $prepareNormalCompletionObserved)
            outputFullyDrained = ($prepareOutputFullyDrained -and -not $prepareFinalizeFailure)
            verifyObservationReceived = $verifyObservationReceived
            broadUiPassed = $broadUiPassed
            nativeAuthorityPassed = $nativeAuthorityPassed
            verifyJUnitPassed = $verifyJUnitPassed
            cleanupOneTestAndTombstoneAssertions = $cleanupPhasePassed
            pidBeforeVerifyAbsent = [string]::IsNullOrWhiteSpace([string]$pidBeforeVerify)
            freshVerifyPid = ($pidBeforeForceStop -and $uiObservation -and [int](Get-ObservationProperty $uiObservation 'inProcessPid' 0) -gt 0 -and [int](Get-ObservationProperty $uiObservation 'inProcessPid' 0) -ne [int]$pidBeforeForceStop)
            hashesStableAndAligned = ($sourceFilesUnchangedDuringRun -and $syncCopiesAlignedBeforeRun -and $syncCopiesAlignedAfterRun -and $apkUnchangedDuringRun -eq $true)
            packagesUninstalled = $uninstallConfirmed
            emulatorClosedAndAdbEmpty = ($emulatorShutdownConfirmed -and $adbEmptyAfterShutdown)
        }
        finalJointGatePassed = $finalJointGatePassed
        primaryFailure = $primaryFailure; cleanupFailure = $cleanupFailure; steps = @($steps)
    }
    $json = $receipt | ConvertTo-Json -Depth 9
    [IO.File]::WriteAllText((Join-Path $runDir 'receipt.json'), $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

if ($BuildTimeoutSeconds -lt 180 -or $InstrumentationTimeoutSeconds -lt 30 -or $AdbTimeoutSeconds -lt 5 -or $OverallTimeoutSeconds -lt ($BuildTimeoutSeconds + 600)) { throw 'Timeouts are too short for a bounded build, three instrumentation phases, and cleanup.' }
if (-not (Test-Path -LiteralPath $gradle)) { throw "Gradle wrapper missing: $gradle" }
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

if ($NoRun) {
    $plan = [ordered]@{
        task = 'L33-F Android process recovery'; noRun = $true; serial = $Serial
        appApk = $appApk; instrumentationApk = $testApk; testClass = $testClass
        javaSource = $javaSource; runnerSource = $PSCommandPath
        phases = $phaseMethods; buildTimeoutSeconds = $BuildTimeoutSeconds
        instrumentationTimeoutSeconds = $InstrumentationTimeoutSeconds; overallTimeoutSeconds = $OverallTimeoutSeconds
        commands = @('require named API 36 emulator as sole adb device and both packages absent',
            'assembleDebug and assembleDebugAndroidTest once', 'hash APKs', 'adb install -r -t app then test APK',
            'am instrument exact prepare method; skip tutorial through its visible control; poll up to 15 seconds for the unique visible enabled Start match control and retain first/last same-frame samples of button disabled, canvas aria-disabled, controller lock reasons, and online-action protocol status; dispatch an instrumentation-injected DOM MouseEvent to start; dispatch two instrumentation-injected Canvas MouseEvents (isTrusted=false), require each product-path saved prefix to converge locally and natively, then remove only the WebView local session key and confirm the native plugin retains the exact envelope before external force-stop',
            'record prepare observation PID and require pidof to match it',
            'force-stop and confirm PID absence', 'start verify instrumentation directly so ActivityScenario cold-starts MainActivity',
            'record Bundle UI observation PID and require it differs from pre-force-stop PID',
            'when present, require post-verify pidof to match observation PID',
            'am instrument exact cleanup method', 'force-stop', 'uninstall test then app and confirm absent', 'close dedicated emulator and confirm adb inventory empty')
    }
    [IO.File]::WriteAllText((Join-Path $runDir 'plan.json'), ($plan | ConvertTo-Json -Depth 6) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Plan saved: $(Join-Path $runDir 'plan.json')"
    exit 0
}

$sourceHashesBeforeRun = Get-VerificationSourceHashes
$syncCopiesAlignedBeforeRun = Test-SyncCopiesAligned $sourceHashesBeforeRun
$script:cleanupReserveSeconds = 320
$script:timer = [Diagnostics.Stopwatch]::StartNew()
try { $adb = Resolve-Adb }
catch {
    $primaryFailure = $_.Exception.Message
    Save-Receipt 'FAIL_ADB_UNAVAILABLE'
    Write-Error "L33-F could not start. Evidence: $runDir; $primaryFailure"
    exit 1
}
try {
    if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { throw 'JAVA_HOME is required for Android Gradle verification.' }
    $javaEvidence.javaPath = Join-Path $env:JAVA_HOME 'bin\java.exe'
    $javaEvidence.jlinkPath = Join-Path $env:JAVA_HOME 'bin\jlink.exe'
    $javaEvidence.jlinkPresent = Test-Path -LiteralPath $javaEvidence.jlinkPath -PathType Leaf
    if (-not (Test-Path -LiteralPath $javaEvidence.javaPath -PathType Leaf) -or -not $javaEvidence.jlinkPresent) {
        throw "Selected JAVA_HOME is not a full JDK (java.exe and jlink.exe are required): $($env:JAVA_HOME)"
    }
    if (-not $syncCopiesAlignedBeforeRun) { throw 'Bound runtime sources/copies are misaligned: require GameController/OnlineApp/LocalGameSession source-to-dist-to-Android equality, dist-to-Android platform/entry copies, and web main.js-to-dist-to-Android equality.' }
    Invoke-Captured 'java-version' $javaEvidence.javaPath @('-version') 15 | Out-Null
    $javaEvidence.version = [IO.File]::ReadAllText((Join-Path $runDir 'java-version.stderr.txt')).Trim()

    $device = Invoke-Adb 'adb-state' @('get-state')
    if ($device.Trim() -ne 'device') { throw "ADB device is not ready: $device" }
    $inventory = Invoke-Captured 'adb-device-inventory' $adb @('devices', '-l') $AdbTimeoutSeconds
    $attached = @($inventory -split "`r?`n" | Where-Object { $_ -match '^\S+\s+device\b' })
    if ($attached.Count -ne 1 -or $attached[0] -notmatch ('^' + [regex]::Escape($Serial) + '\s+device\b')) { throw 'Require exactly the named dedicated emulator as the only attached adb device.' }
    if ($Serial -notmatch '^emulator-\d+$') { throw 'Serial must identify an Android emulator; physical devices are not accepted.' }
    $dedicatedEmulatorValidated = $true
    $api = (Invoke-Adb 'adb-api' @('shell', 'getprop', 'ro.build.version.sdk')).Trim()
    $emulator = (Invoke-Adb 'adb-emulator' @('shell', 'getprop', 'ro.kernel.qemu')).Trim()
    if ($api -ne '36' -or $emulator -ne '1') { throw "Expected isolated API 36 emulator; got API=$api ro.kernel.qemu=$emulator" }
    Invoke-Adb 'adb-build-fingerprint' @('shell', 'getprop', 'ro.build.fingerprint') | Out-Null
    Invoke-Adb 'adb-boot-id' @('shell', 'cat', '/proc/sys/kernel/random/boot_id') | Out-Null
    Invoke-Adb 'adb-abi' @('shell', 'getprop', 'ro.product.cpu.abi') | Out-Null
    Invoke-Adb 'adb-webview-provider' @('shell', 'dumpsys', 'webviewupdate') | Out-Null
    $appPrePath = Get-PackagePath 'pre-app-package-path' $appId
    $testPrePath = Get-PackagePath 'pre-test-package-path' $testId
    Invoke-Adb 'pre-app-package-details' @('shell', 'dumpsys', 'package', $appId) | Out-Null
    Invoke-Adb 'pre-test-package-details' @('shell', 'dumpsys', 'package', $testId) | Out-Null
    if ($appPrePath -or $testPrePath) { throw "Fail-closed: target and test packages must both be absent (app='$appPrePath', test='$testPrePath')." }
    $packagesWereAbsent = $true
    $initialPid = Get-AppPid 'pre-pid'

    Invoke-Captured 'gradle-wrapper-probe' $env:ComSpec @('/d', '/c', 'call', $gradle, '--version') 45 | Out-Null
    Invoke-Captured 'gradle-build-apks' $env:ComSpec @('/d', '/c', 'call', $gradle, '--no-daemon', ':app:assembleDebug', ':app:assembleDebugAndroidTest', '--console=plain') $BuildTimeoutSeconds | Out-Null
    $apkEvidence.app = Get-FileEvidence $appApk
    $apkEvidence.instrumentation = Get-FileEvidence $testApk

    $installAttempted = $true
    Invoke-Adb 'install-app' @('install', '-r', '-t', $appApk) 90 | Out-Null
    Invoke-Adb 'install-instrumentation' @('install', '-r', '-t', $testApk) 90 | Out-Null
    $installCompleted = $true
    $installedAppPath = Get-PackagePath 'installed-app-package-path' $appId
    $installedTestPath = Get-PackagePath 'installed-test-package-path' $testId
    if (-not $installedAppPath -or -not $installedTestPath) { throw 'One or both APK installs are not visible in package manager.' }
    Invoke-Adb 'installed-app-package-details' @('shell', 'dumpsys', 'package', $appId) | Out-Null
    Invoke-Adb 'installed-test-package-details' @('shell', 'dumpsys', 'package', $testId) | Out-Null

    Invoke-PrepareHeldInstrumentation
    if (-not $prepareReadyReceived -or -not $prepareStatusCode2Received -or -not $prepareHostAliveAtReady -or -not $preparePidValidated -or -not $prepareForceStopIssued -or -not $prepareOldPidGone -or -not $prepareExitAfterForceStop -or $prepareNormalCompletionObserved -or $prepareHostAdbKilled) {
        throw 'Prepare boundary did not satisfy all required ready, live-host, PID, external force-stop, and expected process-exit checks.'
    }

    $pidBeforeVerify = Get-AppPid 'pid-before-verify'
    if ($pidBeforeVerify) { throw "Target process restarted before verify instrumentation (PID=$pidBeforeVerify); cold-start boundary is invalid." }
    Invoke-Phase 'verify'
    $prepareVerifyPhasePassed = $true
    $pidAfterVerify = Get-AppPid 'pid-after-verify'
    if ($pidAfterVerify -and [int]$pidAfterVerify -ne [int](Get-ObservationProperty $uiObservation 'inProcessPid' 0)) { throw "Post-instrumentation PID does not match the UI observation (pidof=$pidAfterVerify observed=$($uiObservation.inProcessPid))." }
    Invoke-Adb 'post-verify-app-package-details' @('shell', 'dumpsys', 'package', $appId) | Out-Null
    Invoke-Adb 'post-verify-test-package-details' @('shell', 'dumpsys', 'package', $testId) | Out-Null
} catch {
    $primaryFailure = $_.Exception.Message
} finally {
    $script:cleanupMode = $true
    $script:cleanupTimer = [Diagnostics.Stopwatch]::StartNew()
    if ($installAttempted) {
        try {
            if ($script:prepareProcess -and $script:prepareHostStarted -and -not $script:prepareForceStopIssued) { $script:prepareForceStopUtc = [DateTimeOffset]::UtcNow.ToString('o') }
            Invoke-Adb 'force-stop-before-cleanup' @('shell', 'am', 'force-stop', $appId) 20 | Out-Null
            if ($script:prepareProcess -and $script:prepareHostStarted) { $script:prepareForceStopIssued = $true }
        }
        catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
    }
    if ($script:prepareProcess -and $script:prepareHostStarted) {
        try {
            if (-not $script:prepareProcess.HasExited) {
                if (-not $script:prepareForceStopIssued) {
                    $script:prepareForceStopUtc = [DateTimeOffset]::UtcNow.ToString('o')
                    Invoke-Adb 'cleanup-force-stop-held-prepare' @('shell', 'am', 'force-stop', $appId) 20 | Out-Null
                    $script:prepareForceStopIssued = $true
                }
                $prepareCleanupDeadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
                while (-not $script:prepareProcess.HasExited -and [DateTimeOffset]::UtcNow -lt $prepareCleanupDeadline) {
                    Pump-PrepareOutput
                    Start-Sleep -Milliseconds 25
                }
                if (-not $script:prepareProcess.HasExited) {
                    $script:prepareHostAdbKilled = $true
                    $script:prepareProcess.Kill($true)
                    [void]$script:prepareProcess.WaitForExit(5000)
                    throw 'Cleanup had to kill the prepare adb host process after force-stopping the target.'
                }
            }
            $script:prepareProcess.WaitForExit()
            $script:prepareExitCode = $script:prepareProcess.ExitCode
            if (-not $script:prepareExitUtc) { $script:prepareExitUtc = [DateTimeOffset]::UtcNow.ToString('o') }
            if ($script:prepareForceStopIssued -and $script:prepareForceStopUtc) { $script:prepareExitAfterForceStop = $true }
            $finalizeProcess = $script:prepareProcess
            Finalize-PrepareProcess $finalizeProcess $null $script:prepareStartedUtc
            if ($script:prepareFinalizeFailure) { throw "Prepare process finalization failed: $script:prepareFinalizeFailure" }
        } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
    }
    if ($installAttempted) {
        try {
            if (Get-PackagePath 'cleanup-test-package-presence' $testId) { Invoke-Phase 'cleanup'; $cleanupPhasePassed = $true }
            else { throw 'Instrumentation package absent; cleanup test could not run.' }
        } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        try { Invoke-Adb 'final-force-stop' @('shell', 'am', 'force-stop', $appId) 20 | Out-Null }
        catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        try {
            Invoke-Adb 'pre-uninstall-app-package-details' @('shell', 'dumpsys', 'package', $appId) | Out-Null
            Invoke-Adb 'pre-uninstall-test-package-details' @('shell', 'dumpsys', 'package', $testId) | Out-Null
            $postCleanupPid = Get-AppPid 'pid-before-uninstall'
        } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        try { Invoke-Adb 'uninstall-instrumentation' @('uninstall', $testId) 30 | Out-Null }
        catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        try { Invoke-Adb 'uninstall-app' @('uninstall', $appId) 30 | Out-Null }
        catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }

        try {
            $appAbsent = -not (Get-PackagePath 'post-app-package-path' $appId)
            $testAbsent = -not (Get-PackagePath 'post-test-package-path' $testId)
            if (-not ($appAbsent -and $testAbsent)) { throw "Uninstall not confirmed (appAbsent=$appAbsent, testAbsent=$testAbsent)." }
            $uninstallConfirmed = $true
        } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
    }
    if ($dedicatedEmulatorValidated) {
        try { Invoke-Adb 'close-dedicated-emulator' @('emu', 'kill') 30 | Out-Null; $emulatorShutdownConfirmed = $true }
        catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        try {
            $adbEmptyAfterShutdown = $false
            $shutdownDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
            do {
                $inventoryAfterShutdown = Invoke-Captured 'adb-inventory-after-emulator-close' $adb @('devices', '-l') 25
                $deviceRows = @($inventoryAfterShutdown -split "`r?`n" | Where-Object { $_.Trim() -and $_ -notmatch '^List of devices attached' })
                if ($deviceRows.Count -eq 0) { $adbEmptyAfterShutdown = $true; break }
                Start-Sleep -Seconds 2
            } while ([DateTimeOffset]::UtcNow -lt $shutdownDeadline)
            if (-not $adbEmptyAfterShutdown) { throw "adb still lists device rows after emulator shutdown: $($deviceRows -join '; ')" }
        } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
    }
    try {
        if (Test-Path -LiteralPath $appApk -PathType Leaf) { $apkEvidenceAfterRun.app = Get-FileEvidence $appApk }
        if (Test-Path -LiteralPath $testApk -PathType Leaf) { $apkEvidenceAfterRun.instrumentation = Get-FileEvidence $testApk }
        if ($apkEvidence.app -and $apkEvidence.instrumentation -and $apkEvidenceAfterRun.app -and $apkEvidenceAfterRun.instrumentation) {
            $apkUnchangedDuringRun = ($apkEvidence.app.sha256 -ceq $apkEvidenceAfterRun.app.sha256 -and
                $apkEvidence.instrumentation.sha256 -ceq $apkEvidenceAfterRun.instrumentation.sha256)
            if (-not $apkUnchangedDuringRun -and -not $cleanupFailure) { $cleanupFailure = 'An APK changed during the verification run.' }
        }
        $sourceHashesAfterRun = Get-VerificationSourceHashes
        $syncCopiesAlignedAfterRun = Test-SyncCopiesAligned $sourceHashesAfterRun
        $sourceFilesUnchangedDuringRun = (($sourceHashesBeforeRun | ConvertTo-Json -Compress) -eq ($sourceHashesAfterRun | ConvertTo-Json -Compress))
        if (-not $sourceFilesUnchangedDuringRun -and -not $cleanupFailure) { $cleanupFailure = 'A bound verification source changed during the run; recorded hashes do not bind one stable source state.' }
        if (-not $syncCopiesAlignedAfterRun -and -not $cleanupFailure) { $cleanupFailure = 'Bound runtime source/copy alignment failed in final state.' }
    } catch { if (-not $cleanupFailure) { $cleanupFailure = "Could not hash final verification sources: $($_.Exception.Message)" } }
    $finalJointGatePassed = (
        $prepareReadyReceived -and $prepareStatusCode2Received -and (Test-PrepareStartWaitSamplesPersisted (Get-PrepareStartWaitDiagnostics $prepareReadyObservation)) -and (Test-PrepareObservationUniqueAndPaired) -and $prepareHostAliveAtReady -and $preparePidValidated -and
        $prepareForceStopIssued -and $prepareOldPidGone -and $pidGoneAfterForceStop -and $prepareExitAfterForceStop -and
        -not $prepareNormalCompletionObserved -and -not $prepareHostAdbKilled -and $prepareVerifyPhasePassed -and $cleanupPhasePassed -and
        $prepareOutputFullyDrained -and -not $prepareFinalizeFailure -and $verifyObservationReceived -and $broadUiPassed -and
        $nativeAuthorityPassed -and $verifyJUnitPassed -and $apkUnchangedDuringRun -eq $true -and
        [string]::IsNullOrWhiteSpace([string]$pidBeforeVerify) -and
        $uiObservation -and $pidBeforeForceStop -and [int](Get-ObservationProperty $uiObservation 'inProcessPid' 0) -gt 0 -and
        [int](Get-ObservationProperty $uiObservation 'inProcessPid' 0) -ne [int]$pidBeforeForceStop -and $sourceFilesUnchangedDuringRun -and
        $syncCopiesAlignedBeforeRun -and $syncCopiesAlignedAfterRun -and $uninstallConfirmed -and
        $emulatorShutdownConfirmed -and $adbEmptyAfterShutdown
    )
    if (-not $finalJointGatePassed -and -not $primaryFailure -and -not $cleanupFailure) {
        $cleanupFailure = 'One or more explicit final joint PASS gates were false.'
    }
    $status = if ($primaryFailure -or $cleanupFailure -or -not $finalJointGatePassed) { 'FAIL' } else { 'PASS_INSTRUMENTED_CANVAS_SAVE_FORCE_STOP_RESTORE_CONTINUE' }
    try { Save-Receipt $status }
    catch { if (-not $cleanupFailure) { $cleanupFailure = "Could not save receipt: $($_.Exception.Message)" } }
}

if ($primaryFailure -or $cleanupFailure) {
    Write-Error "L33-F failed. Evidence: $runDir; primary=$primaryFailure; cleanup=$cleanupFailure"
    exit 1
}
Write-Output "L33-F instrumented Canvas MouseEvent save, force-stop, restore, and continued-play check passed. Events are untrusted and do not prove physical touch or real-device behavior. Evidence: $runDir"
exit 0
