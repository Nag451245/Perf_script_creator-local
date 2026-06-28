@echo off
rem perfscript-local launcher: locate a Node runtime and run the app.
rem   perfscript            generate scripts from every HAR in input\
rem   perfscript --run      also validate with local JMeter
rem   perfscript --watch    process files as they appear
rem Double-clicking runs generate-only over input\.
setlocal
set "APP_DIR=%~dp0"
set "NODE_EXE="

rem 1) node already on PATH
where node >nul 2>nul && set "NODE_EXE=node"

rem 2) common portable / install locations (first match wins)
if "%NODE_EXE%"=="" if exist "%LOCALAPPDATA%\nodejs22\node.exe" set "NODE_EXE=%LOCALAPPDATA%\nodejs22\node.exe"
if "%NODE_EXE%"=="" if exist "%USERPROFILE%\nodejs\node.exe"      set "NODE_EXE=%USERPROFILE%\nodejs\node.exe"
if "%NODE_EXE%"=="" if exist "%ProgramFiles%\nodejs\node.exe"     set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if "%NODE_EXE%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

if "%NODE_EXE%"=="" (
  echo [perfscript] Could not find node.exe. Install Node 18+ or add it to PATH.
  exit /b 1
)

"%NODE_EXE%" "%APP_DIR%index.js" %*
set "RC=%ERRORLEVEL%"
rem Keep the window open when double-clicked (no args, interactive console).
if "%~1"=="" pause
exit /b %RC%
