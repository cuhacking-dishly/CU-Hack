$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AddonRoot = Join-Path $RepoRoot "dishly-addon"
$Python = Join-Path $AddonRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Dishly's Python environment is missing. Run npm.cmd run setup first."
}

Push-Location $AddonRoot
try {
    & $Python -m ruff check dishly_retrieval tests scripts
    & $Python -m coverage erase
    & $Python -m coverage run -m unittest discover -s tests -v
    & $Python -m coverage report
    & $Python -m dishly_retrieval validate
} finally {
    Pop-Location
}
