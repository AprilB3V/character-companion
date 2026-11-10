@echo off
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "..\runtime\node\node.exe" set "NODE=..\runtime\node\node.exe"
rem Usage: install.cmd [--port auto^|8790] [--model-from auto^|web] [--profile jingjing]
"%NODE%" scripts\install.mjs %*
if errorlevel 1 (echo. & echo Install failed. & pause & exit /b 1)
if not defined JINGJING_NO_PAUSE pause
