@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Install Node.js, restart the computer, and run this file again.
  echo.
  pause
  exit /b 1
)

start "" "http://localhost:3000"
node server.js

echo.
echo The site has stopped.
pause
