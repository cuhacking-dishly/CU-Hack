param(
    [switch]$SkipNodeInstall,
    [switch]$SkipModelPull
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AddonRoot = Join-Path $RepoRoot "dishly-addon"
$VenvPython = Join-Path $AddonRoot ".venv\Scripts\python.exe"
$LockFile = Join-Path $AddonRoot "requirements.lock"

function Find-BasePython {
    # Prefer an ordinary PATH installation, then python.org's default per-user paths.
    $commands = @("python.exe", "py.exe")
    foreach ($name in $commands) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }

    $programs = Join-Path $env:LOCALAPPDATA "Programs\Python"
    $candidate = Get-ChildItem -Path $programs -Filter python.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "\\.venv\\" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($candidate) { return $candidate.FullName }

    throw "Python 3.11+ was not found. Install 64-bit Python, then rerun npm.cmd run setup."
}

function Find-Npm {
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $installed = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
    if (Test-Path -LiteralPath $installed) { return $installed }
    throw "npm was not found. Install Node.js 24+, reopen PowerShell, and rerun setup."
}

function Find-Ollama {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $installed = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path -LiteralPath $installed) { return $installed }
    throw "Ollama was not found. Install it from https://ollama.com/download/windows and rerun setup."
}

if (-not (Test-Path -LiteralPath $VenvPython)) {
    $basePython = Find-BasePython
    Write-Host "Creating Dishly's project-local Python environment..."
    & $basePython -m venv (Join-Path $AddonRoot ".venv")
}

Write-Host "Installing the locked retrieval dependencies..."
& $VenvPython -m pip install --requirement $LockFile
& $VenvPython -m pip install --no-deps --editable $AddonRoot

if (-not $SkipNodeInstall) {
    $npm = Find-Npm
    Write-Host "Installing locked backend and frontend dependencies..."
    & $npm ci --prefix (Join-Path $RepoRoot "backend")
    & $npm ci --prefix (Join-Path $RepoRoot "frontend")
}

$ollama = Find-Ollama
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2 | Out-Null
} catch {
    Write-Host "Starting Ollama in the background..."
    Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden
    $ready = $false
    foreach ($attempt in 1..20) {
        Start-Sleep -Milliseconds 500
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2 | Out-Null
            $ready = $true
            break
        } catch { }
    }
    if (-not $ready) { throw "Ollama did not become ready on http://127.0.0.1:11434." }
}

if (-not $SkipModelPull) {
    Write-Host "Ensuring the local embedding and goal-parser models are installed..."
    & $ollama pull embeddinggemma
    & $ollama pull qwen3:4b-instruct
}

Push-Location $AddonRoot
try {
    & $VenvPython -m dishly_retrieval validate
    & $VenvPython -m dishly_retrieval build-index
    & $VenvPython -m dishly_retrieval status
} finally {
    Pop-Location
}

Write-Host "Dishly setup is complete. Run npm.cmd run dev from the repository root."
