@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\robot-proxy-oneclick.ps1" -HostName "robot-drive.test" -HostIp "127.0.0.1" -Port 3000
endlocal
