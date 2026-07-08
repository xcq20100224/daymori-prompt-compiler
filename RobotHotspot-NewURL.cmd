@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\start-robot-hotspot-entry.ps1" -Port 3000 -Route "/robot-entry" -SubnetPrefix "192.168.8." -RobotSsid "chenlong-robot-725047"
endlocal
