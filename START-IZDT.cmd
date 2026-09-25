@echo off
setlocal
title IZDT - local server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  echo Install Node.js 22.12+ from https://nodejs.org/en/download
  echo Then close this window and run START-IZDT.cmd again.
  pause
  exit /b 1
)
node scripts\start-local.js
if errorlevel 1 (
  echo.
  echo IZDT could not start. See the message above.
  pause
  exit /b 1
)
endlocal
