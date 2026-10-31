[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Serial,
    [string] $EvidenceRoot = (Join-Path $env:LOCALAPPDATA 'Lifeline\verification\l34a-r16-hard-worker'),
    [int] $TimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$mobileRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $mobileRoot '..')).Path
$androidRoot = Join-Path $mobileRoot 'android'
$appId = 'cn.lifelinegame.mobile'
$testId = "$appId.test"
$testClass = 'cn.lifelinegame.mobile.LifelineHardWorkerCanaryTest'
$runner = "$testId/androidx.test.runner.AndroidJUnitRunner"
$avdName = 'lifeline-l33f-api36-x86_64'
$appApk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $androidRoot 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
$javaSource = Join-Path $androidRoot 'app\src\androidTest\java\cn\lifelinegame\mobile\LifelineHardWorkerCanaryTest.java'
$mobileWebBuildReceiptPath = Join-Path $mobileRoot 'local_artifacts\mobile-web-build-receipt.json'
$mobileWebBuildReceipt = Get-Content -LiteralPath $mobileWebBuildReceiptPath -Raw | ConvertFrom-Json
if ($mobileWebBuildReceipt.runtime_asset_version -ne '20261024-l34a1' -or $mobileWebBuildReceipt.current_web_sync_release_id -ne 'web-current-sync-20261024-r16') { throw 'Refusing canary run without the current R16 mobile Web receipt.' }
$appExpectedSha256 = 'b2dcb63af31af68c5d02892f034dbaba455bd9bd7317122d8c0641af1a5fbb98'
$localSdk = Join-Path $mobileRoot 'local_artifacts\android-sdk'
$localJdk = Join-Path $mobileRoot 'local_artifacts\toolchain\jdk-21.0.12.1+1'
if ([string]::IsNullOrWhiteSpace($env:ANDROID_SDK_ROOT) -and (Test-Path -LiteralPath (Join-Path $localSdk 'platform-tools\adb.exe'))) { $env:ANDROID_SDK_ROOT = $localSdk }
if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME) -and -not [string]::IsNullOrWhiteSpace($env:ANDROID_SDK_ROOT)) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME) -and (Test-Path -LiteralPath (Join-Path $localJdk 'bin\java.exe'))) { $env:JAVA_HOME = $localJdk }
if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path }
if (-not [string]::IsNullOrWhiteSpace($env:ANDROID_SDK_ROOT)) { $env:Path = (Join-Path $env:ANDROID_SDK_ROOT 'platform-tools') + ';' + $env:Path }
$runId = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + ($Serial -replace '[^A-Za-z0-9_.-]', '_')
$runDir = Join-Path $EvidenceRoot $runId
$receiptPath = Join-Path $runDir 'receipt.json'
$adb = $null
$emulatorProcess = $null
$emulatorStartedByRunner = $false
$dedicatedEmulatorValidated = $false
$packagesInitiallyAbsent = $false
$started = [DateTimeOffset]::UtcNow
$primaryFailure = $null
$cleanupFailure = $null
$steps = [System.Collections.Generic.List[object]]::new()
$appBefore = $null
$appAfterBuild = $null
$testApkEvidence = $null
$testExitCode = $null
$testOutput = ''
$appInstalled = $false
$testInstalled = $false
$testExecuted = $false
$uninstalled = $false
$emulatorClosed = $false
$adbEmpty = $false

