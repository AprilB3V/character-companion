@echo off
setlocal
if /i "%~1"=="--portable" goto portable
if "%~1"=="" goto portable
if /i not "%~1"=="--non-interactive" exit /b 2
if not "%~2"=="" exit /b 2
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -NonInteractive
exit /b %errorlevel%

:portable
if /i "%~2"=="--non-interactive" goto portableAuto
if not "%~2"=="" exit /b 2
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-public.ps1"
exit /b %errorlevel%
:portableAuto
if not "%~3"=="" exit /b 2
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\install-public.ps1" -NonInteractive
exit /b %errorlevel%
