@echo off
rem PerfScript single launcher: starts the local browser control center.
rem Use the UI for Generate, Validate, Agent, multi-run, rerun, watch, and stop.
setlocal
set "APP_DIR=%~dp0"
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if "%NODE_EXE%"=="" if exist "%LOCALAPPDATA%\nodejs22\node.exe" set "NODE_EXE=%LOCALAPPDATA%\nodejs22\node.exe"
if "%NODE_EXE%"=="" if exist "%USERPROFILE%\nodejs\node.exe"      set "NODE_EXE=%USERPROFILE%\nodejs\node.exe"
if "%NODE_EXE%"=="" if exist "%ProgramFiles%\nodejs\node.exe"     set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if "%NODE_EXE%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if "%NODE_EXE%"=="" (
  echo [perfscript] Could not find node.exe. Install Node 18+ or add it to PATH.
  pause
  exit /b 1
)

if not exist "%APP_DIR%input" mkdir "%APP_DIR%input"
if not exist "%APP_DIR%output" mkdir "%APP_DIR%output"

start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:7070"
echo ============================================================
echo PerfScript Agent Launcher
echo.
echo Your browser will open http://localhost:7070
echo Use the left panel to select HAR/JMX/XML inputs and run the agent.
echo Keep this window open. Close it to stop the UI server.
echo ============================================================
echo.
"%NODE_EXE%" "%APP_DIR%src\ui-server.js" %*
set "RC=%ERRORLEVEL%"
echo.
echo PerfScript UI stopped ^(exit %RC%^).
pause
exit /b %RC%
