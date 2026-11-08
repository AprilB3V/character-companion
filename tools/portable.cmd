@echo off
setlocal
set "PATH=%~dp0runtime\node;%PATH%"
if /i "%~1"=="setup" goto setup
if /i "%~1"=="stop" goto stop
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\portable-setup.ps1" -NonInteractive
if errorlevel 1 goto failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pet\start.ps1" -Installed %*
if errorlevel 1 goto failed
exit /b 0
:setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\portable-setup.ps1" %2
exit /b %errorlevel%
:stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pet\stop.ps1" -Installed -IncludeCl
exit /b %errorlevel%
:failed
set "START_EXIT=%errorlevel%"
echo See %%LOCALAPPDATA%%\CharacterCompanion\logs for details.
if "%~1"=="" pause
exit /b %START_EXIT%
