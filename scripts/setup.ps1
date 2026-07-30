param(
    [switch]$SkipNodeInstall,
    [switch]$SkipModelPull
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AddonRoot = Join-Path $RepoRoot "dishly-addon"
$VenvRoot = Join-Path $AddonRoot ".venv"
$VenvPython = Join-Path $AddonRoot ".venv\Scripts\python.exe"
$LockFile = Join-Path $AddonRoot "requirements.lock"

function Test-PythonExecutable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        & $Path --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Find-BasePython {
    # Prefer an ordinary PATH installation, then python.org's default per-user paths.
    $commands = @("python.exe", "py.exe")
    foreach ($name in $commands) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and (Test-PythonExecutable $command.Source)) {
            return $command.Source
        }
    }

    $programs = Join-Path $env:LOCALAPPDATA "Programs\Python"
    $candidate = Get-ChildItem -Path $programs -Filter python.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "\\.venv\\" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($candidate -and (Test-PythonExecutable $candidate.FullName)) {
        return $candidate.FullName
    }

    return $null
}

function Find-Uv {
    $command = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $installed = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path -LiteralPath $installed -PathType Leaf) { return $installed }
    return $null
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

$uv = Find-Uv
if (-not (Test-PythonExecutable $VenvPython)) {
    Write-Host "Creating Dishly's project-local Python environment..."
    if ($uv) {
        $env:UV_CACHE_DIR = Join-Path $RepoRoot ".cache\uv"
        $env:UV_PYTHON_INSTALL_DIR = Join-Path $RepoRoot ".runtime\python"
        New-Item -ItemType Directory -Force -Path $env:UV_CACHE_DIR | Out-Null
        New-Item -ItemType Directory -Force -Path $env:UV_PYTHON_INSTALL_DIR | Out-Null
        & $uv venv --python 3.12 --clear $VenvRoot
    } else {
        $basePython = Find-BasePython
        if (-not $basePython) {
            throw "Python 3.11+ was not found. Install 64-bit Python or uv, then rerun npm.cmd run setup."
        }
        & $basePython -m venv --clear $VenvRoot
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-PythonExecutable $VenvPython)) {
        throw "Dishly's project-local Python environment could not be created."
    }
}

Write-Host "Installing the locked retrieval dependencies..."
if ($uv) {
    $env:UV_CACHE_DIR = Join-Path $RepoRoot ".cache\uv"
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $RepoRoot ".runtime\python"
    & $uv pip install --python $VenvPython --requirement $LockFile
    if ($LASTEXITCODE -ne 0) { throw "Locked retrieval dependency installation failed." }
    & $uv pip install --python $VenvPython --no-deps --editable $AddonRoot
    if ($LASTEXITCODE -ne 0) { throw "Dishly retrieval package installation failed." }
} else {
    & $VenvPython -m pip install --requirement $LockFile
    if ($LASTEXITCODE -ne 0) { throw "Locked retrieval dependency installation failed." }
    & $VenvPython -m pip install --no-deps --editable $AddonRoot
    if ($LASTEXITCODE -ne 0) { throw "Dishly retrieval package installation failed." }
}

if (-not $SkipNodeInstall) {
    $npm = Find-Npm
    Write-Host "Installing locked backend and frontend dependencies..."
    & $npm ci --prefix (Join-Path $RepoRoot "backend")
    if ($LASTEXITCODE -ne 0) { throw "Backend dependency installation failed." }
    & $npm ci --prefix (Join-Path $RepoRoot "frontend")
    if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed." }
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
    if ($LASTEXITCODE -ne 0) { throw "The embeddinggemma model pull failed." }
    & $ollama pull qwen3:4b-instruct
    if ($LASTEXITCODE -ne 0) { throw "The qwen3 parser model pull failed." }
}

Push-Location $AddonRoot
try {
    & $VenvPython -m dishly_retrieval validate
    if ($LASTEXITCODE -ne 0) { throw "Reviewed corpus validation failed." }
    & $VenvPython -m dishly_retrieval build-index
    if ($LASTEXITCODE -ne 0) { throw "Vector index generation failed." }
    & $VenvPython -m dishly_retrieval status
    if ($LASTEXITCODE -ne 0) { throw "Retrieval readiness check failed." }
} finally {
    Pop-Location
}

Write-Host "Dishly setup is complete. Run npm.cmd run dev from the repository root."
