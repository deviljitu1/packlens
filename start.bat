@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\tsx (
  call npm install --offline=false
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
node --import tsx scripts\launch.ts --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the error above.
pause
exit /b 1
