@echo off
setlocal EnableExtensions EnableDelayedExpansion
title FiveM Optimizer - Publish GitHub Release
cd /d "%~dp0"

echo.
echo  ============================================
echo   FiveM Optimizer - Publish GitHub Release
echo  ============================================
echo.

where node >nul 2>&1 || (
  echo [ERROR] Node.js was not found.
  pause
  exit /b 1
)

where gh >nul 2>&1 || (
  echo [ERROR] GitHub CLI was not found.
  echo Install it from: https://cli.github.com/
  echo Then run: gh auth login
  pause
  exit /b 1
)

gh auth status >nul 2>&1 || (
  echo [ERROR] GitHub CLI is not logged in.
  echo Run: gh auth login
  pause
  exit /b 1
)

set "DEFAULT_REPO=stacks-opti/test-sub"
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%v"

echo Current app version: %APP_VERSION%
echo.
echo If you are publishing a new update, enter the new version here.
echo Examples: 1.1.0, 2.0.1
echo Leave blank to keep the current package.json version.
echo.
set /p NEW_VERSION=New app version [keep %APP_VERSION%]: 
if not "%NEW_VERSION%"=="" (
  call npm version "%NEW_VERSION%" --no-git-tag-version
  if errorlevel 1 (
    echo [ERROR] Version update failed. Use a valid semver version like 1.1.0.
    pause
    exit /b 1
  )
  for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%v"
)

set "TAG=v%APP_VERSION%"
set "SETUP=dist\FiveM Optimizer Setup %APP_VERSION%.exe"
set "BLOCKMAP=dist\FiveM Optimizer Setup %APP_VERSION%.exe.blockmap"
set "LATEST=dist\latest.yml"

echo.
echo Release tag: %TAG%
echo.

set /p GH_REPO=GitHub repo, like owner/repo [%DEFAULT_REPO%]: 
if "%GH_REPO%"=="" set "GH_REPO=%DEFAULT_REPO%"
echo %GH_REPO%| findstr /r "^[^/][^/]*/[^/][^/]*$" >nul
if errorlevel 1 (
  echo.
  echo [WARN] "%GH_REPO%" is not a GitHub repo. Using %DEFAULT_REPO% instead.
  echo        Repo format must look like owner/repo. Version numbers go in the version prompt above.
  set "GH_REPO=%DEFAULT_REPO%"
)

echo.
echo Building app...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

if not exist "%SETUP%" (
  echo [ERROR] Missing "%SETUP%".
  pause
  exit /b 1
)
if not exist "%BLOCKMAP%" (
  echo [ERROR] Missing "%BLOCKMAP%".
  pause
  exit /b 1
)
if not exist "%LATEST%" (
  echo [ERROR] Missing "%LATEST%".
  pause
  exit /b 1
)

echo.
echo Creating or updating GitHub release...
echo Using GitHub CLI auth only. No token is written into the app or release files.
gh release view "%TAG%" --repo "%GH_REPO%" >nul 2>&1
if errorlevel 1 (
  gh release create "%TAG%" "%SETUP%" "%BLOCKMAP%" "%LATEST%" --repo "%GH_REPO%" --title "FiveM Optimizer %APP_VERSION%" --notes "FiveM Optimizer %APP_VERSION%" --latest
) else (
  gh release upload "%TAG%" "%SETUP%" "%BLOCKMAP%" "%LATEST%" --repo "%GH_REPO%" --clobber
  gh release edit "%TAG%" --repo "%GH_REPO%" --latest
)

if errorlevel 1 (
  echo [ERROR] GitHub release upload failed.
  pause
  exit /b 1
)

echo.
echo [OK] Release published.
echo.
echo Update feed URL:
echo https://github.com/%GH_REPO%/releases/latest/download/
echo.
echo Paste that URL in the app Settings ^> Update Feed URL, or run:
echo configure-github-updates.bat
echo.
pause
