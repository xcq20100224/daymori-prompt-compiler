param(
  [int]$Port = 3000,
  [string]$Route = "/robot-entry",
  [string]$SubnetPrefix = "192.168.8.",
  [string]$RobotSsid = "chenlong-robot-725047"
)

$ErrorActionPreference = "Stop"

function Get-ActiveWlanProfileName {
  try {
    $profile = Get-NetConnectionProfile -ErrorAction Stop |
      Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi|无线' } |
      Select-Object -First 1
    if ($profile -and $profile.Name) {
      return [string]$profile.Name
    }
  }
  catch {
  }
  return ""
}

function Get-WlanIpv4 {
  try {
    $ip = Get-NetIPConfiguration -ErrorAction Stop |
      Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi|无线' -and $_.IPv4Address } |
      Select-Object -First 1
    if ($ip -and $ip.IPv4Address -and $ip.IPv4Address.IPAddress) {
      return [string]$ip.IPv4Address.IPAddress
    }
  }
  catch {
  }
  return ""
}

function Get-SubnetPrefixFromIpv4([string]$Ipv4) {
  if (-not $Ipv4) { return "" }
  $parts = $Ipv4.Split('.')
  if ($parts.Count -ne 4) { return "" }
  return ("{0}.{1}.{2}." -f $parts[0], $parts[1], $parts[2])
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
Set-Location $repoRoot

$activeProfile = Get-ActiveWlanProfileName
if (-not $activeProfile) {
  Write-Output "No active WLAN profile detected. Connect to robot hotspot first."
  exit 5
}

$wlanIp = Get-WlanIpv4
if (-not $wlanIp) {
  Write-Output "No WLAN IPv4 detected. Connect to robot hotspot and retry."
  exit 7
}

$dynamicSubnet = Get-SubnetPrefixFromIpv4 -Ipv4 $wlanIp
if ($dynamicSubnet) {
  $SubnetPrefix = $dynamicSubnet
}

if (-not $wlanIp.StartsWith($SubnetPrefix)) {
  Write-Output ("Current WLAN IP {0} is not in required subnet {1}*" -f $wlanIp, $SubnetPrefix)
  Write-Output "Refusing to start service on non-robot network."
  exit 8
}

if ($activeProfile -ne $RobotSsid) {
  Write-Output ("Warning: WLAN profile is '{0}', expected '{1}'. Continue because subnet check passed." -f $activeProfile, $RobotSsid)
}

Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$env:HOST = "127.0.0.1"
$env:PORT = [string]$Port
$env:ROBOT_LANDING = "1"
$env:ROBOT_AP_ONLY = "1"
$env:ROBOT_AP_ROUTE = $Route
$env:ROBOT_AP_SUBNET_PREFIX = $SubnetPrefix
$env:ROBOT_AP_STRICT_WIFI = "0"
$env:ROBOT_AP_WIFI_SSID = $RobotSsid

Write-Output "Starting robot hotspot entry..."
Write-Output ("Required SSID: " + $RobotSsid)
Write-Output ("Active WLAN: " + $activeProfile)
Write-Output ("WLAN IP: " + $wlanIp)
Write-Output ("URL: http://localhost:" + $Port + $Route)

node server.js
