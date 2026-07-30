$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-DishlyRepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Find-DishlyExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$CommandName,
        [Parameter(Mandatory = $true)][string[]]$Candidates
    )

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in $Candidates) {
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) { return $expanded }
    }
    throw "$CommandName was not found."
}

function Get-DishlyNpm {
    return Find-DishlyExecutable "npm.cmd" @("%ProgramFiles%\nodejs\npm.cmd")
}

function Get-DishlyTailscale {
    return Find-DishlyExecutable "tailscale.exe" @("%ProgramFiles%\Tailscale\tailscale.exe")
}

function Get-DishlyOllama {
    return Find-DishlyExecutable "ollama.exe" @("%LOCALAPPDATA%\Programs\Ollama\ollama.exe")
}

function Get-DishlyPublicOrigin {
    param([Parameter(Mandatory = $true)][string]$Tailscale)

    $rawStatus = & $Tailscale status --json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Tailscale status is unavailable. Complete Tailscale login and configure this Windows user as its operator."
    }
    $status = $rawStatus | ConvertFrom-Json
    if ($status.BackendState -ne "Running" -or -not $status.Self.Online) {
        throw "Tailscale is not connected. Complete the one-time sign-in before starting public production."
    }
    $dnsName = [string]$status.Self.DNSName
    if ([string]::IsNullOrWhiteSpace($dnsName)) {
        throw "Tailscale has no MagicDNS name. Enable MagicDNS and HTTPS in the tailnet."
    }
    return "https://$($dnsName.TrimEnd('.'))"
}

function Test-DishlyProcess {
    param([Parameter(Mandatory = $true)][string]$PidPath)

    if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return $false }
    $rawPid = (Get-Content -Raw -LiteralPath $PidPath).Trim()
    $processId = 0
    if (-not [int]::TryParse($rawPid, [ref]$processId)) { return $false }
    return $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

function Assert-DishlyPortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)

    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().
        GetActiveTcpListeners()
    if ($listeners.Port -contains $Port) {
        throw "TCP port $Port is already in use."
    }
}

function Wait-DishlyHttp {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSeconds = 120,
        [hashtable]$Headers = @{}
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $Headers -TimeoutSec 10
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return $response
            }
        } catch {
            $lastError = $_
        }
        Start-Sleep -Milliseconds 500
    }

    $detail = if ($lastError) { $lastError.Exception.Message } else { "no response" }
    throw "Timed out waiting for $Url ($detail)."
}

function Start-DishlyManagedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][string]$LogDirectory,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $saved = @{}
    foreach ($key in $Environment.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
    }
    try {
        $stdoutPath = Join-Path $LogDirectory "$Name.stdout.log"
        $stderrPath = Join-Path $LogDirectory "$Name.stderr.log"
        return Start-Process `
            -FilePath $FilePath `
            -ArgumentList $ArgumentList `
            -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -WindowStyle Hidden `
            -PassThru
    } finally {
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $saved[$key], "Process")
        }
    }
}

function Stop-DishlyManagedProcess {
    param([Parameter(Mandatory = $true)][string]$PidPath)

    if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return }
    $rawPid = (Get-Content -Raw -LiteralPath $PidPath).Trim()
    $processId = 0
    if ([int]::TryParse($rawPid, [ref]$processId)) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $processId -Force
            $process.WaitForExit(5000) | Out-Null
        }
    }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
}
