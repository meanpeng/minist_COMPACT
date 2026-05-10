$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

$backendHost = if ([string]::IsNullOrWhiteSpace($env:BACKEND_HOST)) { "0.0.0.0" } else { $env:BACKEND_HOST }
$backendPort = if ([string]::IsNullOrWhiteSpace($env:BACKEND_PORT)) { "8000" } else { $env:BACKEND_PORT }
$pythonBin = if ([string]::IsNullOrWhiteSpace($env:PYTHON_BIN)) { "python" } else { $env:PYTHON_BIN }

if (-not (Test-Path -LiteralPath (Join-Path $rootDir "dist/index.html"))) {
  Write-Host "dist/index.html not found; building frontend first."
  npm run build
}

$backendArgs = @(
  "-m", "uvicorn", "backend.main:app",
  "--host", $backendHost,
  "--port", $backendPort
)

Write-Host "Starting production app on http://$backendHost`:$backendPort"
& $pythonBin @backendArgs
