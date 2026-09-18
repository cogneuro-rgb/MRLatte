@echo off
REM Builds the CORE Windows installer (no optional report-figures / validation
REM stacks). Needs internet + a full Python 3.11 (py -3.11) + Node/yarn the
REM first time; re-runs reuse tools\build\downloads\ so they're faster.
cd /d "%~dp0"

echo === 1/2: Assembling the offline bundle (embeddable Python + backend deps) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\build\assemble-bundle.ps1"
if errorlevel 1 goto :error

echo.
echo === 2/2: Building the frontend and packaging the installer ===
cd frontend
call yarn dist:win
if errorlevel 1 goto :error

echo.
echo Done. Installer is in MRLatte-build\electron\
pause
exit /b 0

:error
echo.
echo Build failed - see the errors above.
pause
exit /b 1
