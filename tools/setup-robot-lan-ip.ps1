param(
  [string]$InterfaceAlias = "Wi-Fi",
  [string]$IpAddress = "192.168.6.6",
  [int]$PrefixLength = 24
)

$ErrorActionPreference = "Stop"

function Exit-With([int]$Code, [string]$Message) {
  Write-Output $Message
  exit $Code
}

try {
  $existing = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $IpAddress }

  if ($existing) {
    Exit-With 0 "IP already exists: $IpAddress"
  }

  $iface = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
  if (-not $iface) {
    $wifiLike = Get-NetAdapter | Where-Object { $_.Status -eq "Up" -and $_.Name -match "Wi-?Fi|WLAN|无线" } | Select-Object -First 1
    if ($wifiLike) {
      $InterfaceAlias = $wifiLike.Name
    }
  }

  if (-not (Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue)) {
    Exit-With 2 "Cannot find interface '$InterfaceAlias'. Please pass -InterfaceAlias explicitly."
  }

  New-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $IpAddress -PrefixLength $PrefixLength -AddressFamily IPv4 -Type Unicast | Out-Null
  Exit-With 0 "Added IPv4 $IpAddress/$PrefixLength to '$InterfaceAlias'."
}
catch {
  $msg = $_.Exception.Message
  if ($msg -match "Access is denied|拒绝访问|requires elevation") {
    Exit-With 3 "Need admin privileges. Re-run this script in elevated PowerShell."
  }
  Exit-With 1 "Failed to add IP: $msg"
}
