param([switch]$KeepFunnel)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "free-production-common.ps1")

$RepoRoot = Get-DishlyRepoRoot
$RuntimeRoot = Join-Path $RepoRoot ".dishly"

if (-not $KeepFunnel) {
    try {
        $tailscale = Get-DishlyTailscale
        & $tailscale funnel reset
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Tailscale Funnel could not be reset. Run 'tailscale funnel reset' as its configured operator."
        }
    } catch {
        Write-Warning $_.Exception.Message
    }
}

Stop-DishlyManagedProcess (Join-Path $RuntimeRoot "backend.pid")
Stop-DishlyManagedProcess (Join-Path $RuntimeRoot "retrieval.pid")
Remove-Item -LiteralPath (Join-Path $RuntimeRoot "deployment.json") `
    -Force -ErrorAction SilentlyContinue

Write-Host "Dishly production services are stopped. SQLite state and logs were preserved."
