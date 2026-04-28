@echo off
title FiveM Optimizer - Protect Code
color 0A
cd /d "%~dp0"
echo.
echo  ============================================
echo   Code Protection
echo  ============================================
echo.
where node >nul 2>&1 || (echo [ERROR] Node.js not found & pause & exit)
if not exist "node_modules\javascript-obfuscator" (
    echo Installing obfuscator...
    call npm install javascript-obfuscator --save-dev --silent
)
if not exist "src\backup" mkdir "src\backup"
copy /y "src\main.js" "src\backup\main.js.bak" >nul
copy /y "src\index.html" "src\backup\index.html.bak" >nul
echo [OK] Backup saved to src\backup\
echo.
echo Protecting main.js...
call node_modules\.bin\javascript-obfuscator src\main.js --output src\main.js --compact true --control-flow-flattening true --control-flow-flattening-threshold 0.75 --dead-code-injection true --dead-code-injection-threshold 0.4 --identifier-names-generator hexadecimal --rename-globals false --string-array true --string-array-encoding rc4 --string-array-threshold 0.85 --self-defending true --numbers-to-expressions true --split-strings true --split-strings-chunk-length 5 2>nul
if %ERRORLEVEL% NEQ 0 (echo [ERROR] Failed. Restoring... & copy /y "src\backup\main.js.bak" "src\main.js" >nul & pause & exit)
echo [OK] main.js protected!
echo.
echo  ============================================
echo   PROTECTION COMPLETE
echo   Originals backed up to src\backup\
echo   Now run build.bat to create the exe
echo  ============================================
echo.
pause
