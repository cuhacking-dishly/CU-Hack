$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AddonRoot = Join-Path $RepoRoot "dishly-addon"
$Python = Join-Path $AddonRoot ".venv\Scripts\python.exe"
$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = Join-Path $env:ProgramFiles "nodejs\node.exe" }

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Test-JsonEndpoint([string]$Url) {
    try {
        Invoke-RestMethod -Uri $Url -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Wait-JsonEndpoint([string]$Url, [string]$Name, [int]$Attempts = 40) {
    foreach ($attempt in 1..$Attempts) {
        if (Test-JsonEndpoint $Url) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name did not become available at $Url."
}

Assert-True (Test-Path -LiteralPath $Python) "Run npm.cmd run setup first; Python environment is missing."
Assert-True (Test-Path -LiteralPath $Node) "Node.js was not found."

$tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
$modelNames = @($tags.models | ForEach-Object { $_.name -replace ':latest$', '' })
Assert-True ($modelNames -contains "embeddinggemma") "Ollama model embeddinggemma is missing."
Assert-True ($modelNames -contains "qwen3:4b-instruct") "Ollama model qwen3:4b-instruct is missing."

$retrievalProcess = $null
$backendProcess = $null
$oldRetrievalUrl = $env:RETRIEVAL_SERVICE_URL
$oldCorsOrigins = $env:CORS_ORIGINS
$LogRoot = Join-Path $env:TEMP ("dishly-local-rag-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $LogRoot | Out-Null
$RetrievalOut = Join-Path $LogRoot "retrieval.out.log"
$RetrievalError = Join-Path $LogRoot "retrieval.error.log"
$BackendOut = Join-Path $LogRoot "backend.out.log"
$BackendError = Join-Path $LogRoot "backend.error.log"

try {
    if (-not (Test-JsonEndpoint "http://127.0.0.1:8000/health")) {
        $retrievalProcess = Start-Process -FilePath $Python `
            -ArgumentList "-m", "dishly_retrieval", "serve" `
            -WorkingDirectory $AddonRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $RetrievalOut -RedirectStandardError $RetrievalError
    }
    Wait-JsonEndpoint "http://127.0.0.1:8000/ready" "Dishly retrieval" 60

    $env:RETRIEVAL_SERVICE_URL = "http://127.0.0.1:8000"
    $env:CORS_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173"
    if (-not (Test-JsonEndpoint "http://127.0.0.1:3000/api/health")) {
        $backendProcess = Start-Process -FilePath $Node `
            -ArgumentList "src/server.js" -WorkingDirectory (Join-Path $RepoRoot "backend") `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $BackendOut -RedirectStandardError $BackendError
    }
    Wait-JsonEndpoint "http://127.0.0.1:3000/api/ready" "Dishly backend" 60

    $goalText = "Asian food for dinner with 50g of protein and no peanuts"
    $parse = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/parse-goal" `
        -ContentType "application/json" -Body (@{ text = $goalText } | ConvertTo-Json)
    Assert-True ($parse.parsedFilter.cuisines -contains "asian") "Local parser lost Asian cuisine."
    Assert-True ($parse.parsedFilter.mealType -eq "main course") "Local parser lost dinner."
    Assert-True ($parse.parsedFilter.minProtein_g -eq 50) "Local parser lost the protein target."
    Assert-True ($parse.parsedFilter.intolerances -contains "peanut") "Local parser lost peanut intolerance."
    Assert-True ($parse.parsedFilter.excludeIngredients -contains "peanuts") "Safety overlay lost peanut exclusion."

    $userId = "local-rag-verifier"
    $saveBody = @{
        userId = $userId
        rawText = $goalText
        parsedFilter = $parse.parsedFilter
    } | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/goal" `
        -ContentType "application/json" -Body $saveBody | Out-Null

    $page = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/recipes?userId=$userId&limit=10&matchMode=exact"
    Assert-True ($page.match.mode -eq "exact") "Search did not preserve exact mode."
    Assert-True ($page.recipes.Count -gt 0) "The reviewed corpus produced no exact Asian dinner result."
    Assert-True ($page.match.semanticProvider -eq "ollama:embeddinggemma") "Search did not use the local vector index."
    foreach ($recipe in $page.recipes) {
        $ingredientText = ($recipe.ingredients -join " ").ToLowerInvariant()
        Assert-True (-not $ingredientText.Contains("peanut")) "Hard allergy filter returned peanut recipe $($recipe.id)."
    }

    $detail = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/recipes/$($page.recipes[0].id)"
    Assert-True ($detail.id -eq $page.recipes[0].id) "Detail lookup did not return the selected exact recipe."
    Assert-True ([bool]$detail.sourceUrl) "Recipe detail lost publisher provenance."
    Assert-True ([bool]$detail.image) "Recipe detail lost its exact publisher image."

    Write-Host "Local RAG E2E passed: Express -> Python -> qwen3 parser -> safety filters -> embeddinggemma -> publisher recipe."
} catch {
    Write-Host "Local RAG E2E failed. Captured service logs follow."
    foreach ($log in @($RetrievalOut, $RetrievalError, $BackendOut, $BackendError)) {
        if (Test-Path -LiteralPath $log) {
            Write-Host "--- $log"
            Get-Content -LiteralPath $log
        }
    }
    throw
} finally {
    foreach ($process in @($backendProcess, $retrievalProcess)) {
        if (-not $process) { continue }
        if (-not $process.HasExited) { Stop-Process -Id $process.Id }
        $process.WaitForExit(5000) | Out-Null
        $process.Dispose()
    }
    $env:RETRIEVAL_SERVICE_URL = $oldRetrievalUrl
    $env:CORS_ORIGINS = $oldCorsOrigins
    if (Test-Path -LiteralPath $LogRoot) { Remove-Item -LiteralPath $LogRoot -Recurse -Force }
}
