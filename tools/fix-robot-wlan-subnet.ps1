param(
  [string]$InterfaceAlias = "WLAN",
  [string]$RobotIp = "192.168.4.1",
  [string]$LocalIp = "192.168.4.2",
  [int]$PrefixLength = 24
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Output "Need admin privileges. Please run this script in elevated PowerShell."
  exit 2
}

$adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
if (-not $adapter) {
  Write-Output "Adapter not found: $InterfaceAlias"
  exit 1
}

if ($adapter.Status -ne "Up") {
  Write-Output "Adapter is not up: $InterfaceAlias"
  exit 1
}

$existing = Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -eq $LocalIp }

if (-not $existing) {
  New-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $LocalIp -PrefixLength $PrefixLength -AddressFamily IPv4 -Type Unicast | Out-Null
  Write-Output ("Added IPv4 address {0}/{1} on {2}" -f $LocalIp, $PrefixLength, $InterfaceAlias)
} else {
  Write-Output ("IPv4 already present {0}/{1} on {2}" -f $LocalIp, $PrefixLength, $InterfaceAlias)
}

Write-Output ("Current IPv4 addresses on {0}" -f $InterfaceAlias)
Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Select-Object IPAddress, PrefixLength | Format-Table -AutoSize

Write-Output "Connectivity check to robot"
$ports = @(80, 8080)
foreach ($p in $ports) {
  $ok = Test-NetConnection -ComputerName $RobotIp -Port $p -WarningAction SilentlyContinue
  Write-Output ("  {0}:{1} => TCP={2}" -f $RobotIp, $p, $ok.TcpTestSucceeded)
}
