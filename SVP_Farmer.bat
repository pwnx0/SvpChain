@echo off
title SVP Rewards - Auto Farmer
color 0b
cd /d "%~dp0"

echo ================================================================
echo           SVP REWARDS - AUTOMATED FARMING SUITE
echo ================================================================
echo  Directory: %cd%
echo ================================================================
echo.
echo  [1] Run Multi-Threaded Farmer (10 Threads - 1h IP Cooldown)
echo  [2] Run Test Dry-Run (No gas / No transactions)
echo.
echo  Starting Option [1] automatically in 5 seconds...
echo.

choice /c 12 /t 5 /d 1 /n /m "Select option [1-2] or wait for auto-start: "
set OPT=%errorlevel%

echo.
if "%OPT%"=="1" goto run_threaded
if "%OPT%"=="2" goto run_dry
goto run_threaded

:run_threaded
echo [INFO] Starting Multi-Threaded Farmer...
node index.js --threads 10
goto finish

:run_dry
echo [INFO] Starting Dry Run...
node index.js --dry --once
goto finish

:finish
echo.
echo ================================================================
echo Process finished.
echo ================================================================
pause
