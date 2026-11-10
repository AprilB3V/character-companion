@echo off
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "..\runtime\node\node.exe" set "NODE=..\runtime\node\node.exe"
"%NODE%" scripts\start.mjs %*
if errorlevel 1 pause
