param(
    [switch]$Check,
    [string]$WorktreesRoot = (Join-Path $env:USERPROFILE '.codex/worktrees')
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$links = @(
    @('docs', 'working/docs'),
    @('tasks', 'working/task'),
    @('output', 'working/output'),
    @('tmp', 'working/tmp'),
    @('softcopyright', 'working/softcopyright'),
    @('working/local_artifacts', 'local_artifacts'),
    @('core algorithm/research', 'research'),
    @('working/archives/ai-search-publish', 'line-game-ai-search-publish-20260910')
)
$platforms = @(
    @('wechat/project', 'wechat-minigame/line game/wechat'),
    @('mobile/android/project', 'lifeline-mobile/line game/mobile'),
    @('mobile/harmonyos/project', 'lifeline-mobile/line game/mobile'),
    @('mobile/ios/project', 'ios-softcopyright-prep/line game/mobile'),
    @('platform/steam/project', 'lifeline-steam-m1/line game'),
    @('platform/taptap/project', 'lifeline-taptap/line game/mobile'),
    @('platform/itch/project', 'lifeline-itch-release/line game/itch')
)

function Ensure-Link([string]$relative, [string]$target, [bool]$optional) {
    $path = Join-Path $repo $relative
    $target = [IO.Path]::GetFullPath($target)
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        if ($optional) { Write-Output "UNAVAILABLE $relative"; return }
        if ($Check) { throw "Missing target: $target" }
        # Some local-only destinations are absent in a fresh clone. Make their
        # creation visible; an empty directory is not evidence of recovered data.
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Write-Output "CREATED EMPTY TARGET $target"
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($item) {
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to replace a real directory: $path"
        }
        $actual = [IO.Path]::GetFullPath($item.Target)
        if ($actual -ne $target) { throw "Unexpected link target: $path -> $actual" }
    } elseif ($Check) {
        throw "Missing link: $path"
    } else {
        New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
        New-Item -ItemType Junction -Path $path -Target $target | Out-Null
    }
    Write-Output "OK $relative"
}

foreach ($entry in $links) {
    Ensure-Link $entry[0] (Join-Path $repo $entry[1]) ($entry[0] -eq 'working/archives/ai-search-publish')
}
foreach ($entry in $platforms) {
    Ensure-Link $entry[0] (Join-Path $WorktreesRoot $entry[1]) $true
}

# Hide only compatibility entries in Explorer. Their contents remain accessible.
# No Git worktree registrations or frozen research source paths are changed.
foreach ($relative in @('docs','tasks','output','tmp','softcopyright','research','local_artifacts','line-game-ai-search-publish-20260910')) {
    $path = Join-Path $repo $relative
    if (-not $Check -and (Test-Path -LiteralPath $path)) {
        $item = Get-Item -LiteralPath $path -Force
        $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden
    }
}
