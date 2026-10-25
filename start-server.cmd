@echo off
title Apply Kit server
cd /d "%~dp0server"
rem Stop an older copy (even a hidden one) still holding the port, so this one can start.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:4777" ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
start "" http://localhost:4777
bun server.ts
pause
