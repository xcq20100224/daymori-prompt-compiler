param(
  [string]$ListenIp = "127.0.0.1",
  [int]$Port = 3000,
  [string]$RobotLanding = "1"
)

$ErrorActionPreference = "Stop"

$env:HOST = $ListenIp
$env:PORT = [string]$Port
$env:ROBOT_LANDING = $RobotLanding

Write-Output "Starting robot proxy on http://$ListenIp`:$Port/"
Write-Output "Landing route enabled: ROBOT_LANDING=$RobotLanding"

node server.js
