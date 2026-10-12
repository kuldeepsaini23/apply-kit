@echo off
title Apply Kit server
cd /d "%~dp0server"
start "" http://localhost:4777
bun server.ts
pause
