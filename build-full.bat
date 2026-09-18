@echo off
REM Builds the FULL Windows installer: adds the optional report-figures
REM (nilearn/matplotlib/pandas) and validation (neuropythy) stacks as
REM installer components on top of the core bundle. Needs internet + a full
REM Python 3.11 (py -3.11) + Node/yarn the first time; re-runs reuse
REM tools\build\downloads\ so they're faster.
cd /d "%~dp0"

echo === 1/2: Assembling the offline bundle (embeddable Python + backend deps + optional stacks) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\build\assemble-bundle.ps1" -Full
if errorlevel 1 goto :error

echo.
echo === 2/2: Building the frontend and packaging the installer ===
cd frontend
call yarn dist:win:full
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
