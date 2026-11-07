@echo off
setlocal
if "%~1"=="" goto interactive
if /i not "%~1"=="--non-interactive" exit /b 2
if not "%~2"=="" exit /b 2
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -NonInteractive
exit /b %errorlevel%

:interactive
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1"
set "INSTALL_EXIT=%errorlevel%"
if not "%INSTALL_EXIT%"=="0" pause
exit /b %INSTALL_EXIT%
