@echo off
rem Creates a "PerfScript Studio" shortcut on your Desktop that launches the
rem agent (START_AGENT.cmd) with the PerfScript icon. Double-click this once.
setlocal
set "APP_DIR=%~dp0"
set "TARGET=%APP_DIR%START_AGENT.cmd"
set "ICON=%APP_DIR%assets\perfscript.ico"

if not exist "%ICON%" (
  rem Icon missing (fresh checkout) — generate it if Node is available.
  where node >nul 2>nul && node "%APP_DIR%scripts\make-icon.js"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([System.IO.Path]::Combine($ws.SpecialFolders('Desktop'),'PerfScript Studio.lnk'));" ^
  "$lnk.TargetPath = '%TARGET%';" ^
  "$lnk.WorkingDirectory = '%APP_DIR%';" ^
  "$lnk.IconLocation = '%ICON%,0';" ^
  "$lnk.Description = 'Launch the PerfScript JMeter scripting agent';" ^
  "$lnk.WindowStyle = 1;" ^
  "$lnk.Save();"

if errorlevel 1 (
  echo Could not create the shortcut. Make sure PowerShell is available.
) else (
  echo Created "PerfScript Studio" on your Desktop.
  echo Double-click it any time to start the agent.
)
echo.
pause
