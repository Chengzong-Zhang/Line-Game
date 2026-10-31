[CmdletBinding()]
param(
    [string]$ToolRoot,
    [string]$JavaHome,
    [string]$ArtifactDirectory,
    [switch]$ValidateOnly,
    [switch]$VerifyL26,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'

$mobileRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $mobileRoot
$projectRoot = Join-Path $mobileRoot 'harmony'

if ([string]::IsNullOrWhiteSpace($ToolRoot)) {
    $ToolRoot = Join-Path $mobileRoot 'local_artifacts/harmony-native-20261022-01/tools/command-line-tools'
}
if ([string]::IsNullOrWhiteSpace($JavaHome)) {
    $JavaHome = Join-Path $mobileRoot 'local_artifacts/native-build-20261022-parent01/temurin21/jdk-21.0.12.1+1'
}

function Resolve-ExistingDirectory([string]$Path, [string]$Label) {
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $repoRoot $Path }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label directory not found: $Path" }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-ExistingFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label file not found: $Path" }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Read-PackageVersion([string]$PackageRoot, [string]$Label) {
    $manifestPath = Join-Path $PackageRoot 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "$Label package.json not found: $manifestPath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    return [string]$manifest.version
}

function Assert-JunctionTarget([string]$LinkPath, [string]$ExpectedTarget, [string]$Label) {
    $item = Get-Item -LiteralPath $LinkPath -Force -ErrorAction Stop
    if ($item.LinkType -ne 'Junction') { throw "$Label must be a Windows junction: $LinkPath (LinkType=$($item.LinkType))" }
    $actualTarget = [string](@($item.Target)[0])
    if (-not [IO.Path]::IsPathRooted($actualTarget)) { $actualTarget = Join-Path (Split-Path -Parent $LinkPath) $actualTarget }
    $actualTarget = [IO.Path]::GetFullPath($actualTarget).TrimEnd('\', '/')
    $expectedTarget = [IO.Path]::GetFullPath($ExpectedTarget).TrimEnd('\', '/')
    if (-not [string]::Equals($actualTarget, $expectedTarget, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label junction target mismatch. Expected '$expectedTarget'; found '$actualTarget'."
    }
}

$ToolRoot = Resolve-ExistingDirectory $ToolRoot 'Harmony command-line tools'
$JavaHome = Resolve-ExistingDirectory $JavaHome 'JDK'

$nodeHome = Join-Path $ToolRoot 'tool/node'
$nodeExe = Resolve-ExistingFile (Join-Path $nodeHome 'node.exe') 'Bundled Node'
$sdkHome = Resolve-ExistingDirectory (Join-Path $ToolRoot 'sdk') 'Harmony SDK'
$hvigorJs = Resolve-ExistingFile (Join-Path $ToolRoot 'hvigor/hvigor/bin/hvigor.js') 'Bundled Hvigor entry point'
$javaExe = Resolve-ExistingFile (Join-Path $JavaHome 'bin/java.exe') 'JDK Java'
$javaVersion = Join-Path $JavaHome 'release'
if (-not (Test-Path -LiteralPath $javaVersion -PathType Leaf)) { throw "JDK release metadata not found: $javaVersion" }

$toolBundleRoot = Split-Path -Parent (Split-Path -Parent $ToolRoot)
$isolatedNodeModules = Join-Path $toolBundleRoot 'node_modules'
$commonJsBoundary = Join-Path (Split-Path -Parent $ToolRoot) 'package.json'
$projectOhosRoot = Join-Path $projectRoot 'node_modules/@ohos'
$projectHvigor = Join-Path $projectOhosRoot 'hvigor'
$projectPlugin = Join-Path $projectOhosRoot 'hvigor-ohos-plugin'
$isolatedOhosRoot = Join-Path $isolatedNodeModules '@ohos'
$isolatedHvigor = Join-Path $isolatedOhosRoot 'hvigor'
$isolatedPlugin = Join-Path $isolatedOhosRoot 'hvigor-ohos-plugin'
$expectedHvigorTarget = Join-Path $ToolRoot 'hvigor/hvigor'
$expectedPluginTarget = Join-Path $ToolRoot 'hvigor/hvigor-ohos-plugin'

if (-not (Test-Path -LiteralPath $commonJsBoundary -PathType Leaf)) { throw "CommonJS compatibility file not found: $commonJsBoundary" }
$commonJs = Get-Content -LiteralPath $commonJsBoundary -Raw | ConvertFrom-Json
if ($commonJs.type -ne 'commonjs') { throw "Expected type=commonjs in $commonJsBoundary" }

$projectPackage = Get-Content -LiteralPath (Join-Path $projectRoot 'oh-package.json5') -Raw | ConvertFrom-Json
$hvigorConfig = Get-Content -LiteralPath (Join-Path $projectRoot 'hvigor/hvigor-config.json5') -Raw | ConvertFrom-Json
$expectedVersion = '5.8.9'
foreach ($packageName in @('@ohos/hvigor', '@ohos/hvigor-ohos-plugin')) {
    if ([string]$projectPackage.devDependencies.$packageName -ne $expectedVersion) {
        throw "Project devDependency $packageName must be $expectedVersion."
    }
    if ([string]$hvigorConfig.dependencies.$packageName -ne $expectedVersion) {
        throw "Hvigor config dependency $packageName must be $expectedVersion."
    }
}

Assert-JunctionTarget $projectHvigor $expectedHvigorTarget 'Project @ohos/hvigor'
Assert-JunctionTarget $projectPlugin $expectedPluginTarget 'Project @ohos/hvigor-ohos-plugin'
Assert-JunctionTarget $isolatedHvigor $expectedHvigorTarget 'NODE_PATH @ohos/hvigor'
Assert-JunctionTarget $isolatedPlugin $expectedPluginTarget 'NODE_PATH @ohos/hvigor-ohos-plugin'

$hvigorVersion = Read-PackageVersion $expectedHvigorTarget 'Bundled Hvigor'
$pluginVersion = Read-PackageVersion $expectedPluginTarget 'Bundled Hvigor plugin'
if ($hvigorVersion -ne $expectedVersion) { throw "Bundled Hvigor version is $hvigorVersion; expected $expectedVersion." }
if ($pluginVersion -ne $expectedVersion) { throw "Bundled Hvigor plugin version is $pluginVersion; expected $expectedVersion." }

$hvigorCliPackage = Get-Content -LiteralPath (Join-Path $expectedHvigorTarget 'package.json') -Raw | ConvertFrom-Json
if ($hvigorCliPackage.version -ne $expectedVersion) { throw "Bundled Hvigor CLI version mismatch: $($hvigorCliPackage.version)." }

$jdkReleaseText = Get-Content -LiteralPath $javaVersion -Raw
if ($jdkReleaseText -notmatch 'JAVA_VERSION="21\.') { throw 'The selected JDK must be version 21.' }
$nodeVersion = (& $nodeExe --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Bundled Node could not start: $nodeVersion" }
if ($nodeVersion -notmatch '^v18\.') { throw "Bundled Node must be version 18; found $nodeVersion." }

$preflight = [ordered]@{
    status = 'PASS_LOCAL_HARMONY_TOOLCHAIN_PREFLIGHT'
    project = [IO.Path]::GetRelativePath($repoRoot, $projectRoot)
    toolRoot = [IO.Path]::GetRelativePath($repoRoot, $ToolRoot)
    javaHome = [IO.Path]::GetRelativePath($repoRoot, $JavaHome)
    nodeVersion = $nodeVersion
    hvigorVersion = $hvigorVersion
    hvigorPluginVersion = $pluginVersion
    commonJsBoundary = [IO.Path]::GetRelativePath($repoRoot, $commonJsBoundary)
    projectJunctions = 'PASS (both junctions point to the selected official tool bundle)'
    isolatedNodePathJunctions = 'PASS (both junctions point to the selected official tool bundle)'
    onlineInstall = 'DISABLED; this script calls the bundled Node/Hvigor entry directly and never invokes a package manager'
}
if ($ValidateOnly) {
    $preflight | ConvertTo-Json -Depth 5
    return
}

if ([string]::IsNullOrWhiteSpace($ArtifactDirectory)) { throw 'ArtifactDirectory is required unless -ValidateOnly is specified.' }
if (-not [IO.Path]::IsPathRooted($ArtifactDirectory)) { $ArtifactDirectory = Join-Path $repoRoot $ArtifactDirectory }
$ArtifactDirectory = [IO.Path]::GetFullPath($ArtifactDirectory)
if (Test-Path -LiteralPath $ArtifactDirectory) { throw "Refusing to overwrite existing artifact directory: $ArtifactDirectory" }
if ($VerifyL26) {
    $verifierScript = Join-Path $mobileRoot 'tools/verify-l26-harmony-hap.py'
    Resolve-ExistingFile $verifierScript 'L26 HAP verifier' | Out-Null
    $receiptPath = Join-Path $mobileRoot 'local_artifacts/mobile-web-build-receipt.json'
    Resolve-ExistingFile $receiptPath 'Current mobile Web build receipt' | Out-Null
    $identityConfigPath = Resolve-ExistingFile (Join-Path $mobileRoot 'config/release-identity-candidate.json') 'Harmony release identity candidate'
    try {
        $identityConfig = Get-Content -LiteralPath $identityConfigPath -Raw | ConvertFrom-Json
    } catch {
        throw "Harmony release identity candidate is invalid JSON: $identityConfigPath"
    }
    $identityInvalid = $identityConfig.schema -ne 'lifeline-mobile-release-identity-candidate-v1' -or
        [string]::IsNullOrWhiteSpace([string]$identityConfig.harmony.bundleName) -or
        [int]$identityConfig.harmony.versionCode -le 0 -or
        [string]::IsNullOrWhiteSpace([string]$identityConfig.harmony.versionName)
    if ($identityInvalid) {
        throw "Harmony release identity candidate is missing a valid Harmony bundleName, versionCode, or versionName: $identityConfigPath"
    }
}

New-Item -ItemType Directory -Path $ArtifactDirectory | Out-Null
$isolatedHome = Join-Path $ArtifactDirectory 'isolated-user-home'
$isolatedHvigorHome = Join-Path $ArtifactDirectory 'isolated-hvigor-home'
New-Item -ItemType Directory -Path $isolatedHome,$isolatedHvigorHome -Force | Out-Null

$scopedEnvironmentNames = @('DEVECO_NODE_HOME','NODE_HOME','DEVECO_SDK_HOME','JAVA_HOME','NODE_PATH','USERPROFILE','HOME','HVIGOR_USER_HOME','PATH','npm_config_userconfig','npm_config_offline')
$previousEnvironment = @{}
foreach ($name in $scopedEnvironmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

$buildLog = Join-Path $ArtifactDirectory 'harmony-assemble.log'
$exitCodePath = Join-Path $ArtifactDirectory 'harmony-build-exit-code.txt'
$buildStarted = [DateTime]::UtcNow
$buildExitCode = $null
$hapPath = $null
try {
    $env:DEVECO_NODE_HOME = $nodeHome
    $env:NODE_HOME = $nodeHome
    $env:DEVECO_SDK_HOME = $sdkHome
    $env:JAVA_HOME = $JavaHome
    $env:NODE_PATH = $isolatedNodeModules
    $env:USERPROFILE = $isolatedHome
    $env:HOME = $isolatedHome
    $env:HVIGOR_USER_HOME = $isolatedHvigorHome
    $env:npm_config_userconfig = Join-Path $isolatedHome '.npmrc'
    $env:npm_config_offline = 'true'
    $env:PATH = "$($JavaHome)\bin;$nodeHome;$($previousEnvironment['PATH'])"

    Push-Location -LiteralPath $projectRoot
    try {
        & $nodeExe $hvigorJs assembleHap --mode module -p module=entry@default --no-daemon --no-incremental 2>&1 | Tee-Object -FilePath $buildLog
        $buildExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    Set-Content -LiteralPath $exitCodePath -Value $buildExitCode -Encoding ascii
    if ($buildExitCode -ne 0) { throw "Harmony build failed with exit code $buildExitCode. See $buildLog" }
    $buildLogText = Get-Content -LiteralPath $buildLog -Raw
    if ($buildLogText -notmatch 'BUILD SUCCESSFUL') {
        throw "Hvigor returned exit code 0 but did not report BUILD SUCCESSFUL. See $buildLog"
    }

    $hapOutputRoot = Join-Path $projectRoot 'entry/build/default/outputs/default'
    $hap = Get-ChildItem -LiteralPath $hapOutputRoot -File -Filter '*-unsigned.hap' -ErrorAction Stop |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $hap) { throw "Successful build did not produce an unsigned HAP in $hapOutputRoot" }
    $hapFreshness = 'REBUILT_DURING_BUILD'
    if ($hap.LastWriteTimeUtc -lt $buildStarted.AddSeconds(-2)) {
        throw "Unsigned HAP is older than this non-incremental build: $($hap.FullName)"
    }
    $hapPath = Join-Path $ArtifactDirectory $hap.Name
    if (Test-Path -LiteralPath $hapPath) { throw "Refusing to overwrite copied HAP: $hapPath" }
    Copy-Item -LiteralPath $hap.FullName -Destination $hapPath
    $hapHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $hapPath).Hash.ToLowerInvariant()

    $verificationStatus = 'NOT_RUN'
    $verificationReceipt = $null
    $verificationExitCode = $null
    if ($VerifyL26) {
        $pythonCommand = Get-Command $Python -ErrorAction Stop
        $runDirectory = Join-Path $ArtifactDirectory 'verify-harmony-l26'
        if (Test-Path -LiteralPath $runDirectory) { throw "Refusing to overwrite verifier directory: $runDirectory" }
        $verifierLog = Join-Path $ArtifactDirectory 'harmony-verifier.log'
        $verifierExitPath = Join-Path $ArtifactDirectory 'harmony-verifier-exit-code.txt'
        $javaExe = Join-Path $JavaHome 'bin/java.exe'
        $hapSignTool = Join-Path $sdkHome 'default/openharmony/toolchains/lib/hap-sign-tool.jar'
        & $pythonCommand.Source $verifierScript --hap $hapPath --build-log $buildLog --run-dir $runDirectory --receipt $receiptPath --identity-config $identityConfigPath --java $javaExe --hap-sign-tool $hapSignTool 2>&1 | Tee-Object -FilePath $verifierLog
        $verificationExitCode = $LASTEXITCODE
        Set-Content -LiteralPath $verifierExitPath -Value $verificationExitCode -Encoding ascii
        if ($verificationExitCode -ne 0) { throw "HAP verifier failed with exit code $verificationExitCode. See $verifierLog" }
        $verificationReceipt = Join-Path $runDirectory 'harmony-hap-verification.json'
        $verificationData = Get-Content -LiteralPath $verificationReceipt -Raw | ConvertFrom-Json
        $verificationStatus = [string]$verificationData.status
    }

    $buildSummary = [ordered]@{
        schema = 'lifeline-harmony-repro-build-v1'
        status = 'PASS_LOCAL_UNSIGNED_HAP_BUILD'
        buildStartedAtUtc = $buildStarted.ToString('o')
        buildFinishedAtUtc = [DateTime]::UtcNow.ToString('o')
        command = 'node <tools>/hvigor/hvigor/bin/hvigor.js assembleHap --mode module -p module=entry@default --no-daemon --no-incremental'
        buildExitCode = $buildExitCode
        buildLog = [IO.Path]::GetFileName($buildLog)
        buildLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $buildLog).Hash.ToLowerInvariant()
        buildExitCodeFile = [IO.Path]::GetFileName($exitCodePath)
        unsignedHap = [ordered]@{
            path = [IO.Path]::GetFileName($hapPath)
            bytes = (Get-Item -LiteralPath $hapPath).Length
            sha256 = $hapHash
            sourceLastWriteTimeUtc = $hap.LastWriteTimeUtc.ToString('o')
            freshness = $hapFreshness
        }
        verifierStatus = $verificationStatus
        verifierReceipt = if ($verificationReceipt) { [IO.Path]::GetRelativePath($ArtifactDirectory, $verificationReceipt) } else { $null }
    }
    $summaryPath = Join-Path $ArtifactDirectory 'harmony-build-receipt.json'
    $buildSummary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8
    $buildSummary | ConvertTo-Json -Depth 8
} finally {
    foreach ($name in $scopedEnvironmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
}
