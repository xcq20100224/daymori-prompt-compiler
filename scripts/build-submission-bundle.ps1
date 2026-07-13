$ErrorActionPreference = 'Stop'

$zip = 'docs/benchmarks/results/daymori_submission_20260709.zip'
if (Test-Path $zip) {
    Remove-Item $zip -Force
}

$items = New-Object System.Collections.Generic.List[string]
$items.Add('docs/benchmarks/results/submission_manifest_20260709.md')
$items.Add('auto-optimize.ps1')

$variantRoot = 'docs/benchmarks/results/variants'
$latest3 = Get-ChildItem $variantRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 3

foreach ($dir in $latest3) {
    $summaryPath = Join-Path $dir.FullName 'summary.json'
    if (-not (Test-Path $summaryPath)) { continue }

    $summaryResolved = (Resolve-Path $summaryPath).Path
    $root = (Get-Location).Path
    if ($summaryResolved.StartsWith($root)) {
        $summaryRel = $summaryResolved.Substring($root.Length).TrimStart('\\') -replace '\\', '/'
        $items.Add($summaryRel)
    }
    else {
        $items.Add($summaryPath)
    }

    $summaryText = Get-Content $summaryPath -Raw
    $idMatch = [regex]::Match($summaryText, '"requestId"\s*:\s*"([0-9a-fA-F\-]{36})"')
    if (-not $idMatch.Success) { continue }
    $requestId = $idMatch.Groups[1].Value
    $bestDir = "docs/benchmarks/results/exports/$requestId"
    foreach ($f in @('deck.pptx', 'quality.json', 'validation.json', 'generation_trace.json')) {
        $candidate = Join-Path $bestDir $f
        if (Test-Path $candidate) {
            $items.Add($candidate)
        }
    }
}

$finalItems = $items | Select-Object -Unique
Compress-Archive -Path $finalItems -DestinationPath $zip -CompressionLevel Optimal
Write-Output $zip
