param(
  [string]$HostName = "robot-drive.test",
  [string]$HostIp = "127.0.0.1",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-ElevatedSelf {
  param(
    [string]$HostName,
    [string]$HostIp,
    [int]$Port
  )

  $argList = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $PSCommandPath + '"'),
    "-HostName", ('"' + $HostName + '"'),
    "-HostIp", ('"' + $HostIp + '"'),
    "-Port", $Port
  )

  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
Set-Location $repoRoot

if (-not (Test-IsAdmin)) {
  Write-Output "Requesting administrator permission..."
  Start-ElevatedSelf -HostName $HostName -HostIp $HostIp -Port $Port
  exit 0
}

Write-Output "[1/4] Updating fixed host entry..."
& powershell -NoProfile -ExecutionPolicy Bypass -File "tools/setup-robot-fixed-entry.ps1" -HostName $HostName -HostIp $HostIp

Write-Output "[2/4] Releasing port $Port if occupied..."
$conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($conns) {
  $procIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $procIds) {
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Output ("  Stopped process " + $procId)
    }
    catch {
      Write-Output ("  Skip process " + $procId + ": " + $_.Exception.Message)
    }
  }
}
else {
  Write-Output "  Port is free."
}

Write-Output "[3/4] Starting robot proxy service..."
Write-Output ("  URL: http://" + $HostName + ":" + $Port + "/robot-drive-latest?v=20260703r2")
Write-Output "[4/4] Press Ctrl+C to stop service."

& powershell -NoProfile -ExecutionPolicy Bypass -File "tools/start-robot-proxy.ps1" -ListenIp 127.0.0.1 -Port $Port -RobotLanding 1
