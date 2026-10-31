[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Serial,
    [string] $EvidenceRoot = (Join-Path $env:LOCALAPPDATA 'Lifeline\verification\l33d-process-recovery'),
    [int] $BuildTimeoutSeconds = 240,
    [int] $InstrumentationTimeoutSeconds = 90,
    [int] $AdbTimeoutSeconds = 25,
    [int] $OverallTimeoutSeconds = 900,
    [switch] $NoRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidRoot = Join-Path $repoRoot 'android'
$gradle = Join-Path $androidRoot 'gradlew.bat'
$appId = 'cn.lifelinegame.mobile'
$testId = "$appId.test"
$testClass = 'cn.lifelinegame.mobile.LifelineProcessRecoveryTest'
$instrumentation = "$testId/androidx.test.runner.AndroidJUnitRunner"
$phaseMethods = [ordered]@{ prepare = 'prepareSavedSession'; verify = 'verifyColdStartStorageAndSessionParser'; cleanup = 'cleanupSessionAndVerifyTombstone' }
$appApk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $androidRoot 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
$javaSource = Join-Path $androidRoot 'app\src\androidTest\java\cn\lifelinegame\mobile\LifelineProcessRecoveryTest.java'
$safeSerial = $Serial -replace '[^A-Za-z0-9_.-]', '_'
$runId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + $safeSerial
$runDir = Join-Path $EvidenceRoot $runId
$startedAt = [DateTimeOffset]::UtcNow
$steps = [System.Collections.Generic.List[object]]::new()
$primaryFailure = $null
$cleanupFailure = $null
$adb = $null
$apkEvidence = [ordered]@{ app = $null; instrumentation = $null }
$initialPid = $null
$pidBeforeForceStop = $null
$relaunchPid = $null
$pidGoneAfterForceStop = $false
$pidBeforeVerify = $null
$pidAfterVerify = $null
$postCleanupPid = $null
$packagesWereAbsent = $false
$installAttempted = $false
$installCompleted = $false
$uninstallConfirmed = $false
$javaEvidence = [ordered]@{ home = $env:JAVA_HOME; javaPath = $null; jlinkPath = $null; jlinkPresent = $false; version = $null }
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
        try { $stdoutText = $stdoutTask.GetAwaiter().GetResult() } catch { }
        try { $stderrText = $stderrTask.GetAwaiter().GetResult() } catch { }
    } finally {
        [IO.File]::WriteAllText($stdoutPath, $stdoutText, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($stderrPath, $stderrText, [Text.UTF8Encoding]::new($false))
        $process.Dispose()
    }
    $record = [pscustomobject]@{
        name = $Name; executable = $Executable; arguments = $Arguments; rawCommandLine = $RawCommandLine
        startedUtc = $began.ToString('o'); finishedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        timeoutSeconds = $TimeoutSeconds; timedOut = $timedOut; exitCode = $exitCode
        stdout = [IO.Path]::GetFileName($stdoutPath); stderr = [IO.Path]::GetFileName($stderrPath)
    }
    $steps.Add($record)
    if ($timedOut) { throw "$Name exceeded its $TimeoutSeconds second timeout." }
    if ($exitCode -ne 0 -and -not $AllowFailure) { throw "$Name failed with exit code $exitCode." }
    return $stdoutText
}

function Invoke-Adb([string] $Name, [string[]] $Arguments, [int] $Timeout = $AdbTimeoutSeconds, [switch] $AllowFailure) {
    return Invoke-Captured $Name $adb (@('-s', $Serial) + $Arguments) $Timeout -AllowFailure:$AllowFailure
}

function Get-AppPid([string] $Name) {
    return (Invoke-Adb $Name @('shell', 'pidof', $appId) 12 -AllowFailure).Trim()
}

function Get-PackagePath([string] $Name, [string] $Package) {
    return (Invoke-Adb $Name @('shell', 'pm', 'path', $Package) 15 -AllowFailure).Trim()
}

