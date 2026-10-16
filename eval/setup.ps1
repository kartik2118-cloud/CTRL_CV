Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Allow script execution for this process
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$EvalDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $EvalDir
$VenvDir = Join-Path $EvalDir "venv"
$DataDir = Join-Path $EvalDir "data"
$ResultsDir = Join-Path $EvalDir "results"
$ReqFile = Join-Path $EvalDir "requirements.txt"

Write-Host "Creating directories: eval/data and eval/results..."
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null

if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    Write-Host "Creating Python virtual environment at $VenvDir..."
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -m venv $VenvDir
    } elseif (Test-Path "$env:LOCALAPPDATA\Python\bin\python.exe") {
        & "$env:LOCALAPPDATA\Python\bin\python.exe" -m venv $VenvDir
    } else {
        python -m venv $VenvDir
    }
} else {
    Write-Host "Virtual environment already exists at $VenvDir."
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

Write-Host "Upgrading pip..."
& $VenvPython -m pip install --upgrade pip

Write-Host "Installing requirements from $ReqFile..."
& $VenvPip install -r $ReqFile

Write-Host "Setup finished successfully."
