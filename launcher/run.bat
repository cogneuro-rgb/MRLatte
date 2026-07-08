@echo off
REM ===================================================================
REM  NeuroVue - start the app (offline, self-contained)
REM  Double-click this file to launch NeuroVue in your web browser.
REM  Uses the bundled Python + MongoDB - nothing needs to be installed.
REM  %~dp0 = the folder this script lives in, so the bundle works from
REM  any location (USB drive, Desktop, Program folder, ...).
REM ===================================================================
title NeuroVue
cd /d "%~dp0"

if not exist "%~dp0python\python.exe" (
    echo.
    echo   ERROR: NeuroVue files look incomplete ^(python\python.exe missing^).
    echo   Please re-install NeuroVue.
    echo.
    pause
    exit /b 1
)

"%~dp0python\python.exe" "%~dp0launcher.py"

REM If the launcher exited with an error before it could show its own message,
REM keep the window open so the user can read what happened.
if errorlevel 1 pause
