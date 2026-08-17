@echo off
setlocal enabledelayedexpansion
set PORT=1010

echo Checking for existing process on port %PORT%...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo Killing existing process PID %%P on port %PORT%...
    taskkill /F /PID %%P >nul 2>&1
)

echo Starting MergeVideos app...
cd /d "%~dp0"
node server.js
