param(
    [string]$Topic = "AI客服降本增效方案",
    [int]$Rounds = 3,
    [int]$CountPerRound = 10,
    [string]$ApiBase = "http://127.0.0.1:3402",
    [string]$NodePath = "C:\Progra~1\nodejs\node.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $NodePath)) {
    throw "Node executable not found: $NodePath"
}

$variantRoot = "docs/benchmarks/results/variants"
if (-not (Test-Path $variantRoot)) {
    New-Item -ItemType Directory -Force -Path $variantRoot | Out-Null
}

Write-Host "Start optimization loop: rounds=$Rounds, count=$CountPerRound, api=$ApiBase" -ForegroundColor Cyan

$roundSummaries = @()

for ($round = 1; $round -le $Rounds; $round++) {
    Write-Host "`n========== Round $round/$Rounds ==========" -ForegroundColor Yellow

    $before = Get-ChildItem $variantRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

    $env:BENCH_API_BASE = $ApiBase
    & $NodePath tools/run-variant-batch.mjs --topic="$Topic" --count=$CountPerRound --concurrency=2 --enhanced
    if ($LASTEXITCODE -ne 0) {
        throw "run-variant-batch failed at round $round with exit code $LASTEXITCODE"
    }

    $after = Get-ChildItem $variantRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

    if (-not $after) {
        throw "No variant directory found after round $round"
    }

    if ($before -and $after.FullName -eq $before.FullName) {
        Write-Host "Warning: latest variant directory unchanged, still reading summary from $($after.Name)" -ForegroundColor DarkYellow
    }

    $summaryPath = Join-Path $after.FullName "summary.json"
    if (-not (Test-Path $summaryPath)) {
        throw "Missing summary.json: $summaryPath"
    }

    $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json

    $badSamplesPath = "docs/benchmarks/training/bad_samples.jsonl"
    $badCount = 0
    if (Test-Path $badSamplesPath) {
        $badCount = (Get-Content $badSamplesPath | Measure-Object).Count
    }

    $roundInfo = [PSCustomObject]@{
        Round      = $round
        VariantDir = $after.Name
        Success    = [int]$summary.success
        Failed     = [int]$summary.failed
        Total      = [int]$summary.total
        BestEngine = [string]($summary.best.engine)
        BestPath   = [string]($summary.best.relativePath)
        BadSamples = $badCount
    }
    $roundSummaries += $roundInfo

    Write-Host ("Round {0} done: success={1}/{2}, failed={3}, bad_samples={4}" -f $round, $roundInfo.Success, $roundInfo.Total, $roundInfo.Failed, $roundInfo.BadSamples) -ForegroundColor Green

    if ($round -lt $Rounds) {
        Write-Host "Cooldown 10s before next round..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 10
    }
}

Write-Host "`nOptimization loop finished." -ForegroundColor Cyan
$roundSummaries | Format-Table -AutoSize
