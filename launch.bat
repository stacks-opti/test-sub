@echo off
title FiveM Optimizer
cd /d "%~dp0"
if not exist "node_modules\.bin\electron.cmd" (
    echo Installing Electron - one time only...
    call npm install
)
call "node_modules\.bin\electron.cmd" . --disable-gpu-sandbox --no-sandbox 2>"%~dp0error.log"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Check error.log in this folder.
    type "%~dp0error.log"
    pause
)
