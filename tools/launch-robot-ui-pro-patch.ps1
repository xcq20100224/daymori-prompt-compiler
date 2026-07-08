param(
  [string]$RobotUrl = "http://192.168.4.1"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "userscripts\robot-ui-console-injector.js"
if (-not (Test-Path $scriptPath)) {
  Write-Output "Injector file not found: $scriptPath"
  exit 1
}

$injector = Get-Content -Raw -Path $scriptPath
Set-Clipboard -Value $injector
Write-Output "Injector copied to clipboard."

Start-Process $RobotUrl
Write-Output "Robot page opened: $RobotUrl"
Write-Output "Final step in browser: press F12, open Console, Ctrl+V, Enter."
