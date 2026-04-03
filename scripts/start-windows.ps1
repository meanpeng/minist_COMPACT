$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

$backendHost = if ([string]::IsNullOrWhiteSpace($env:BACKEND_HOST)) { "0.0.0.0" } else { $env:BACKEND_HOST }
$backendPort = if ([string]::IsNullOrWhiteSpace($env:BACKEND_PORT)) { "8000" } else { $env:BACKEND_PORT }
$frontendHost = if ([string]::IsNullOrWhiteSpace($env:FRONTEND_HOST)) { "0.0.0.0" } else { $env:FRONTEND_HOST }
$frontendPort = if ([string]::IsNullOrWhiteSpace($env:FRONTEND_PORT)) { "5173" } else { $env:FRONTEND_PORT }

$backendArgs = @(
  "-m", "uvicorn", "backend.main:app",
  "--reload",
  "--host", $backendHost,
  "--port", $backendPort
)

$frontendArgs = @(
  "./node_modules/vite/bin/vite.js",
  "--host", $frontendHost,
  "--port", $frontendPort
)

Write-Host "Starting backend on http://$backendHost`:$backendPort"
$backendProcess = Start-Process -FilePath "python" -ArgumentList $backendArgs -WorkingDirectory $rootDir -PassThru

Write-Host "Starting frontend on http://$frontendHost`:$frontendPort"
$frontendProcess = Start-Process -FilePath "node" -ArgumentList $frontendArgs -WorkingDirectory $rootDir -PassThru

try {
  while ($true) {
    if ($backendProcess.HasExited) {
      throw "Backend process exited unexpectedly."
    }

    if ($frontendProcess.HasExited) {
      throw "Frontend process exited unexpectedly."
    }

    Start-Sleep -Seconds 1
  }
}
finally {
  foreach ($proc in @($backendProcess, $frontendProcess)) {
    if ($null -ne $proc -and -not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force
    }
  }
}
