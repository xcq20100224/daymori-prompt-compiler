$ErrorActionPreference = 'Stop'

$candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notmatch '^127\.' -and
    $_.IPAddress -notmatch '^169\.254\.' -and
    $_.IPAddress -notmatch '^0\.'
  } |
  Select-Object IPAddress, InterfaceAlias, PrefixOrigin

if (-not $candidates) {
  Write-Output 'No usable IPv4 found. Use http://localhost:3000/robot-drive-latest'
  exit 0
}

Write-Output 'Use one of the following URLs from your current network:'
$candidates | ForEach-Object {
  $ip = $_.IPAddress
  $iface = $_.InterfaceAlias
  Write-Output ("- http://{0}:3000/robot-drive-latest?v=20260703r2   ({1})" -f $ip, $iface)
}

Write-Output 'Local fallback:'
Write-Output '- http://localhost:3000/robot-drive-latest?v=20260703r2'
