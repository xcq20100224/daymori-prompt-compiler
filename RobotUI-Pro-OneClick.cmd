@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launch-robot-ui-pro-patch.ps1" -RobotUrl "http://192.168.4.1"
endlocal
