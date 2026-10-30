@echo off
setlocal
rem ---------------------------------------------------------------
rem  Lishui Trail - offline demo console
rem  Zero dependency / zero network / no Agnes model, no API key.
rem  Just double-click this file, then open the URL below.
rem ---------------------------------------------------------------
set PORT=8790
echo.
echo   Lishui Trail demo console starting ...
echo   Open in browser:  http://127.0.0.1:%PORT%/
echo   Stop: press Ctrl+C in this window
echo.
"E:\node.exe" "%~dp0server.mjs"
endlocal
