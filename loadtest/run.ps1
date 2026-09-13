<#
.SYNOPSIS
  Run one load-test stage through Docker (grafana/k6). Windows PowerShell 5.1 compatible.

.EXAMPLE
  .\run.ps1 baseline
  .\run.ps1 high http://host.docker.internal:3000
  $env:SOAK_MINUTES = 60; .\run.ps1 soak

  Stages: baseline | moderate | high | spike | soak | e | g | h
  Environment pass-through: SESSION_COOKIE, CSRF_COOKIE, SOAK_MINUTES and the tuning knobs in README.md.
  Extra k6 flags: $env:K6_ARGS = "--http-debug=full"
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("baseline", "moderate", "high", "spike", "soak", "e", "g", "h")]
  [string]$Stage,

  [Parameter(Position = 1)]
  [string]$BaseUrl = ""
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
  if ($env:BASE_URL) { $BaseUrl = $env:BASE_URL } else { $BaseUrl = "http://host.docker.internal:8000" }
}
$image = if ($env:K6_IMAGE) { $env:K6_IMAGE } else { "grafana/k6:0.54.0" }

$dir = $PSScriptRoot
$usersFile = Join-Path $dir "users.json"
if (-not (Test-Path $usersFile)) {
  Write-Error "loadtest/users.json is missing. Seed it first:`n  cd backend; uv run python manage.py seed_loadtest --out ../loadtest/users.json"
}
$resultsDir = Join-Path $dir "results"
if (-not (Test-Path $resultsDir)) { New-Item -ItemType Directory -Path $resultsDir | Out-Null }

# Docker Desktop accepts C:\... and C:/... host paths; forward slashes avoid escaping surprises.
$hostDir = ($dir -replace "\\", "/")

$sessionCookie = if ($env:SESSION_COOKIE) { $env:SESSION_COOKIE } else { "keel_session" }
$csrfCookie = if ($env:CSRF_COOKIE) { $env:CSRF_COOKIE } else { "keel_csrftoken" }
$soakMinutes = if ($env:SOAK_MINUTES) { $env:SOAK_MINUTES } else { "30" }

$dockerArgs = @(
  "run", "--rm",
  "--add-host=host.docker.internal:host-gateway",
  "-v", "${hostDir}/k6:/scripts",
  "-v", "${hostDir}/results:/results",
  "-v", "${hostDir}/users.json:/scripts/users.json:ro",
  "-e", "STAGE=$Stage",
  "-e", "BASE_URL=$BaseUrl",
  "-e", "SESSION_COOKIE=$sessionCookie",
  "-e", "CSRF_COOKIE=$csrfCookie",
  "-e", "SOAK_MINUTES=$soakMinutes"
)

$passThrough = @(
  "E_VUS", "E_MINUTES", "G_IO_VUS", "G_BROWSE_VUS", "G_MINUTES", "H_REPORT_VUS", "H_PIPELINE_VUS", "H_MINUTES",
  "VERBOSE", "SEARCH_PREFIXES", "IMPORT_ROWS", "JOB_POLL_SECONDS", "JOB_POLL_MAX_SECONDS",
  "IO_MIN_ITERATION_SECONDS", "RECENT_AUTH_MINUTES"
)
foreach ($name in $passThrough) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $dockerArgs += @("-e", "$name=$value") }
}

$dockerArgs += @($image, "run")
if ($env:K6_ARGS) { $dockerArgs += ($env:K6_ARGS -split " " | Where-Object { $_ }) }
$dockerArgs += $(if ($Stage -eq "smoke") { "/scripts/smoke.js" } else { "/scripts/main.js" })

Write-Host "k6 stage=$Stage base=$BaseUrl image=$image results=$resultsDir"
& docker @dockerArgs
exit $LASTEXITCODE