function Get-FileEvidence([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file missing: $Path" }
    $file = Get-Item -LiteralPath $Path
    return [ordered]@{ path = $file.FullName; bytes = $file.Length; lastWriteTimeUtc = $file.LastWriteTimeUtc.ToString('o'); sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Find-Adb {
    foreach ($sdk in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)) {
        if (-not [string]::IsNullOrWhiteSpace($sdk)) {
            $candidate = Join-Path $sdk 'platform-tools\adb.exe'
            if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
        }
    }
    $command = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'adb.exe not found; set ANDROID_SDK_ROOT or ANDROID_HOME.'
}

function Invoke-Logged([string] $Name, [string] $Executable, [string[]] $Arguments, [int] $LimitSeconds = 45, [switch] $AllowFailure) {
    $outPath = Join-Path $runDir "$Name.stdout.txt"
    $errPath = Join-Path $runDir "$Name.stderr.txt"
    $info = [Diagnostics.ProcessStartInfo]::new()
    $effectiveExecutable = $Executable
    $effectiveArguments = @($Arguments)
    if ([IO.Path]::GetExtension($Executable) -ieq '.bat') {
        $effectiveExecutable = $env:ComSpec
        $effectiveArguments = @('/d', '/c', 'call', ('"' + $Executable + '"')) + $Arguments
    }
    $info.FileName = $effectiveExecutable
    $info.WorkingDirectory = $androidRoot
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if ([IO.Path]::GetExtension($Executable) -ieq '.bat') {
        $info.Arguments = '/d /c call "' + $Executable + '" ' + ($Arguments -join ' ')
    } else {
        foreach ($argument in $effectiveArguments) { [void]$info.ArgumentList.Add([string]$argument) }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $exitCode = $null
    $timedOut = $false
    $stdout = ''
    $stderr = ''
    if (-not $process.Start()) { throw "Could not start $effectiveExecutable." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($LimitSeconds * 1000)) {
        $timedOut = $true
        try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
        [void]$process.WaitForExit(5000)
    } else { $process.WaitForExit(); $exitCode = $process.ExitCode }
    try { $stdout = $stdoutTask.GetAwaiter().GetResult() } catch { $stdout = "stdout read failed: $($_.Exception.Message)" }
    try { $stderr = $stderrTask.GetAwaiter().GetResult() } catch { $stderr = "stderr read failed: $($_.Exception.Message)" }
    [IO.File]::WriteAllText($outPath, $stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($errPath, $stderr, [Text.UTF8Encoding]::new($false))
    $steps.Add([ordered]@{ name = $Name; executable = $Executable; arguments = $Arguments; exitCode = $exitCode; timedOut = $timedOut; stdoutFile = $outPath; stderrFile = $errPath }) | Out-Null
    if ($timedOut) { throw "$Name exceeded its $LimitSeconds second timeout and was terminated." }
    if (-not $AllowFailure -and $exitCode -ne 0) { throw "$Name failed with exit code $exitCode`: $stderr $stdout" }
    return [ordered]@{ exitCode = $exitCode; stdout = $stdout; stderr = $stderr }
}

function Invoke-Adb([string] $Name, [string[]] $Arguments, [int] $LimitSeconds = 45, [switch] $AllowFailure) {
    return Invoke-Logged $Name $adb (@('-s', $Serial) + $Arguments) $LimitSeconds -AllowFailure:$AllowFailure
}

function Package-Path([string] $Package) {
    $result = Invoke-Adb "package-$($Package.Replace('.', '-'))" @('shell', 'pm', 'path', $Package) -AllowFailure
    return [bool]($result.stdout -match '^package:')
}

function Save-Receipt([string] $Status) {
    $receipt = [ordered]@{
        schema = 'lifeline-android-hard-worker-l34-a-r16-v1'; task = 'L34-A R16 Android packaged Hard module Worker'; status = $Status
        mobileWebBuildReceipt = Get-FileEvidence $mobileWebBuildReceiptPath
        currentWebSyncReleaseId = $mobileWebBuildReceipt.current_web_sync_release_id; runtimeAssetVersion = $mobileWebBuildReceipt.runtime_asset_version
        startedAtUtc = $started.ToString('o'); finishedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        scope = 'Packaged Capacitor WebView on one named API 36 Android emulator; no physical-device, strength, or timing claim'
        serial = $Serial; avdName = $avdName; applicationId = $appId; instrumentationPackage = $testId
        instrumentationRunner = $runner; testClass = $testClass; source = Get-FileEvidence $javaSource
        appApkBefore = $appBefore; appApkAfterBuild = $appAfterBuild; appApkAfterRun = $appAfterRun
        instrumentationApk = $testApkEvidence; instrumentationExitCode = $testExitCode
        appInstalled = $appInstalled; instrumentationInstalled = $testInstalled; instrumentationExecuted = $testExecuted
        packagesUninstalled = $uninstalled
        emulatorClosed = $emulatorClosed; adbEmptyAfterShutdown = $adbEmpty
        primaryFailure = $primaryFailure; cleanupFailure = $cleanupFailure; steps = @($steps)
    }
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 10) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$appAfterRun = $null
try {
    $adb = Find-Adb
    $appBefore = Get-FileEvidence $appApk
    if ($appBefore.sha256 -cne $appExpectedSha256) { throw "Fail-closed: app APK SHA-256 is $($appBefore.sha256), expected $appExpectedSha256." }
    if ($TimeoutSeconds -lt 60) { throw 'TimeoutSeconds must be at least 60.' }

    if ($Serial -notmatch '^emulator-(\d+)$') { throw 'Serial must be a dedicated emulator serial such as emulator-5554.' }
    $port = [int]$Matches[1]
    $inventory = Invoke-Logged 'adb-inventory-before' $adb @('devices', '-l') 20
    $deviceRows = @($inventory.stdout -split "`r?`n" | Where-Object { $_ -match '^\S+\s+device\b' })
    if ($deviceRows.Count -ne 0) { throw "Fail-closed: this runner only starts its own dedicated AVD; existing online ADB devices were found: $($deviceRows -join '; ')." }
    if ($deviceRows.Count -eq 0) {
        $emulatorExe = Join-Path $env:ANDROID_SDK_ROOT 'emulator\emulator.exe'
        if (-not (Test-Path -LiteralPath $emulatorExe)) { throw "Android emulator executable missing: $emulatorExe" }
        $emulatorProcess = Start-Process -FilePath $emulatorExe -ArgumentList @('-avd', $avdName, '-port', [string]$port, '-no-window', '-no-audio', '-no-boot-anim') -WindowStyle Hidden -PassThru
        $emulatorStartedByRunner = $true
        $bootDeadline = [DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(240, $TimeoutSeconds))
        do {
            if ($emulatorProcess.HasExited) { throw "Dedicated emulator exited during startup with code $($emulatorProcess.ExitCode)." }
            Start-Sleep -Seconds 3
            $inventory = Invoke-Logged 'adb-inventory-during-startup' $adb @('devices', '-l') 20 -AllowFailure
            $deviceRows = @($inventory.stdout -split "`r?`n" | Where-Object { $_ -match '^\S+\s+device\b' })
            if ($deviceRows.Count -gt 1 -or ($deviceRows.Count -eq 1 -and $deviceRows[0] -notmatch ('^' + [regex]::Escape($Serial) + '\s+device\b'))) {
                throw "Fail-closed: expected only $Serial while starting the dedicated AVD; found $($deviceRows -join '; ')."
            }
            if ($deviceRows.Count -eq 1) {
                $boot = Invoke-Logged 'emulator-boot-complete' $adb @('-s', $Serial, 'shell', 'getprop', 'sys.boot_completed') 10 -AllowFailure
                if ($boot.stdout.Trim() -eq '1') { break }
            }
        } while ([DateTimeOffset]::UtcNow -lt $bootDeadline)
        if ($deviceRows.Count -ne 1) { throw "Dedicated emulator $Serial did not boot before the bounded deadline." }
        $boot = Invoke-Logged 'emulator-boot-complete-final' $adb @('-s', $Serial, 'shell', 'getprop', 'sys.boot_completed') 10
        if ($boot.stdout.Trim() -ne '1') { throw 'Dedicated emulator did not report boot completion.' }
    }
    if ($deviceRows.Count -ne 1 -or $deviceRows[0] -notmatch ('^' + [regex]::Escape($Serial) + '\s+device\b')) {
        throw "Fail-closed: expected the named emulator $Serial as the sole online adb device; found $($deviceRows -join '; ')."
    }
    $avd = Invoke-Adb 'emulator-avd-name' @('emu', 'avd', 'name')
    if ($avd.stdout -notmatch "(?m)^$([regex]::Escape($avdName))\s*$") { throw "Fail-closed: connected AVD is not $($avdName): $($avd.stdout.Trim())" }
    $api = Invoke-Adb 'emulator-api-level' @('shell', 'getprop', 'ro.build.version.sdk')
    if ($api.stdout.Trim() -ne '36') { throw "Fail-closed: emulator API level must be 36, got '$($api.stdout.Trim())'." }
    $dedicatedEmulatorValidated = $true
    foreach ($package in @($appId, $testId)) {
        if (Package-Path $package) { throw "Fail-closed: $package was already installed; preserve existing emulator state." }
    }
    $packagesInitiallyAbsent = $true

    $build = Invoke-Logged 'gradle-assemble-android-test' (Join-Path $androidRoot 'gradlew.bat') @('--no-daemon', ':app:assembleDebugAndroidTest', '--console=plain') $TimeoutSeconds
    if ($build.exitCode -ne 0) { throw "AndroidTest packaging failed: $($build.stderr) $($build.stdout)" }
    $appAfterBuild = Get-FileEvidence $appApk
    if ($appAfterBuild.sha256 -cne $appExpectedSha256) { throw "App APK changed during AndroidTest packaging: before=$($appBefore.sha256) after=$($appAfterBuild.sha256); stopped before install." }
    $testApkEvidence = Get-FileEvidence $testApk

    Invoke-Adb 'install-app' @('install', '-t', $appApk) | Out-Null
    $appInstalled = $true
    Invoke-Adb 'install-android-test' @('install', '-t', $testApk) | Out-Null
    $testInstalled = $true
    if (-not (Package-Path $appId) -or -not (Package-Path $testId)) { throw 'Installed application or instrumentation package is not visible.' }
    $test = Invoke-Adb 'run-hard-worker-instrumentation' @('shell', 'am', 'instrument', '-w', '-e', 'class', $testClass, $runner) -LimitSeconds ([Math]::Max(150, $TimeoutSeconds)) -AllowFailure
    $testExecuted = $true
    $testExitCode = $test.exitCode
    $testOutput = $test.stdout + [Environment]::NewLine + $test.stderr
    [IO.File]::WriteAllText((Join-Path $runDir 'instrumentation-output.txt'), $testOutput, [Text.UTF8Encoding]::new($false))
    if ($test.exitCode -ne 0 -or $testOutput -notmatch 'OK \(1 test\)') { throw "Instrumentation did not report exactly one passing test (exit=$($test.exitCode))." }
} catch {
    $primaryFailure = $_.Exception.Message
} finally {
    if ($adb) {
        if ($dedicatedEmulatorValidated -and $packagesInitiallyAbsent) {
            try {
                if (Package-Path $appId) {
                    try { Invoke-Adb 'force-stop-before-cleanup' @('shell', 'am', 'force-stop', $appId) -AllowFailure | Out-Null } catch { $cleanupFailure = $_.Exception.Message }
                }
                foreach ($package in @($testId, $appId)) {
                    if (-not (Package-Path $package)) { continue }
                    try { Invoke-Adb "uninstall-$($package.Replace('.', '-'))" @('uninstall', $package) -AllowFailure | Out-Null } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
                }
                $uninstalled = -not (Package-Path $appId) -and -not (Package-Path $testId)
                if (-not $uninstalled) { throw 'Application or instrumentation package remained installed after cleanup.' }
            } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        }
        if ($emulatorStartedByRunner) {
            try { Invoke-Adb 'close-dedicated-emulator' @('emu', 'kill') -AllowFailure | Out-Null; $emulatorClosed = $true } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
        }
        try {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
            do {
                $after = Invoke-Logged 'adb-inventory-after-shutdown' $adb @('devices', '-l') 20 -AllowFailure
                $rows = @($after.stdout -split "`r?`n" | Where-Object { $_ -match '^\S+\s+device\b' })
                if ($rows.Count -eq 0) { $adbEmpty = $true; break }
                Start-Sleep -Seconds 2
            } while ([DateTimeOffset]::UtcNow -lt $deadline)
            if (-not $adbEmpty -and -not $cleanupFailure) { $cleanupFailure = 'ADB still listed an online device after dedicated emulator shutdown.' }
        } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
    }
    try { if (Test-Path -LiteralPath $appApk -PathType Leaf) { $appAfterRun = Get-FileEvidence $appApk } } catch { if (-not $cleanupFailure) { $cleanupFailure = $_.Exception.Message } }
    $status = if ($primaryFailure -or $cleanupFailure -or -not $appInstalled -or -not $testInstalled -or -not $testExecuted -or -not $uninstalled -or -not $emulatorClosed -or -not $adbEmpty) { 'FAIL' } else { 'PASS_ANDROID_API36_PACKAGED_HARD_WORKER_CONTRACT' }
    Save-Receipt $status
}

if ($primaryFailure -or $cleanupFailure) { throw "L34-A R16 failed. Receipt: $receiptPath; primary=$primaryFailure; cleanup=$cleanupFailure" }
Write-Output "L34-A R16 packaged Hard Worker runtime contract passed. Receipt: $receiptPath"

