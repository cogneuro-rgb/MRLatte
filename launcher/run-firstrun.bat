@echo off
REM ===================================================================
REM  NeuroVue - first-run setup (executed once by the self-extractor).
REM  Creates a "NeuroVue" shortcut on the Desktop, then launches the app.
REM  %~dp0 = the folder the bundle was extracted into.
REM ===================================================================
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

REM Create the Desktop shortcut (Desktop path resolved via PowerShell so it works
REM even when the Desktop is redirected to OneDrive).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$app='%APPDIR%'; $d=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut((Join-Path $d 'NeuroVue.lnk')); $s.TargetPath=(Join-Path $app 'run.bat'); $s.WorkingDirectory=$app; $s.WindowStyle=1; $s.Description='Launch NeuroVue'; $ico=Join-Path $app 'neurovue.ico'; if(Test-Path $ico){$s.IconLocation=$ico}; $s.Save()"

REM Launch the app now (run.bat opens its own window).
start "" "%APPDIR%\run.bat"
exit /b 0
