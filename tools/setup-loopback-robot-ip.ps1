param(
  [string]$InterfaceAlias = "",
  [string]$IpAddress = "192.168.4.1",
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

  if (-not $InterfaceAlias) {
    $active = Get-NetAdapter -ErrorAction SilentlyContinue |
      Where-Object { $_.Status -eq "Up" -and $_.HardwareInterface -eq $true } |
      Select-Object -First 1
    if ($active) {
      $InterfaceAlias = $active.Name
    }
  }

  if (-not $InterfaceAlias) {
    Exit-With 2 "No active network adapter found."
  }

  # Try native cmdlet first.
  try {
    New-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $IpAddress -PrefixLength $PrefixLength -AddressFamily IPv4 -Type Unicast | Out-Null
    Exit-With 0 "Added $IpAddress/$PrefixLength on '$InterfaceAlias'."
  }
  catch {
    # Fallback to netsh for systems where cmdlet cannot apply.
    $mask = if ($PrefixLength -eq 24) { "255.255.255.0" } elseif ($PrefixLength -eq 16) { "255.255.0.0" } else { "255.255.255.0" }
    & netsh interface ipv4 add address name="$InterfaceAlias" address=$IpAddress mask=$mask store=persistent | Out-Null
    Exit-With 0 "Added $IpAddress/$PrefixLength via netsh on '$InterfaceAlias'."
  }
}
catch {
  $msg = $_.Exception.Message
  if ($msg -match "Access is denied|拒绝访问|requires elevation") {
    Exit-With 3 "Need admin privileges. Re-run in elevated PowerShell."
  }
  Exit-With 1 "Failed to add IP: $msg"
}
