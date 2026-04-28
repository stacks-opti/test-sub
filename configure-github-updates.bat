@echo off
setlocal
title FiveM Optimizer - GitHub Updates
cd /d "%~dp0"
echo.
echo  ============================================
echo   FiveM Optimizer - GitHub Update Setup
echo  ============================================
echo.
echo  This configures the installed app to check:
echo  https://github.com/OWNER/REPO/releases/latest/download/
echo.
echo  No GitHub token is saved. This writes only the public release URL.
echo.
set /p GH_OWNER=GitHub owner or org [stacks-opti]: 
set /p GH_REPO=GitHub repo name [test-sub]: 
if "%GH_OWNER%"=="" set "GH_OWNER=stacks-opti"
if "%GH_REPO%"=="" set "GH_REPO=test-sub"

set "FEED_URL=https://github.com/%GH_OWNER%/%GH_REPO%/releases/latest/download/"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\FiveM Optimizer"
if not exist "%INSTALL_DIR%" (
  set "INSTALL_DIR=%ProgramFiles%\FiveM Optimizer"
)
if not exist "%INSTALL_DIR%" (
  echo [ERROR] Could not find the installed app folder.
  echo Install FiveM Optimizer first, then run this again.
  pause
  exit /b 1
)

> "%INSTALL_DIR%\update-config.json" echo {
>>"%INSTALL_DIR%\update-config.json" echo   "url": "%FEED_URL%"
>>"%INSTALL_DIR%\update-config.json" echo }

echo.
echo [OK] GitHub update URL saved:
echo %FEED_URL%
echo.
echo Restart FiveM Optimizer, then use Settings ^> Check for App Updates.
pause
