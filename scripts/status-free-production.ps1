$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "free-production-common.ps1")

$RepoRoot = Get-DishlyRepoRoot
$RuntimeRoot = Join-Path $RepoRoot ".dishly"
$DeploymentPath = Join-Path $RuntimeRoot "deployment.json"
$BackendPidPath = Join-Path $RuntimeRoot "backend.pid"
$RetrievalPidPath = Join-Path $RuntimeRoot "retrieval.pid"

$status = [ordered]@{
    backendRunning = Test-DishlyProcess $BackendPidPath
    retrievalRunning = Test-DishlyProcess $RetrievalPidPath
    deployment = $null
    localReadiness = $null
    funnel = $null
}

if (Test-Path -LiteralPath $DeploymentPath -PathType Leaf) {
    $status.deployment = Get-Content -Raw -LiteralPath $DeploymentPath | ConvertFrom-Json
}

$port = 3000
if ($status.deployment -and $status.deployment.port) {
    $port = [int]$status.deployment.port
}
try {
    $status.localReadiness = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$port/api/ready" `
        -TimeoutSec 10
} catch {
    $status.localReadiness = @{ ok = $false; error = $_.Exception.Message }
}

try {
    $tailscale = Get-DishlyTailscale
    $rawFunnel = & $tailscale funnel status --json 2>&1
    if ($LASTEXITCODE -eq 0 -and $rawFunnel) {
        $status.funnel = $rawFunnel | ConvertFrom-Json
    }
} catch {
    $status.funnel = @{ error = $_.Exception.Message }
}

$status | ConvertTo-Json -Depth 10
