<#
.SYNOPSIS
    Starts the Django dev server with its dependencies guaranteed to be up.

.EXAMPLE
    pwsh -File scripts/dev.ps1
    pwsh -File scripts/dev.ps1 -Port 8001 -SkipMigrate
#>
[CmdletBinding()]
param(
    [int] $Port = 8000,
    [switch] $SkipMigrate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'ensure-services.ps1')

Push-Location (Join-Path $repoRoot 'backend')
try {
    if (-not $SkipMigrate) {
        # Console scripts in .venv still point at an old path, so always go
        # through `uv run python -m ...` rather than a bare entry point.
        uv run python manage.py migrate
        if ($LASTEXITCODE -ne 0) { throw "migrate failed with exit code $LASTEXITCODE" }
    }
    uv run python manage.py runserver $Port
}
finally {
    Pop-Location
}
