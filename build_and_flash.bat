@echo off
REM Windows helper: build the FAP with ufbt and install it on a USB-connected Flipper (close qFlipper first)
cd /d "%~dp0"
where ufbt >nul 2>nul && (set "UFBT=ufbt") || (set "UFBT=py -m ufbt")
echo === ufbt update (SDK release) ===
%UFBT% update
echo === build ===
%UFBT%
if errorlevel 1 goto fail
echo === launch on the Flipper ===
%UFBT% launch
if errorlevel 1 goto fail
echo.
echo OK: app installed and launched.
goto end
:fail
echo.
echo FAILED - see the messages above.
:end
pause
