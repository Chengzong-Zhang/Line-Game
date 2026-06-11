param(
    [Parameter(Mandatory = $true)]
    [string]$StudentId,

    [Parameter(Mandatory = $true)]
    [string]$Name
)

$ErrorActionPreference = "Stop"

$submissionRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ownerName = -join @([char]24352, [char]22478, [char]23447)
$sourceDir = Join-Path $submissionRoot "241098117-$ownerName"
$demoFile = Join-Path $sourceDir "demo.mp4"
$requiredEntries = @(
    "README.md",
    "AI_CODING_SUMMARY.md",
    "src",
    "demo.mp4"
)

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Submission directory not found: $sourceDir"
}

foreach ($entry in $requiredEntries) {
    $path = Join-Path $sourceDir $entry
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required submission entry is missing: $entry"
    }
}

if ((Get-Item -LiteralPath $demoFile).Length -eq 0) {
    throw "demo.mp4 is empty. Add the real screen recording first."
}

$forbidden = Get-ChildItem -LiteralPath $sourceDir -Recurse -Force | Where-Object {
    $_.Name -eq ".git" -or
    $_.Name -eq "__pycache__" -or
    $_.Extension -in @(".pyc", ".db", ".sqlite", ".sqlite3", ".docx")
}

if ($forbidden) {
    $paths = ($forbidden.FullName -join [Environment]::NewLine)
    throw "Forbidden entries found in the submission directory:`n$paths"
}

$safeStudentId = $StudentId.Trim()
$safeName = $Name.Trim()
if (-not $safeStudentId -or -not $safeName) {
    throw "StudentId and Name cannot be empty."
}

$zipPath = Join-Path $submissionRoot "$safeStudentId-$safeName.zip"
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $sourceDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "Final submission archive created: $zipPath"
