param(
  [ValidateSet("on", "off")]
  [string]$Mode = "on",
  [string]$IpAddress = "192.168.4.1"
)

$ErrorActionPreference = "Stop"

function Exit-With([int]$Code, [string]$Message) {
  Write-Output $Message
  exit $Code
}

$destination = "$IpAddress/32"

try {
  if ($Mode -eq "off") {
    $existing = Get-NetRoute -DestinationPrefix $destination -ErrorAction SilentlyContinue |
      Where-Object { $_.NextHop -eq "127.0.0.1" -or $_.InterfaceAlias -match "Loopback|回送" }

    if (-not $existing) {
      Exit-With 0 "No mock route to remove for $destination"
    }

    $existing | ForEach-Object {
      Remove-NetRoute -DestinationPrefix $_.DestinationPrefix -InterfaceIndex $_.InterfaceIndex -NextHop $_.NextHop -Confirm:$false -ErrorAction SilentlyContinue
    }

    Exit-With 0 "Removed mock route for $destination"
  }

  $already = Get-NetRoute -DestinationPrefix $destination -ErrorAction SilentlyContinue |
    Where-Object { $_.NextHop -eq "127.0.0.1" }
  if ($already) {
    Exit-With 0 "Mock route already enabled for $destination"
  }

  try {
    New-NetRoute -DestinationPrefix $destination -InterfaceAlias "Loopback Pseudo-Interface 1" -NextHop "127.0.0.1" -RouteMetric 1 -PolicyStore ActiveStore | Out-Null
    Exit-With 0 "Enabled mock route: $destination -> 127.0.0.1"
  }
  catch {
    & route add $IpAddress mask 255.255.255.255 127.0.0.1 metric 1 | Out-Null
    Exit-With 0 "Enabled mock route via route.exe: $destination -> 127.0.0.1"
  }
}
catch {
  $msg = $_.Exception.Message
  if ($msg -match "Access is denied|拒绝访问|requires elevation") {
    Exit-With 3 "Need admin privileges. Re-run in elevated PowerShell."
  }
  Exit-With 1 "Failed to toggle mock route: $msg"
}
