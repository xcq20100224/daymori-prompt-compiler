param(
  [string]$HostName = "robot-drive.test",
  [int]$Port = 3000
)

$ErrorActionPreference = "Continue"

Write-Output "=== Robot Entry Diagnose ==="
Write-Output ("HostName: {0}" -f $HostName)
Write-Output ("Port: {0}" -f $Port)

Write-Output "\n[1] hosts mapping"
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
if (Test-Path $hostsPath) {
  $hits = Get-Content $hostsPath | Where-Object { $_ -match "\\s$HostName(\\s|$)" }
  if ($hits) {
    $hits | ForEach-Object { Write-Output ("  " + $_) }
  } else {
    Write-Output "  NOT FOUND in hosts"
  }
} else {
  Write-Output "  hosts file missing"
}

Write-Output "\n[2] DNS resolve"
try {
  Resolve-DnsName -Name $HostName -ErrorAction Stop | Select-Object -First 3 | ForEach-Object {
    Write-Output ("  " + $_.Name + " -> " + $_.IPAddress)
  }
}
catch {
  Write-Output ("  DNS failed: " + $_.Exception.Message)
}

Write-Output "\n[3] local tcp listen"
try {
  $listen = Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port }
  if ($listen) {
    $listen | ForEach-Object { Write-Output ("  LISTEN " + $_.LocalAddress + ":" + $_.LocalPort) }
  } else {
    Write-Output "  no process listening on target port"
  }
}
catch {
  Write-Output ("  tcp check failed: " + $_.Exception.Message)
}

Write-Output "\n[4] HTTP probe"
$targets = @(
  ("http://{0}:{1}/robot-drive-latest?v=20260703r2" -f $HostName, $Port),
  ("http://localhost:{0}/robot-drive-latest?v=20260703r2" -f $Port)
)
foreach ($u in $targets) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 5
    $isNew = if ($r.Content -match "robot-drive-2026-07-03-r2") { "NEW_UI" } else { "OLD_OR_OTHER" }
    Write-Output ("  OK {0} status={1} tag={2}" -f $u, $r.StatusCode, $isNew)
  }
  catch {
    Write-Output ("  FAIL {0} err={1}" -f $u, $_.Exception.Message)
  }
}
