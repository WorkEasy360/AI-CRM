<#
.SYNOPSIS
    Guarantees the local dependencies (PostgreSQL on 5433, Redis, Mailpit) are
    accepting connections before anything tries to talk to them.

.DESCRIPTION
    The backend fails with "connection timeout expired ... port 5433" whenever the
    Docker engine is stopped, so this script starts Docker Desktop if it is not
    running, brings the compose services up, and waits for the Postgres health
    check to pass. It is idempotent: on an already-healthy stack it is a no-op.
#>
[CmdletBinding()]
param(
    # How long to wait for the Docker engine to finish starting.
    [int] $EngineTimeoutSeconds = 180,
    # How long to wait for the compose services to report healthy.
    [int] $ServiceTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

function Test-DockerEngine {
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Start-DockerDesktop {
    # Docker Desktop is a per-user install on this machine, so it is not under
    # Program Files; check both locations rather than assuming either.
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
    )
    $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) {
        throw "Docker Desktop is not running and its executable was not found in: $($candidates -join '; ')"
    }

    Write-Host 'Docker engine is down; starting Docker Desktop...' -ForegroundColor Yellow
    Start-Process -FilePath $exe -ArgumentList '-Autostart' | Out-Null

    $deadline = (Get-Date).AddSeconds($EngineTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerEngine) {
            Write-Host 'Docker engine is up.' -ForegroundColor Green
            return
        }
        Start-Sleep -Seconds 3
    }
    throw "Docker engine did not come up within $EngineTimeoutSeconds seconds. Start Docker Desktop manually and retry."
}

if (-not (Test-DockerEngine)) {
    Start-DockerDesktop
}

# --wait blocks until every started service passes its health check, so the
# caller can connect immediately afterwards without a retry loop of its own.
Push-Location $repoRoot
try {
    docker compose up -d --wait --wait-timeout $ServiceTimeoutSeconds postgres redis mailpit
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up failed with exit code $LASTEXITCODE. Check 'docker compose logs postgres'."
    }
}
finally {
    Pop-Location
}

Write-Host 'postgres (5433), redis (6379) and mailpit (8025) are ready.' -ForegroundColor Green
