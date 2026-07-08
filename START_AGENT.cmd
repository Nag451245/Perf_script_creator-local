@echo off
rem Start the always-on PerfScript Agent.
rem Drop HAR/JMX/recording XML files into input\ while this window stays open.
rem The agent groups fresh files, generates the JMX, validates with JMeter,
rem and asks Gemini for safe bounded fixes when deterministic repair gets stuck.
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

echo ============================================================
echo PerfScript Agent is starting in watch mode.
echo.
echo 1. Drop your files into:
echo    %APP_DIR%input
echo.
echo 2. Supported groups:
echo    flow__run1.har + flow__run2.har
echo    flow__run1.jmx + flow__run1.recording.xml
echo    flow__run2.jmx + flow__run2.recording.xml
echo.
echo 3. Keep this window open. Close it to stop the agent.
echo ============================================================
echo.
start "" "%APP_DIR%input"
"%NODE_EXE%" "%APP_DIR%index.js" --agent --watch %*
set "RC=%ERRORLEVEL%"
echo.
echo Agent stopped ^(exit %RC%^). Results are in the output\ folder.
pause
exit /b %RC%
