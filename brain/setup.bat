@echo off
title SAP Cutover Brain — Setup
echo ============================================
echo   SAP Cutover Brain — One-Time Setup
echo ============================================
echo.

set PYTHON="C:\Users\neha.a.bhardwaj\AppData\Local\Python\pythoncore-3.14-64\python.exe"

REM Check Python
%PYTHON% --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found at expected path.
    pause
    exit /b 1
)

echo [1/2] Installing Python dependencies...
%PYTHON% -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
    echo ERROR: pip install failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo [2/2] Creating data folder...
if not exist "%~dp0data\files" mkdir "%~dp0data\files"

echo.
echo ============================================
echo   Setup complete!
echo.
echo   Next steps:
echo   1. Load the Chrome extension:
echo      Open Chrome > Extensions > Load unpacked
echo      Select the brain-extension folder
echo   2. Double-click start.bat to run the server
echo   3. Go to SAP Roadmap Viewer and click Export
echo ============================================
pause