function Invoke-Phase([string] $Phase) {
    $method = $phaseMethods[$Phase]
    $args = @('-s', $Serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', "$testClass#$method",
        '-e', 'phase', $Phase, $instrumentation)
    $output = Invoke-Captured "instrumentation-$Phase" $adb $args $InstrumentationTimeoutSeconds
    $codeOk = $output -match '(?m)^INSTRUMENTATION_CODE:\s*-1\s*$'
    $testOk = $output -match '(?m)^INSTRUMENTATION_STATUS_CODE:\s*0\s*$'
    if (-not ($codeOk -and $testOk)) { throw "Instrumentation $Phase lacked successful INSTRUMENTATION_STATUS_CODE 0 and INSTRUMENTATION_CODE -1 evidence." }
    $step = $steps[$steps.Count - 1]
    $step | Add-Member -NotePropertyName instrumentationStatusCode0 -NotePropertyValue $testOk
    $step | Add-Member -NotePropertyName instrumentationCodeMinus1 -NotePropertyValue $codeOk
}

function Get-FileEvidence([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Expected APK missing: $Path" }
    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{ path = $Path; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Get-SourceEvidence([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{ path = $Path; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Save-Receipt([string] $Status) {
    $receipt = [ordered]@{
        schemaVersion = 2; task = 'L33-D Android process recovery'; status = $Status
        scope = 'storage-plus-parser; Android emulator force-stop cold start; UI restore not observed'
        serial = $Serial; applicationId = $appId; instrumentationPackage = $testId
        instrumentationRunner = $instrumentation; testClass = $testClass; runDirectory = $runDir
        startedUtc = $startedAt.ToString('o'); finishedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        totalTimeoutSeconds = $OverallTimeoutSeconds; buildTimeoutSeconds = $BuildTimeoutSeconds
        instrumentationTimeoutSeconds = $InstrumentationTimeoutSeconds; adbTimeoutSeconds = $AdbTimeoutSeconds
        packagesAbsentBeforeInstall = $packagesWereAbsent; installAttempted = $installAttempted
        installCompleted = $installCompleted; uninstallConfirmed = $uninstallConfirmed
        apk = $apkEvidence
        java = $javaEvidence
        source = [ordered]@{ java = (Get-SourceEvidence $javaSource); runner = (Get-SourceEvidence $PSCommandPath) }
        initialPid = $initialPid; pidBeforeForceStop = $pidBeforeForceStop
        pidGoneAfterForceStop = $pidGoneAfterForceStop; relaunchPid = $relaunchPid
        pidBeforeVerify = $pidBeforeVerify; pidAfterVerify = $pidAfterVerify; postCleanupPid = $postCleanupPid
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
        task = 'L33-D Android process recovery'; noRun = $true; serial = $Serial
        appApk = $appApk; instrumentationApk = $testApk; testClass = $testClass
        javaSource = $javaSource; runnerSource = $PSCommandPath
        phases = $phaseMethods; buildTimeoutSeconds = $BuildTimeoutSeconds
        instrumentationTimeoutSeconds = $InstrumentationTimeoutSeconds; overallTimeoutSeconds = $OverallTimeoutSeconds
        commands = @('preflight API 36 emulator and require both packages absent',
            'assembleDebug and assembleDebugAndroidTest once', 'hash APKs', 'adb install -r -t app then test APK',
            'am instrument exact prepare method', 'am start MainActivity and record PID',
            'force-stop and confirm PID absence', 'am start and record cold-start PID',
            'am instrument exact verify method', 'record post-verify PID and package state',
            'am instrument exact cleanup method', 'force-stop', 'uninstall test then app and confirm absent')
    }
    [IO.File]::WriteAllText((Join-Path $runDir 'plan.json'), ($plan | ConvertTo-Json -Depth 6) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Plan saved: $(Join-Path $runDir 'plan.json')"
    exit 0
}

$script:cleanupReserveSeconds = 320
$script:timer = [Diagnostics.Stopwatch]::StartNew()
try { $adb = Resolve-Adb }
catch {
    $primaryFailure = $_.Exception.Message
    Save-Receipt 'FAIL_ADB_UNAVAILABLE'
    Write-Error "L33-D could not start. Evidence: $runDir; $primaryFailure"
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
    Invoke-Captured 'java-version' $javaEvidence.javaPath @('-version') 15 | Out-Null
    $javaEvidence.version = [IO.File]::ReadAllText((Join-Path $runDir 'java-version.stderr.txt')).Trim()

    $device = Invoke-Adb 'adb-state' @('get-state')
    if ($device.Trim() -ne 'device') { throw "ADB device is not ready: $device" }
    Invoke-Captured 'adb-device-inventory' $adb @('devices', '-l') $AdbTimeoutSeconds | Out-Null
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

    Invoke-Phase 'prepare'
    Invoke-Adb 'start-after-prepare' @('shell', 'am', 'start', '-W', '-n', "$appId/.MainActivity") 45 | Out-Null
    $pidBeforeForceStop = Get-AppPid 'pid-before-force-stop'
    if (-not $pidBeforeForceStop) { throw 'Target app has no process after prepare instrumentation.' }
    Invoke-Adb 'force-stop-after-prepare' @('shell', 'am', 'force-stop', $appId) | Out-Null
    $goneDeadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    do {
        $remaining = Get-AppPid 'pid-gone-poll'
        if (-not $remaining) { $pidGoneAfterForceStop = $true; break }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $goneDeadline)
    if (-not $pidGoneAfterForceStop) { throw "Target process remained after force-stop (PID=$remaining)." }

    Invoke-Adb 'relaunch' @('shell', 'am', 'start', '-W', '-n', "$appId/.MainActivity") 45 | Out-Null
    $relaunchDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    do {
        $relaunchPid = Get-AppPid 'relaunch-pid-poll'
        if ($relaunchPid) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $relaunchDeadline)
    if (-not $relaunchPid) { throw 'Target process did not return after explicit relaunch.' }
    if ($relaunchPid -eq $pidBeforeForceStop) { throw "PID unchanged across confirmed absence: $pidBeforeForceStop" }

    $pidBeforeVerify = Get-AppPid 'pid-before-verify'
    Invoke-Phase 'verify'
    $pidAfterVerify = Get-AppPid 'pid-after-verify'
    Invoke-Adb 'post-verify-app-package-details' @('shell', 'dumpsys', 'package', $appId) | Out-Null
    Invoke-Adb 'post-verify-test-package-details' @('shell', 'dumpsys', 'package', $testId) | Out-Null
} catch {
    $primaryFailure = $_.Exception.Message
} finally {
    $script:cleanupMode = $true
    $script:cleanupTimer = [Diagnostics.Stopwatch]::StartNew()
    if ($installAttempted) {
        try {
            if (Get-PackagePath 'cleanup-test-package-presence' $testId) { Invoke-Phase 'cleanup' }
            else { throw 'Instrumentation package absent; cleanup test could not run.' }
        } catch { $cleanupFailure = $_.Exception.Message }
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
    $status = if ($primaryFailure -or $cleanupFailure) { 'FAIL' } else { 'PASS_STORAGE_PARSER_FORCE_STOP_RELAUNCH' }
    try { Save-Receipt $status }
    catch { if (-not $cleanupFailure) { $cleanupFailure = "Could not save receipt: $($_.Exception.Message)" } }
}

if ($primaryFailure -or $cleanupFailure) {
    Write-Error "L33-D failed. Evidence: $runDir; primary=$primaryFailure; cleanup=$cleanupFailure"
    exit 1
}
Write-Output "L33-D storage/parser force-stop cold-start check passed. Evidence: $runDir"
exit 0
