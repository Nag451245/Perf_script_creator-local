@echo off
rem perfscript-local: launch the simple web UI and open it in the browser.
rem   Keep this window open while you use the UI; close it to stop the server.
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
rem Open the browser a moment after the server starts (server runs in THIS window).
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:7070"
echo Starting PerfScript UI...  (close this window to stop it)
"%NODE_EXE%" "%APP_DIR%src\ui-server.js"
pause
