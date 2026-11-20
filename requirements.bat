@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "VENV_DIR=%CD%\.venv"

where py >nul 2>nul
if %errorlevel% equ 0 (
    set "PYTHON=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python 3 was not found on PATH.
        echo Install Python 3.12 or newer, enable Add Python to PATH, and run this file again.
        pause
        exit /b 1
    )
    set "PYTHON=python"
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo Creating the CrowdSentinel virtual environment...
    %PYTHON% -m venv "%VENV_DIR%"
    if errorlevel 1 goto :failed
)

echo Upgrading pip...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed

echo Installing API requirements...
"%VENV_DIR%\Scripts\python.exe" -m pip install -r "%CD%\api\requirements.txt"
if errorlevel 1 goto :failed

echo Installing worker requirements...
"%VENV_DIR%\Scripts\python.exe" -m pip install -r "%CD%\worker\requirements.txt"
if errorlevel 1 goto :failed

echo.
echo CrowdSentinel requirements installed successfully.
echo Virtual environment: %VENV_DIR%
echo Activate it in PowerShell with:
echo .\.venv\Scripts\Activate.ps1
pause
exit /b 0

:failed
echo.
echo Installation failed. Check the error above, then run this file again.
pause
exit /b 1
