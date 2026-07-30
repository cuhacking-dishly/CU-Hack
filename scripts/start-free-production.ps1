param(
    [switch]$SkipSetup,
    [switch]$SkipVerification,
    [switch]$LocalOnly,
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [ValidateRange(1, 65535)][int]$RetrievalPort = 8000
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "free-production-common.ps1")

$RepoRoot = Get-DishlyRepoRoot
$RuntimeRoot = Join-Path $RepoRoot ".dishly"
$LogDirectory = Join-Path $RuntimeRoot "logs"
$StateDirectory = Join-Path $RuntimeRoot "state"
$BackendPidPath = Join-Path $RuntimeRoot "backend.pid"
$RetrievalPidPath = Join-Path $RuntimeRoot "retrieval.pid"
$DeploymentPath = Join-Path $RuntimeRoot "deployment.json"
$TokenPath = Join-Path $RuntimeRoot "retrieval-token"
$VenvPython = Join-Path $RepoRoot "dishly-addon\.venv\Scripts\python.exe"
$FrontendDist = Join-Path $RepoRoot "frontend\dist"
$SqlitePath = Join-Path $StateDirectory "dishly.sqlite"
$npm = Get-DishlyNpm
$tailscale = $null
$origin = "http://127.0.0.1:$Port"
$startedProcesses = @()
$funnelStarted = $false

if (-not $LocalOnly) {
    $tailscale = Get-DishlyTailscale
    $origin = Get-DishlyPublicOrigin $tailscale
}

if (Test-DishlyProcess $BackendPidPath) {
    throw "Dishly's production API is already running. Use npm.cmd run production:status."
}
if (Test-DishlyProcess $RetrievalPidPath) {
    throw "Dishly's retrieval service is already running. Use npm.cmd run production:status."
}
Assert-DishlyPortAvailable $Port
Assert-DishlyPortAvailable $RetrievalPort

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $LogDirectory, $StateDirectory | Out-Null
Remove-Item -LiteralPath $BackendPidPath, $RetrievalPidPath -Force -ErrorAction SilentlyContinue

