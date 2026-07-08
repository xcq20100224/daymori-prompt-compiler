param(
  [string]$HostName = "robot-drive.local",
  [string]$HostIp = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$marker = "# daymori-robot-fixed-entry"

function Exit-With([int]$Code, [string]$Message) {
  Write-Output $Message
  exit $Code
}

try {
  if (-not (Test-Path $hostsPath)) {
    Exit-With 1 "hosts file not found: $hostsPath"
  }

  $content = Get-Content -Path $hostsPath -ErrorAction Stop

  $filtered = $content | Where-Object {
    $_ -notmatch "\\s$HostName(\\s|$)" -and $_ -notmatch "daymori-robot-fixed-entry"
  }

  $newLine = "$HostIp`t$HostName`t$marker"
  $updated = @($filtered + $newLine)

  Set-Content -Path $hostsPath -Value $updated -Encoding ASCII -ErrorAction Stop

  Write-Output "Fixed entry mapped: http://$HostName/ -> $HostIp"
  Write-Output "Done."
  exit 0
}
catch {
  $msg = $_.Exception.Message
  if ($msg -match "Access to the path|拒绝访问|Access is denied") {
    Exit-With 3 "Need admin privileges. Re-run in elevated PowerShell."
  }
  Exit-With 1 "Failed to update hosts: $msg"
}
