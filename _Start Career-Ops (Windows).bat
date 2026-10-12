@echo off
rem Double-click this file to start Career-Ops.
rem It checks for Node.js (and offers to install it), installs what Career-Ops
rem needs on the first run, then opens the app in your browser.
rem Keep this window open while you use Career-Ops.
setlocal
cd /d "%~dp0"
title Career-Ops
echo ==============================================
echo   Career-Ops
echo ==============================================
echo.

call :findnode
if defined NODE_OK goto run

echo Career-Ops needs Node.js (free, from nodejs.org), and this computer does not have it yet.
echo.
choice /C YN /M "Install Node.js now"
if errorlevel 2 goto manual

where winget >nul 2>nul
if errorlevel 1 goto msi
echo Installing Node.js with Windows Package Manager. Windows may ask for permission.
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
call :findnode
if defined NODE_OK goto run

:msi
echo Downloading the Node.js installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\install-node.ps1"
call :findnode
if defined NODE_OK goto run

:manual
echo.
echo Please install Node.js from the page that is opening (choose the LTS version),
echo then double-click "_Start Career-Ops (Windows).bat" again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:run
node app\launch.mjs
if errorlevel 1 (
  echo.
  echo Career-Ops stopped with a problem. See the message above.
  pause
)
exit /b

:findnode
set "NODE_OK="
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 exit /b
node -e "process.exit(+process.versions.node.split(.)[0] >= 18 ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "NODE_OK=1"
exit /b
