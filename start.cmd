@echo off
rem ============================================================
rem  Lishui Trail - offline planning console (view layer of the
rem  AGH plugin). Starts a local-only HTTP server on 127.0.0.1
rem  and opens the default browser. No network access, no model
rem  calls. Close this window to stop the server.
rem ============================================================
setlocal
chcp 65001 >nul
title Lishui Trail Console

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "E:\node.exe" set "NODE_EXE=E:\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE_EXE (
  echo [X] Node.js not found. Please install Node.js 22 or later, then retry.
  echo     https://nodejs.org/
  pause
  exit /b 1
)

echo [i] Starting local console ...
"%NODE_EXE%" "%~dp0apps\console\server.mjs" --open

echo.
echo [i] Server stopped.
pause
