@echo off
rem perfscript-local: generate + validate with local JMeter (one double-click).
rem   Correlates every recording in input\, builds the .jmx, runs it through
rem   JMeter, and reports pass/fail. Same as: perfscript --run
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
"%NODE_EXE%" "%APP_DIR%index.js" --run %*
set "RC=%ERRORLEVEL%"
echo.
echo Done ^(exit %RC%^). Results are in the output\ folder.
pause
exit /b %RC%
