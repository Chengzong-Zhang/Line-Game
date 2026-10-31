$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$python = Join-Path $root 'local_artifacts\r4_fresh_install_20260910_c\fresh-venv\Scripts\python.exe'
$base = Join-Path $root 'local_artifacts\model_free'
$gail = Join-Path $base 'imitation_all_sizes_seed20260921_v1\gail_all_sizes_seed20260921_v1\generator.pt'
$gan = Join-Path $base 'imitation_all_sizes_seed20260921_v1\gan_all_sizes_seed20260921_v1\generator.pt'
$manifest = Join-Path $root 'web\web前端\assets\research-ai\model-free-manifest.json'
while (-not ((Test-Path -LiteralPath $gail) -and (Test-Path -LiteralPath $gan))) {
    Start-Sleep -Seconds 30
}
$env:PYTHONPATH = Join-Path $root 'research\iclr2027'
& $python (Join-Path $root 'research\iclr2027\scripts\export_web_model_free.py')
if (-not (Test-Path -LiteralPath $manifest)) { throw 'model-free manifest was not produced' }
Write-Output "exported $manifest"