try {
    if (-not $SkipSetup) {
        Write-Host "Installing the locked production dependencies..."
        & $npm ci --prefix $RepoRoot
        if ($LASTEXITCODE -ne 0) { throw "Repository dependency installation failed." }
        & (Join-Path $PSHOME "powershell.exe") -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot "setup.ps1")
        if ($LASTEXITCODE -ne 0) { throw "Dishly setup failed." }
    }

    if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
        throw "The retrieval Python environment is missing. Run npm.cmd run production:setup."
    }

    Write-Host "Building the production React application..."
    & $npm --prefix (Join-Path $RepoRoot "frontend") run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend production build failed." }
    if (-not (Test-Path -LiteralPath (Join-Path $FrontendDist "index.html") -PathType Leaf)) {
        throw "The frontend build did not produce dist\index.html."
    }

    if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) {
        $tokenBytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $random.GetBytes($tokenBytes)
        } finally {
            $random.Dispose()
        }
        $token = ([BitConverter]::ToString($tokenBytes)).Replace("-", "").ToLowerInvariant()
        [IO.File]::WriteAllText($TokenPath, $token, [Text.UTF8Encoding]::new($false))
    }
    $serviceToken = (Get-Content -Raw -LiteralPath $TokenPath).Trim()
    if ($serviceToken.Length -lt 32) { throw "The local retrieval token is invalid." }

    Write-Host "Starting the private local RAG service..."
    $retrieval = Start-DishlyManagedProcess `
        -FilePath $VenvPython `
        -ArgumentList @("-m", "dishly_retrieval", "serve") `
        -WorkingDirectory (Join-Path $RepoRoot "dishly-addon") `
        -Environment @{
            DISHLY_AUTO_BUILD_INDEX = "false"
            DISHLY_SERVICE_HOST = "127.0.0.1"
            DISHLY_SERVICE_PORT = [string]$RetrievalPort
            DISHLY_SERVICE_TOKEN = $serviceToken
            OLLAMA_HOST = "http://127.0.0.1:11434"
            OLLAMA_EMBEDDING_MODEL = "embeddinggemma"
            OLLAMA_PARSER_MODEL = "qwen3:4b-instruct"
            OLLAMA_PARSER_TIMEOUT_SECONDS = "180"
        } `
        -LogDirectory $LogDirectory `
        -Name "retrieval"
    $startedProcesses += $retrieval
    Set-Content -LiteralPath $RetrievalPidPath -Value $retrieval.Id -Encoding ascii
    Wait-DishlyHttp "http://127.0.0.1:$RetrievalPort/health" 60 | Out-Null

    Write-Host "Starting the loopback-only production web gateway..."
    $backend = Start-DishlyManagedProcess `
        -FilePath (Get-Command node.exe).Source `
        -ArgumentList @("src/server.js") `
        -WorkingDirectory (Join-Path $RepoRoot "backend") `
        -Environment @{
            CORS_ORIGINS = $origin
            FRONTEND_DIST_PATH = $FrontendDist
            GOAL_PARSER_TIMEOUT_MS = "300000"
            HOST = "127.0.0.1"
            NODE_ENV = "production"
            PORT = [string]$Port
            REQUIRE_PERSISTENT_STORE = "true"
            RETRIEVAL_SERVICE_TOKEN = $serviceToken
            RETRIEVAL_SERVICE_URL = "http://127.0.0.1:$RetrievalPort"
            RETRIEVAL_TIMEOUT_MS = "120000"
            SQLITE_DATABASE_PATH = $SqlitePath
        } `
        -LogDirectory $LogDirectory `
        -Name "backend"
    $startedProcesses += $backend
    Set-Content -LiteralPath $BackendPidPath -Value $backend.Id -Encoding ascii
    Wait-DishlyHttp "http://127.0.0.1:$Port/api/ready" 180 | Out-Null

    if (-not $SkipVerification) {
        Write-Host "Verifying the complete production stack locally..."
        & (Get-Command node.exe).Source (Join-Path $RepoRoot "scripts\verify-production.mjs") `
            --api "http://127.0.0.1:$Port/api" `
            --frontend "http://127.0.0.1:$Port" `
            --origin $origin
        if ($LASTEXITCODE -ne 0) { throw "Local production verification failed." }
    }

    if (-not $LocalOnly) {
        Write-Host "Publishing Dishly through the free encrypted Tailscale Funnel..."
        & $tailscale funnel --bg --yes $Port
        if ($LASTEXITCODE -ne 0) { throw "Tailscale Funnel setup failed." }
        $funnelStarted = $true
        Wait-DishlyHttp "$origin/api/health" 120 | Out-Null

        if (-not $SkipVerification) {
            Write-Host "Verifying the real public URL..."
            & (Get-Command node.exe).Source (Join-Path $RepoRoot "scripts\verify-production.mjs") `
                --api "$origin/api" `
                --frontend $origin `
                --origin $origin
            if ($LASTEXITCODE -ne 0) { throw "Public production verification failed." }
        }
    }

    $deployment = [ordered]@{
        origin = $origin
        api = "$origin/api"
        health = "$origin/api/health"
        readiness = "$origin/api/ready"
        localOnly = [bool]$LocalOnly
        startedAt = [DateTime]::UtcNow.ToString("o")
        backendPid = $backend.Id
        retrievalPid = $retrieval.Id
        port = $Port
        retrievalPort = $RetrievalPort
        sqlitePath = $SqlitePath
        logs = $LogDirectory
    }
    $deployment | ConvertTo-Json | Set-Content -LiteralPath $DeploymentPath -Encoding utf8

    Write-Host ""
    Write-Host "Dishly is live at $origin"
    Write-Host "Readiness: $origin/api/ready"
    Write-Host "Persistent state: $SqlitePath"
    Write-Host "Logs: $LogDirectory"
} catch {
    if ($funnelStarted -and $tailscale) {
        & $tailscale funnel reset 2>$null
    }
    for ($index = $startedProcesses.Count - 1; $index -ge 0; $index -= 1) {
        Stop-Process -Id $startedProcesses[$index].Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $BackendPidPath, $RetrievalPidPath, $DeploymentPath `
        -Force -ErrorAction SilentlyContinue
    throw
}
