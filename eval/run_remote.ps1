# eval/run_remote.ps1: Remote Backend Protocol & Evaluation Runner
# Reads backend WebSocket endpoint strictly from env CTRLCV_WS_URL.
# If CTRLCV_WS_URL is unset, emits "SKIPPED: no URL" and exits cleanly.

$wsUrl = $env:CTRLCV_WS_URL

if (-not $wsUrl -or $wsUrl.Trim() -eq "") {
    Write-Output "SKIPPED: no URL"
    exit 0
}

Write-Output "======================================================================"
Write-Output "Remote Evaluation Suite: $wsUrl"
Write-Output "======================================================================"

# Determine Python command
$pyCmd = "python"
if (Test-Path "eval/venv/Scripts/python.exe") {
    $pyCmd = "eval/venv/Scripts/python.exe"
}

# 1. Contract Protocol Verification
Write-Output "`n[Stage 1/3] Running Contract Verification (eval/check_contract.py)..."
& $pyCmd eval/check_contract.py --ws_url $wsUrl
$contractExit = $LASTEXITCODE

# 2. Batch Evaluation across chunk sizes (1000ms, 2000ms, 3000ms)
$chunkSizes = @(1000, 2000, 3000)

foreach ($chunkMs in $chunkSizes) {
    Write-Output "`n[Stage 2/3] Running FLEURS Benchmark (chunk_ms = $chunkMs ms)..."
    & $pyCmd eval/run_all.py --ws_url $wsUrl --max_clips_per_lang 2 --concurrency 1 --realtime --confirm_rpm --chunk_ms $chunkMs
}

# 3. Overall Judge Evaluation
Write-Output "`n[Stage 3/3] Running Automated Evaluation Judge (eval/judge_sim.mjs)..."
& node eval/judge_sim.mjs --ws_url $wsUrl

Write-Output "`nRemote evaluation finished."
