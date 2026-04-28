@echo off
title Reset Authorization
color 0C
echo.
echo  This deletes saved authorization so the app
echo  asks for Discord login on the next launch.
echo.
set /p C=Type YES to confirm: 
if /i "%C%" NEQ "YES" (echo Cancelled. & pause & exit)
set "F=%USERPROFILE%\FiveM_Optimizer\.hwid"
set "A=%USERPROFILE%\FiveM_Optimizer\discord-auth.json"
if exist "%F%" del /f /q "%F%"
if exist "%A%" del /f /q "%A%"
echo [OK] Saved authorization reset. App will ask for Discord login next launch.
echo.
pause
